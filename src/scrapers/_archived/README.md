/**
 * Wallapop scraper — ARCHIVED for soft-launch.
 *
 * Reasons:
 * - TypeScript errors (`search_objects` on untyped `{}`) broke `npm run typecheck` / CI.
 * - Not wired into the production scraper cron (`scraper.job.ts` has it commented out).
 * - Re-enable only after: typed API response, `validateAndEnrich`, and state/dedupe coverage.
 *
 * Do not import this file from production paths until those land.
 */
export {};
