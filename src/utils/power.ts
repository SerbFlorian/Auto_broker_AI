/**
 * Normalize portal power figures to metric CV (same unit we store in powerHp).
 *
 * Conversions:
 *   kW → CV  ≈ × 1.35962
 *   HP / BHP / PS / CH / CV → stored as-is (rounded)
 */
const KW_TO_CV = 1.35962;

export function kwToCv(kw: number): number {
  return Math.round(kw * KW_TO_CV);
}

/**
 * Parse a free-text power field from a portal or a version string.
 * Prefers an explicit unit; bare numbers are only accepted when `allowBare` is true
 * (detail "Power" fields), never from noisy version blobs.
 */
export function parsePowerCv(
  raw: string | null | undefined,
  opts: { allowBare?: boolean } = {}
): number | null {
  if (!raw) return null;
  const text = String(raw).replace(/,/g, '.').trim();
  if (!text) return null;

  const kw = text.match(/(\d+(?:\.\d+)?)\s*k\s*w\b/i);
  if (kw?.[1]) {
    const n = parseFloat(kw[1]);
    return n > 0 && n < 2000 ? kwToCv(n) : null;
  }

  const withUnit = text.match(
    /(\d+(?:\.\d+)?)\s*(?:cv|ch|hp|ps|bhp|din)\b/i
  );
  if (withUnit?.[1]) {
    const n = Math.round(parseFloat(withUnit[1]));
    return n > 20 && n < 2000 ? n : null;
  }

  // Parenthetical "(150 HP)" / "(110kW)"
  const parenKw = text.match(/\((\d+(?:\.\d+)?)\s*k\s*w\)/i);
  if (parenKw?.[1]) {
    const n = parseFloat(parenKw[1]);
    return n > 0 && n < 2000 ? kwToCv(n) : null;
  }
  const parenHp = text.match(/\((\d+(?:\.\d+)?)\s*(?:cv|ch|hp|ps|bhp)\)/i);
  if (parenHp?.[1]) {
    const n = Math.round(parseFloat(parenHp[1]));
    return n > 20 && n < 2000 ? n : null;
  }

  if (opts.allowBare) {
    const bare = text.match(/^(\d{2,4})$/);
    if (bare?.[1]) {
      const n = parseInt(bare[1], 10);
      return n > 20 && n < 2000 ? n : null;
    }
  }

  return null;
}

/** Pick the first usable CV from several candidate strings. */
export function firstPowerCv(
  ...candidates: Array<string | number | null | undefined>
): number | null {
  for (const c of candidates) {
    if (typeof c === 'number' && c > 20 && c < 2000) return Math.round(c);
    if (typeof c === 'string') {
      const n = parsePowerCv(c, { allowBare: true });
      if (n) return n;
    }
  }
  return null;
}
