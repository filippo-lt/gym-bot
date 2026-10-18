/** Function maxDuration (api/telegram.ts and api/cron/tick.ts in vercel.json). */
export const MAX_DURATION_S = 60;
/** Chat lease: always maxDuration + 60 s, so a live holder never loses it (SPEC §3). */
export const LEASE_S = 120;
/** Stop taking new rows this many seconds after the invocation started. */
export const STOP_TAKING_AT_S = 45;
export const MAX_ATTEMPTS = 3;
