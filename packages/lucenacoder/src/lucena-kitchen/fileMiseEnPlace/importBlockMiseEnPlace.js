import { byteRangeForLineRange, textForRange } from './lineRanges.js';
import { declarationLane, stableKitchenId } from './normalizeDeclarations.js';

export function buildImportBlockMiseEnPlace({
  path = '',
  content = '',
  lines = [],
  declarations = [],
} = {}) {
  const imports = declarations.filter((declaration) => declarationLane(declaration) === 'import_block');
  if (!imports.length) {
    return {
      id: stableKitchenId([path, 'import_block', 'empty']),
      lane: 'import_block',
      start_byte: null,
      end_byte: null,
      start_line: null,
      end_line: null,
      text: '',
      imports: [],
    };
  }

  const startLine = Math.min(...imports.map((item) => item.startLine));
  const endLine = Math.max(...imports.map((item) => item.endLine));
  const { startByte, endByte } = byteRangeForLineRange(lines, startLine, endLine);

  return {
    id: stableKitchenId([path, 'import_block', startByte, endByte]),
    lane: 'import_block',
    kind: 'import_block',
    name: 'import block',
    start_byte: startByte,
    end_byte: endByte,
    start_line: startLine,
    end_line: endLine,
    text: textForRange(content, startByte, endByte),
    imports: imports.map((declaration, index) => importStatementItem(path, declaration, index)),
  };
}

function importStatementItem(path = '', declaration = {}, index = 0) {
  const source = importSource(declaration.text);
  const importedSymbols = importedSymbolList(declaration.text);
  return {
    id: stableKitchenId([path, 'import_statement', index, declaration.startByte, declaration.endByte]),
    lane: 'import_block',
    kind: 'import_statement',
    name: source || declaration.name || `import_${index + 1}`,
    source,
    imported_symbols: importedSymbols,
    exported: Boolean(declaration.exported),
    start_byte: declaration.startByte,
    end_byte: declaration.endByte,
    start_line: declaration.startLine,
    end_line: declaration.endLine,
    text: declaration.text || '',
    signature_or_header: declaration.signature_or_header || '',
    notes: [],
  };
}

function importSource(text = '') {
  const source = String(text || '').match(/\bfrom\s+['"]([^'"]+)['"]/u)?.[1]
    || String(text || '').match(/^\s*import\s+['"]([^'"]+)['"]/u)?.[1]
    || String(text || '').match(/\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/u)?.[1]
    || '';
  return source;
}

function importedSymbolList(text = '') {
  const source = String(text || '').replace(/\s+/gu, ' ').trim();
  const named = source.match(/\{([^}]+)\}/u)?.[1];
  const symbols = [];
  if (named) {
    symbols.push(...named.split(',').map((item) => item.trim()).filter(Boolean));
  }
  const defaultImport = source.match(/^import\s+([A-Za-z_$][\w$]*)\s*(?:,|\s+from)/u)?.[1];
  if (defaultImport) symbols.unshift(defaultImport);
  const namespaceImport = source.match(/\*\s+as\s+([A-Za-z_$][\w$]*)/u)?.[1];
  if (namespaceImport) symbols.push(`* as ${namespaceImport}`);
  return [...new Set(symbols)];
}
