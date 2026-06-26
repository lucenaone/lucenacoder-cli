// src/cli-indexer.js — Tree-sitter WASM indexer for the CLI agent
// Runs on the user's machine at startup, parses all code files locally,
// and builds a symbol index that can be pushed to the browser
// via RTDB when the tunnel connects.

import { readFile, readdir, stat } from 'fs/promises';
import { join, extname, relative } from 'path';
import { existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { createWorkspaceIgnore } from './ignore-rules.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ── Language Support ──
const LANGUAGE_MAP = {
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.ts': 'typescript',
  '.tsx': 'tsx',
  '.py': 'python',
  '.rb': 'ruby',
  '.go': 'go',
  '.rs': 'rust',
};

// ── Parser singleton ──
let _Parser = null;
let _Language = null;
let isInitialized = false;
const languageCache = new Map();

function getGrammarsDir() {
  return join(__dirname, '..', 'grammars');
}

async function initParser() {
  if (isInitialized) return;
  const mod = await import('web-tree-sitter');
  _Parser = mod.Parser;
  _Language = mod.Language;

  const grammarsDir = getGrammarsDir();

  await _Parser.init({
    locateFile: (scriptName) => {
      return join(grammarsDir, scriptName);
    },
  });
  isInitialized = true;
}

async function loadLanguage(langExt) {
  if (languageCache.has(langExt)) return languageCache.get(langExt);

  const langName = LANGUAGE_MAP[langExt];
  if (!langName) throw new Error(`Unsupported language: ${langExt}`);

  const grammarsDir = getGrammarsDir();
  const wasmFile = join(grammarsDir, `tree-sitter-${langName}.wasm`);
  const language = await _Language.load(wasmFile);
  languageCache.set(langExt, language);
  return language;
}

// ── Chunk Extraction (mirrors ast-worker.js exactly) ──

function extractChunks(rootNode, code) {
  const chunks = [];

  function walk(node, depth, parentType) {
    const type = node.type;

    // ── Imports ──
    if (type === 'import_declaration' || type === 'import_statement' || type === 'import_from_statement') {
      chunks.push({
        type: 'import',
        name: node.text.slice(0, 80),
        startByte: node.startIndex,
        endByte: node.endIndex,
        text: node.text,
      });
      return;
    }

    // ── Classes ──
    if (type === 'class_declaration' || type === 'class_definition' || type === 'class') {
      const nameNode = node.childForFieldName('name');
      const name = nameNode ? nameNode.text : '<anonymous>';
      const isExported = isExportedNode(node);
      chunks.push({
        type: 'class',
        name,
        exported: isExported,
        startByte: node.startIndex,
        endByte: node.endIndex,
        text: node.text,
      });
      extractNestedNames(node, chunks, name);
      return;
    }

    // ── Function declarations ──
    if (type === 'function_declaration' || type === 'function_definition' || type === 'method_definition') {
      if (depth > 1) {
        return;
      }
      const nameNode = node.childForFieldName('name');
      const name = nameNode ? nameNode.text : '<anonymous>';
      const isExported = isExportedNode(node) || isExportedNode(node.parent);
      chunks.push({
        type: 'function',
        name,
        exported: isExported,
        startByte: node.startIndex,
        endByte: node.endIndex,
        text: node.text,
      });
      return;
    }

    // ── Variable declarations (top-level only) ──
    if ((type === 'variable_declarator' || type === 'variable_declaration' || type === 'lexical_declaration') && depth === 0) {
      if (type === 'variable_declaration' || type === 'lexical_declaration') {
        for (let i = 0; i < node.childCount; i++) {
          const child = node.child(i);
          if (child.type === 'variable_declarator') {
            const nameNode = child.childForFieldName('name');
            const valueNode = child.childForFieldName('value');
            const name = nameNode ? nameNode.text : '<unknown>';
            const isArrowFn = valueNode && (valueNode.type === 'arrow_function' || valueNode.type === 'function');
            const isExported = isExportedNode(node);
            chunks.push({
              type: isArrowFn ? 'function' : 'variable',
              name,
              exported: isExported,
              startByte: node.startIndex,
              endByte: node.endIndex,
              text: node.text,
            });
          }
        }
        return;
      }

      const nameNode = node.childForFieldName('name');
      const valueNode = node.childForFieldName('value');
      const name = nameNode ? nameNode.text : '<unknown>';
      const isArrowFn = valueNode && (valueNode.type === 'arrow_function' || valueNode.type === 'function');
      const isExported = isExportedNode(node.parent);
      chunks.push({
        type: isArrowFn ? 'function' : 'variable',
        name,
        exported: isExported,
        startByte: node.parent ? node.parent.startIndex : node.startIndex,
        endByte: node.parent ? node.parent.endIndex : node.endIndex,
        text: node.parent ? node.parent.text : node.text,
      });
      return;
    }

    // ── Python assignments at top level ──
    if (type === 'assignment' && depth === 0) {
      const leftNode = node.childForFieldName('left');
      const name = leftNode ? leftNode.text : '<unknown>';
      chunks.push({
        type: 'variable',
        name,
        exported: false,
        startByte: node.startIndex,
        endByte: node.endIndex,
        text: node.text,
      });
      return;
    }

    // ── Go top-level var/const ──
    if ((type === 'var_declaration' || type === 'const_declaration') && depth === 0) {
      chunks.push({
        type: 'variable',
        name: node.text.slice(0, 60),
        exported: false,
        startByte: node.startIndex,
        endByte: node.endIndex,
        text: node.text,
      });
      return;
    }

    // ── Ruby method definitions ──
    if (type === 'method' || type === 'singleton_method') {
      const nameNode = node.childForFieldName('name');
      const name = nameNode ? nameNode.text : '<anonymous>';
      chunks.push({
        type: 'function',
        name,
        exported: false,
        startByte: node.startIndex,
        endByte: node.endIndex,
        text: node.text,
      });
      return;
    }

    // ── Rust function definitions ──
    if (type === 'function_item' || type === 'function_signature_item') {
      const nameNode = node.childForFieldName('name');
      const name = nameNode ? nameNode.text : '<anonymous>';
      const isExported = isExportedNode(node) || isExportedNode(node.parent);
      chunks.push({
        type: 'function',
        name,
        exported: isExported,
        startByte: node.startIndex,
        endByte: node.endIndex,
        text: node.text,
      });
      return;
    }

    // ── Rust impl blocks ──
    if (type === 'impl_item') {
      const typeNode = node.childForFieldName('type');
      const name = typeNode ? typeNode.text : '<impl>';
      chunks.push({
        type: 'class',
        name,
        exported: false,
        startByte: node.startIndex,
        endByte: node.endIndex,
        text: node.text,
      });
      return;
    }

    // ── Export statements wrapping other declarations ──
    if (type === 'export_statement' || type === 'export_default_declaration') {
      for (let i = 0; i < node.childCount; i++) {
        walk(node.child(i), depth, type);
      }
      return;
    }

    // ── Continue walking children ──
    for (let i = 0; i < node.childCount; i++) {
      walk(node.child(i), depth + 1, type);
    }
  }

  walk(rootNode, 0, null);
  return { chunks };
}

function isExportedNode(node) {
  if (!node) return false;
  if (node.type === 'export_statement' || node.type === 'export_default_declaration') return true;
  if (node.type === 'pub') return true; // Rust
  if (node.parent && (node.parent.type === 'export_statement' || node.parent.type === 'export_default_declaration')) return true;
  return false;
}

function extractNestedNames(node, chunks, parentName) {
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child.type === 'method_definition' || child.type === 'function_definition' || child.type === 'method') {
      const nameNode = child.childForFieldName('name');
      if (nameNode) {
        chunks.push({
          type: 'nested_function',
          name: nameNode.text,
          parent: parentName,
          startByte: child.startIndex,
          endByte: child.endIndex,
          text: child.text,
        });
      }
    }
  }
}

// ── File Tree Walker ──

async function walkWorkspaceFiles(dirPath, cwd, workspaceIgnore, results = []) {
  const entries = await readdir(dirPath, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = join(dirPath, entry.name);
    const relPath = relative(cwd, fullPath).replace(/\\/g, '/');
    if (workspaceIgnore.ignoresPath(relPath)) continue;

    if (entry.isDirectory()) {
      await walkWorkspaceFiles(fullPath, cwd, workspaceIgnore, results);
    } else if (entry.isFile()) {
      results.push({
        path: relPath,
        fullPath,
        ext: extname(entry.name),
        lineCount: await countTextFileLines(fullPath),
      });
    }
  }

  return results;
}

async function countTextFileLines(fullPath) {
  if (!isTextLikeFile(fullPath)) return null;

  try {
    const info = await stat(fullPath);
    if (info.size > 5 * 1024 * 1024) return null;
    const content = await readFile(fullPath, 'utf-8');
    if (!content) return 0;
    return content.split('\n').length;
  } catch {
    return null;
  }
}

function isTextLikeFile(filePath) {
  return /\.(cjs|css|csv|go|html?|js|jsx|json|mdx?|mjs|py|rb|rs|sql|svg|ts|tsx|txt|xml|ya?ml)$/i.test(filePath);
}

// ── Main Index Builder ──

export async function buildIndex(cwd, onProgress) {
  await initParser();

  const workspaceIgnore = createWorkspaceIgnore(cwd);
  const workspaceFiles = await walkWorkspaceFiles(cwd, cwd, workspaceIgnore);
  const files = workspaceFiles
    .filter(file => LANGUAGE_MAP[file.ext])
    .map(file => ({
      filePath: '/' + file.path,
      fullPath: file.fullPath,
      ext: file.ext,
    }));
  const totalFiles = files.length;

  if (onProgress) onProgress({ phase: 'parsing', current: 0, total: totalFiles });

  // Symbol index: Array<{ name, filePath, type, exported, parent }>
  const symbolEntries = [];

  let parsed = 0;
  let errors = 0;

  for (const file of files) {
    try {
      const code = await readFile(file.fullPath, 'utf-8');
      const lang = await loadLanguage(file.ext);
      const parser = new _Parser();
      parser.setLanguage(lang);
      const tree = parser.parse(code);
      const { chunks } = extractChunks(tree.rootNode, code);
      tree.delete();

      // Build symbol entries
      for (const chunk of chunks) {
        if (chunk.type === 'import') continue; // Skip imports for symbol index
        symbolEntries.push({
          name: chunk.name,
          filePath: file.filePath,
          type: chunk.type,
          exported: chunk.exported || false,
          parent: chunk.parent || null,
          startByte: chunk.startByte || 0,
          endByte: chunk.endByte || 0,
        });
      }

      parsed++;
      if (onProgress && parsed % 25 === 0) {
        onProgress({ phase: 'parsing', current: parsed, total: totalFiles });
      }
    } catch (err) {
      errors++;
      console.error(`[cli-indexer] Error parsing ${file.filePath}: ${err.message}`);
    }
  }

  if (onProgress) onProgress({ phase: 'done', current: parsed, total: totalFiles });

  return {
    files: workspaceFiles.map(({ path, lineCount }) => ({ path, lineCount })),
    symbols: symbolEntries,
    stats: {
      fileCount: workspaceFiles.length,
      filesParsed: parsed,
      filesErrored: errors,
      symbolCount: symbolEntries.length,
    },
  };
}

// ── Single-file re-index (for incremental updates) ──

export async function parseWorkspaceFile(cwd, relPath) {
  await initParser();

  const workspaceIgnore = createWorkspaceIgnore(cwd);
  const relativePath = String(relPath || '').replace(/\\/g, '/').replace(/^\/+/, '');
  const cleanRelPath = `/${relativePath}`;
  if (workspaceIgnore.ignoresPath(relativePath)) return null;

  const ext = extname(cleanRelPath);
  const langName = LANGUAGE_MAP[ext];
  if (!langName) return null;

  const fullPath = join(cwd, cleanRelPath.replace(/^\//, ''));
  if (!existsSync(fullPath)) return { filePath: cleanRelPath, content: null, chunks: [] };

  const code = await readFile(fullPath, 'utf-8');
  const lang = await loadLanguage(ext);
  const parser = new _Parser();
  parser.setLanguage(lang);
  const tree = parser.parse(code);
  const { chunks } = extractChunks(tree.rootNode, code);
  tree.delete();
  return { filePath: cleanRelPath, content: code, chunks };
}

export async function reindexFile(cwd, relPath) {
  try {
    const parsed = await parseWorkspaceFile(cwd, relPath);
    if (!parsed) return null;
    if (parsed.content === null) return { filePath: parsed.filePath, symbols: [] };

    const symbolEntries = [];
    for (const chunk of parsed.chunks) {
      if (chunk.type === 'import') continue;
      symbolEntries.push({
        name: chunk.name,
        filePath: parsed.filePath,
        type: chunk.type,
        exported: chunk.exported || false,
        parent: chunk.parent || null,
        startByte: chunk.startByte || 0,
        endByte: chunk.endByte || 0,
      });
    }

    return { filePath: parsed.filePath, symbols: symbolEntries };
  } catch (err) {
    console.error(`[cli-indexer] Error re-indexing ${relPath}: ${err.message}`);
    return null;
  }
}
