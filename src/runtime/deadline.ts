import { AsyncLocalStorage } from "node:async_hooks";

const store = new AsyncLocalStorage<{ endMs: number }>();

/** Runs `fn` under a hard end time (epoch ms) that nested async code can read. */
export function runWithDeadline<T>(endMs: number, fn: () => Promise<T>): Promise<T> {
  return store.run({ endMs }, fn);
}

/** Milliseconds left under the current deadline; `Infinity` outside one. */
export function timeLeftMs(now: number = Date.now()): number {
  const ctx = store.getStore();
  return ctx ? ctx.endMs - now : Number.POSITIVE_INFINITY;
}

/** Clamps a timeout to the time left minus a margin, never below 1 s. */
export function clampTimeout(ms: number, marginMs = 5_000): number {
  return Math.max(1_000, Math.min(ms, timeLeftMs() - marginMs));
}
