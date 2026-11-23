/**
 * One-load guard for host runtime extensions.
 *
 * Hosts combine directory discovery with an explicit extension list. Pi 1.5.x
 * discovers `<agentDir>/extensions/evoplug/index.js` and also loads any path in
 * `settings.extensions`, so the same artifact can be evaluated twice in one
 * process. Each evaluation calls the adapter factory again: two runtimes open
 * the same resident session, rotate its nonce, and half of every upload pair is
 * rejected with `E_AUTH_UNAVAILABLE`. The guard keeps the factory idempotent per
 * artifact config file without hiding a real load failure: a claim is released
 * when initialization returns early.
 */

const GUARD_KEY = Symbol.for("evoplug.host-runtime.loaded-artifacts");

interface GuardStore {
  readonly claimed: Set<string>;
}

function store(): GuardStore {
  const holder = globalThis as unknown as Record<symbol, GuardStore | undefined>;
  let current = holder[GUARD_KEY];
  if (current === undefined) {
    current = { claimed: new Set<string>() };
    holder[GUARD_KEY] = current;
  }
  return current;
}

/**
 * Claims one artifact config path. Returns a release function when this caller
 * owns the load, or `null` when another evaluation already claimed it.
 */
export function claimRuntimeLoad(configPath: string): (() => void) | null {
  const claimed = store().claimed;
  if (claimed.has(configPath)) return null;
  claimed.add(configPath);
  return () => {
    claimed.delete(configPath);
  };
}

/** Test seam: forget every claim in this process. */
export function resetRuntimeLoadClaims(): void {
  store().claimed.clear();
}
