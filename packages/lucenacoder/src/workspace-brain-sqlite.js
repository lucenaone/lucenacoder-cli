import initSqlJs from 'sql.js';
import { createRequire } from 'module';
import { mkdir, readFile, rename, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { dirname, join } from 'path';

const require = createRequire(import.meta.url);
const sqliteWasmPath = require.resolve('sql.js/dist/sql-wasm.wasm');

let sqlPromise = null;
let writeQueue = Promise.resolve();
const SQLITE_HEADER = 'SQLite format 3\u0000';

function getSql() {
  if (!sqlPromise) {
    sqlPromise = initSqlJs({ locateFile: () => sqliteWasmPath });
  }
  return sqlPromise;
}

export async function ensureWorkspaceBrainSqlite(cwd) {
  return enqueueWorkspaceBrainWrite(async () => {
    const db = await openWorkspaceBrainDb(cwd, { waitForWrites: false });
    try {
      await saveWorkspaceBrainDb(cwd, db);
    } finally {
      db.close();
    }
  });
}

export async function loadWorkspaceBrainState(cwd) {
  const db = await openWorkspaceBrainDb(cwd);
  try {
    return {
      threads: readThreads(db),
      tabThreadMap: readTabThreadMap(db),
      project: readMetaJson(db, 'workspace', null),
    };
  } finally {
    db.close();
  }
}

export async function saveWorkspaceBrainState(cwd, { threads = [], tabThreadMap = {}, project = null } = {}) {
  return enqueueWorkspaceBrainWrite(async () => {
    const db = await openWorkspaceBrainDb(cwd, { waitForWrites: false });
    try {
      writeThreads(db, threads);
      writeTabThreadMap(db, tabThreadMap, threads);
      if (project) writeMetaJson(db, 'workspace', project);
      await saveWorkspaceBrainDb(cwd, db);
    } finally {
      db.close();
    }
  });
}

export async function getWorkspaceBrainThread(cwd, requestedThreadId = '') {
  const state = await loadWorkspaceBrainState(cwd);
  const threadId = requestedThreadId || newestThreadId(state.threads);
  const thread = state.threads.find((item) => item.id === threadId) || null;
  return {
    thread,
    index: state.threads.map(threadIndexEntry),
  };
}

export async function upsertWorkspaceBrainThread(cwd, thread) {
  if (!thread?.id) throw new Error('thread.id is required');
  const state = await loadWorkspaceBrainState(cwd);
  const threads = state.threads.some((item) => item.id === thread.id)
    ? state.threads.map((item) => (item.id === thread.id ? thread : item))
    : [thread, ...state.threads];
  await saveWorkspaceBrainState(cwd, {
    threads,
    tabThreadMap: state.tabThreadMap,
    project: state.project,
  });
}

async function openWorkspaceBrainDb(cwd, { waitForWrites = true } = {}) {
  if (waitForWrites) await writeQueue;
  const SQL = await getSql();
  const dbPath = workspaceBrainDbPath(cwd);
  const bytes = existsSync(dbPath) ? new Uint8Array(await readFile(dbPath)) : null;
  return bytes?.length
    ? await openVerifiedDatabase(SQL, cwd, bytes)
    : createUsableDatabase(SQL);
}

async function saveWorkspaceBrainDb(cwd, db) {
  const dbPath = workspaceBrainDbPath(cwd);
  const backupPath = workspaceBrainBackupPath(cwd);
  const bytes = Buffer.from(db.export());
  verifySqliteBytes(bytes);
  await mkdir(dirname(dbPath), { recursive: true });
  await atomicWriteFile(backupPath, bytes);
  await atomicWriteFile(dbPath, bytes);
}

async function enqueueWorkspaceBrainWrite(operation) {
  const run = writeQueue.then(operation, operation);
  writeQueue = run.catch(() => {});
  return run;
}

async function atomicWriteFile(filePath, bytes) {
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tempPath, bytes);
  await rename(tempPath, filePath);
}

async function openVerifiedDatabase(SQL, cwd, primaryBytes) {
  try {
    return createUsableDatabase(SQL, primaryBytes);
  } catch {
    const backupPath = workspaceBrainBackupPath(cwd);
    if (existsSync(backupPath)) {
      try {
        const backupBytes = new Uint8Array(await readFile(backupPath));
        return createUsableDatabase(SQL, backupBytes);
      } catch {
        return createUsableDatabase(SQL);
      }
    }
    return createUsableDatabase(SQL);
  }
}

function createUsableDatabase(SQL, bytes = null) {
  const db = bytes?.length ? new SQL.Database(bytes) : new SQL.Database();
  try {
    ensureSchema(db);
    verifyDatabaseIntegrity(db);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

function verifyDatabaseIntegrity(db) {
  const rows = selectRows(db, 'PRAGMA integrity_check');
  if (rows[0]?.integrity_check !== 'ok') {
    throw new Error('WorkspaceBrain SQLite integrity check failed');
  }
}

function verifySqliteBytes(bytes) {
  if (!bytes?.length || bytes.length < 100) {
    throw new Error('WorkspaceBrain SQLite export is invalid');
  }
  if (bytes.subarray(0, 16).toString('utf8') !== SQLITE_HEADER) {
    throw new Error('WorkspaceBrain SQLite export is not a SQLite database');
  }
}

function workspaceBrainDbPath(cwd) {
  return join(cwd, '.WorkspaceBrain', 'workspace.sqlite');
}

function workspaceBrainBackupPath(cwd) {
  return `${workspaceBrainDbPath(cwd)}.bak`;
}

function ensureSchema(db) {
  db.run(`
    PRAGMA user_version = 1;
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS threads (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      summary TEXT NOT NULL DEFAULT '',
      tags_json TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL DEFAULT 'active',
      model TEXT,
      active_plan_json TEXT,
      ledger_json TEXT NOT NULL DEFAULT '[]',
      created_at TEXT,
      updated_at TEXT
    );
    CREATE TABLE IF NOT EXISTS turns (
      id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      turn_index INTEGER NOT NULL,
      user_message_json TEXT,
      started_at TEXT,
      completed_at TEXT,
      token_usage_json TEXT NOT NULL DEFAULT '{}',
      tool_count INTEGER NOT NULL DEFAULT 0,
      model TEXT,
      metadata_json TEXT,
      remote_tunnel_run_id TEXT,
      cloud_run_id TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_turns_thread_order ON turns(thread_id, turn_index);
    CREATE TABLE IF NOT EXISTS tab_thread_map (
      scope TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL
    );
  `);
  ensureTimelineItemsSchema(db);
}

function ensureTimelineItemsSchema(db) {
  const columns = selectRows(db, 'PRAGMA table_info(timeline_items)');
  const hasStorageId = columns.some((column) => column.name === 'storage_id');

  if (columns.length && !hasStorageId) {
    db.run('ALTER TABLE timeline_items RENAME TO timeline_items_legacy');
    createTimelineItemsTable(db);
    db.run(`
      INSERT INTO timeline_items (storage_id, id, turn_id, item_index, type, content, name, args_json, status, result, error, observation_json, metadata_json, created_at)
      SELECT turn_id || ':' || item_index, id, turn_id, item_index, type, content, name, args_json, status, result, error, observation_json, metadata_json, created_at
      FROM timeline_items_legacy
    `);
    db.run('DROP TABLE timeline_items_legacy');
    return;
  }

  createTimelineItemsTable(db);
}

function createTimelineItemsTable(db) {
  db.run(`
    CREATE TABLE IF NOT EXISTS timeline_items (
      storage_id TEXT PRIMARY KEY,
      id TEXT NOT NULL,
      turn_id TEXT NOT NULL,
      item_index INTEGER NOT NULL,
      type TEXT NOT NULL,
      content TEXT,
      name TEXT,
      args_json TEXT,
      status TEXT,
      result TEXT,
      error TEXT,
      observation_json TEXT,
      metadata_json TEXT,
      created_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_timeline_turn_order ON timeline_items(turn_id, item_index);
  `);
}

function readThreads(db) {
  return selectRows(db, `
    SELECT * FROM threads
    ORDER BY datetime(COALESCE(updated_at, created_at, '1970-01-01')) DESC
  `).map((threadRow) => ({
    id: threadRow.id,
    title: threadRow.title || 'New Thread',
    summary: threadRow.summary || '',
    tags: parseJson(threadRow.tags_json, []),
    status: threadRow.status || 'active',
    model: threadRow.model || null,
    activePlan: parseJson(threadRow.active_plan_json, null),
    ledger: parseJson(threadRow.ledger_json, []),
    createdAt: threadRow.created_at || null,
    updatedAt: threadRow.updated_at || threadRow.created_at || null,
    turns: readTurns(db, threadRow.id),
  }));
}

function readTurns(db, threadId) {
  return selectRows(db, 'SELECT * FROM turns WHERE thread_id = ? ORDER BY turn_index ASC', [threadId])
    .map((row) => cleanObject({
      id: row.id,
      userMessage: parseJson(row.user_message_json, null),
      timeline: readTimeline(db, row.id),
      startedAt: row.started_at || null,
      completedAt: row.completed_at || null,
      tokenUsage: parseJson(row.token_usage_json, { prompt: 0, completion: 0, total: 0 }),
      toolCount: Number(row.tool_count || 0),
      model: row.model || null,
      metadata: parseJson(row.metadata_json, null),
      remoteTunnelRunId: row.remote_tunnel_run_id || null,
      cloudRunId: row.cloud_run_id || null,
    }));
}

function readTimeline(db, turnId) {
  return selectRows(db, 'SELECT * FROM timeline_items WHERE turn_id = ? ORDER BY item_index ASC', [turnId])
    .map((row) => cleanObject({
      id: row.id,
      type: row.type,
      content: row.content,
      name: row.name,
      args: parseJson(row.args_json, null),
      status: row.status,
      result: row.result,
      error: row.error,
      observation: parseJson(row.observation_json, null),
      metadata: parseJson(row.metadata_json, null),
      createdAt: row.created_at || null,
    }));
}

function writeThreads(db, threads) {
  db.run('BEGIN');
  try {
    db.run('DELETE FROM timeline_items');
    db.run('DELETE FROM turns');
    db.run('DELETE FROM threads');
    const insertThread = db.prepare('INSERT INTO threads (id, title, summary, tags_json, status, model, active_plan_json, ledger_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    const insertTurn = db.prepare('INSERT INTO turns (id, thread_id, turn_index, user_message_json, started_at, completed_at, token_usage_json, tool_count, model, metadata_json, remote_tunnel_run_id, cloud_run_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    const insertItem = db.prepare('INSERT INTO timeline_items (storage_id, id, turn_id, item_index, type, content, name, args_json, status, result, error, observation_json, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    for (const thread of threads || []) {
      insertThread.run([
        thread.id,
        thread.title || 'New Thread',
        thread.summary || '',
        json(thread.tags || []),
        thread.status || 'active',
        thread.model || null,
        nullableJson(thread.activePlan),
        json(thread.ledger || []),
        thread.createdAt || null,
        thread.updatedAt || thread.createdAt || null,
      ]);
      for (const [turnIndex, turn] of (thread.turns || []).entries()) {
        insertTurn.run([
          turn.id,
          thread.id,
          turnIndex,
          nullableJson(turn.userMessage || null),
          turn.startedAt || null,
          turn.completedAt || null,
          json(turn.tokenUsage || { prompt: 0, completion: 0, total: 0 }),
          Number(turn.toolCount || 0),
          turn.model || null,
          nullableJson(turn.metadata || null),
          turn.remoteTunnelRunId || null,
          turn.cloudRunId || null,
        ]);
        for (const [itemIndex, item] of (turn.timeline || []).entries()) {
          insertItem.run([
            `${turn.id}:${itemIndex}`,
            item.id || `${turn.id}-item-${itemIndex}`,
            turn.id,
            itemIndex,
            item.type || 'text',
            item.content || null,
            item.name || null,
            nullableJson(item.args || null),
            item.status || null,
            item.result || null,
            item.error || null,
            nullableJson(item.observation || null),
            nullableJson(item.metadata || null),
            item.createdAt || null,
          ]);
        }
      }
    }
    insertThread.free();
    insertTurn.free();
    insertItem.free();
    db.run('COMMIT');
  } catch (error) {
    db.run('ROLLBACK');
    throw error;
  }
}

function readTabThreadMap(db) {
  return Object.fromEntries(selectRows(db, 'SELECT scope, thread_id FROM tab_thread_map').map((row) => [row.scope, row.thread_id]));
}

function writeTabThreadMap(db, tabThreadMap, threads) {
  const validThreadIds = new Set((threads || []).map((thread) => thread.id));
  db.run('DELETE FROM tab_thread_map');
  const insert = db.prepare('INSERT INTO tab_thread_map (scope, thread_id) VALUES (?, ?)');
  for (const [scope, threadId] of Object.entries(tabThreadMap || {})) {
    if (validThreadIds.has(threadId)) insert.run([scope, threadId]);
  }
  insert.free();
}

function readMetaJson(db, key, fallback) {
  const rows = selectRows(db, 'SELECT value_json FROM meta WHERE key = ?', [key]);
  return rows.length ? parseJson(rows[0].value_json, fallback) : fallback;
}

function writeMetaJson(db, key, value) {
  db.run('INSERT OR REPLACE INTO meta (key, value_json) VALUES (?, ?)', [key, json(value)]);
}

function selectRows(db, sql, params = []) {
  const stmt = db.prepare(sql, params);
  const rows = [];
  try {
    while (stmt.step()) rows.push(stmt.getAsObject());
  } finally {
    stmt.free();
  }
  return rows;
}

function threadIndexEntry(thread = {}) {
  return {
    id: thread.id,
    title: thread.title,
    summary: thread.summary || '',
    tags: thread.tags || [],
    status: thread.status || 'active',
    model: thread.model || null,
    messageCount: countThreadMessages(thread),
    turnCount: (thread.turns || []).length,
    updatedAt: thread.updatedAt,
  };
}

function countThreadMessages(thread = {}) {
  let count = 0;
  for (const turn of thread.turns || []) {
    if (turn.userMessage?.content) count += 1;
    count += (turn.timeline || []).filter((item) => item.type === 'text').length;
  }
  return count;
}

function newestThreadId(threads = []) {
  return [...threads]
    .sort((a, b) => Date.parse(b?.updatedAt || '') - Date.parse(a?.updatedAt || ''))[0]?.id
    || threads[0]?.id
    || '';
}

function json(value) {
  return JSON.stringify(value ?? null);
}

function nullableJson(value) {
  return value == null ? null : JSON.stringify(value);
}

function parseJson(value, fallback) {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function cleanObject(value) {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== null && entry !== undefined));
}
