/**
 * Tiny argv parser for the `pe` CLI.
 *
 * The parser is deliberately schema-free: it knows which flags are boolean and
 * treats every other `--flag` as taking a value. Command modules validate the
 * options they actually use. Repeated flags become arrays, which is how
 * `--file` / `--item` work.
 */

export class UsageError extends Error {
  constructor(message) {
    super(message);
    this.name = "UsageError";
    this.exitCode = 2;
  }
}

const BOOLEAN_FLAGS = new Set([
  "json",
  "yes",
  "wait",
  "help",
  "cli-version",
  "unread",
  "deep",
  "force",
  "start",
  "adopt",
  "enable",
  "disable",
  "run-now",
  "quiet",
]);

const SHORT_FLAGS = new Map([
  ["-h", "help"],
  ["-j", "json"],
  ["-y", "yes"],
]);

function addOption(options, name, value) {
  if (!Object.hasOwn(options, name)) {
    options[name] = value;
    return;
  }
  const current = options[name];
  options[name] = Array.isArray(current) ? [...current, value] : [current, value];
}

export function parseArgv(argv) {
  const options = Object.create(null);
  const positionals = [];

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--") {
      positionals.push(...argv.slice(index + 1));
      break;
    }

    if (SHORT_FLAGS.has(token)) {
      addOption(options, SHORT_FLAGS.get(token), true);
      continue;
    }

    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }

    let name = token.slice(2);
    let value = null;
    const equals = name.indexOf("=");
    if (equals >= 0) {
      value = name.slice(equals + 1);
      name = name.slice(0, equals);
    }
    if (!name) throw new UsageError(`无法解析参数：${token}`);

    if (value === null) {
      if (BOOLEAN_FLAGS.has(name)) {
        value = true;
      } else if (index + 1 < argv.length && !argv[index + 1].startsWith("-")) {
        value = argv[index + 1];
        index += 1;
      } else {
        value = "";
      }
    }
    addOption(options, name, value);
  }

  return { options, positionals };
}

export function opt(options, name, fallback = undefined) {
  const value = options[name];
  if (value === undefined) return fallback;
  if (Array.isArray(value)) return value[value.length - 1];
  return value;
}

export function optList(options, name) {
  const value = options[name];
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

export function flag(options, name) {
  return options[name] === true || options[name] === "true" || options[name] === "";
}

export function requireOpt(options, name, usage) {
  const value = opt(options, name);
  if (value === undefined || value === null || value === "") {
    throw new UsageError(`缺少 --${name}。用法：${usage}`);
  }
  return value;
}

export function requireArg(positionals, index, label, usage) {
  const value = positionals[index];
  if (value === undefined || value === "") {
    throw new UsageError(`缺少 ${label}。用法：${usage}`);
  }
  return value;
}

export function integerOpt(options, name, { fallback = undefined, min = null, max = null } = {}) {
  const raw = opt(options, name);
  if (raw === undefined || raw === null || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value)) throw new UsageError(`--${name} 必须是整数，收到：${raw}`);
  if (min !== null && value < min) throw new UsageError(`--${name} 不能小于 ${min}`);
  if (max !== null && value > max) throw new UsageError(`--${name} 不能大于 ${max}`);
  return value;
}

/** Resolve the `--wait` contract: boolean flag, optional `--wait=<seconds>`. */
export function waitOptions(options, { defaultSeconds = 120 } = {}) {
  const raw = options.wait;
  const enabled = raw === true || raw === "true" || (typeof raw === "string" && raw !== "");
  let seconds = defaultSeconds;
  if (typeof raw === "string" && raw !== "") {
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      throw new UsageError(`--wait 的秒数必须是正数，收到：${raw}`);
    }
    seconds = parsed;
  }
  const timeout = opt(options, "timeout");
  if (timeout !== undefined && timeout !== true && timeout !== "") {
    const parsed = Number(timeout);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      throw new UsageError(`--timeout 的秒数必须是正数，收到：${timeout}`);
    }
    seconds = parsed;
  }
  return { enabled, timeoutMs: Math.round(seconds * 1000), seconds };
}
