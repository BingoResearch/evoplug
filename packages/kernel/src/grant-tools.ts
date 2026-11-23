/**
 * Grant primitives re-exported for the app layer (DD-FND-021).
 *
 * `@evoplug/auth` is a kernel dependency; the app composition root may not
 * import it directly. These are the same implementations, not copies.
 */

export {
  createGrant,
  grantIssueSubjectHash,
  grantRevokeSubjectHash,
  revokeGrant,
  toGrantPublicView,
  validateGrantIssueRequest
} from "@evoplug/auth";
export type {
  AuthorizationGrant,
  GrantIssueRequest,
  GrantRevokeRequest
} from "@evoplug/auth";
