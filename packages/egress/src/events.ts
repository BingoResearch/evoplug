/**
 * Egress ledger event names, row schema and the DD-FND-097.2 row hash.
 *
 * `after_hash = sha256(JCS({row_schema, row_json}))` over the complete DDL
 * column set. The persistence layer supplies `row_json`; this helper only
 * fixes the preimage, never fills missing columns.
 */




