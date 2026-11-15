/**
 * Deterministic egress evaluation (DD-FND-093 rules 1-8).
 *
 * The evaluator is pure: DNS resolution, TLS and byte re-computation are
 * performed by the gateway before and after this call. Every dimension is
 * reported in `findings`; the decision reason is chosen in the fixed priority
 * order documented below and never depends on policy array order beyond rule
 * matching.
 *
 * Approval boundary: an approval never substitutes for a policy match. When
 * every dimension matches, `context.require_single_approval` decides whether a
 * matching active approval is mandatory for this send; without it the
 * standing policy authorises the request (`approval_id=null`). The
 * `approval_required` branch exists exactly for that single-use mode and
 * carries `approval_request_hash = request.request_hash`.
 */

import { equalVersionBinding, err, ok } from "@evoplug/core";
import type { ErrorEnvelope, Id, Result, SourceRef, VersionBinding } from "@evoplug/core";

import { egressApprovalCoversRequest } from "./approval.js";
import { egressSchemaError } from "./errors.js";
import { freezeEgressRequest } from "./request.js";
import type {
  EgressApproval,
  EgressDecision,
  EgressDenyReason,
  EgressEndpointRule,
  EgressFinding,
  EgressPolicy,
  EgressRequest,
  EgressRequestInput,
  EgressRequestSource,
} from "./types.js";

export interface EgressSourceStatus {
  readonly retrievable: boolean;
  readonly task_id: Id<"task">;
  readonly branch_id: Id<"br">;
}

export interface EgressEvaluationContext {
  /** Wall clock used only for approval expiry; byte checks use static fields. */
  readonly now_ms: number;
  /** Resolved retrievability and ownership for every source in the request. */
  readonly source_status: ReadonlyMap<SourceRef, EgressSourceStatus>;
  /** Current authoritative binding, when the caller can read it. */
  readonly current_binding?: VersionBinding;
  /** Active approval already looked up by the service, if any. */
  readonly active_approval?: EgressApproval | null;
  /**
   * When true, a policy-matched request still requires one active single-use
   * approval. Defaults to false (standing policy authorises the send).
   */
  readonly require_single_approval?: boolean;
}

interface RuleMatch {
  readonly rule: EgressEndpointRule;
  readonly endpoint: boolean;
  readonly model: boolean;
  readonly data_classes: boolean;
  readonly bytes: boolean;
}

/**
 * Evaluates an egress request against the current policy.
 *
 * Priority for the denial reason:
 * 1. `project_excluded`
 * 2. `secret_forbidden`
 * 3. `binding_mismatch`
 * 4. `replay_policy_denied`
 * 5. `endpoint_not_allowed`
 * 6. `model_not_allowed`
 * 7. `data_class_not_allowed`
 * 8. `source_count_exceeded`
 * 9. `source_unretrievable`
 * 10. `source_not_allowed`
 * 11. `byte_limit_exceeded`
 */
export function evaluateEgress(
  policy: EgressPolicy,
  input: EgressRequestInput,
  context: EgressEvaluationContext,
): Result<EgressDecision, ErrorEnvelope> {
  if (policy.schema_version !== "rsi.egress_policy/1") {
    return err(egressSchemaError("policy.schema_version", "rsi.egress_policy/1"));
  }
  if (input.schema_version !== "rsi.egress_request/1") {
    return err(egressSchemaError("schema_version", "rsi.egress_request/1"));
  }
  if (
    Object.prototype.hasOwnProperty.call(input, "policy_version") ||
    Object.prototype.hasOwnProperty.call(input, "request_hash")
  ) {
    // Both fields are server-derived; a client-supplied copy is never accepted.
    return err(egressSchemaError("request", "server_derived_hash_and_policy_version"));
  }
  const frozen = freezeEgressRequest(input, policy.policy_version);
  if (!frozen.ok) {
    return frozen;
  }
  const request = frozen.value;
  const matches = matchRules(policy, request);
  const selected = selectRule(matches);
  const endpointMatched = matches.some((match) => match.endpoint);
  const modelMatched = matches.some((match) => match.endpoint && match.model);
  const dataClassMatched = matches.some(
    (match) => match.endpoint && match.model && match.data_classes,
  );
  const bytesMatched = selected !== null;
  const projectExcluded = policy.project_exclusions.includes(request.project_id);
  const bindingMismatch =
    context.current_binding !== undefined &&
    !equalVersionBinding(context.current_binding, request.binding);
  const replayDenied =
    request.purpose === "replay" && policy.permission_for_replay === "deny";
  const secretSource = request.sources.find((source) => source.data_class === "secret") ?? null;
  const sourceCountExceeded = request.sources.length > policy.max_source_refs;
  const sourceIssues = classifySources(request.sources, request, context.source_status);
  const findings = buildFindings(
    request,
    projectExcluded,
    endpointMatched,
    modelMatched,
    request.sources.map((source) => dataClassAllowed(matches, source)),
    sourceIssues,
    bytesMatched,
  );

  const denial = firstDenial({
    projectExcluded,
    bindingMismatch,
    replayDenied,
    secretSource,
    endpointMatched,
    modelMatched,
    dataClassMatched,
    sourceCountExceeded,
    sourceIssues,
    selected,
  });
  if (denial !== null) {
    return ok({
      allowed: false,
      request,
      reason_code: denial,
      findings,
    });
  }

  const approval =
    context.active_approval !== null && context.active_approval !== undefined
      ? context.active_approval
      : null;
  const matchingApproval =
    approval !== null && egressApprovalCoversRequest(approval, request, context.now_ms)
      ? approval
      : null;
  if (context.require_single_approval === true && matchingApproval === null) {
    return ok({
      allowed: false,
      request,
      reason_code: "approval_required",
      findings,
      approval_request_hash: request.request_hash,
    });
  }
  return ok({
    allowed: true,
    request,
    policy_version: policy.policy_version,
    approval_id: matchingApproval?.approval_id ?? null,
    findings,
  });
}

/** Finds all rules whose endpoint triple and path prefix match. */
export function matchEndpointRules(
  policy: EgressPolicy,
  request: EgressRequest,
): readonly EgressEndpointRule[] {
  return policy.endpoints.filter((rule) => endpointMatches(rule, request));
}

function matchRules(policy: EgressPolicy, request: EgressRequest): RuleMatch[] {
  return policy.endpoints.map((rule) => {
    const endpoint = endpointMatches(rule, request);
    const model = endpoint && rule.models.includes(request.model);
    const dataClasses =
      model &&
      request.sources.every((source) =>
        rule.data_classes.some((dataClass) => dataClass === source.data_class),
      );
    const bytes = dataClasses && request.byte_length <= rule.max_request_bytes;
    return { rule, endpoint, model, data_classes: dataClasses, bytes };
  });
}

function endpointMatches(rule: EgressEndpointRule, request: EgressRequest): boolean {
  return (
    rule.scheme === request.endpoint.scheme &&
    rule.host === request.endpoint.host &&
    rule.port === request.endpoint.port &&
    request.endpoint.path.startsWith(rule.path_prefix)
  );
}

function selectRule(matches: readonly RuleMatch[]): EgressEndpointRule | null {
  for (const match of matches) {
    if (match.endpoint && match.model && match.data_classes && match.bytes) {
      return match.rule;
    }
  }
  return null;
}

function dataClassAllowed(matches: readonly RuleMatch[], source: EgressRequestSource): boolean {
  return matches.some(
    (match) =>
      match.endpoint &&
      match.model &&
      match.data_classes &&
      match.rule.data_classes.some((dataClass) => dataClass === source.data_class),
  );
}

interface SourceIssue {
  readonly source: EgressRequestSource;
  readonly reason: "source_unretrievable" | "source_not_allowed";
}

function classifySources(
  sources: readonly EgressRequestSource[],
  request: EgressRequest,
  statuses: ReadonlyMap<SourceRef, EgressSourceStatus>,
): SourceIssue[] {
  const issues: SourceIssue[] = [];
  for (const source of sources) {
    const status = statuses.get(source.ref);
    if (status === undefined || !status.retrievable) {
      issues.push({ source, reason: "source_unretrievable" });
      continue;
    }
    if (
      status.task_id !== request.binding.task_id ||
      status.branch_id !== request.binding.branch_id
    ) {
      issues.push({ source, reason: "source_not_allowed" });
    }
  }
  return issues;
}

interface DenialInput {
  readonly projectExcluded: boolean;
  readonly bindingMismatch: boolean;
  readonly replayDenied: boolean;
  readonly secretSource: EgressRequestSource | null;
  readonly endpointMatched: boolean;
  readonly modelMatched: boolean;
  readonly dataClassMatched: boolean;
  readonly sourceCountExceeded: boolean;
  readonly sourceIssues: readonly SourceIssue[];
  readonly selected: EgressEndpointRule | null;
}

function firstDenial(input: DenialInput): EgressDenyReason | null {
  if (input.projectExcluded) {
    return "project_excluded";
  }
  if (input.secretSource !== null) {
    return "secret_forbidden";
  }
  if (input.bindingMismatch) {
    return "binding_mismatch";
  }
  if (input.replayDenied) {
    return "replay_policy_denied";
  }
  if (!input.endpointMatched) {
    return "endpoint_not_allowed";
  }
  if (!input.modelMatched) {
    return "model_not_allowed";
  }
  if (!input.dataClassMatched) {
    return "data_class_not_allowed";
  }
  if (input.sourceCountExceeded) {
    return "source_count_exceeded";
  }
  const unretrievable = input.sourceIssues.find(
    (issue) => issue.reason === "source_unretrievable",
  );
  if (unretrievable !== undefined) {
    return "source_unretrievable";
  }
  if (input.sourceIssues.length > 0) {
    return "source_not_allowed";
  }
  if (input.selected === null) {
    return "byte_limit_exceeded";
  }
  return null;
}

function buildFindings(
  request: EgressRequest,
  projectExcluded: boolean,
  endpointMatched: boolean,
  modelMatched: boolean,
  dataClassPassed: readonly boolean[],
  sourceIssues: readonly SourceIssue[],
  bytesMatched: boolean,
): EgressFinding[] {
  const findings: EgressFinding[] = [
    {
      dimension: "endpoint",
      ref: `${request.endpoint.scheme}://${request.endpoint.host}:${String(request.endpoint.port)}`,
      passed: endpointMatched,
    },
    {
      dimension: "model",
      ref: request.model,
      passed: modelMatched,
    },
    {
      dimension: "project",
      ref: request.project_id,
      passed: !projectExcluded,
    },
    {
      dimension: "bytes",
      ref: null,
      passed: bytesMatched,
    },
  ];
  for (let index = 0; index < request.sources.length; index += 1) {
    const source = request.sources[index];
    if (source === undefined) {
      continue;
    }
    findings.push({
      dimension: "data_class",
      ref: source.ref,
      passed: dataClassPassed[index] === true,
    });
    const issue = sourceIssues.find((candidate) => candidate.source.ref === source.ref);
    findings.push({
      dimension: "source",
      ref: source.ref,
      passed: issue === undefined,
    });
  }
  return findings;
}
