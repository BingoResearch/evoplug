/**
 * Admission control and resource statistics for the FND layer
 * (DD-FND-103, TST LOAD §2.3).
 *
 * The typed contracts live in `../ports/admission.ts`; this module owns the
 * frozen policy, the in-memory queue and the two port implementations.
 */

export * from "./policy.js";
export * from "./ports.js";
