/**
 * `@evoplug/delivery` public surface.
 *
 * DD-FND-092 delivery plan/record, three-axis state machine, dedupe and the
 * DD-FND-097.4 history derivation, plus delivery effects for the outbox.
 */

export * from "./types.js";
export * from "./errors.js";
export * from "./dedupe.js";
export * from "./create.js";
export * from "./state.js";
export * from "./outbox.js";
export * from "./events.js";
