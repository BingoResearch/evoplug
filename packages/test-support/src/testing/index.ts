/**
 * `@evoplug/test-support/testing` entry.
 *
 * The package already exposes a `./testing` subpath for workspace symmetry
 * (DD-FND-022). For test-support that surface is the same helpers as the root
 * entry; re-exporting keeps both specifiers valid.
 */

export * from "../index.js";
