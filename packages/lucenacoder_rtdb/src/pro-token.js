import { mkdir, readFile, writeFile } from 'fs/promises';
import { dirname, join } from 'path';
import { homedir } from 'os';

const TOKEN_PATH = join(homedir(), '.lucenacoder', 'pro.json');
const VALIDATE_URL = process.env.LUCENA_VALIDATE_PRO_URL || 'https://lucenacoder.com/api/pro/validate-token';
const REGISTER_TUNNEL_URL = process.env.LUCENA_REGISTER_TUNNEL_URL || 'https://lucenacoder.com/api/remote/register-tunnel';
const PRO_FETCH_TIMEOUT_MS = 4_000;

async function fetchWithTimeout(url, options = {}, timeoutMs = PRO_FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

export async function readStoredProToken() {
  try {
    const raw = await readFile(TOKEN_PATH, 'utf-8');
    const data = JSON.parse(raw);
    if (!data?.tokenForPro) return null;
    return data;
  } catch {
    return null;
  }
}

export async function storeProToken({ tokenForPro, email }) {
  if (!tokenForPro) return null;
  const data = {
    tokenForPro,
    email: email || '',
    savedAt: new Date().toISOString(),
  };
  await mkdir(dirname(TOKEN_PATH), { recursive: true });
  await writeFile(TOKEN_PATH, JSON.stringify(data, null, 2), 'utf-8');
  return data;
}

export async function validateStoredProToken() {
  const stored = await readStoredProToken();
  if (!stored?.tokenForPro) return { valid: false };

  try {
    const response = await fetchWithTimeout(VALIDATE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tokenForPro: stored.tokenForPro }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || !payload.valid) return { valid: false, stored };
    return { valid: true, stored, ...payload };
  } catch {
    return { valid: false, stored };
  }
}

export async function registerProTunnel({ tokenForPro, tunnelId, cwdName, platform, pid, source = 'local-npx', status = 'active', online = true }) {
  if (!tokenForPro || !tunnelId) return { ok: false };

  try {
    const response = await fetchWithTimeout(REGISTER_TUNNEL_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tokenForPro,
        tunnelId,
        cwdName,
        displayName: cwdName,
        platform,
        pid,
        source,
        status,
        online,
      }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) return { ok: false, ...payload };
    return { ok: true, ...payload };
  } catch {
    return { ok: false };
  }
}
