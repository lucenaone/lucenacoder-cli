export function normalizeNewlines(content = '') {
  return String(content ?? '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

export function splitLines(content = '') {
  return normalizeNewlines(content).split('\n');
}

export function lineCountForContent(content = '') {
  const lines = splitLines(content);
  return lines.length === 1 && lines[0] === '' ? 0 : lines.length;
}

export function buildLineStartOffsets(lines = []) {
  const offsets = [];
  let offset = 0;
  for (const line of lines) {
    offsets.push(offset);
    offset += String(line || '').length + 1;
  }
  return offsets;
}

export function lineIndexForOffset(lineStartOffsets = [], offset = 0) {
  let low = 0;
  let high = lineStartOffsets.length - 1;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    if (lineStartOffsets[mid] <= offset) low = mid + 1;
    else high = mid - 1;
  }
  return Math.max(0, high);
}

export function normalizeDeclarationRange(declaration = {}, lineStartOffsets = [], totalLines = 0) {
  const startByte = Number(declaration.startByte);
  const endByte = Number(declaration.endByte);
  if (!Number.isFinite(startByte) || !Number.isFinite(endByte) || endByte <= startByte) return null;
  const endOffset = Math.max(startByte, endByte - 1);
  return {
    ...declaration,
    startByte,
    endByte,
    startLine: lineIndexForOffset(lineStartOffsets, startByte) + 1,
    endLine: Math.min(totalLines, lineIndexForOffset(lineStartOffsets, endOffset) + 1),
  };
}

export function textForRange(content = '', startByte = 0, endByte = 0) {
  const normalized = normalizeNewlines(content);
  return normalized.slice(Math.max(0, startByte), Math.max(0, endByte));
}

export function trimLineRange(lines = [], startLine = 1, endLine = lines.length) {
  let start = Math.max(1, startLine);
  let end = Math.min(lines.length, endLine);
  while (start <= end && !String(lines[start - 1] || '').trim()) start += 1;
  while (end >= start && !String(lines[end - 1] || '').trim()) end -= 1;
  return end >= start ? { startLine: start, endLine: end } : null;
}

export function byteRangeForLineRange(lines = [], startLine = 1, endLine = startLine) {
  const startIndex = Math.max(0, startLine - 1);
  const endIndex = Math.max(startIndex, Math.min(lines.length, endLine));
  let startByte = 0;
  for (let index = 0; index < startIndex; index += 1) {
    startByte += String(lines[index] || '').length + 1;
  }
  let endByte = startByte;
  for (let index = startIndex; index < endIndex; index += 1) {
    endByte += String(lines[index] || '').length;
    if (index < endIndex - 1) endByte += 1;
  }
  return { startByte, endByte };
}
