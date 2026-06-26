import { declarationLane, stableKitchenId } from './normalizeDeclarations.js';

export function buildGlobalsMiseEnPlace({ path = '', declarations = [] } = {}) {
  return declarations
    .filter((declaration) => declarationLane(declaration) === 'globals')
    .map((declaration, index) => ({
      id: declaration.id || stableKitchenId([path, 'global', index, declaration.startByte, declaration.endByte]),
      lane: 'globals',
      kind: declaration.kind || 'global',
      name: declaration.name || `global_${index + 1}`,
      exported: Boolean(declaration.exported),
      start_byte: declaration.startByte,
      end_byte: declaration.endByte,
      start_line: declaration.startLine,
      end_line: declaration.endLine,
      text: declaration.text || '',
      signature_or_header: declaration.signature_or_header || declaration.name || '',
      notes: [],
    }));
}
