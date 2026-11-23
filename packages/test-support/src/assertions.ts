/**
 * Small assertion and asynchronous helpers for tests.
 *
 * These helpers deliberately keep failure messages short and do not import a
 * test runner, so they work in unit, functional, integration and fault suites.
 */

import type { ErrorEnvelope, Result } from "@evoplug/core";

/** Returns the success value or throws with the failure code and status. */
export function assertOk<T, E extends ErrorEnvelope>(result: Result<T, E>): T {
  if (!result.ok) {
    throw new Error(`expected Ok, received ${result.status}/${result.error.code}`);
  }
  return result.value;
}

/** Returns the error envelope or throws when the result is a success. */
export function assertErr<T, E extends ErrorEnvelope>(result: Result<T, E>): E {
  if (result.ok) {
    throw new Error(`expected Err, received ${result.status}`);
  }
  return result.error;
}

export interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T | PromiseLike<T>) => void;
  readonly reject: (reason?: unknown) => void;
}

/** A promise whose settlement is controlled by the test. */
export function deferred<T>(): Deferred<T> {
  let resolvePromise!: (value: T | PromiseLike<T>) => void;
  let rejectPromise!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return {
    promise,
    resolve: resolvePromise,
    reject: rejectPromise
  };
}

interface WaitForOptions {
  /** Maximum real time to wait. Defaults to 1000 ms. */
  readonly timeoutMs?: number;
  /** Poll interval in real time. Defaults to 10 ms. */
  readonly intervalMs?: number;
}

function assertDuration(value: number, name: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative finite number, received ${String(value)}`);
  }
}

/**
 * Polls `predicate` on real timers until it returns true or the timeout
 * expires. The fake clock does not drive real timers, so this helper is for
 * cases where the awaited condition is external to the clock.
 */
export async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  options: WaitForOptions = {}
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 1000;
  const intervalMs = options.intervalMs ?? 10;
  assertDuration(timeoutMs, "timeoutMs");
  assertDuration(intervalMs, "intervalMs");
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) {
      return;
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new Error(`waitFor timed out after ${String(timeoutMs)} ms`);
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, Math.min(intervalMs, remaining));
    });
  }
}
