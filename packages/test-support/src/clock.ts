/**
 * Deterministic clock for tests.
 *
 * `FakeClock` implements the production `Clock` port so services can be built
 * against either implementation. Monotonic time only moves forward through
 * `advance`; wall time can be moved backwards with `setUtcNowMs` to prove that
 * persisted ordering never depends on the wall clock (testing design TST 5).
 *
 * The clock owns no timers. Tests that need scheduled callbacks should use the
 * harness timer queue; deadlines are created explicitly with `deadlineIn`.
 */

import type { Clock } from "@evoplug/core";

export interface FakeClockOptions {
  /** Initial wall-clock epoch in milliseconds. Defaults to 0. */
  readonly startUtcMs?: number;
  /** Initial monotonic reading in milliseconds. Defaults to 0. */
  readonly startMonotonicMs?: number;
}

function assertNonNegativeFinite(value: number, name: string): void {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative finite number, received ${String(value)}`);
  }
}

/**
 * Test clock with manual advancement.
 *
 * `advance(deltaMs)` moves both the monotonic reading and the wall clock by the
 * same delta. This keeps timestamped fixtures in step with deadline arithmetic.
 * Use `setUtcNowMs` when a test needs to move only the wall clock (including
 * backwards).
 */
export class FakeClock implements Clock {
  private utcMs: number;
  private monotonicMs: number;

  constructor(options: FakeClockOptions = {}) {
    const startUtcMs = options.startUtcMs ?? 0;
    const startMonotonicMs = options.startMonotonicMs ?? 0;
    assertNonNegativeFinite(startUtcMs, "startUtcMs");
    assertNonNegativeFinite(startMonotonicMs, "startMonotonicMs");
    this.utcMs = startUtcMs;
    this.monotonicMs = startMonotonicMs;
  }

  /** Current wall-clock epoch in milliseconds. */
  utcNowMs(): number {
    return this.utcMs;
  }

  /** Current monotonic reading in milliseconds. */
  monotonicNowMs(): number {
    return this.monotonicMs;
  }

  /**
   * Remaining time until an absolute reading on this clock's monotonic
   * timeline. Expired deadlines return 0, matching the production clock.
   */
  monotonicRemainingMs(deadline: number): number {
    if (!Number.isFinite(deadline)) {
      throw new RangeError(`deadline must be a finite monotonic timestamp, received ${String(deadline)}`);
    }
    const remaining = deadline - this.monotonicMs;
    return remaining > 0 ? remaining : 0;
  }

  /** Absolute monotonic reading `delayMs` in the future. */
  deadlineIn(delayMs: number): number {
    assertNonNegativeFinite(delayMs, "delayMs");
    return this.monotonicMs + delayMs;
  }

  /**
   * Advance monotonic and wall time by `deltaMs`. No timers fire; callbacks
   * scheduled by the harness are executed by the harness, not by this clock.
   */
  advance(deltaMs: number): void {
    assertNonNegativeFinite(deltaMs, "deltaMs");
    this.monotonicMs += deltaMs;
    this.utcMs += deltaMs;
  }

  /**
   * Set the wall clock without touching monotonic time. Backwards movement is
   * allowed by design so ordering tests cannot accidentally rely on it.
   */
  setUtcNowMs(epochMs: number): void {
    if (!Number.isSafeInteger(epochMs) || epochMs < 0) {
      throw new RangeError(`epochMs must be a non-negative safe integer, received ${String(epochMs)}`);
    }
    this.utcMs = epochMs;
  }
}

/** Creates a deterministic clock; equivalent to `new FakeClock(options)`. */
export function createFakeClock(options: FakeClockOptions = {}): FakeClock {
  return new FakeClock(options);
}
