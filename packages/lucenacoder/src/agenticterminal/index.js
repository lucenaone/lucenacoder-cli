const DEFAULT_RECENT_OUTPUT_LIMIT = 8000;
const DEFAULT_READY_TIMEOUT_MS = 12_000;
const DEFAULT_RUNNING_BOUNDARY_TIMEOUT_MS = 60_000;

const SERVER_COMMAND_RE = /(?:^|[;&|]\s*|&&\s*)(?:(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:dev|start|serve)|(?:npx\s+)?(?:vite|webpack-dev-server)(?:\s|$)|(?:npx\s+)?(?:next|astro|remix|webpack)\s+(?:dev|serve|start)(?:\s|$)|firebase\s+emulators:start|rails\s+(?:s|server)|python(?:3)?\s+-m\s+http\.server|docker\s+compose\s+up(?:\s|$))/iu;
const INTERACTIVE_COMMAND_RE = /(?:^|[;&|]\s*|&&\s*)(?:firebase\s+login|gh\s+auth\s+login|npm\s+login|pnpm\s+login|yarn\s+npm\s+login|ssh(?:\s|$)|psql(?:\s|$)|mysql(?:\s|$)|redis-cli(?:\s|$)|node(?:\s|$)|python(?:3)?(?:\s|$)|irb(?:\s|$)|rails\s+console|prisma\s+studio|vercel\s+login|wrangler\s+login|netlify\s+login)/iu;

const READY_RE = /(?:Local:\s*https?:\/\/|Network:\s*https?:\/\/|https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0):\d+|ready in \d+(?:\.\d+)?\s*(?:ms|s)|compiled successfully|server (?:started|running)|listening on|VITE v[^\n]*ready|webpack compiled|firebase emulator hub running|started server on|accepting connections)/iu;

const INPUT_PROMPT_RE = /(?:\bpassword(?: for [^:\n]+)?|passphrase|enter .*:|press (?:enter|return)|continue\?|\bproceed\?|\bare you sure\b|\by\/n\b|\bY\/n\b|\byes\/no\b|\blogin required\b|\bauthentication required\b)[^\n]*$/iu;

const URL_RE = /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|[a-z0-9.-]+)(?::\d+)?(?:\/[^\s'"<>]*)?/giu;

export function classifyCommand(command = "") {
  const text = String(command || "");
  const longRunning = SERVER_COMMAND_RE.test(text);
  const interactive = INTERACTIVE_COMMAND_RE.test(text);
  return {
    command: text,
    longRunning,
    interactive,
    stdinPolicy: stdinPolicyForCommand(text),
    dedupeKey: terminalDedupeKey(text),
    kind: longRunning ? "server" : interactive ? "interactive" : "command",
  };
}

export function isLikelyLongRunningCommand(command = "") {
  return classifyCommand(command).longRunning;
}

export function stdinPolicyForCommand(command = "") {
  const text = String(command || "");
  if (INTERACTIVE_COMMAND_RE.test(text)) return "open";
  if (SERVER_COMMAND_RE.test(text)) return "open";
  return "closed";
}

export function terminalDedupeKey(command = "", cwd = "") {
  const text = String(command || "")
    .replace(/\s+/g, " ")
    .replace(/\s*(?:2>&1|1>&2)\s*/g, " ")
    .trim();
  const scope = commandDirectoryScope(text);
  const relevant = text.match(/(?:(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:dev|start|serve)|(?:npx\s+)?vite(?:\s+[^\n;&|]*)?|(?:npx\s+)?next\s+(?:dev|start)|firebase\s+emulators:start|docker\s+compose\s+up(?:\s+[^\n;&|]*)?)/iu)?.[0] || text;
  return `${String(cwd || "").trim()}::${scope}::${relevant.toLowerCase().replace(/\s+/g, " ")}`;
}

export function createTerminalSession({
  id,
  command,
  cwd = "",
  ownerRunId = "",
  purpose = "",
  child = null,
  now = Date.now(),
  recentOutputLimit = DEFAULT_RECENT_OUTPUT_LIMIT,
  readyTimeoutMs = DEFAULT_READY_TIMEOUT_MS,
  runningBoundaryTimeoutMs = DEFAULT_RUNNING_BOUNDARY_TIMEOUT_MS,
} = {}) {
  if (!id) throw new Error("AgenticTerminal session requires id.");
  if (!command) throw new Error("AgenticTerminal session requires command.");
  const classification = classifyCommand(command);
  return {
    id,
    command: String(command),
    cwd: String(cwd || ""),
    ownerRunId: String(ownerRunId || ""),
    purpose: String(purpose || ""),
    child,
    status: "running",
    kind: classification.kind,
    longRunning: classification.longRunning,
    interactive: classification.interactive,
    stdinPolicy: classification.stdinPolicy,
    dedupeKey: terminalDedupeKey(command, cwd),
    startedAt: now,
    updatedAt: now,
    lastOutputAt: null,
    recentOutput: "",
    detectedUrls: [],
    inputPrompt: "",
    exitCode: null,
    signal: null,
    boundarySent: false,
    recentOutputLimit,
    readyTimeoutMs,
    runningBoundaryTimeoutMs,
  };
}

export class TerminalSessionRegistry {
  constructor() {
    this.sessions = new Map();
    this.backgroundByDedupeKey = new Map();
    this.foregroundByOwner = new Map();
  }

  create(options = {}) {
    const session = createTerminalSession(options);
    this.sessions.set(session.id, session);
    if (session.ownerRunId) this.foregroundByOwner.set(session.ownerRunId, session.id);
    if (session.longRunning) this.backgroundByDedupeKey.set(session.dedupeKey, session.id);
    return session;
  }

  get(sessionId = "") {
    return this.sessions.get(sessionId) || null;
  }

  foregroundSession(ownerRunId = "") {
    const sessionId = this.foregroundByOwner.get(ownerRunId);
    const session = sessionId ? this.sessions.get(sessionId) : null;
    return isLiveSession(session) ? session : null;
  }

  releaseForeground(sessionId = "") {
    const session = this.sessions.get(sessionId);
    if (!session?.ownerRunId) return false;
    if (this.foregroundByOwner.get(session.ownerRunId) === sessionId) {
      this.foregroundByOwner.delete(session.ownerRunId);
      return true;
    }
    return false;
  }

  findReusable({ command = "", cwd = "" } = {}) {
    const classification = classifyCommand(command);
    if (!classification.longRunning) return null;
    const sessionId = this.backgroundByDedupeKey.get(terminalDedupeKey(command, cwd));
    const session = sessionId ? this.sessions.get(sessionId) : null;
    if (!session || !isLiveSession(session)) return null;
    return session;
  }

  observe(sessionId, chunk, options = {}) {
    const session = this.get(sessionId);
    if (!session) return null;
    return observeTerminalOutput(session, chunk, options);
  }

  boundary(sessionId, options = {}) {
    const session = this.get(sessionId);
    return resolveTerminalBoundary(session, options);
  }

  snapshot(sessionId, { reason = "existing_terminal_session" } = {}) {
    const session = this.get(sessionId);
    return session ? terminalSessionSnapshot(session, { reason }) : null;
  }

  close(sessionId, { exitCode = 0, signal = null } = {}) {
    const session = this.get(sessionId);
    if (!session) return null;
    const boundary = session.boundarySent
      ? terminalSessionSnapshot(session, { reason: "process_exited_after_receipt", status: exitCode === 0 ? "completed" : "failed" })
      : resolveTerminalBoundary(session, { closed: true, exitCode, signal });
    this.remove(sessionId);
    return boundary;
  }

  remove(sessionId = "") {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    this.sessions.delete(sessionId);
    if (session.ownerRunId && this.foregroundByOwner.get(session.ownerRunId) === sessionId) {
      this.foregroundByOwner.delete(session.ownerRunId);
    }
    if (session.dedupeKey && this.backgroundByDedupeKey.get(session.dedupeKey) === sessionId) {
      this.backgroundByDedupeKey.delete(session.dedupeKey);
    }
    return true;
  }

  activeSessions() {
    return [...this.sessions.values()].filter(isLiveSession);
  }
}

export function observeTerminalOutput(session, chunk, { stream = "stdout", now = Date.now() } = {}) {
  if (!session) throw new Error("observeTerminalOutput requires session.");
  const text = String(chunk || "");
  if (!text) return session;
  const prefix = stream === "stderr" ? "" : "";
  const nextOutput = `${session.recentOutput || ""}${prefix}${text}`;
  session.recentOutput = nextOutput.length > session.recentOutputLimit
    ? nextOutput.slice(-session.recentOutputLimit)
    : nextOutput;
  session.lastOutputAt = now;
  session.updatedAt = now;
  session.detectedUrls = unique([...session.detectedUrls, ...extractUrls(text)]);
  const prompt = detectInputPrompt(session.recentOutput);
  if (prompt) {
    session.inputPrompt = prompt;
    session.status = "blocked_for_input";
  }
  return session;
}

export function resolveTerminalBoundary(session, {
  now = Date.now(),
  closed = false,
  exitCode = null,
  signal = null,
  force = false,
} = {}) {
  if (!session || session.boundarySent) return null;

  if (closed) {
    session.exitCode = typeof exitCode === "number" ? exitCode : 0;
    session.signal = signal || null;
    session.status = session.exitCode === 0 ? "completed" : "failed";
    return markBoundary(session, {
      status: session.status,
      reason: "process_exited",
    });
  }

  if (session.status === "blocked_for_input") {
    return markBoundary(session, {
      status: "blocked_for_input",
      reason: "input_prompt_detected",
    });
  }

  if (READY_RE.test(session.recentOutput || "")) {
    session.status = "ready_background";
    return markBoundary(session, {
      status: "ready_background",
      reason: "ready_output_detected",
    });
  }

  const elapsed = now - session.startedAt;
  if (session.longRunning && elapsed >= session.readyTimeoutMs) {
    session.status = "ready_background";
    return markBoundary(session, {
      status: "ready_background",
      reason: "long_running_ready_timeout",
    });
  }

  if (force || elapsed >= session.runningBoundaryTimeoutMs) {
    session.status = "running";
    return markBoundary(session, {
      status: "running",
      reason: force ? "forced_running_boundary" : "running_boundary_timeout",
    });
  }

  return null;
}

export function terminalReceipt(boundary, options = {}) {
  if (!boundary) return "";
  const output = String(boundary.recentOutput || "").trim();
  const lines = [
    "Terminal Command Receipt",
    `status: ${boundary.status}`,
    `reason: ${boundary.reason}`,
    `command: ${boundary.command}`,
  ];
  if (boundary.cwd) lines.push(`cwd: ${boundary.cwd}`);
  if (options.includeSessionId !== false && boundary.sessionId) lines.push(`session_id: ${boundary.sessionId}`);
  if (boundary.exitCode != null) lines.push(`exit_code: ${boundary.exitCode}`);
  if (boundary.signal) lines.push(`signal: ${boundary.signal}`);
  if (boundary.detectedUrls?.length) {
    lines.push("detected_urls:");
    for (const url of boundary.detectedUrls) lines.push(`- ${url}`);
  }
  if (boundary.status === "blocked_for_input" && boundary.inputPrompt) {
    lines.push(`input_prompt: ${boundary.inputPrompt}`);
    lines.push("available_actions: send_terminal_input, stop_terminal_session");
    lines.push("next_actions: send input to this terminal session or ask the user.");
  }
  if (boundary.status === "ready_background") {
    lines.push("process_state: running in background");
    lines.push("available_actions: stop_terminal_session");
    lines.push("next_actions: continue; do not rerun this command unless the user asks.");
  }
  if (boundary.status === "running") {
    lines.push("process_state: still running");
    lines.push("available_actions: read_terminal_session, stop_terminal_session");
    lines.push("next_actions: continue only if this receipt is enough; otherwise check this terminal session later.");
  }
  lines.push("recent_output:");
  lines.push("```text");
  lines.push(output || "No stdout/stderr yet.");
  lines.push("```");
  if (options.includeJson) {
    lines.push("");
    lines.push("receipt_json:");
    lines.push(JSON.stringify(publicTerminalBoundary(boundary)));
  }
  return lines.join("\n");
}

export function terminalUserReceipt(boundary) {
  return terminalReceipt(boundary, { includeSessionId: false });
}

export function terminalSessionSnapshot(session, { reason = "terminal_session_snapshot", status = "" } = {}) {
  if (!session) return null;
  return {
    status: status || session.status || "running",
    reason,
    command: session.command,
    cwd: session.cwd,
    sessionId: session.id,
    exitCode: session.exitCode,
    signal: session.signal,
    detectedUrls: [...(session.detectedUrls || [])],
    inputPrompt: session.inputPrompt,
    recentOutput: session.recentOutput,
    startedAt: session.startedAt,
    updatedAt: session.updatedAt,
    longRunning: session.longRunning,
    stdinPolicy: session.stdinPolicy,
    dedupeKey: session.dedupeKey,
  };
}

function markBoundary(session, { status, reason }) {
  session.boundarySent = true;
  session.status = status;
  return {
    status,
    reason,
    command: session.command,
    cwd: session.cwd,
    sessionId: session.id,
    exitCode: session.exitCode,
    signal: session.signal,
    detectedUrls: [...session.detectedUrls],
    inputPrompt: session.inputPrompt,
    recentOutput: session.recentOutput,
    startedAt: session.startedAt,
    updatedAt: session.updatedAt,
    longRunning: session.longRunning,
    stdinPolicy: session.stdinPolicy,
    dedupeKey: session.dedupeKey,
  };
}

function publicTerminalBoundary(boundary = {}) {
  return {
    status: boundary.status,
    reason: boundary.reason,
    command: boundary.command,
    cwd: boundary.cwd,
    sessionId: boundary.sessionId,
    exitCode: boundary.exitCode,
    signal: boundary.signal,
    detectedUrls: [...(boundary.detectedUrls || [])],
    inputPrompt: boundary.inputPrompt,
    recentOutput: boundary.recentOutput,
  };
}

function isLiveSession(session) {
  return Boolean(session && !["completed", "failed", "stopped"].includes(session.status));
}

function detectInputPrompt(text = "") {
  const tail = String(text || "").split(/\r?\n/).slice(-4).join("\n").trim();
  const match = tail.match(INPUT_PROMPT_RE);
  return match ? match[0].trim() : "";
}

function extractUrls(text = "") {
  return String(text || "").match(URL_RE) || [];
}

function unique(values = []) {
  return [...new Set(values.filter(Boolean))];
}

function commandDirectoryScope(command = "") {
  const matches = [...String(command || "").matchAll(/(?:^|[;&|]\s*|&&\s*)cd\s+((?:"[^"]+")|(?:'[^']+')|[^\s;&|]+)\s*(?:&&|;)/giu)];
  const raw = matches.at(-1)?.[1] || ".";
  return raw.replace(/^['"]|['"]$/g, "");
}
