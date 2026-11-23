/**
 * Delivery ledger event name, row schema and DD-FND-097.2 row hash.
 *
 * `delivery.create`, every `delivery.update` and outbox `delivery.expire`
 * write one `delivery.recorded` frame with the complete post-update row.
 * `delivery_history` is a derived projection, not a ledger row schema.
 */




