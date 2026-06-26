export function searchFileMiseEnPlace(mise = {}, query = '', options = {}) {
  const tokens = searchTokens(query);
  if (!tokens.length) return [];
  const limit = Math.max(1, Math.min(50, Number(options.limit) || 12));
  const candidates = [
    ...(mise.import_block?.imports || []),
    ...(mise.globals || []),
    ...(mise.functions || []),
    ...(mise.classes_or_type_blocks || []),
    ...(mise.top_level_side_effects || []),
    ...(mise.unsupported_or_ambiguous_ranges || []),
  ];
  return candidates
    .map((item) => ({ item, score: scoreItem(item, tokens) }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score || (left.item.start_line || 0) - (right.item.start_line || 0))
    .slice(0, limit)
    .map(({ item, score }) => ({
      id: item.id,
      lane: item.lane,
      kind: item.kind,
      name: item.name,
      score,
      start_line: item.start_line,
      end_line: item.end_line,
      signature_or_header: item.signature_or_header,
    }));
}

function scoreItem(item = {}, tokens = []) {
  const name = searchable(item.name);
  const header = searchable(item.signature_or_header);
  const source = searchable(item.source);
  const symbols = searchable((item.imported_symbols || []).join(' '));
  const text = searchable(item.text);
  let score = 0;
  for (const token of tokens) {
    if (name.includes(token)) score += 12;
    if (header.includes(token)) score += 8;
    if (source.includes(token)) score += 8;
    if (symbols.includes(token)) score += 6;
    if (text.includes(token)) score += 2;
  }
  return score;
}

function searchTokens(value = '') {
  return String(value || '')
    .replace(/([a-z0-9])([A-Z])/gu, '$1 $2')
    .split(/[^A-Za-z0-9_$@./-]+/u)
    .map((token) => token.trim().toLowerCase())
    .filter((token) => token.length >= 2);
}

function searchable(value = '') {
  return String(value || '').toLowerCase();
}
