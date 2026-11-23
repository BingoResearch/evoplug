/**
 * Clock port (DD-FND-034 cross-domain table).
 *
 * Wall-clock timestamps (`*_at` fields) and duration budgets are separate
 * axes: `utcNowMs()` only feeds persisted timestamps, while deadline remaining
 * time is measured on the monotonic timeline and never with `Date.now()`.
 *
 * A `deadline` value is an absolute reading on the same monotonic timeline as
 * the clock instance, in milliseconds. Callers that create deadlines must use
 * a clock from the same origin (the system clock uses `performance.now()`).
 */

import { performance } from "node:perf_hooks";

export interface Clock {
  utcNowMs(): number;
  /**
   * The current reading on the monotonic timeline. A caller builds a
   * deadline as `monotonicNowMs() + remainingMs` so the deadline lives on
   * the same timeline as the clock instance; a fake clock with its own
   * origin is then honoured exactly.
   */
  monotonicNowMs(): number;
  monotonicRemainingMs(deadline: number): number;
}

/** Production clock backed by `Date.now()` and `performance.now()`. */
function createSystemClock(): Clock {
  return Object.freeze({
    utcNowMs(): number {
      return Date.now();
    },
    monotonicNowMs(): number {
      return performance.now();
    },
    monotonicRemainingMs(deadline: number): number {
      if (!Number.isFinite(deadline)) {
        throw new RangeError(`deadline must be a finite monotonic timestamp, received ${String(deadline)}`);
      }
      const remaining = deadline - performance.now();
      return remaining > 0 ? remaining : 0;
    }
  });
}

/** Shared production clock instance. */
export const systemClock: Clock = createSystemClock();
