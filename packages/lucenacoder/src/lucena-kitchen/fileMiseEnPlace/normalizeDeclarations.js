import {
  buildLineStartOffsets,
  lineCountForContent,
  normalizeDeclarationRange,
  normalizeNewlines,
  splitLines,
  textForRange,
} from './lineRanges.js';

const LANGUAGE_BY_EXTENSION = new Map([
  ['js', 'javascript'],
  ['jsx', 'javascriptreact'],
  ['ts', 'typescript'],
  ['tsx', 'typescriptreact'],
  ['py', 'python'],
  ['rb', 'ruby'],
  ['go', 'go'],
  ['rs', 'rust'],
]);

export function languageForPath(path = '') {
  const extension = String(path || '').split('.').pop()?.toLowerCase() || '';
  return LANGUAGE_BY_EXTENSION.get(extension) || '';
}

function stableKitchenIdWithPrefix(prefix = 'editable_block_id', parts = []) {
  const input = parts.map((part) => String(part ?? '')).join(':');
  let hash = 2166136261;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `${prefix}_${(hash >>> 0).toString(36).padStart(6, '0').slice(-6)}`;
}

export function stableKitchenId(parts = []) {
  return stableKitchenIdWithPrefix('editable_block_id', parts);
}

export function stableKitchenCssId(parts = []) {
  return stableKitchenIdWithPrefix('editable_css_block_id', parts);
}

export function normalizeDeclarations({
  path = '',
  content = '',
  declarations = [],
} = {}) {
  const source = normalizeNewlines(content);
  const lines = splitLines(source);
  const lineStartOffsets = buildLineStartOffsets(lines);
  const totalLines = lineCountForContent(source);
  const normalized = (Array.isArray(declarations) ? declarations : [])
    .map((declaration) => normalizeDeclarationRange(declaration, lineStartOffsets, totalLines))
    .filter(Boolean)
    .map((declaration, index) => {
      const kind = normalizeKind(declaration);
      const name = declaration.fullName || declaration.name || fallbackDeclarationName(declaration, index);
      const text = declaration.text || textForRange(source, declaration.startByte, declaration.endByte);
      return {
        ...declaration,
        id: stableKitchenId([path, kind, name, declaration.startByte, declaration.endByte]),
        kind,
        name,
        text,
        exported: Boolean(declaration.exported),
        signature_or_header: signatureOrHeader(kind, text, name),
      };
    })
    .sort((left, right) => left.startByte - right.startByte || left.endByte - right.endByte);
  return mergeBareExportDeclarations(normalized, source);
}

export function declarationLane(declaration = {}) {
  if (declaration.kind === 'import') return 'import_block';
  if (declaration.kind === 'function' || declaration.kind === 'method') return 'functions';
  if (declaration.kind === 'class' || declaration.kind === 'type_block') return 'classes_or_type_blocks';
  return 'globals';
}

function normalizeKind(declaration = {}) {
  const raw = String(declaration.type || '').toLowerCase();
  if (raw === 'import') return 'import';
  if (raw === 'nested_function' || raw === 'method') return 'method';
  if (raw === 'function' || raw === 'arrow_function') return 'function';
  if (raw === 'class') return 'class';
  if (['struct', 'enum', 'trait', 'impl', 'interface', 'type'].includes(raw)) return 'type_block';
  return 'global';
}

function fallbackDeclarationName(declaration = {}, index = 0) {
  const text = String(declaration.text || '').trim();
  if (!text) return `anonymous_${index + 1}`;
  return text.split(/\s+/u).slice(0, 4).join(' ').slice(0, 80) || `anonymous_${index + 1}`;
}

function signatureOrHeader(kind = '', text = '', fallbackName = '') {
  const source = String(text || '').trim();
  const firstLine = source.split('\n').find((line) => line.trim())?.trim().replace(/\s+/gu, ' ') || '';
  if (!source) return fallbackName;

  const fn = source.match(/(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(([^)]*)\)/u);
  if (fn) return `${fn[1]}(${compactParams(fn[2])})`;

  const arrow = source.match(/(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\(([^)]*)\)|([A-Za-z_$][\w$]*))\s*=>/u);
  if (arrow) return `${arrow[1]}(${compactParams(arrow[2] || arrow[3] || '')})`;

  const py = source.match(/^def\s+([A-Za-z_]\w*)\s*\(([^)]*)\)/u);
  if (py) return `${py[1]}(${compactParams(py[2])})`;

  const cls = source.match(/^(?:export\s+)?class\s+([A-Za-z_$][\w$]*)/u);
  if (cls) return cls[1];

  if (kind === 'import') return firstLine;
  return firstLine.slice(0, 180) || fallbackName;
}

function compactParams(params = '') {
  return String(params || '').replace(/\s+/gu, ' ').trim().slice(0, 140);
}

function mergeBareExportDeclarations(declarations = [], source = '') {
  const merged = [];
  for (let index = 0; index < declarations.length; index += 1) {
    const declaration = declarations[index];
    const next = declarations[index + 1];
    if (isBareExportDeclaration(declaration) && next?.exported && declaration.startLine === next.startLine) {
      const adjusted = {
        ...next,
        id: stableKitchenId([next.id, 'export-boundary', declaration.startByte, next.endByte]),
        startByte: declaration.startByte,
        startLine: declaration.startLine,
        text: textForRange(source, declaration.startByte, next.endByte),
      };
      adjusted.signature_or_header = signatureOrHeader(adjusted.kind, adjusted.text, adjusted.name);
      merged.push(adjusted);
      index += 1;
      continue;
    }
    if (isBareExportDeclaration(declaration)) continue;
    merged.push(declaration);
  }
  return merged;
}

function isBareExportDeclaration(declaration = {}) {
  return declaration.kind === 'global'
    && declaration.exported
    && /^default_export$|^export$/u.test(String(declaration.name || ''))
    && /^export(?:\s+default)?$/u.test(String(declaration.text || '').trim());
}
