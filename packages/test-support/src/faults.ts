/**
 * Typed fault injection points (testing design TST 5.1).
 *
 * A `FaultRegistry` is an ordinary object owned by one test. It never uses
 * module-global mutable state, so parallel cases in the same process cannot
 * see each other's faults. The registry only decides *which* action applies
 * and counts occurrences; executing a kill, hang or disconnect belongs to the
 * harness that owns the process, socket or fake host.
 */

export type FaultPoint =
  | "blob.after_write_before_fsync"
  | "blob.after_fsync"
  | "journal.after_append_before_fsync"
  | "journal.after_fsync"
  | "sqlite.after_commit_before_ack"
  | "ack.before_return"
  | "ipc.after_send"
  | "queue.enqueue"
  | "gateway.after_send"
  | "delivery.before_host"
  | "delivery.after_host_accept_before_record"
  | "write.before_replace"
  | "write.after_replace"
  | "reader.slow"
  | "fs.enospc"
  | "sqlite.busy"
  | "process.kill";

