/**
 * `@evoplug/test-support` public surface.
 *
 * Test-only building blocks shared by the unit, functional, integration and
 * fault suites: a deterministic clock, an isolated `EVOPLUG_HOME`, a per-test
 * fault registry, deterministic fixture construction and small assertions.
 *
 * Nothing here owns module-global mutable state. Each test creates its own
 * clock, home, fault registry and fixture builder.
 */

export * from "./clock.js";
export * from "./temp-home.js";
export * from "./faults.js";
export * from "./fixtures.js";
export * from "./assertions.js";
