/**
 * Bounded barrier drain used before the online pipeline reads trigger signals.
 *
 * `Promise.race([drain, timeout])` leaves the fallback timer armed after the
 * drain wins, so a later tick writes a misleading `online_barrier_timeout`
 * diagnostic even though the barrier was already empty. This helper clears the
 * timer on the winning side; the timeout fires only for a drain that is still
 * pending after `timeout_ms`.
 */
export type DrainOutcome = "drained" | "timeout";

export function drainWithTimeout(
  drain: () => Promise<void>,
  timeout_ms: number,
  on_timeout: () => void
): Promise<DrainOutcome> {
  return new Promise<DrainOutcome>((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (outcome: DrainOutcome): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      resolve(outcome);
    };
    timer = setTimeout(() => {
      on_timeout();
      finish("timeout");
    }, timeout_ms);
    // A pending drain must not keep the process alive by itself.
    (timer as { unref?: () => void }).unref?.();
    // A drain rejection is treated as completion: hook failures are recorded
    // by the fanout and must never turn into an ingest error.
    void drain().then(
      () => finish("drained"),
      () => finish("drained")
    );
  });
}
