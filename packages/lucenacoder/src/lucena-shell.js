import { execaCommand } from 'execa';
import { parse } from 'shell-quote';
import { isAbsolute, resolve, relative } from 'path';

const READ_ONLY_COMMANDS = new Set([
  'awk', 'basename', 'cat', 'cd', 'curl', 'cut', 'dirname', 'echo', 'false', 'find',
  'grep', 'head', 'ls', 'pwd', 'rg', 'sed', 'sort', 'tail', 'test', 'true',
  'uniq', 'wc', 'which',
  'dir', 'type', 'findstr', 'where', 'tree', 'more', 'clip', 'ver', 'vol',
  'hostname', 'systeminfo',
  'get-childitem', 'get-content', 'select-string', 'get-location',
  'get-command', 'get-process', 'get-service', 'get-item', 'get-itemproperty',
  'test-path', 'get-help', 'write-output', 'write-host',
]);

const READ_ONLY_GIT_SUBCOMMANDS = new Set([
  'branch', 'diff', 'grep', 'log', 'ls-files', 'rev-parse', 'show', 'status',
]);

const READ_ONLY_GH_COMMANDS = new Map([
  ['auth', new Set(['status'])],
  ['repo', new Set(['list', 'view'])],
  ['pr', new Set(['checks', 'diff', 'list', 'status', 'view'])],
  ['issue', new Set(['list', 'status', 'view'])],
  ['search', new Set(['code', 'commits', 'issues', 'prs', 'repos'])],
]);

const CHAIN_OPERATORS = new Set(['&&', '||', ';', '|']);
const WRITE_OPERATORS = new Set(['>', '>>', '<>', '>|', '<<', '<<-', '<<<']);
const COMMANDS_WITH_PATH_OPERANDS = new Set([
  'cat', 'chmod', 'chown', 'cp', 'find', 'grep', 'head', 'ls', 'mkdir', 'mv',
  'rm', 'rmdir', 'sed', 'tail', 'touch', 'wc',
]);

export class LucenaShell {
  constructor(workspaceRoot) {
    this.workspaceRoot = resolve(workspaceRoot);
    this.cwd = this.workspaceRoot;
    this.workspaceEnv = {};
  }

  setWorkspaceEnv(envKey, value) {
    const cleanKey = String(envKey || '').toUpperCase().replace(/[^A-Z0-9_]+/g, '_');
    if (!cleanKey) return false;
    this.workspaceEnv[cleanKey] = String(value || '').trim();
    return true;
  }

  hasWorkspaceEnv(envKey) {
    const cleanKey = String(envKey || '').toUpperCase().replace(/[^A-Z0-9_]+/g, '_');
    return Boolean(cleanKey && this.workspaceEnv[cleanKey]);
  }

  analyze(rawCommand) {
    const sanitized = sanitizeCommand(rawCommand);
    const analysis = {
      command: sanitized.command,
      rejected: false,
      rejectReason: '',
      isReadOnly: true,
      needsApproval: false,
      touchesOutsideWorkspace: false,
      reasons: [],
      segments: [],
    };

    if (!sanitized.ok) {
      return {
        ...analysis,
        rejected: true,
        rejectReason: sanitized.reason,
        isReadOnly: false,
        needsApproval: true,
      };
    }

    sanitized.command = normalizeWorkspaceAbsoluteCommandPaths(sanitized.command, this.workspaceRoot);
    analysis.command = sanitized.command;

    if (!sanitized.command) return analysis;

    if (/`|\$\(/.test(sanitized.command)) {
      analysis.isReadOnly = false;
      analysis.needsApproval = true;
      analysis.reasons.push('uses command substitution');
    }

    let tokens;
    try {
      tokens = parse(sanitized.command);
    } catch (err) {
      return {
        ...analysis,
        rejected: true,
        rejectReason: err.message || 'Command could not be parsed.',
        isReadOnly: false,
        needsApproval: true,
      };
    }

    let current = [];
    for (const token of tokens) {
      if (isOperator(token) && CHAIN_OPERATORS.has(token.op)) {
        this._addSegmentAnalysis(analysis, current);
        current = [];
        continue;
      }

      if (isOperator(token) && WRITE_OPERATORS.has(token.op)) {
        analysis.isReadOnly = false;
        analysis.needsApproval = true;
        analysis.reasons.push(`uses shell redirection (${token.op})`);
      }

      if (isOperator(token) && token.op === '&') {
        analysis.isReadOnly = false;
        analysis.needsApproval = true;
        analysis.reasons.push('runs a background process');
      }

      current.push(token);
    }
    this._addSegmentAnalysis(analysis, current);

    analysis.reasons = [...new Set(analysis.reasons)];
    return analysis;
  }

  canExecute(rawCommand, options = {}) {
    const mode = options.mode === 'yolo' ? 'yolo' : 'safe';
    const approved = options.approved === true;
    const outsideWorkspaceApproved = options.outsideWorkspaceApproved === true;
    const analysis = this.analyze(rawCommand);

    if (analysis.rejected) {
      return { ok: false, analysis, reason: analysis.rejectReason };
    }

    if (analysis.isReadOnly) {
      return { ok: true, analysis };
    }

    if (mode === 'safe' && !approved) {
      return {
        ok: false,
        analysis,
        reason: `Safe Mode blocked a mutating command. Approval is required. ${formatReasons(analysis.reasons)}`,
      };
    }

    if (mode === 'yolo' && analysis.touchesOutsideWorkspace && !outsideWorkspaceApproved) {
      return {
        ok: false,
        analysis,
        reason: `YOLO Mode blocked an outside-workspace mutation. Approval is required. ${formatReasons(analysis.reasons)}`,
      };
    }

    return { ok: true, analysis };
  }

  execute(rawCommand, options = {}) {
    const decision = this.canExecute(rawCommand, options);
    if (!decision.ok) {
      const err = new Error(decision.reason);
      err.analysis = decision.analysis;
      throw err;
    }

    return execaCommand(decision.analysis.command, {
      cwd: this.cwd,
      shell: true,
      reject: false,
      preferLocal: true,
      stdin: 'pipe',
      env: {
        ...this.workspaceEnv,
        LUCENA_WORKSPACE_ROOT: this.workspaceRoot,
      },
    });
  }

  _addSegmentAnalysis(analysis, tokens) {
    const words = tokens.filter((token) => typeof token === 'string');
    if (words.length === 0) return;

    let index = 0;
    while (words[index] && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[index])) {
      index++;
    }

    const command = stripQuotes(words[index] || '').toLowerCase();
    if (!command) return;

    const segment = {
      command,
      words,
      isReadOnly: true,
      touchesOutsideWorkspace: false,
    };
    analysis.segments.push(segment);

    if (command === 'cd') {
      const target = words[index + 1] ? stripQuotes(words[index + 1]) : this.workspaceRoot;
      const nextCwd = resolvePath(this.cwd, target, this.workspaceRoot);
      if (!isInside(this.workspaceRoot, nextCwd)) {
        segment.touchesOutsideWorkspace = true;
        analysis.touchesOutsideWorkspace = true;
        analysis.reasons.push(`changes directory outside workspace (${displayPath(this.workspaceRoot, nextCwd)})`);
      }
      return;
    }

    if (command === 'git') {
      const subcommand = stripQuotes(words[index + 1] || '').toLowerCase();
      if (!READ_ONLY_GIT_SUBCOMMANDS.has(subcommand)) {
        markMutating(analysis, segment, subcommand ? `git ${subcommand} may modify state` : 'git command is incomplete');
      }
    } else if (command === 'gh') {
      if (!isReadOnlyGhCommand(words.slice(index))) {
        markMutating(analysis, segment, 'mutating gh commands must be approved');
      }
    } else if (command === 'curl' && words.slice(index + 1).some(isCurlWriteOption)) {
      markMutating(analysis, segment, 'curl output options may write files');
    } else if (command === 'sed' && words.some((word) => /^-.*i/.test(stripQuotes(word)))) {
      markMutating(analysis, segment, 'sed in-place editing may modify files');
    } else if (!READ_ONLY_COMMANDS.has(command)) {
      markMutating(analysis, segment, `${command} is not classified as read-only`);
    }

    if (segment.isReadOnly) return;

    const pathOperands = collectPathOperands(command, words.slice(index + 1));
    if (pathOperands.length === 0 && !isInside(this.workspaceRoot, this.cwd)) {
      segment.touchesOutsideWorkspace = true;
      analysis.touchesOutsideWorkspace = true;
      analysis.reasons.push('mutates from a working directory outside the workspace');
      return;
    }

    for (const operand of pathOperands) {
      const absolutePath = resolvePath(this.cwd, operand, this.workspaceRoot);
      if (!isInside(this.workspaceRoot, absolutePath)) {
        segment.touchesOutsideWorkspace = true;
        analysis.touchesOutsideWorkspace = true;
        analysis.reasons.push(`references outside-workspace path (${displayPath(this.workspaceRoot, absolutePath)})`);
      }
    }
  }
}

function sanitizeCommand(rawCommand) {
  const command = String(rawCommand || '').replace(/\r\n?/g, '\n').trim();

  if (!command) return { ok: true, command };
  if (command.length > 8000) {
    return { ok: false, command, reason: 'Command is too long.' };
  }
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(command)) {
    return { ok: false, command, reason: 'Command contains unsupported control characters.' };
  }

  return { ok: true, command };
}

function isOperator(token) {
  return token && typeof token === 'object' && typeof token.op === 'string';
}

function isReadOnlyGhCommand(words) {
  const group = stripQuotes(words[1] || '').toLowerCase();
  const action = stripQuotes(words[2] || '').toLowerCase();
  if (group === 'api') {
    const methodIndex = words.findIndex((word) => ['-X', '--method'].includes(stripQuotes(word)));
    if (methodIndex >= 0) return stripQuotes(words[methodIndex + 1] || '').toUpperCase() === 'GET';
    return !words.some((word) => ['-f', '-F', '--field', '--raw-field', '--input'].includes(stripQuotes(word)));
  }
  return READ_ONLY_GH_COMMANDS.get(group)?.has(action) || false;
}

function markMutating(analysis, segment, reason) {
  segment.isReadOnly = false;
  analysis.isReadOnly = false;
  analysis.needsApproval = true;
  analysis.reasons.push(reason);
}

function collectPathOperands(command, args) {
  if (!COMMANDS_WITH_PATH_OPERANDS.has(command)) return [];
  const operands = [];

  for (let i = 0; i < args.length; i++) {
    const arg = stripQuotes(args[i]);
    if (!arg || arg === '--') continue;

    if (arg.startsWith('-')) {
      if (optionConsumesNext(command, arg)) i++;
      continue;
    }

    if (looksLikePath(arg)) operands.push(arg);
  }

  return operands;
}

function optionConsumesNext(command, option) {
  if (command === 'find' && ['-name', '-path', '-type', '-maxdepth', '-mindepth'].includes(option)) return true;
  if (command === 'grep' && ['-e', '-f', '--exclude', '--include'].includes(option)) return true;
  return false;
}

function isCurlWriteOption(word) {
  const option = stripQuotes(word);
  return option === '-o' || option === '-O' || option === '-J' || option === '--output' || option === '--remote-name' || option === '--remote-header-name' || option.startsWith('--output=');
}

function looksLikePath(value) {
  if (!value) return false;
  if (value.includes('*') || value.includes('?') || value.includes('[')) return true;
  return value === '.' || value === '..' || value.startsWith('/') || value.startsWith('./') || value.startsWith('../') || value.includes('/');
}

function resolvePath(cwd, value, workspaceRoot = cwd) {
  const text = String(value || '');
  if (isWorkspaceAbsolutePath(text)) {
    return resolve(workspaceRoot, text.replace(/^\/+/u, ''));
  }
  return isAbsolute(text) ? resolve(text) : resolve(cwd, text);
}

function normalizeWorkspaceAbsoluteCommandPaths(command, workspaceRoot) {
  return String(command || '').replace(
    /(^|[\s=:])\/(?!\/)(?!Applications(?:\/|$)|Library(?:\/|$)|System(?:\/|$)|Users(?:\/|$)|Volumes(?:\/|$)|bin(?:\/|$)|dev(?:\/|$)|etc(?:\/|$)|home(?:\/|$)|opt(?:\/|$)|private(?:\/|$)|proc(?:\/|$)|root(?:\/|$)|sbin(?:\/|$)|tmp(?:\/|$)|usr(?:\/|$)|var(?:\/|$))([^\s"'`$;&|<>)]*)/gu,
    (_match, prefix, workspacePath) => `${prefix}${quoteShellWord(resolve(workspaceRoot, workspacePath))}`,
  );
}

function quoteShellWord(value) {
  const text = String(value || '');
  if (!text) return "''";
  if (/^[A-Za-z0-9_/@%+=:,.;*?[\]-]+$/u.test(text)) return text;
  return `'${text.replace(/'/g, `'\\''`)}'`;
}

function isWorkspaceAbsolutePath(value) {
  const text = String(value || '').replace(/\\/g, '/');
  if (!text.startsWith('/') || text.startsWith('//')) return false;
  return !/^\/(?:Applications|Library|System|Users|Volumes|bin|dev|etc|home|opt|private|proc|root|sbin|tmp|usr|var)(?:\/|$)/u.test(text);
}

function isInside(root, candidate) {
  const rel = relative(root, candidate);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function displayPath(root, absolutePath) {
  return isInside(root, absolutePath) ? `/${relative(root, absolutePath)}` : absolutePath;
}

function stripQuotes(value) {
  return String(value).replace(/^["']|["']$/g, '');
}

function formatReasons(reasons) {
  return reasons.length ? `Reasons: ${reasons.join('; ')}.` : '';
}
