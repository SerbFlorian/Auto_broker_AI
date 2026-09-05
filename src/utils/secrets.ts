/**
 * Redact secrets before logs / Telegram CRITICAL alerts.
 */
const PATTERNS: Array<{ re: RegExp; to: string }> = [
  { re: /\b\d{8,10}:[A-Za-z0-9_-]{30,}\b/g, to: '[REDACTED_BOT_TOKEN]' },
  { re: /\bsk_(?:live|test)_[A-Za-z0-9]+\b/g, to: '[REDACTED_STRIPE_KEY]' },
  { re: /\bwhsec_[A-Za-z0-9]+\b/g, to: '[REDACTED_WHSEC]' },
  { re: /\bsk-[A-Za-z0-9_-]{20,}\b/g, to: '[REDACTED_OPENAI_KEY]' },
  {
    re: /(postgres(?:ql)?:\/\/[^:/?#\s]+):([^@/\s]+)@/gi,
    to: '$1:[REDACTED]@'
  },
  { re: /(redis:\/\/[^:]*):([^@/\s]+)@/gi, to: '$1:[REDACTED]@' },
  { re: /(redis:\/\/:)([^@/\s]+)@/gi, to: '$1[REDACTED]@' },
  { re: /(Bearer\s+)[A-Za-z0-9._\-+=\/]+/gi, to: '$1[REDACTED]' },
  {
    re: /\b([A-Z][A-Z0-9_]*(?:PASSWORD|SECRET|TOKEN|API_KEY|ACCESS_KEY|PRIVATE_KEY)[A-Z0-9_]*)\s*[=:]\s*([^\s&'"]+)/gi,
    to: '$1=[REDACTED]'
  },
  {
    re: /(Authorization["']?\s*:\s*["']?)[^"'\s]+/gi,
    to: '$1[REDACTED]'
  }
];

export function redactSecrets(input: unknown): string {
  let text =
    typeof input === 'string'
      ? input
      : input instanceof Error
        ? `${input.name}: ${input.message}${input.stack ? `\n${input.stack}` : ''}`
        : (() => {
            try {
              return JSON.stringify(input);
            } catch {
              return String(input);
            }
          })();

  for (const { re, to } of PATTERNS) {
    text = text.replace(re, to);
  }
  return text;
}

/** Comma-separated positive Telegram user ids allowed for admin commands. */
export function getAdminUserIds(): number[] {
  const raw = process.env.TELEGRAM_ADMIN_USER_IDS || '';
  return raw
    .split(',')
    .map((s) => parseInt(s.trim(), 10))
    .filter((n) => Number.isFinite(n) && n > 0);
}

export function isAdminUser(telegramId: number | undefined | null): boolean {
  if (!telegramId) return false;
  const ids = getAdminUserIds();
  if (ids.length === 0) return false;
  return ids.includes(Number(telegramId));
}

export function isBrightDataEnabled(): boolean {
  const flag = (process.env.BRIGHTDATA_ENABLED || 'false').toLowerCase();
  if (flag === 'false' || flag === '0' || flag === 'off' || flag === 'no') {
    return false;
  }
  return flag === 'true' || flag === '1' || flag === 'on' || flag === 'yes';
}
