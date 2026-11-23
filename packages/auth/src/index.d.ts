/**
 * `@evoplug/auth` public surface (DD-FND-090, DD-FND-091, DD-FND-095).
 *
 * Authorization grants and decisions, managed write intents and the managed
 * block byte grammar, plus config-write patch hashing and request validation.
 * The `ConfigWritePort` DTOs themselves live in `@evoplug/core`.
 */
export * from "./errors.js";
export * from "./path-glob.js";
export * from "./grants.js";
export * from "./decision.js";
export * from "./block.js";
export * from "./write-intent.js";
export * from "./consumption.js";
export * from "./config-patch.js";
