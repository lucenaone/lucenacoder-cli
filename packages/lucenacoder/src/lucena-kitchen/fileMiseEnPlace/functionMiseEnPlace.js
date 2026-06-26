import { declarationLane, stableKitchenId } from './normalizeDeclarations.js';

export function buildFunctionMiseEnPlace({ path = '', declarations = [] } = {}) {
  return declarations
    .filter((declaration) => declarationLane(declaration) === 'functions')
    .map((declaration, index) => ({
      id: declaration.id || stableKitchenId([path, 'function', index, declaration.startByte, declaration.endByte]),
      lane: 'functions',
      kind: declaration.kind || 'function',
      name: declaration.name || `function_${index + 1}`,
      parent: declaration.parent || null,
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

export function buildClassOrTypeBlocksMiseEnPlace({ path = '', declarations = [] } = {}) {
  return declarations
    .filter((declaration) => declarationLane(declaration) === 'classes_or_type_blocks')
    .map((declaration, index) => ({
      id: declaration.id || stableKitchenId([path, 'class_or_type', index, declaration.startByte, declaration.endByte]),
      lane: 'classes_or_type_blocks',
      kind: declaration.kind || 'class',
      name: declaration.name || `class_or_type_${index + 1}`,
      exported: Boolean(declaration.exported),
      start_byte: declaration.startByte,
      end_byte: declaration.endByte,
      start_line: declaration.startLine,
      end_line: declaration.endLine,
      text: declaration.text || '',
      signature_or_header: declaration.signature_or_header || declaration.name || '',
      notes: ['Class-like/type-like declaration is preserved as a declaration boundary until Kitchen supports safer inner-unit replacement for this language.'],
    }));
}
