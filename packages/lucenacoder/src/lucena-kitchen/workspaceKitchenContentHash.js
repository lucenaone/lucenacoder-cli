export function stableKitchenContentHash(content = '') {
  let hash = 2166136261;
  const text = String(content || '');
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `c_${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

export function kitchenByteCount(content = '') {
  return new TextEncoder().encode(String(content || '')).length;
}
