/**
 * Replay ledger event names, row schemas and DD-FND-097.2 row hashes.
 *
 * Every event carries a complete row snapshot: the hash preimage is exactly
 * `{row_schema, row_json}`, and insert events use `before_hash=null`. The
 * persistence layer owns the full column projection; this module never fills
 * a missing column.
 */




