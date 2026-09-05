/**
 * Process role for dual-container deploy.
 * - all: monolith (local / single container)
 * - app: Telegram bot + Stripe webhook + digests + R2 backup
 * - scraper: Playwright/HTTP scrapers + DB cleanup (no bot polling, no HTTP)
 */
export type WorkerMode = 'all' | 'app' | 'scraper';

export function getWorkerMode(): WorkerMode {
  const raw = (process.env.WORKER_MODE || 'all').trim().toLowerCase();
  if (raw === 'app' || raw === 'scraper' || raw === 'all') return raw;
  // A typo here would silently start a second bot poller / duplicate scrapers.
  throw new Error(
    `Invalid WORKER_MODE="${process.env.WORKER_MODE}". Use one of: all | app | scraper.`
  );
}

export function runsAppRole(mode: WorkerMode = getWorkerMode()): boolean {
  return mode === 'all' || mode === 'app';
}

export function runsScraperRole(mode: WorkerMode = getWorkerMode()): boolean {
  return mode === 'all' || mode === 'scraper';
}
