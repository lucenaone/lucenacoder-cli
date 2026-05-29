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
  ensureRawEventsSchema(db);
}

function ensureRawEventsSchema(db) {
  db.run(`
    CREATE TABLE IF NOT EXISTS raw_events (
      storage_id TEXT PRIMARY KEY,
      id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      turn_id TEXT NOT NULL,
      event_index INTEGER NOT NULL,
      type TEXT NOT NULL,
      role TEXT,
      tool_call_id TEXT,
      name TEXT,
      status TEXT,
      content TEXT,
      args_json TEXT,
      result TEXT,
      error TEXT,
      observation_json TEXT,
      metadata_json TEXT,
      images_json TEXT,
      created_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_raw_events_turn_order ON raw_events(turn_id, event_index);
    CREATE INDEX IF NOT EXISTS idx_raw_events_tool_call ON raw_events(turn_id, tool_call_id);
    CREATE TABLE IF NOT EXISTS model_call_traces (
      storage_id TEXT PRIMARY KEY,
      turn_id TEXT NOT NULL,
      trace_index INTEGER NOT NULL,
      iteration INTEGER,
      model TEXT,
      prompt_tokens INTEGER NOT NULL DEFAULT 0,
      completion_tokens INTEGER NOT NULL DEFAULT 0,
      total_tokens INTEGER NOT NULL DEFAULT 0,
      cached_tokens INTEGER NOT NULL DEFAULT 0,
      message_count INTEGER NOT NULL DEFAULT 0,
      assistant_chars INTEGER NOT NULL DEFAULT 0,
      had_tool_calls INTEGER NOT NULL DEFAULT 0,
      available_tools_json TEXT NOT NULL DEFAULT '[]',
      tool_calls_json TEXT NOT NULL DEFAULT '[]',
      trace_json TEXT NOT NULL DEFAULT '{}'
    );
    CREATE INDEX IF NOT EXISTS idx_model_call_traces_turn_order ON model_call_traces(turn_id, trace_index);
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
    .map((row) => {
      const rawEvents = readRawEvents(db, row.id);
      return cleanObject({
        id: row.id,
        userMessage: parseJson(row.user_message_json, null),
        rawEvents,
        timeline: timelineFromRawEvents(rawEvents),
        startedAt: row.started_at || null,
        completedAt: row.completed_at || null,
        tokenUsage: parseJson(row.token_usage_json, { prompt: 0, completion: 0, total: 0 }),
        toolCount: Number(row.tool_count || 0),
        model: row.model || null,
        ...turnMetadataFromSql(row.metadata_json),
        modelCallTraces: readModelCallTraces(db, row.id),
        remoteTunnelRunId: row.remote_tunnel_run_id || null,
        cloudRunId: row.cloud_run_id || null,
      });
    });
}

function readModelCallTraces(db, turnId) {
  return selectRows(db, 'SELECT * FROM model_call_traces WHERE turn_id = ? ORDER BY trace_index ASC', [turnId])
    .map((row) => {
      const trace = parseJson(row.trace_json, {});
      return {
        ...trace,
        iteration: Number(row.iteration || 0) || undefined,
        availableTools: parseJson(row.available_tools_json, []),
        messageCount: Number(row.message_count || 0),
        response: {
          ...(trace.response || {}),
          model: row.model || trace.response?.model,
          usage: {
            prompt_tokens: Number(row.prompt_tokens || 0),
            completion_tokens: Number(row.completion_tokens || 0),
            total_tokens: Number(row.total_tokens || 0),
            cached_tokens: Number(row.cached_tokens || 0),
          },
          assistantChars: Number(row.assistant_chars || 0),
          hadToolCalls: Boolean(row.had_tool_calls),
        },
        toolCalls: parseJson(row.tool_calls_json, []),
      };
    });
}

function turnMetadataFromSql(rawMetadata) {
  const metadata = parseJson(rawMetadata, null);
  if (!metadata || typeof metadata !== 'object') return { metadata: null };
  const { modelCallTraces, ...rest } = metadata;
  return {
    metadata: Object.keys(rest).length ? rest : null,
    modelCallTraces: Array.isArray(modelCallTraces) ? modelCallTraces : [],
  };
}

function readRawEvents(db, turnId) {
  return selectRows(db, 'SELECT * FROM raw_events WHERE turn_id = ? ORDER BY event_index ASC', [turnId])
    .map((row) => cleanObject({
      id: row.id,
      type: row.type,
      role: row.role,
      toolCallId: row.tool_call_id,
      name: row.name,
      status: row.status,
      content: row.content,
      args: parseJson(row.args_json, null),
      result: row.result,
      error: row.error,
      observation: parseJson(row.observation_json, null),
      metadata: parseJson(row.metadata_json, null),
      images: parseJson(row.images_json, null),
      createdAt: row.created_at || null,
    }));
}

function writeThreads(db, threads) {
  db.run('BEGIN');
  try {
    db.run('DELETE FROM raw_events');
    db.run('DELETE FROM model_call_traces');
    db.run('DELETE FROM turns');
    db.run('DELETE FROM threads');
    const insertThread = db.prepare('INSERT INTO threads (id, title, summary, tags_json, status, model, active_plan_json, ledger_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    const insertTurn = db.prepare('INSERT INTO turns (id, thread_id, turn_index, user_message_json, started_at, completed_at, token_usage_json, tool_count, model, metadata_json, remote_tunnel_run_id, cloud_run_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    const insertRawEvent = db.prepare('INSERT INTO raw_events (storage_id, id, thread_id, turn_id, event_index, type, role, tool_call_id, name, status, content, args_json, result, error, observation_json, metadata_json, images_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    const insertModelTrace = db.prepare('INSERT INTO model_call_traces (storage_id, turn_id, trace_index, iteration, model, prompt_tokens, completion_tokens, total_tokens, cached_tokens, message_count, assistant_chars, had_tool_calls, available_tools_json, tool_calls_json, trace_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
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
        const rawEvents = rawEventsFromTurn(turn);
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
          nullableJson(turnMetadataForSql(turn)),
          turn.remoteTunnelRunId || null,
          turn.cloudRunId || null,
        ]);
        for (const [eventIndex, event] of rawEvents.entries()) {
          insertRawEvent.run([
            `${turn.id}:${eventIndex}`,
            event.id || `${turn.id}:raw:${eventIndex}`,
            thread.id,
            turn.id,
            eventIndex,
            event.type || 'message',
            event.role || null,
            event.toolCallId || null,
            event.name || null,
            event.status || null,
            event.content || null,
            nullableJson(event.args || null),
            event.result || null,
            event.error || null,
            nullableJson(event.observation || null),
            nullableJson(event.metadata || null),
            nullableJson(event.images || null),
            event.createdAt || null,
          ]);
        }
        for (const [traceIndex, trace] of (turn.modelCallTraces || []).entries()) {
          const usage = trace.response?.usage || {};
          insertModelTrace.run([
            `${turn.id}:${traceIndex}`,
            turn.id,
            traceIndex,
            trace.iteration || null,
            trace.response?.model || turn.model || null,
            Number(usage.prompt_tokens || 0),
            Number(usage.completion_tokens || 0),
            Number(usage.total_tokens || 0),
            Number(usage.cached_tokens || usage.prompt_tokens_details?.cached_tokens || 0),
            Number(trace.messageCount || 0),
            Number(trace.response?.assistantChars || 0),
            trace.response?.hadToolCalls ? 1 : 0,
            json(trace.availableTools || []),
            json(trace.toolCalls || []),
            json(trace),
          ]);
        }
      }
    }
    insertThread.free();
    insertTurn.free();
    insertRawEvent.free();
    insertModelTrace.free();
    db.run('COMMIT');
  } catch (error) {
    db.run('ROLLBACK');
    throw error;
  }
}

function turnMetadataForSql(turn = {}) {
  const metadata = { ...(turn.metadata || {}) };
  return Object.keys(metadata).length ? metadata : null;
}

function rawEventsFromTurn(turn = {}) {
  return Array.isArray(turn.rawEvents) ? turn.rawEvents : [];
}

function timelineFromRawEvents(rawEvents = []) {
  const timeline = [];
  const toolIndexes = new Map();
  for (const event of rawEvents || []) {
    if (event?.type === 'message' && event.role === 'assistant') {
      timeline.push(cleanObject({ id: event.id, type: 'text', content: event.content || '', metadata: event.metadata || null, createdAt: event.createdAt || null }));
    } else if (event?.type === 'system') {
      timeline.push(cleanObject({ id: event.id, type: 'system', content: event.content || '', metadata: event.metadata || null, createdAt: event.createdAt || null }));
    } else if (event?.type === 'tool_call') {
      const id = event.toolCallId || event.id;
      toolIndexes.set(id, timeline.length);
      timeline.push(cleanObject({ id, type: 'tool', name: event.name || '', args: event.args || null, status: event.status || 'running', metadata: event.metadata || null, createdAt: event.createdAt || null }));
    } else if (event?.type === 'tool_result') {
      const id = event.toolCallId || event.id;
      const index = toolIndexes.get(id);
      const patch = cleanObject({ id, type: 'tool', name: event.name || '', status: event.status || (event.error ? 'error' : 'done'), result: event.result, error: event.error, observation: event.observation || null, metadata: event.metadata || null });
      if (index == null) {
        toolIndexes.set(id, timeline.length);
        timeline.push({ ...patch, createdAt: event.createdAt || null });
      } else {
        timeline[index] = { ...timeline[index], ...patch };
      }
    }
  }
  return timeline.filter((item) => item.type !== 'text' || item.content);
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
    const rawEvents = rawEventsFromTurn(turn);
    count += rawEvents.filter((event) => (
      event?.type === 'message'
      && (event.role === 'user' || event.role === 'assistant')
      && event.content
    )).length;
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
