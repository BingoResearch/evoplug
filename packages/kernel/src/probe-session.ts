/**
 * Kernel probe-session markers (design appendix H.3, appendix L.1).
 *
 * A kernel-launched probe authenticates `host_runtime_session.session_role =
 * 'evaluator'`. The runtime cannot author that column directly; the kernel
 * records the role it authenticates from the ready request, and the probe
 * launcher's isolation environment forces `evaluator`. `ephemeral` only says
 * the runtime process exits after one hook event, so a one-shot host session
 * is a `host_session` and is not suppressed.
 *
 * Probe uploads remain part of the evidence stream (the probe collector joins
 * `host_runtime_upload`), but downstream consumers must treat them as
 * evaluator work: no review signal, no TaskOutcome, no confirmation slot.
 *
 * The event draft itself cannot carry `origin=evaluator` on every event:
 * internal trigger lineage requires an already-committed root event, and a
 * probe session's first event has none. The session marker is therefore the
 * stable, kernel-owned source of truth.
 */

import type { SqlRow, SqliteConnection } from "@evoplug/storage";

function tableExists(connection: SqliteConnection, name: string): boolean {
  try {
    const row = connection
      .prepare<SqlRow>("SELECT name FROM sqlite_master WHERE type = 'table' AND name = :name LIMIT 1")
      .get({ name });
    return row !== undefined;
  } catch {
    return false;
  }
}

function isEvaluator(connection: SqliteConnection, where: string, value: string): boolean {
  if (!tableExists(connection, "host_runtime_session")) return false;
  try {
    const row = connection
      .prepare<SqlRow>(
        `SELECT session_role FROM host_runtime_session WHERE ${where} = :value
          ORDER BY started_at DESC LIMIT 1`
      )
      .get({ value });
    return row !== undefined && row["session_role"] === "evaluator";
  } catch {
    return false;
  }
}

/** True when the native session id belongs to a kernel-launched probe. */
export function isKernelProbeNativeSession(
  connection: SqliteConnection,
  native_session_id: string | null | undefined
): boolean {
  if (typeof native_session_id !== "string" || native_session_id.length === 0) return false;
  return isEvaluator(connection, "native_session_id", native_session_id);
}

/** True when the runtime session id belongs to a kernel-launched probe. */
export function isKernelProbeRuntimeSession(
  connection: SqliteConnection,
  session_id: string | null | undefined
): boolean {
  if (typeof session_id !== "string" || session_id.length === 0) return false;
  return isEvaluator(connection, "session_id", session_id);
}

/** True when a committed event came from a kernel-launched probe session. */
export function isKernelProbeEvent(
  connection: SqliteConnection,
  event_id: string | null | undefined
): boolean {
  if (typeof event_id !== "string" || event_id.length === 0) return false;
  if (!tableExists(connection, "event_log") || !tableExists(connection, "session")) return false;
  try {
    const row = connection
      .prepare<SqlRow>(
        `SELECT s.external_session_id AS native_session_id
           FROM event_log e
           JOIN session s ON s.session_id = e.session_id
          WHERE e.event_id = :event_id
          LIMIT 1`
      )
      .get({ event_id });
    if (row === undefined) return false;
    const nativeId = row["native_session_id"];
    return typeof nativeId === "string" && isKernelProbeNativeSession(connection, nativeId);
  } catch {
    return false;
  }
}
