import { redactSecrets } from './secrets.js';

type LogFn = (...args: unknown[]) => void;

function formatArgs(args: unknown[]): unknown[] {
  return args.map((a) => {
    if (typeof a === 'string') return redactSecrets(a);
    if (a instanceof Error) return redactSecrets(a);
    if (a && typeof a === 'object') {
      try {
        return redactSecrets(JSON.stringify(a));
      } catch {
        return redactSecrets(String(a));
      }
    }
    return a;
  });
}

function wrap(fn: LogFn): LogFn {
  return (...args: unknown[]) => fn(...formatArgs(args));
}

/**
 * Patch console so accidental secret dumps in logs are redacted.
 * Call once at process boot (before other imports that log, when possible).
 */
export function installRedactedConsole(): void {
  console.log = wrap(console.log.bind(console));
  console.info = wrap(console.info.bind(console));
  console.warn = wrap(console.warn.bind(console));
  console.error = wrap(console.error.bind(console));
  console.debug = wrap(console.debug.bind(console));
}

export const logger = {
  info: (...args: unknown[]) => console.log(...formatArgs(args)),
  warn: (...args: unknown[]) => console.warn(...formatArgs(args)),
  error: (...args: unknown[]) => console.error(...formatArgs(args)),
  debug: (...args: unknown[]) => console.debug(...formatArgs(args))
};
