import { buildClassOrTypeBlocksMiseEnPlace, buildFunctionMiseEnPlace } from './functionMiseEnPlace.js';
import { buildGlobalsMiseEnPlace } from './globalsMiseEnPlace.js';
import { buildImportBlockMiseEnPlace } from './importBlockMiseEnPlace.js';
import { lineCountForContent, normalizeNewlines, splitLines } from './lineRanges.js';
import { languageForPath, normalizeDeclarations } from './normalizeDeclarations.js';
import { searchFileMiseEnPlace } from './searchFileMiseEnPlace.js';
import { kitchenByteCount, stableKitchenContentHash } from '../workspaceKitchenContentHash.js';

const FULL_FILE_BLOCK_MAX_LINES = 600;
const PAGED_FILE_BLOCK_LINES = 400;

export function buildFileMiseEnPlace({
  path = '',
  content = '',
  declarations = [],
} = {}) {
  const source = normalizeNewlines(content);
  const language = languageForPath(path);
  const lines = splitLines(source);
  const normalizedDeclarations = normalizeDeclarations({ path, content: source, declarations });
  const importBlock = buildImportBlockMiseEnPlace({
    path,
    content: source,
    lines,
    declarations: normalizedDeclarations,
  });
  const globals = buildGlobalsMiseEnPlace({ path, declarations: normalizedDeclarations });
  const functions = buildFunctionMiseEnPlace({ path, declarations: normalizedDeclarations });
  const classesOrTypeBlocks = buildClassOrTypeBlocksMiseEnPlace({ path, declarations: normalizedDeclarations });
  const unsupportedOrAmbiguousRanges = unsupportedRanges({
    path,
    language,
    declarations: normalizedDeclarations,
    content: source,
  });

  const mise = {
    kind: 'lucena_kitchen.file_mise_en_place',
    version: 1,
    path,
    language,
    source_content_hash: stableKitchenContentHash(source),
    source_byte_count: kitchenByteCount(source),
    parse_status: parseStatus({ language, declarations: normalizedDeclarations }),
    line_count: lineCountForContent(source),
    import_block: importBlock,
    globals,
    functions,
    classes_or_type_blocks: classesOrTypeBlocks,
    top_level_side_effects: [],
    unsupported_or_ambiguous_ranges: unsupportedOrAmbiguousRanges,
  };

  return {
    ...mise,
    summary: formatFileMiseEnPlaceSummary(mise),
  };
}

export { searchFileMiseEnPlace };

export function formatFileMiseEnPlaceSummary(mise = {}) {
  const lines = [
    `File mise en place: ${mise.path || '(unknown file)'}`,
    `Language: ${mise.language || 'unsupported'}; parse status: ${mise.parse_status || 'unknown'}; lines: ${mise.line_count || 0}`,
    '',
    'Imports:',
  ];

  const imports = mise.import_block?.imports || [];
  if (imports.length) {
    for (const item of imports) {
      const symbols = item.imported_symbols?.length ? ` { ${item.imported_symbols.join(', ')} }` : '';
      lines.push(`- L${item.start_line}-${item.end_line}: ${item.source || item.name}${symbols}`);
    }
  } else {
    lines.push('- none detected');
  }

  lines.push('', 'Globals:');
  if (mise.globals?.length) {
    for (const item of mise.globals) lines.push(`- L${item.start_line}-${item.end_line}: ${item.signature_or_header || item.name}`);
  } else {
    lines.push('- none detected');
  }

  lines.push('', 'Functions:');
  if (mise.functions?.length) {
    for (const item of mise.functions) lines.push(`- L${item.start_line}-${item.end_line}: ${item.signature_or_header || item.name}`);
  } else {
    lines.push('- none detected');
  }

  if (mise.classes_or_type_blocks?.length) {
    lines.push('', 'Class/type blocks:');
    for (const item of mise.classes_or_type_blocks) lines.push(`- L${item.start_line}-${item.end_line}: ${item.signature_or_header || item.name} (${item.kind})`);
  }

  if (mise.unsupported_or_ambiguous_ranges?.length) {
    lines.push('', 'Unsupported or ambiguous:');
    for (const item of mise.unsupported_or_ambiguous_ranges) lines.push(`- ${item.notes?.[0] || item.name || item.kind}`);
  }

  return lines.join('\n');
}

function parseStatus({ language = '', declarations = [] } = {}) {
  if (!language) return 'unsupported_language';
  if (!declarations.length) return 'no_declarations_detected';
  return 'parsed';
}

function unsupportedRanges({ path = '', language = '', declarations = [], content = '' } = {}) {
  const source = normalizeNewlines(content);
  const totalLines = lineCountForContent(source);
  if (!language) {
    return coarseTextBlocks({
      path,
      content: source,
      kind: 'unsupported_language',
      note: 'Kitchen file mise en place does not have parser support for this file extension yet.',
      totalLines,
    });
  }
  if (!declarations.length && source.trim()) {
    return coarseTextBlocks({
      path,
      content: source,
      kind: 'no_declarations_detected',
      note: 'Parser returned no top-level imports, globals, functions, or class/type blocks for this file.',
      totalLines,
    });
  }
  return [];
}

function coarseTextBlocks({
  path = '',
  content = '',
  kind = '',
  note = '',
  totalLines = 0,
} = {}) {
  if (!content.trim()) return [];
  const lines = splitLines(content);
  const completeFile = totalLines <= FULL_FILE_BLOCK_MAX_LINES;
  if (completeFile) {
    return [coarseTextBlock({
      path,
      kind,
      note,
      text: content,
      startLine: 1,
      endLine: totalLines,
      totalLines,
      completeFile: true,
      nextStartLine: null,
    })];
  }
  const blocks = [];
  for (let startLine = 1; startLine <= totalLines; startLine += PAGED_FILE_BLOCK_LINES) {
    const endLine = Math.min(startLine + PAGED_FILE_BLOCK_LINES - 1, totalLines);
    blocks.push(coarseTextBlock({
      path,
      kind,
      note,
      text: lines.slice(startLine - 1, endLine).join('\n'),
      startLine,
      endLine,
      totalLines,
      completeFile: false,
      nextStartLine: endLine >= totalLines ? null : endLine + 1,
    }));
  }
  return blocks;
}

function coarseTextBlock({
  path = '',
  kind = '',
  note = '',
  text = '',
  startLine = 1,
  endLine = 1,
  totalLines = 0,
  completeFile = false,
  nextStartLine = null,
} = {}) {
  return {
    id: `coarse:${path}:${startLine}-${endLine}`,
    lane: 'unsupported_or_ambiguous_ranges',
    kind,
    name: completeFile ? path : `${path} lines ${startLine}-${endLine}`,
    exported: false,
    start_byte: null,
    end_byte: text.length,
    start_line: startLine,
    end_line: endLine,
    text,
    signature_or_header: completeFile
      ? `Full file: ${path}`
      : `File chunk: ${path} L${startLine}-${endLine}`,
    complete_file: completeFile,
    total_lines: totalLines,
    next_start_line: nextStartLine || null,
    notes: [
      note,
      completeFile
        ? `Entire editable text file returned because it is ${totalLines} lines, within the ${FULL_FILE_BLOCK_MAX_LINES}-line Kitchen full-file limit.`
        : nextStartLine
          ? `Lines ${startLine}-${endLine} returned from ${totalLines}-line editable text file. Continue at line ${nextStartLine}.`
          : `Lines ${startLine}-${endLine} returned from ${totalLines}-line editable text file. This is the final chunk.`,
    ],
  };
}
