import { buildLineStartOffsets, lineCountForContent, normalizeNewlines, splitLines } from './fileMiseEnPlace/lineRanges.js';
import { stableKitchenCssId } from './fileMiseEnPlace/normalizeDeclarations.js';
import { kitchenByteCount, stableKitchenContentHash } from './workspaceKitchenContentHash.js';

const STYLE_EXTENSION_RE = /\.(css|scss|sass|less)$/iu;
const CLASS_TOKEN_RE = /\.[A-Za-z_-][A-Za-z0-9_-]*/gu;

export function isStylePath(path = '') {
  return STYLE_EXTENSION_RE.test(String(path || ''));
}

export function buildStyleFileMiseEnPlace({ path = '', content = '' } = {}) {
  const source = normalizeNewlines(content);
  const blocks = parseStyleBlocks({ path, content: source });
  const mise = {
    kind: 'lucena_kitchen.style_file_mise_en_place',
    version: 1,
    path,
    language: styleLanguageForPath(path),
    source_content_hash: stableKitchenContentHash(source),
    source_byte_count: kitchenByteCount(source),
    parse_status: blocks.length ? 'parsed' : source.trim() ? 'no_style_blocks_detected' : 'empty_file',
    line_count: lineCountForContent(source),
    import_block: { lane: 'import_block', imports: [] },
    globals: [],
    functions: [],
    classes_or_type_blocks: [],
    top_level_side_effects: [],
    style_blocks: blocks,
    unsupported_or_ambiguous_ranges: [],
  };
  return {
    ...mise,
    summary: formatStyleMiseEnPlaceSummary(mise),
  };
}

export function styleUnitsFromMiseEnPlace(mise = {}) {
  return Array.isArray(mise.style_blocks) ? mise.style_blocks.filter((unit) => unit?.id) : [];
}

function parseStyleBlocks({ path = '', content = '' } = {}) {
  const lines = splitLines(content);
  const lineStartOffsets = buildLineStartOffsets(lines);
  const blocks = [];
  scanStyleBlocks(content, {
    path,
    blocks,
    media: '',
    offset: 0,
    lineStartOffsets,
    totalLines: lineCountForContent(content),
  });
  return blocks;
}

function scanStyleBlocks(text = '', { path = '', blocks, media = '', offset = 0, lineStartOffsets = [], totalLines = 1 } = {}) {
  let index = 0;
  while (index < text.length) {
    const open = text.indexOf('{', index);
    if (open < 0) break;
    const close = matchingBraceIndex(text, open);
    if (close < 0) break;
    const rawHead = text.slice(index, open);
    const prelude = cleanStylePrelude(rawHead);
    const body = text.slice(open + 1, close).trim();
    const absoluteStart = offset + firstNonWhitespaceOffset(rawHead, index);
    const absoluteEnd = offset + close + 1;
    if (prelude.startsWith('@media')) {
      scanStyleBlocks(text.slice(open + 1, close), {
        path,
        blocks,
        media: prelude,
        offset: offset + open + 1,
        lineStartOffsets,
        totalLines,
      });
    } else if (prelude && !prelude.startsWith('@')) {
      const selectors = selectorsFromPrelude(prelude);
      const textForBlock = text.slice(absoluteStart - offset, close + 1);
      blocks.push({
        id: stableKitchenCssId([path, 'style_blocks', prelude, absoluteStart, absoluteEnd]),
        lane: 'style_blocks',
        kind: media ? 'responsive_style_block' : 'style_block',
        name: prelude,
        source: media || '',
        imported_symbols: [],
        exported: false,
        start_byte: absoluteStart,
        end_byte: absoluteEnd,
        start_line: lineForOffset(lineStartOffsets, absoluteStart, totalLines),
        end_line: lineForOffset(lineStartOffsets, absoluteEnd, totalLines),
        text: textForBlock,
        signature_or_header: prelude,
        selectors,
        classes: unique(selectors.flatMap(selectorClasses)),
        notes: media ? [`Inside ${media}`] : [],
      });
    }
    index = close + 1;
  }
}

function formatStyleMiseEnPlaceSummary(mise = {}) {
  const lines = [
    `Style mise en place: ${mise.path || '(unknown stylesheet)'}`,
    `Language: ${mise.language || 'style'}; parse status: ${mise.parse_status || 'unknown'}; lines: ${mise.line_count || 0}`,
    '',
    'Style blocks:',
  ];
  if (mise.style_blocks?.length) {
    for (const item of mise.style_blocks) lines.push(`- L${item.start_line}-${item.end_line}: ${item.signature_or_header || item.name}`);
  } else {
    lines.push('- none detected');
  }
  return lines.join('\n');
}

function styleLanguageForPath(path = '') {
  const extension = String(path || '').split('.').pop()?.toLowerCase() || '';
  if (extension === 'scss') return 'scss';
  if (extension === 'sass') return 'sass';
  if (extension === 'less') return 'less';
  return 'css';
}

function matchingBraceIndex(text = '', openIndex = 0) {
  let depth = 0;
  for (let index = openIndex; index < text.length; index += 1) {
    const char = text[index];
    if (char === '{') depth += 1;
    if (char === '}') {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function cleanStylePrelude(value = '') {
  return String(value || '')
    .replace(/\/\*[\s\S]*?\*\//gu, '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .join(' ')
    .trim();
}

function selectorsFromPrelude(prelude = '') {
  return unique(String(prelude || '').split(',').map((selector) => selector.trim().replace(/\s+/gu, ' ')).filter(Boolean));
}

function selectorClasses(selector = '') {
  return [...String(selector || '').matchAll(CLASS_TOKEN_RE)]
    .map((match) => String(match[0] || '').replace(/^\./u, ''))
    .filter(Boolean);
}

function firstNonWhitespaceOffset(value = '', fallback = 0) {
  const match = String(value || '').match(/\S/u);
  return fallback + (match ? match.index || 0 : 0);
}

function lineForOffset(lineStartOffsets = [], offset = 0, totalLines = 1) {
  let line = 1;
  for (let index = 0; index < lineStartOffsets.length; index += 1) {
    if (lineStartOffsets[index] <= offset) line = index + 1;
    else break;
  }
  return Math.max(1, Math.min(totalLines, line));
}

function unique(values = []) {
  return [...new Set(values.map((value) => String(value || '').trim()).filter(Boolean))];
}
