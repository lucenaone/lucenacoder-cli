export const WORKSPACE_KITCHEN_DB_FILE = '/.WorkspaceBrain/workspace-kitchen.sqlite';
export const WORKSPACE_KITCHEN_SCHEMA_VERSION = 3;

export function createWorkspaceKitchenDatabase(SQL, bytes = null) {
  if (!SQL?.Database) throw new Error('createWorkspaceKitchenDatabase requires sql.js SQL module.');
  const db = bytes?.length ? new SQL.Database(bytes) : new SQL.Database();
  try {
    ensureWorkspaceKitchenSchema(db);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

export function ensureWorkspaceKitchenSchema(db) {
  db.run(`
    PRAGMA user_version = ${WORKSPACE_KITCHEN_SCHEMA_VERSION};
    CREATE TABLE IF NOT EXISTS kitchen_meta (
      key TEXT PRIMARY KEY,
      value_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS kitchen_source_files (
      path TEXT PRIMARY KEY,
      content_sha256 TEXT NOT NULL,
      content_fingerprint TEXT NOT NULL DEFAULT '',
      language TEXT NOT NULL DEFAULT '',
      parse_status TEXT NOT NULL DEFAULT '',
      line_count INTEGER NOT NULL DEFAULT 0,
      byte_count INTEGER NOT NULL DEFAULT 0,
      summary TEXT NOT NULL DEFAULT '',
      mise_json TEXT NOT NULL DEFAULT '{}',
      indexed_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS kitchen_units (
      id TEXT PRIMARY KEY,
      file_path TEXT NOT NULL,
      lane TEXT NOT NULL,
      kind TEXT NOT NULL,
      name TEXT NOT NULL DEFAULT '',
      source TEXT NOT NULL DEFAULT '',
      imported_symbols_json TEXT NOT NULL DEFAULT '[]',
      exported INTEGER NOT NULL DEFAULT 0,
      start_byte INTEGER,
      end_byte INTEGER,
      start_line INTEGER,
      end_line INTEGER,
      signature_or_header TEXT NOT NULL DEFAULT '',
      text TEXT NOT NULL DEFAULT '',
      complete_file INTEGER NOT NULL DEFAULT 0,
      total_lines INTEGER,
      next_start_line INTEGER,
      notes_json TEXT NOT NULL DEFAULT '[]',
      search_text TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL,
      FOREIGN KEY(file_path) REFERENCES kitchen_source_files(path) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_kitchen_units_file_lane ON kitchen_units(file_path, lane);
    CREATE INDEX IF NOT EXISTS idx_kitchen_units_lane_name ON kitchen_units(lane, name);
    CREATE TABLE IF NOT EXISTS kitchen_unit_search (
      unit_id TEXT PRIMARY KEY,
      file_path TEXT NOT NULL,
      lane TEXT NOT NULL,
      kind TEXT NOT NULL,
      name TEXT NOT NULL DEFAULT '',
      source TEXT NOT NULL DEFAULT '',
      imported_symbols TEXT NOT NULL DEFAULT '',
      signature_or_header TEXT NOT NULL DEFAULT '',
      text TEXT NOT NULL DEFAULT '',
      search_text TEXT NOT NULL DEFAULT '',
      FOREIGN KEY(unit_id) REFERENCES kitchen_units(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_kitchen_unit_search_file ON kitchen_unit_search(file_path);
    CREATE INDEX IF NOT EXISTS idx_kitchen_unit_search_lane ON kitchen_unit_search(lane);
  `);
  ensureKitchenColumn(db, 'kitchen_source_files', 'content_fingerprint', "TEXT NOT NULL DEFAULT ''");
  ensureKitchenColumn(db, 'kitchen_source_files', 'byte_count', 'INTEGER NOT NULL DEFAULT 0');
  ensureKitchenColumn(db, 'kitchen_units', 'complete_file', 'INTEGER NOT NULL DEFAULT 0');
  ensureKitchenColumn(db, 'kitchen_units', 'total_lines', 'INTEGER');
  ensureKitchenColumn(db, 'kitchen_units', 'next_start_line', 'INTEGER');
  writeKitchenMeta(db, 'schema', {
    version: WORKSPACE_KITCHEN_SCHEMA_VERSION,
    source: 'lucena_kitchen',
  });
}

export function upsertFileMiseEnPlace(db, {
  mise,
  contentSha256 = '',
  contentFingerprint = '',
  byteCount = null,
  indexedAt = new Date().toISOString(),
} = {}) {
  if (!mise?.path) throw new Error('upsertFileMiseEnPlace requires mise.path.');
  const existing = getKitchenSourceFileFingerprint(db, mise.path);
  const nextSha = contentSha256 || '';
  const nextFingerprint = contentFingerprint || nextSha;
  if (existing && existing.contentSha256 === nextSha && existing.contentFingerprint === nextFingerprint) {
    return { changed: false, reason: 'fresh' };
  }
  db.run('BEGIN');
  try {
    db.run(
      `INSERT OR REPLACE INTO kitchen_source_files
       (path, content_sha256, content_fingerprint, language, parse_status, line_count, byte_count, summary, mise_json, indexed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        mise.path,
        nextSha,
        nextFingerprint,
        mise.language || '',
        mise.parse_status || '',
        Number(mise.line_count) || 0,
        Number(byteCount) || byteCountFromMise(mise),
        mise.summary || '',
        json(mise),
        indexedAt,
      ],
    );
    db.run('DELETE FROM kitchen_units WHERE file_path = ?', [mise.path]);
    db.run('DELETE FROM kitchen_unit_search WHERE file_path = ?', [mise.path]);

    for (const unit of unitsFromFileMiseEnPlace(mise)) {
      writeKitchenUnit(db, mise.path, unit, indexedAt);
    }
    db.run('COMMIT');
    return { changed: true, reason: existing ? 'updated' : 'created' };
  } catch (error) {
    db.run('ROLLBACK');
    throw error;
  }
}

export function getKitchenFileMiseEnPlace(db, path = '') {
  const row = selectRows(db, 'SELECT * FROM kitchen_source_files WHERE path = ? LIMIT 1', [path])[0];
  if (!row) return null;
  return kitchenFileMiseEnPlaceFromRow(db, row);
}

export function getKitchenFileMiseEnPlaceByPathSuffix(db, path = '') {
  const suffixes = candidateKitchenPathSuffixes(path);
  for (const suffix of suffixes) {
    const rows = selectRows(
      db,
      'SELECT * FROM kitchen_source_files WHERE path = ? OR path LIKE ? ORDER BY LENGTH(path) ASC LIMIT 2',
      [suffix, `%/${suffix}`],
    );
    if (rows.length === 1) return kitchenFileMiseEnPlaceFromRow(db, rows[0]);
  }
  return null;
}

function kitchenFileMiseEnPlaceFromRow(db, row = {}) {
  return {
    path: row.path,
    contentSha256: row.content_sha256,
    contentFingerprint: row.content_fingerprint,
    language: row.language,
    parseStatus: row.parse_status,
    lineCount: row.line_count,
    byteCount: row.byte_count,
    summary: row.summary,
    indexedAt: row.indexed_at,
    mise: parseJson(row.mise_json, null),
    units: getKitchenUnitsForFile(db, row.path),
  };
}

function candidateKitchenPathSuffixes(path = '') {
  const normalized = String(path || '').trim().replace(/\\/gu, '/').replace(/^\/+/u, '');
  if (!normalized) return [];
  const parts = normalized.split('/').filter(Boolean);
  const suffixes = [];
  for (let count = Math.min(parts.length, 4); count >= 1; count -= 1) {
    const suffix = parts.slice(-count).join('/');
    if (suffix && !suffixes.includes(suffix)) suffixes.push(suffix);
  }
  return suffixes;
}

export function removeKitchenFileMiseEnPlace(db, path = '') {
  const cleanPath = String(path || '').trim();
  if (!cleanPath) return false;
  db.run('BEGIN');
  try {
    db.run('DELETE FROM kitchen_unit_search WHERE file_path = ?', [cleanPath]);
    let changed = db.getRowsModified() > 0;
    db.run('DELETE FROM kitchen_units WHERE file_path = ?', [cleanPath]);
    changed = db.getRowsModified() > 0 || changed;
    db.run('DELETE FROM kitchen_source_files WHERE path = ?', [cleanPath]);
    changed = db.getRowsModified() > 0 || changed;
    db.run('COMMIT');
    return changed;
  } catch (error) {
    db.run('ROLLBACK');
    throw error;
  }
}

export function removeKitchenPathPrefix(db, path = '') {
  const cleanPath = String(path || '').trim().replace(/\/+$/u, '') || '/';
  if (!cleanPath || cleanPath === '/') return pruneKitchenToManifest(db, []);
  const stale = selectRows(
    db,
    'SELECT path FROM kitchen_source_files WHERE path = ? OR path LIKE ? ORDER BY path',
    [cleanPath, `${cleanPath}/%`],
  ).map((row) => row.path);
  if (!stale.length) return { removed: 0, paths: [] };

  db.run('BEGIN');
  try {
    for (const stalePath of stale) {
      db.run('DELETE FROM kitchen_unit_search WHERE file_path = ?', [stalePath]);
      db.run('DELETE FROM kitchen_units WHERE file_path = ?', [stalePath]);
      db.run('DELETE FROM kitchen_source_files WHERE path = ?', [stalePath]);
    }
    db.run('COMMIT');
    return { removed: stale.length, paths: stale };
  } catch (error) {
    db.run('ROLLBACK');
    throw error;
  }
}

export function pruneKitchenToManifest(db, paths = []) {
  const allowed = new Set((paths || []).map((path) => String(path || '').trim()).filter(Boolean));
  const existing = selectRows(db, 'SELECT path FROM kitchen_source_files ORDER BY path');
  const stale = existing.map((row) => row.path).filter((path) => !allowed.has(path));
  if (!stale.length) return { removed: 0, paths: [] };

  db.run('BEGIN');
  try {
    for (const path of stale) {
      db.run('DELETE FROM kitchen_unit_search WHERE file_path = ?', [path]);
      db.run('DELETE FROM kitchen_units WHERE file_path = ?', [path]);
      db.run('DELETE FROM kitchen_source_files WHERE path = ?', [path]);
    }
    db.run('COMMIT');
    return { removed: stale.length, paths: stale };
  } catch (error) {
    db.run('ROLLBACK');
    throw error;
  }
}

export function getKitchenSourceFileFingerprint(db, path = '') {
  const cleanPath = String(path || '').trim();
  if (!cleanPath) return null;
  const row = selectRows(
    db,
    'SELECT content_sha256, content_fingerprint, indexed_at FROM kitchen_source_files WHERE path = ? LIMIT 1',
    [cleanPath],
  )[0];
  if (!row) return null;
  return {
    contentSha256: row.content_sha256 || '',
    contentFingerprint: row.content_fingerprint || row.content_sha256 || '',
    indexedAt: row.indexed_at || '',
  };
}

export function getKitchenUnitsForFile(db, path = '') {
  return selectRows(
    db,
    'SELECT * FROM kitchen_units WHERE file_path = ? ORDER BY COALESCE(start_line, 999999), lane, name',
    [path],
  ).map(unitFromRow);
}

export function searchWorkspaceKitchen(db, query = '', options = {}) {
  const text = String(query || '').trim();
  if (!text) return [];
  const limit = Math.max(1, Math.min(100, Number(options.limit) || 20));
  const lane = String(options.lane || '').trim();
  return fallbackKitchenSearch(db, text, { lane, limit });
}

export function kitchenStats(db) {
  const files = selectRows(db, 'SELECT COUNT(*) AS count FROM kitchen_source_files')[0]?.count || 0;
  const units = selectRows(db, 'SELECT COUNT(*) AS count FROM kitchen_units')[0]?.count || 0;
  const byLane = selectRows(db, 'SELECT lane, COUNT(*) AS count FROM kitchen_units GROUP BY lane ORDER BY lane')
    .map((row) => ({ lane: row.lane, count: row.count }));
  return { files, units, byLane };
}

function writeKitchenMeta(db, key = '', value = {}) {
  db.run(
    'INSERT OR REPLACE INTO kitchen_meta (key, value_json, updated_at) VALUES (?, ?, ?)',
    [key, json(value), new Date().toISOString()],
  );
}

function ensureKitchenColumn(db, tableName = '', columnName = '', definition = '') {
  const columns = selectRows(db, `PRAGMA table_info(${tableName})`);
  if (columns.some((column) => column.name === columnName)) return;
  db.run(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`);
}

function writeKitchenUnit(db, filePath = '', unit = {}, updatedAt = '') {
  const importedSymbols = Array.isArray(unit.imported_symbols) ? unit.imported_symbols : [];
  const notes = Array.isArray(unit.notes) ? unit.notes : [];
  const searchText = unitSearchText(unit);
  const row = [
    unit.id,
    filePath,
    unit.lane || '',
    unit.kind || '',
    unit.name || '',
    unit.source || '',
    json(importedSymbols),
    unit.exported ? 1 : 0,
    nullableNumber(unit.start_byte),
    nullableNumber(unit.end_byte),
    nullableNumber(unit.start_line),
    nullableNumber(unit.end_line),
    unit.signature_or_header || '',
    unit.text || '',
    unit.complete_file ? 1 : 0,
    nullableNumber(unit.total_lines),
    nullableNumber(unit.next_start_line),
    json(notes),
    searchText,
    updatedAt,
  ];
  db.run(
    `INSERT OR REPLACE INTO kitchen_units
     (id, file_path, lane, kind, name, source, imported_symbols_json, exported, start_byte, end_byte, start_line, end_line, signature_or_header, text, complete_file, total_lines, next_start_line, notes_json, search_text, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    row,
  );
  db.run(
    `INSERT OR REPLACE INTO kitchen_unit_search
     (unit_id, file_path, lane, kind, name, source, imported_symbols, signature_or_header, text, search_text)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      unit.id,
      filePath,
      unit.lane || '',
      unit.kind || '',
      unit.name || '',
      unit.source || '',
      importedSymbols.join(' '),
      unit.signature_or_header || '',
      unit.text || '',
      searchText,
    ],
  );
}

export function unitsFromFileMiseEnPlace(mise = {}) {
  return [
    ...(mise.import_block?.imports || []),
    ...(mise.globals || []),
    ...(mise.functions || []),
    ...(mise.classes_or_type_blocks || []),
    ...(mise.style_blocks || []),
    ...(mise.top_level_side_effects || []),
    ...(mise.unsupported_or_ambiguous_ranges || []),
  ].filter((unit) => unit?.id);
}

function unitSearchText(unit = {}) {
  return [
    unit.lane,
    unit.kind,
    unit.name,
    unit.source,
    ...(unit.imported_symbols || []),
    unit.signature_or_header,
    ...(unit.notes || []),
    unit.text,
  ].filter(Boolean).join('\n');
}

function unitFromRow(row = {}) {
  return {
    id: row.id,
    file_path: row.file_path,
    lane: row.lane,
    kind: row.kind,
    name: row.name,
    source: row.source,
    imported_symbols: parseJson(row.imported_symbols_json, []),
    exported: Boolean(row.exported),
    start_byte: nullableRowNumber(row.start_byte),
    end_byte: nullableRowNumber(row.end_byte),
    start_line: nullableRowNumber(row.start_line),
    end_line: nullableRowNumber(row.end_line),
    signature_or_header: row.signature_or_header,
    text: row.text,
    complete_file: Boolean(row.complete_file),
    total_lines: nullableRowNumber(row.total_lines),
    next_start_line: nullableRowNumber(row.next_start_line),
    notes: parseJson(row.notes_json, []),
    search_text: row.search_text,
    updated_at: row.updated_at,
  };
}

function fallbackKitchenSearch(db, query = '', { lane = '', limit = 20 } = {}) {
  const tokens = tokenizeSearch(query);
  const rows = selectRows(db, [
    'SELECT ku.*, kus.imported_symbols AS imported_symbols_search',
    'FROM kitchen_units ku',
    'JOIN kitchen_unit_search kus ON kus.unit_id = ku.id',
    lane ? 'WHERE ku.lane = ?' : '',
  ].filter(Boolean).join(' '), lane ? [lane] : []);
  return rows
    .map((row) => ({ row, score: fallbackScore(row, tokens) }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score || String(left.row.file_path).localeCompare(String(right.row.file_path)))
    .slice(0, limit)
    .map(({ row, score }) => ({ ...unitFromRow(row), rank: -score }));
}

function fallbackScore(row = {}, tokens = []) {
  let score = 0;
  const fields = [
    [row.name, 14],
    [row.signature_or_header, 10],
    [row.source, 8],
    [row.imported_symbols_search || row.imported_symbols_json, 7],
    [row.lane, 3],
    [row.kind, 3],
    [row.text, 2],
    [row.search_text, 1],
  ];
  for (const token of tokens) {
    for (const [value, weight] of fields) {
      if (String(value || '').toLowerCase().includes(token)) score += weight;
    }
  }
  return score > 0 ? score + laneSearchBias(row.lane) : 0;
}

function laneSearchBias(lane = '') {
  if (lane === 'functions') return 18;
  if (lane === 'classes_or_type_blocks') return 14;
  if (lane === 'style_blocks') return 12;
  if (lane === 'globals') return 4;
  return 0;
}

function tokenizeSearch(value = '') {
  return String(value || '')
    .split(/[^A-Za-z0-9_$@./-]+/u)
    .map((token) => token.trim())
    .filter(Boolean)
    .map((token) => token.toLowerCase())
    .slice(0, 12);
}

function selectRows(db, sql, params = []) {
  const stmt = db.prepare(sql);
  try {
    stmt.bind(params);
    const rows = [];
    while (stmt.step()) rows.push(stmt.getAsObject());
    return rows;
  } finally {
    stmt.free();
  }
}

function json(value) {
  return JSON.stringify(value ?? null);
}

function parseJson(value, fallback) {
  try {
    return value ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
}

function nullableNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function nullableRowNumber(value) {
  if (value == null) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function byteCountFromMise(mise = {}) {
  const text = [
    mise.summary || '',
    ...(unitsFromFileMiseEnPlace(mise).map((unit) => unit.text || unit.signature_or_header || unit.name || '')),
  ].join('\n');
  return new TextEncoder().encode(text).length;
}
