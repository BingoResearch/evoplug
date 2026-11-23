/**
 * SQLite-backed read repositories for the QP typed tables (DD-QP-27,
 * DD-QP-27a).
 *
 * The five QP tables are relationship indexes; the immutable bodies live in
 * `object_document` / `object_head`. After a journal-only recovery a
 * restarted process must be able to read the recovered issue, judgment,
 * transition, plan and plan state back, so the QP repositories accept an
 * optional read source.
 *
 * The read source is the structural transaction port of `@evoplug/core`, not
 * a storage-package type: QP never imports the storage package.
 */

