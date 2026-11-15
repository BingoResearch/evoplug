/**
 * Cross-domain port DTOs owned by FND and consumed by CFG, REV and HOST
 * (DD-FND-090, DD-FND-095).
 *
 * `src/index.ts` re-exports this module; consumers must not deep-import it.
 */

export * from "./write-decision.js";
export * from "./config-write.js";
export * from "./replay.js";
export * from "./adapter-install.js";
export * from "./decision-draft.js";
export * from "./admission.js";
