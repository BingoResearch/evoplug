/**
 * `@evoplug/ipc` public surface.
 *
 * Transport only: frame codec, hello authentication, dispatcher, client, and
 * the idempotency port. No SQLite, journal, or domain package is imported here.
 */

export * from "./crc32c.js";
export * from "./frame.js";
export * from "./protocol.js";
export * from "./methods.js";
export * from "./errors.js";
export * from "./json.js";
export * from "./validation.js";
export * from "./endpoint.js";
export * from "./idempotency.js";
export * from "./dispatcher.js";
export * from "./server.js";
export * from "./client.js";
