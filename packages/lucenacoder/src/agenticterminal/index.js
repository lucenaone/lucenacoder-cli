const DEFAULT_RECENT_OUTPUT_LIMIT = 8000;
const DEFAULT_READY_TIMEOUT_MS = 12_000;
const DEFAULT_RUNNING_BOUNDARY_TIMEOUT_MS = 60_000;

const SERVER_COMMAND_RE = /(?:^|[;&|]\s*|&&\s*)(?:(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:dev|start|serve|storybook)|(?:npx\s+)?vite(?=$|\s+(?!build\b))(?:\s+[^\n;&|]*)?|(?:npx\s+)?webpack-dev-server(?:\s|$)|(?:npx\s+)?storybook\s+(?:dev|serve|start)(?:\s|$)|(?:npx\s+)?(?:next|astro|remix|webpack|nuxt|svelte-kit)\s+(?:dev|serve|start)(?:\s|$)|(?:npx\s+)?(?:expo|react-native)\s+start(?:\s|$)|(?:npx\s+)?ng\s+serve(?:\s|$)|(?:npx\s+)?vue-cli-service\s+serve(?:\s|$)|prisma\s+studio(?:\s|$)|firebase\s+emulators:start|rails\s+(?:s|server)|python(?:3)?\s+-m\s+http\.server|docker\s+compose\s+up(?:\s|$))/iu;
const INTERACTIVE_COMMAND_RE = /(?:^|[;&|]\s*|&&\s*)(?:firebase\s+login|gh\s+auth\s+login|npm\s+login|pnpm\s+login|yarn\s+npm\s+login|ssh(?:\s|$)|psql(?:\s|$)|mysql(?:\s|$)|redis-cli(?:\s|$)|node\s*(?:$|[;&|])|python(?:3)?\s*(?:$|[;&|])|irb(?:\s|$)|rails\s+console|vercel\s+login|wrangler\s+login|netlify\s+login)/iu;

const READY_RE = /(?:Local:\s*https?:\/\/|Network:\s*https?:\/\/|https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0):\d+|server (?:started|running)|listening on|webpack compiled|firebase emulator hub running|started server on|accepting connections)/iu;

const INPUT_PROMPT_RE = /(?:\bpassword(?: for [^:\n]+)?|passphrase|enter .*:|press (?:enter|return)|continue\?|\bproceed\?|\bare you sure\b|\by\/n\b|\bY\/n\b|\byes\/no\b|\blogin required\b|\bauthentication required\b)[^\n]*$/iu;

const URL_RE = /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|[a-z0-9.-]+)(?::\d+)?(?:\/[^\s'"<>]*)?/giu;

const INSPECT_CONTENT_RE = /(?:^|[;&|]\s*|&&\s*)(?:cat|grep|rg|head|tail|find)\b/iu;
const INSTALL_RE = /(?:^|[;&|]\s*|&&\s*)(?:npm\s+(?:install|i|ci)|pnpm\s+(?:install|i)|yarn\s+(?:install|add)|bun\s+install|pip(?:3)?\s+install|composer\s+install|bundle\s+install)\b/iu;
const VERIFY_RE = /(?:^|[;&|]\s*|&&\s*)(?:(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:build|test|lint|typecheck)|(?:npx\s+)?(?:tsc|eslint|vite|next|astro)\s+(?:--noEmit|build)|pytest|python(?:3)?\s+-m\s+pytest|go\s+test|cargo\s+(?:test|build)|bundle\s+exec\s+rspec|rails\s+test|php\s+artisan\s+test|make\s+(?:build|test))\b/iu;
const QUALITY_RE = /(?:lint|typecheck|tsc|eslint|test|pytest|rspec|go\s+test|cargo\s+test)/iu;
const DEPLOY_RE = /(?:^|[;&|]\s*|&&\s*)(?:(?:npx\s+)?firebase\s+deploy|vercel\s+deploy|netlify\s+deploy|wrangler\s+deploy|gcloud\s+(?:run\s+)?deploy)\b/iu;
const REPO_REVIEW_RE = /(?:^|[;&|]\s*|&&\s*)(?:git\s+(?:status|diff|log|branch|remote|ls-remote)|gh\s+(?:pr\s+(?:status|checks)|run\s+list))\b/iu;
const PUBLISH_CODE_RE = /git\s+add\b[\s\S]*(?:&&|;)[\s\S]*git\s+commit\b[\s\S]*(?:&&|;)[\s\S]*git\s+push\b/iu;
const STOP_APP_RE = /(?:^|[;&|]\s*|&&\s*)(?:lsof\b[\s\S]*(?:kill|xargs)|pkill\b|kill\b|killall\b)\b/iu;
const PROCESS_MONITOR_RE = /(?:^|[;&|]\s*|&&\s*)(?:tail\s+-f|docker\s+logs\s+-f|journalctl\s+-f|watch\b)\b/iu;
const AUTH_FLOW_RE = /(?:^|[;&|]\s*|&&\s*)(?:firebase\s+login|gh\s+auth\s+login|npm\s+login|pnpm\s+login|yarn\s+npm\s+login|vercel\s+login|wrangler\s+login|netlify\s+login)\b/iu;
const INTERACTIVE_SESSION_RE = /(?:^|[;&|]\s*|&&\s*)(?:ssh(?:\s|$)|psql(?:\s|$)|mysql(?:\s|$)|redis-cli(?:\s|$)|node\s*(?:$|[;&|])|python(?:3)?\s*(?:$|[;&|])|irb(?:\s|$)|rails\s+console)\b/iu;
const NETWORK_CHECK_RE = /(?:^|[;&|]\s*|&&\s*)(?:curl|wget|ping|dig|nslookup|host)\b/iu;
const ENV_CHECK_RE = /(?:^|[;&|]\s*|&&\s*)(?:node|npm|pnpm|yarn|bun|python3?|pip3?|go|cargo|ruby|bundle|docker|firebase|vercel|wrangler|gcloud|gh)\s+(?:--version|-v|version)\b|(?:^|[;&|]\s*|&&\s*)which\s+\S+|(?:^|[;&|]\s*|&&\s*)command\s+-v\s+\S+/iu;
const SERVICE_STATUS_RE = /(?:^|[;&|]\s*|&&\s*)(?:docker\s+compose\s+ps|docker\s+ps|kubectl\s+get|systemctl\s+status|brew\s+services\s+list)\b/iu;
const DB_MIGRATE_RE = /(?:^|[;&|]\s*|&&\s*)(?:prisma\s+migrate|rails\s+db:migrate|alembic\s+upgrade|sequelize\s+db:migrate|knex\s+migrate|typeorm\s+migration)\b/iu;
const PROVIDER_COMMAND_RE = /(?:^|[;&|]\s*|&&\s*)(gh|glab|firebase|wrangler|cloudflare|vercel|stripe|aws|railway|gcloud|supabase|netlify|fly|render|heroku)\b/iu;

export function classifyCommand(command = "") {
  const text = String(command || "");
  const longRunning = SERVER_COMMAND_RE.test(text);
  const interactive = INTERACTIVE_COMMAND_RE.test(text);
  const intent = terminalIntentForCommand(text);
  const provider = terminalProviderForCommand(text);
  return {
    command: text,
    intent,
    provider: provider.provider,
    providerOperation: provider.operation,
    providerRisk: provider.risk,
    longRunning,
    interactive,
    stdinPolicy: stdinPolicyForCommand(text),
    dedupeKey: terminalDedupeKey(text),
    kind: longRunning ? "server" : interactive ? "interactive" : "command",
  };
}

export function terminalIntentForCommand(command = "") {
  const text = String(command || "");
  const chained = /(?:&&|;)/.test(text);
  if (PUBLISH_CODE_RE.test(text)) return "publish_code_change";
  if (INSTALL_RE.test(text) && VERIFY_RE.test(text)) return "prepare_and_verify_project";
  if (DEPLOY_RE.test(text) && /curl\b|open\b|hosting:channel:list|vercel\s+inspect/iu.test(text)) return "deploy_and_confirm_live";
  if (VERIFY_RE.test(text) && chained && QUALITY_RE.test(text)) return "quality_gate";
  if (STOP_APP_RE.test(text)) return "stop_app";
  if (SERVER_COMMAND_RE.test(text)) return "run_app";
  if (AUTH_FLOW_RE.test(text)) return "auth_flow";
  if (INTERACTIVE_SESSION_RE.test(text)) return "interactive_session";
  if (DEPLOY_RE.test(text)) return "deploy_app";
  if (DB_MIGRATE_RE.test(text)) return "database_migration";
  const provider = terminalProviderForCommand(text);
  if (provider.operation === "auth") return "auth_flow";
  if (provider.operation === "deploy") return "deploy_app";
  if (provider.operation === "logs") return "provider_logs";
  if (provider.operation === "status") return "provider_status";
  if (provider.operation === "env_or_secret") return "provider_env_or_secret";
  if (provider.operation === "billing_mutation") return "provider_billing_mutation";
  if (provider.operation === "data_mutation") return "provider_data_mutation";
  if (provider.operation === "resource_lookup") return "provider_resource_lookup";
  if (VERIFY_RE.test(text)) return "verify_project";
  if (REPO_REVIEW_RE.test(text)) return "repo_change_review";
  if (PROCESS_MONITOR_RE.test(text)) return "process_monitor";
  if (NETWORK_CHECK_RE.test(text)) return "network_check";
  if (SERVICE_STATUS_RE.test(text)) return "service_status";
  if (ENV_CHECK_RE.test(text)) return "environment_check";
  if (INSPECT_CONTENT_RE.test(text)) return "inspect_content";
  if (INSTALL_RE.test(text)) return "prepare_project";
  return "terminal_command";
}

export function terminalProviderForCommand(command = "") {
  const text = String(command || "");
  const cli = text.match(PROVIDER_COMMAND_RE)?.[1]?.toLowerCase() || "";
  if (!cli) return { provider: "", operation: "", risk: "" };
  const provider = cli === "gh" ? "github"
    : cli === "glab" ? "gitlab"
      : cli === "wrangler" || cli === "cloudflare" ? "cloudflare"
        : cli;
  const operation = providerOperationForCommand(provider, text);
  return {
    provider,
    operation,
    risk: providerRiskForOperation(operation),
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
  pid = null,
  ownerRunId = "",
  threadId = "",
  turnId = "",
  tabScope = "",
  workspaceId = "",
  tunnelId = "",
  runId = "",
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
    pid,
    ownerRunId: String(ownerRunId || ""),
    threadId: String(threadId || ""),
    turnId: String(turnId || ""),
    tabScope: String(tabScope || ""),
    workspaceId: String(workspaceId || ""),
    tunnelId: String(tunnelId || ""),
    runId: String(runId || ""),
    purpose: String(purpose || ""),
    child,
    status: "running",
    kind: classification.kind,
    intent: classification.intent,
    provider: classification.provider,
    providerOperation: classification.providerOperation,
    providerRisk: classification.providerRisk,
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

  if (session.longRunning && READY_RE.test(session.recentOutput || "")) {
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
  const currentResult = terminalCurrentResult(boundary, output);
  const lines = [
    "Terminal Command Receipt",
    `intent: ${boundary.intent || terminalIntentForCommand(boundary.command)}`,
    `status: ${boundary.status}`,
    `reason: ${boundary.reason}`,
    `command: ${boundary.command}`,
  ];
  if (boundary.cwd) lines.push(`cwd: ${boundary.cwd}`);
  if (options.includeSessionId !== false && boundary.sessionId) lines.push(`session_id: ${boundary.sessionId}`);
  if (boundary.provider) lines.push(`provider: ${boundary.provider}`);
  if (boundary.providerOperation) lines.push(`provider_operation: ${boundary.providerOperation}`);
  if (boundary.providerRisk) lines.push(`provider_risk: ${boundary.providerRisk}`);
  if (boundary.exitCode != null) lines.push(`exit_code: ${boundary.exitCode}`);
  if (boundary.signal) lines.push(`signal: ${boundary.signal}`);
  if (boundary.detectedUrls?.length) {
    lines.push("detected_urls:");
    for (const url of boundary.detectedUrls) lines.push(`- ${url}`);
  }
  if (currentResult.length) {
    lines.push("current_result:");
    for (const item of currentResult) lines.push(`- ${item}`);
  }
  if (boundary.status === "blocked_for_input" && boundary.inputPrompt) {
    lines.push(`input_prompt: ${boundary.inputPrompt}`);
    lines.push("available_actions: send_active_terminal_input, stop_active_terminal_session");
    lines.push(`next_actions: ${terminalNextAction(boundary)}.`);
  }
  if (boundary.status === "ready_background") {
    lines.push("process_state: running in background");
    lines.push(`next_actions: ${terminalNextAction(boundary)}.`);
  }
  if (boundary.status === "running") {
    lines.push("process_state: still running");
    lines.push("available_actions: read_active_terminal_session, stop_active_terminal_session");
    lines.push(`next_actions: ${terminalNextAction(boundary)}.`);
  }
  if (boundary.status === "completed" || boundary.status === "failed") {
    lines.push(`next_actions: ${terminalNextAction(boundary)}.`);
  }
  lines.push("recent_output:");
  lines.push("```text");
  lines.push(output || "No stdout/stderr yet.");
  lines.push("```");
  if (options.includeJson) {
    lines.push("");
    lines.push("receipt_json:");
    lines.push(JSON.stringify(boundary));
  }
  return lines.join("\n");
}

function terminalCurrentResult(boundary = {}, output = "") {
  const intent = boundary.intent || terminalIntentForCommand(boundary.command);
  const status = boundary.status || "";
  const urls = Array.isArray(boundary.detectedUrls) ? boundary.detectedUrls : [];
  const firstUrl = urls[0] || "";
  const firstLine = firstMeaningfulOutputLine(output);
  const result = [];

  if (status === "ready_background") {
    if (intent === "run_app") {
      result.push(firstUrl ? `app_url: ${firstUrl}` : "app_url: not detected yet");
      result.push("app_state: running in background");
      return result;
    }
    if (intent === "process_monitor") return ["monitor_state: running in background"];
    return ["process_state: running in background"];
  }

  if (status === "blocked_for_input") {
    if (firstUrl) result.push(`auth_or_action_url: ${firstUrl}`);
    if (boundary.inputPrompt) result.push(`input_needed: ${boundary.inputPrompt}`);
    if (!result.length) result.push("input_needed: terminal is waiting for input");
    return result;
  }

  if (status === "running") {
    return [firstLine ? `running_output: ${firstLine}` : "process_state: still running"];
  }

  if (status === "failed") {
    return [firstLine ? `failure: ${firstLine}` : "failure: command exited non-zero"];
  }

  if (status !== "completed") return [];

  if (intent === "run_app") {
    if (firstUrl) result.push(`app_url: ${firstUrl}`);
    result.push("app_state: command completed");
    return result;
  }
  if (intent === "deploy_app" || intent === "deploy_and_confirm_live") {
    result.push(firstUrl ? `deploy_url: ${firstUrl}` : "deploy_result: completed; see recent_output");
    return result;
  }
  if (intent === "verify_project" || intent === "quality_gate") {
    return [firstLine ? `verification: passed; ${firstLine}` : "verification: passed"];
  }
  if (intent === "prepare_project" || intent === "prepare_and_verify_project") {
    return [firstLine ? `setup: completed; ${firstLine}` : "setup: completed"];
  }
  if (intent === "repo_change_review") {
    return [firstLine ? `repo_state: ${firstLine}` : "repo_state: command completed"];
  }
  if (intent === "network_check") {
    return [firstLine ? `network_result: ${firstLine}` : "network_result: command completed"];
  }
  if (intent === "environment_check") {
    return [firstLine ? `environment_result: ${firstLine}` : "environment_result: command completed"];
  }
  if (intent === "service_status") {
    return [firstLine ? `service_status: ${firstLine}` : "service_status: command completed"];
  }
  if (intent === "provider_logs") {
    return [firstLine ? `provider_logs: ${firstLine}` : "provider_logs: returned"];
  }
  if (intent === "provider_status" || intent === "provider_resource_lookup") {
    return [firstLine ? `provider_result: ${firstLine}` : "provider_result: command completed"];
  }
  if (intent === "provider_env_or_secret") return ["provider_env_or_secret: completed"];
  if (intent === "provider_billing_mutation") return ["provider_billing_mutation: completed"];
  if (intent === "provider_data_mutation") return ["provider_data_mutation: completed"];
  if (intent === "database_migration") return ["database_migration: completed"];
  if (intent === "stop_app") return ["app_state: stop command completed"];
  if (intent === "inspect_content") {
    return [firstLine ? `inspection_result: ${firstLine}` : "inspection_result: command completed"];
  }
  return firstLine ? [`command_result: ${firstLine}`] : ["command_result: completed"];
}

function firstMeaningfulOutputLine(output = "") {
  return String(output || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .find((line) => !/^```/.test(line))
    ?.slice(0, 220) || "";
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
    intent: session.intent,
    provider: session.provider,
    providerOperation: session.providerOperation,
    providerRisk: session.providerRisk,
    pid: session.pid,
    threadId: session.threadId,
    turnId: session.turnId,
    tabScope: session.tabScope,
    workspaceId: session.workspaceId,
    tunnelId: session.tunnelId,
    runId: session.runId,
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
    intent: session.intent,
    provider: session.provider,
    providerOperation: session.providerOperation,
    providerRisk: session.providerRisk,
    pid: session.pid,
    threadId: session.threadId,
    turnId: session.turnId,
    tabScope: session.tabScope,
    workspaceId: session.workspaceId,
    tunnelId: session.tunnelId,
    runId: session.runId,
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

function providerOperationForCommand(provider = "", command = "") {
  const text = String(command || "").toLowerCase();
  if (/\b(?:login|auth|sso)\b/.test(text)) return "auth";
  if (/\bdeploy\b|hosting:\w+|pages\s+deploy|workers\s+deploy/.test(text)) return "deploy";
  if (/\b(?:logs?|tail|events?)\b/.test(text)) return "logs";
  if (/\b(?:status|checks?|inspect|describe|info|whoami|projects?\s+list|apps?\s+list|sites?\s+list|services?\s+list|ps)\b/.test(text)) return "status";
  if (/\b(?:env|secret|secrets|config|vars?)\b/.test(text)) return "env_or_secret";
  if (provider === "stripe") {
    if (/\b(?:subscriptions?|invoices?|payment_intents?|payment-links?|checkout|refunds?|prices?|products?|coupons?|tax_rates?)\b/.test(text)
      && /\b(?:create|update|delete|cancel|refund|capture|confirm|expire|void|finalize|pay)\b/.test(text)) return "billing_mutation";
    if (/\b(?:customers?|accounts?|payment_methods?|metadata)\b/.test(text)
      && /\b(?:create|update|delete|attach|detach)\b/.test(text)) return "data_mutation";
    if (/\b(?:list|retrieve|search|get)\b/.test(text)) return "resource_lookup";
  }
  if (/\b(?:create|update|delete|remove|set|unset|put|apply|write|push)\b/.test(text)) return "data_mutation";
  if (/\b(?:list|ls|get|retrieve|search|show|view)\b/.test(text)) return "resource_lookup";
  return provider ? "provider_command" : "";
}

function providerRiskForOperation(operation = "") {
  if (operation === "billing_mutation") return "billing_write";
  if (operation === "data_mutation" || operation === "env_or_secret" || operation === "deploy") return "write";
  if (operation === "auth") return "auth";
  return operation ? "read" : "";
}

function terminalNextAction(boundary = {}) {
  const intent = boundary.intent || terminalIntentForCommand(boundary.command);
  const status = boundary.status || "";
  if (status === "blocked_for_input") return "send input to this terminal session or ask the user";
  if (status === "ready_background") {
    if (intent === "run_app") return "continue; the app is running in background";
    if (intent === "process_monitor") return "continue; the monitor is running in background";
    return "continue; command is running in background";
  }
  if (status === "running") return "command is still running";
  if (status === "completed") {
    if (intent === "prepare_and_verify_project") return "continue; dependencies and verification completed";
    if (intent === "quality_gate") return "continue; quality gate completed";
    if (intent === "verify_project") return "continue; verification completed";
    if (intent === "deploy_app" || intent === "deploy_and_confirm_live") return "continue; deployment command completed; use detected URLs or output as the deploy result";
    if (intent === "repo_change_review") return "continue with the current repo state from this output";
    if (intent === "publish_code_change") return "continue; code publish command completed";
    if (intent === "stop_app") return "continue; stop command completed";
    if (intent === "inspect_content") return "continue with the returned file inspection if sufficient";
    if (intent === "network_check") return "continue with the returned network status";
    if (intent === "environment_check") return "continue with the returned environment/tool availability";
    if (intent === "service_status") return "continue with the returned service status";
    if (intent === "database_migration") return "continue; database migration command completed";
    if (intent === "provider_logs") return "continue with the returned provider logs";
    if (intent === "provider_status") return "continue with the returned provider status";
    if (intent === "provider_env_or_secret") return "continue; provider environment/secret command completed";
    if (intent === "provider_billing_mutation") return "continue; provider billing mutation completed";
    if (intent === "provider_data_mutation") return "continue; provider data mutation completed";
    if (intent === "provider_resource_lookup") return "continue with the returned provider resource data";
    return "continue";
  }
  if (status === "failed") {
    if (intent === "prepare_and_verify_project") return "fix the failed install or verification step before rerunning";
    if (intent === "quality_gate" || intent === "verify_project") return "fix the first actionable failure before rerunning verification";
    if (intent === "deploy_app" || intent === "deploy_and_confirm_live") return "fix the deploy failure or authentication issue before rerunning";
    if (intent === "auth_flow") return "ask the user for the required authentication action";
    if (intent === "interactive_session") return "send input to this terminal session or ask the user";
    if (intent === "database_migration") return "fix the migration failure before rerunning";
    if (intent === "provider_billing_mutation" || intent === "provider_data_mutation") return "fix the provider mutation failure before rerunning";
    if (intent.startsWith("provider_")) return "fix the provider command failure before rerunning";
    return "fix the failure shown in recent_output before rerunning";
  }
  return "continue";
}

function commandDirectoryScope(command = "") {
  const matches = [...String(command || "").matchAll(/(?:^|[;&|]\s*|&&\s*)cd\s+((?:"[^"]+")|(?:'[^']+')|[^\s;&|]+)\s*(?:&&|;)/giu)];
  const raw = matches.at(-1)?.[1] || ".";
  return raw.replace(/^['"]|['"]$/g, "");
}
