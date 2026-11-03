/**
 * Tiny structured logger with secret redaction.
 *
 * The bot token (or any other configured secret) must never reach stdout,
 * a log file, or a git commit. Every log line passes through `redactSecrets`.
 */

const GENERIC_TOKEN_PATTERN = /\b[\w-]{20,}\.[\w-]{6,}\.[\w-]{25,}\b/g;

export function redactSecrets(text, secrets = []) {
  let out = String(text);
  for (const secret of secrets) {
    if (typeof secret === 'string' && secret.length >= 8) {
      out = out.split(secret).join('[REDACTED]');
    }
  }
  return out.replace(GENERIC_TOKEN_PATTERN, '[REDACTED]');
}

export function createLogger({
  name = 'voice-bridge',
  secrets = [],
  level = 'info',
  sink = console,
  now = () => new Date().toISOString(),
} = {}) {
  const levels = { debug: 10, info: 20, warn: 30, error: 40 };
  const threshold = levels[level] ?? levels.info;

  const format = (lvl, message, extra) => {
    const line = `${now()} ${lvl.toUpperCase()} [${name}] ${message}`;
    const payload = extra === undefined ? '' : ` ${safeStringify(extra)}`;
    return redactSecrets(line + payload, secrets);
  };

  const emit = (lvl, message, extra) => {
    if ((levels[lvl] ?? 0) < threshold) return;
    const line = format(lvl, message, extra);
    if (lvl === 'error' || lvl === 'warn') sink.error(line);
    else sink.log(line);
  };

  return {
    debug: (message, extra) => emit('debug', message, extra),
    info: (message, extra) => emit('info', message, extra),
    warn: (message, extra) => emit('warn', message, extra),
    error: (message, extra) => emit('error', message, extra),
  };
}

function safeStringify(value) {
  if (value instanceof Error) return JSON.stringify({ error: value.message });
  try {
    return JSON.stringify(value);
  } catch {
    return '"[unserializable]"';
  }
}
