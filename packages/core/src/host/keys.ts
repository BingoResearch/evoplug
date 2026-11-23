/**
 * HOST content keys and identity hashes (DD-TRG-003, DD-TRG-004, DD-TRG-007,
 * DD-CAP-002, DD-CAP-008, DD-HOST-001, DD-HOST-110).
 *
 * Every function here is deterministic and pure: it builds the exact preimage
 * described by the design and returns a `sha256:` `Hash`.
 */

import { canonicalJsonText, compareUtf8 } from "../canonical.js";
import { canonicalHash } from "../hash.js";
import type { Hash } from "../hash.js";
import type { JsonValue } from "../json.js";
import type {
  CapabilityBinding,
  ConfigSpace,
  ConstructionPath,
  HostEventIdentity,
  OriginKind,
  PendingKind,
  PendingWorkRef,
  PolicyScope,
  SignalType,
  StableEventScope,
  TriggerPolicy
} from "./types.js";

/** Sorts objects by their JCS text and returns the sorted JCS strings. */
function sortedCanonicalObjects(objects: readonly JsonValue[]): string[] {
  const texts = objects.map((value) => canonicalJsonText(value));
  texts.sort(compareUtf8);
  return texts;
}

/** JCS array of the already canonical strings, then hashed. */
function hashCanonicalStringArray(texts: readonly string[]): Hash {
  const array: JsonValue[] = texts.map((text) => text);
  return canonicalHash(array);
}

/**
 * `event_identity_key` (DD-TRG-004). The preimage has exactly eleven fields;
 * missing `native_message_id`, `native_event_id` and `source_seq` are written
 * as JSON `null`, never omitted.
 */
export function eventIdentityKey(
  identity: Omit<HostEventIdentity, "schema_version" | "event_identity_key">
): Hash {
  const preimage: JsonValue = {
    schema_version: "rsi.host_event_identity/1",
    host_id: identity.host_id,
    config_space: identity.config_space,
    mode: identity.mode,
    native_session_id: identity.native_session_id,
    native_kind: identity.native_kind,
    host_event: identity.host_event,
    native_message_id: identity.native_message_id,
    native_event_id: identity.native_event_id,
    source_seq: identity.source_seq,
    occurred_at: identity.occurred_at
  };
  return canonicalHash(preimage);
}

/** Full `HostEventIdentity` including the computed key. */
export function buildHostEventIdentity(
  identity: Omit<HostEventIdentity, "schema_version" | "event_identity_key">
): HostEventIdentity {
  return {
    schema_version: "rsi.host_event_identity/1",
    host_id: identity.host_id,
    config_space: identity.config_space,
    mode: identity.mode,
    native_session_id: identity.native_session_id,
    native_kind: identity.native_kind,
    host_event: identity.host_event,
    native_message_id: identity.native_message_id,
    native_event_id: identity.native_event_id,
    source_seq: identity.source_seq,
    occurred_at: identity.occurred_at,
    event_identity_key: eventIdentityKey(identity)
  };
}

/** `scope_hash` for a `StableEventScope` (DD-TRG-004). */
export function stableEventScopeHash(scope: Omit<StableEventScope, "scope_hash">): Hash {
  const preimage: JsonValue = {
    schema_version: "rsi.stable_event_scope/1",
    host_id: scope.host_id,
    config_space: scope.config_space,
    native_session_id: scope.native_session_id,
    task_id: scope.task_id,
    branch_id: scope.branch_id,
    input_epoch: scope.input_epoch,
    goal_version: scope.goal_version,
    config_version: scope.config_version,
    watermark: scope.watermark
  };
  return canonicalHash(preimage);
}

interface ReviewScopeKeyInput {
  task_id: string;
  branch_id: string;
  input_epoch: number;
  goal_version: string;
  config_version: string;
  stable_watermark: number;
  stable_event_ids: readonly string[];
  pending_state: "none" | "pending" | "unknown";
  pending_fields: readonly Pick<PendingWorkRef, "pending_id" | "kind" | "state">[];
  review_kind: "auto" | "explicit";
}

/** `review_scope_key` (DD-TRG-003). */
export function reviewScopeKey(input: ReviewScopeKeyInput): Hash {
  const stableEventIds = Array.from(new Set(input.stable_event_ids));
  stableEventIds.sort(compareUtf8);
  const pendingFields = sortedCanonicalObjects(
    input.pending_fields.map<JsonValue>((field) => ({
      pending_id: field.pending_id,
      kind: field.kind,
      state: field.state
    }))
  );
  const preimage: JsonValue = {
    task_id: input.task_id,
    branch_id: input.branch_id,
    input_epoch: input.input_epoch,
    goal_version: input.goal_version,
    config_version: input.config_version,
    stable_watermark: input.stable_watermark,
    stable_event_ids: stableEventIds,
    pending_state: input.pending_state,
    pending_fields: pendingFields,
    review_kind: input.review_kind
  };
  return canonicalHash(preimage);
}

interface BoundaryKeyInput {
  task_id: string;
  branch_id: string;
  input_epoch: number;
  goal_version: string;
  config_version: string;
  boundary_kind: "host_stable_event" | "exit" | "user_selected" | "none";
  stable_watermark: number;
  stable_event_ids: readonly string[];
}

/** `boundary_key` (DD-TRG-003). */
export function boundaryKey(input: BoundaryKeyInput): Hash {
  const stableEventIds = Array.from(new Set(input.stable_event_ids));
  stableEventIds.sort(compareUtf8);
  const preimage: JsonValue = {
    task_id: input.task_id,
    branch_id: input.branch_id,
    input_epoch: input.input_epoch,
    goal_version: input.goal_version,
    config_version: input.config_version,
    boundary_kind: input.boundary_kind,
    stable_watermark: input.stable_watermark,
    stable_event_ids: stableEventIds
  };
  return canonicalHash(preimage);
}

interface SignalDigestInput {
  type: SignalType;
  strength: "verified" | "claim";
  detector_version: "sigdet/1";
  evidence_refs: readonly string[];
  issue_ids: readonly string[];
  requirement_ids: readonly string[];
}

/** `signal_digest` (DD-TRG-003): canonical signal strings, sorted, then hashed. */
export function signalDigest(signals: readonly SignalDigestInput[]): Hash {
  const canonicalSignals: string[] = [];
  for (const signal of signals) {
    const evidenceRefs = Array.from(new Set(signal.evidence_refs));
    evidenceRefs.sort(compareUtf8);
    const issueIds = Array.from(new Set(signal.issue_ids));
    issueIds.sort(compareUtf8);
    const requirementIds = Array.from(new Set(signal.requirement_ids));
    requirementIds.sort(compareUtf8);
    canonicalSignals.push(
      canonicalJsonText({
        type: signal.type,
        strength: signal.strength,
        detector_version: signal.detector_version,
        evidence_refs: evidenceRefs,
        issue_ids: issueIds,
        requirement_ids: requirementIds
      })
    );
  }
  canonicalSignals.sort(compareUtf8);
  return hashCanonicalStringArray(canonicalSignals);
}

/** `trigger_dedupe_key` (DD-TRG-003). */
export function triggerDedupeKey(input: {
  boundary_key: Hash;
  signal_digest: Hash;
  review_kind: "auto" | "explicit";
}): Hash {
  return canonicalHash({
    boundary_key: input.boundary_key,
    signal_digest: input.signal_digest,
    review_kind: input.review_kind
  });
}

/** `pending_key` (DD-TRG-007), discriminated by pending kind. */
export function pendingKey(input:
  | {
      kind: "delivery";
      host_id: string;
      config_space: string;
      session_ref: string;
      boundary_event_ref: string;
      delivery_target_hash: Hash;
      content_hash: Hash;
    }
  | { kind: "review_defer"; boundary_key: Hash; policy_hash: Hash }
  | { kind: "generation_resume"; review_job_id: string; snapshot_ref: string }): Hash {
  switch (input.kind) {
    case "delivery":
      return canonicalHash({
        kind: "delivery",
        host_id: input.host_id,
        config_space: input.config_space,
        session_ref: input.session_ref,
        boundary_event_ref: input.boundary_event_ref,
        delivery_target_hash: input.delivery_target_hash,
        content_hash: input.content_hash
      });
    case "review_defer":
      return canonicalHash({
        kind: "review_defer",
        boundary_key: input.boundary_key,
        policy_hash: input.policy_hash
      });
    case "generation_resume":
      return canonicalHash({
        kind: "generation_resume",
        review_job_id: input.review_job_id,
        snapshot_ref: input.snapshot_ref
      });
  }
}

/** `binding_key = sha256(JCS(CapabilityBinding))` (DD-CAP-002). */
export function capabilityBindingKey(binding: CapabilityBinding): Hash {
  const preimage: JsonValue = {
    host_id: binding.host_id,
    source_pin: {
      host_version: binding.source_pin.host_version,
      host_version_kind: binding.source_pin.host_version_kind,
      source_commit: binding.source_pin.source_commit
    },
    binary_pin: {
      binary_version: binding.binary_pin.binary_version,
      binary_hash: binding.binary_pin.binary_hash
    },
    adapter_version: binding.adapter_version,
    subject: binding.subject,
    mode: binding.mode,
    config_space: binding.config_space,
    root_id: binding.root_id,
    construction_path: binding.construction_path,
    execution_environment: {
      os: binding.execution_environment.os,
      arch: binding.execution_environment.arch,
      isolation: binding.execution_environment.isolation
    },
    mapping: binding.mapping,
    backend_id: binding.backend_id ?? null
  };
  return canonicalHash(preimage);
}

/** Scope identity used by `TriggerPolicyRef.scope_key` (inferred formula). */
export function policyScopeKey(scope: PolicyScope): Hash {
  return canonicalHash({
    schema_version: "rsi.policy_scope_key/1",
    scope_kind: scope.scope_kind,
    host_id: scope.host_id ?? null,
    mode: scope.mode ?? null,
    config_space: scope.config_space ?? null,
    project_id: scope.project_id ?? null
  });
}

/** `policy_hash` covers semantic fields only (DD-TRG-002). */
export function triggerPolicyHash(policy: TriggerPolicy): Hash {
  return canonicalHash({
    schema_version: policy.schema_version,
    scope: policyScopeJson(policy.scope),
    online: {
      enabled: policy.online.enabled,
      on_input: policy.online.on_input,
      on_tool_event: policy.online.on_tool_event,
      on_compaction: policy.online.on_compaction,
      remote_semantics: policy.online.remote_semantics,
      min_interval_ms: policy.online.min_interval_ms,
      max_remote_checks_per_input: policy.online.max_remote_checks_per_input,
      max_remote_checks_per_minute: policy.online.max_remote_checks_per_minute,
      semantic_merge_window_ms: policy.online.semantic_merge_window_ms,
      local_fact_priority: policy.online.local_fact_priority,
      delivery_min_inclusion: policy.online.delivery_min_inclusion
    },
    progress: {
      enabled: policy.progress.enabled,
      on_input_boundary: policy.progress.on_input_boundary,
      on_stable_boundary: policy.progress.on_stable_boundary,
      min_checks: policy.progress.min_checks,
      min_span_ms: policy.progress.min_span_ms,
      window_ms: policy.progress.window_ms,
      max_checks_per_window: policy.progress.max_checks_per_window,
      excluded_task_states: policy.progress.excluded_task_states,
      stall_opens_issue: policy.progress.stall_opens_issue,
      step_effect_mode: policy.progress.step_effect_mode,
      semantic_compare: policy.progress.semantic_compare
    },
    review: {
      mode: policy.review.mode,
      auto: {
        enabled: policy.review.auto.enabled,
        require_stable_boundary: policy.review.auto.require_stable_boundary,
        signal_match: policy.review.auto.signal_match,
        min_signals: policy.review.auto.min_signals,
        max_open_jobs_per_task: policy.review.auto.max_open_jobs_per_task,
        max_auto_jobs_per_task_24h: policy.review.auto.max_auto_jobs_per_task_24h
      },
      explicit: {
        enabled: policy.review.explicit.enabled,
        allowed_when_auto_disabled: policy.review.explicit.allowed_when_auto_disabled,
        unstable_snapshot: policy.review.explicit.unstable_snapshot,
        require_grant: policy.review.explicit.require_grant
      },
      pending: {
        defer_max_ms: policy.review.pending.defer_max_ms,
        on_timeout: policy.review.pending.on_timeout,
        resume_on_verified_stable: policy.review.pending.resume_on_verified_stable
      },
      signal_policy: {
        repeated_correction: {
          min_distinct_events: policy.review.signal_policy.repeated_correction.min_distinct_events,
          window_ms: policy.review.signal_policy.repeated_correction.window_ms
        },
        reproducible_error: {
          min_independent_runs: policy.review.signal_policy.reproducible_error.min_independent_runs,
          same_failure_signature: policy.review.signal_policy.reproducible_error.same_failure_signature
        },
        stable_recovery: {
          verified_failure_required: policy.review.signal_policy.stable_recovery.verified_failure_required,
          min_consecutive_passes: policy.review.signal_policy.stable_recovery.min_consecutive_passes
        },
        completion_claim_max_strength: policy.review.signal_policy.completion_claim_max_strength
      }
    },
    origin: {
      evaluator_suppression: policy.origin.evaluator_suppression,
      descendant_suppression: policy.origin.descendant_suppression,
      unknown_origin_auto_review: policy.origin.unknown_origin_auto_review,
      unknown_origin_online_checks: policy.origin.unknown_origin_online_checks,
      unknown_origin_explicit_review: policy.origin.unknown_origin_explicit_review,
      registry_ttl_ms: policy.origin.registry_ttl_ms
    },
    capabilities: {
      profile_version: policy.capabilities.profile_version,
      subject: policy.capabilities.subject,
      allow_unverified_auto_review: policy.capabilities.allow_unverified_auto_review,
      allow_unverified_online_semantics: policy.capabilities.allow_unverified_online_semantics,
      require_probe_freshness_ms: policy.capabilities.require_probe_freshness_ms
    },
    budget: {
      budget_policy_ref: policy.budget.budget_policy_ref,
      require_budget_for_paid_request: policy.budget.require_budget_for_paid_request,
      require_budget_for_generation: policy.budget.require_budget_for_generation
    }
  });
}

function policyScopeJson(scope: PolicyScope): JsonValue {
  return {
    scope_kind: scope.scope_kind,
    host_id: scope.host_id ?? null,
    mode: scope.mode ?? null,
    config_space: scope.config_space ?? null,
    project_id: scope.project_id ?? null
  };
}

/** `descriptor_hash = sha256(JCS(descriptor))` (DD-HOST-001). */
export function adapterDescriptorHash(descriptor: import("./types.js").AdapterDescriptor): Hash {
  return canonicalHash(descriptorToJson(descriptor));
}

export function descriptorToJson(descriptor: import("./types.js").AdapterDescriptor): JsonValue {
  return {
    schema_version: descriptor.schema_version,
    adapter_id: descriptor.adapter_id,
    host_id: descriptor.host_id,
    adapter_version: descriptor.adapter_version,
    implementation_hash: descriptor.implementation_hash,
    supported_modes: descriptor.supported_modes,
    config_spaces: descriptor.config_spaces,
    registration_targets: descriptor.registration_targets.map<JsonValue>((target) => ({
      target_id: target.target_id,
      config_space: target.config_space,
      scope: target.scope,
      kind: target.kind,
      load_boundary: target.load_boundary,
      marker_id: target.marker_id
    })),
    event_contracts: descriptor.event_contracts.map<JsonValue>((contract) => ({
      host_event: contract.host_event,
      native_kind: contract.native_kind,
      canonical_kinds: contract.canonical_kinds,
      required_capabilities: contract.required_capabilities
    })),
    declared_capabilities: descriptor.declared_capabilities
  };
}

/** `registration_hash` preimage (DD-HOST-001). */
export function registrationHash(input: {
  host_id: string;
  mode: string;
  config_space: string;
  adapter_id: string;
  adapter_version: string;
  implementation_hash: Hash;
  descriptor_hash: Hash;
  target_id: string;
  artifact_hash: Hash;
  expected_previous_hash: Hash | null;
}): Hash {
  return canonicalHash({
    schema_version: "rsi.adapter_registration/1",
    host_id: input.host_id,
    mode: input.mode,
    config_space: input.config_space,
    adapter_id: input.adapter_id,
    adapter_version: input.adapter_version,
    implementation_hash: input.implementation_hash,
    descriptor_hash: input.descriptor_hash,
    target_id: input.target_id,
    artifact_hash: input.artifact_hash,
    expected_previous_hash: input.expected_previous_hash
  });
}

/** `action_ref` for `review.explicit` interactions (DD-TRG-012). */
export function interactionActionRef(input: {
  action: "review.explicit";
  request_id: string;
  binding: import("../version-binding.js").VersionBinding;
  host_id: string;
  mode: string;
  config_space: ConfigSpace | null;
  authorization_ref: string | null;
}): Hash {
  return canonicalHash({
    schema_version: "rsi.host_action_ref/1",
    action: input.action,
    request_id: input.request_id,
    binding: {
      task_id: input.binding.task_id,
      branch_id: input.binding.branch_id,
      input_epoch: input.binding.input_epoch,
      goal_version: input.binding.goal_version,
      config_version: input.binding.config_version,
      watermark: input.binding.watermark
    },
    host_id: input.host_id,
    mode: input.mode,
    config_space: input.config_space,
    authorization_ref: input.authorization_ref
  });
}

/** `prompt_id` (DD-TRG-012 §12.4). */
export function interactionPromptId(input: {
  route_id: string;
  route_hash: Hash;
  action_ref: Hash;
  kind: "clarification" | "authorization";
  reason_code: "execution_blocking_clarification" | "authorization_required";
}): string {
  const hash = canonicalHash({
    schema_version: "rsi.host_interaction_prompt_id/1",
    route_id: input.route_id,
    route_hash: input.route_hash,
    action_ref: input.action_ref,
    kind: input.kind,
    reason_code: input.reason_code
  });
  return `prompt:${hash.slice("sha256:".length)}`;
}

/** `root_id` from the native install root (DD-HOST-001 §preinstall). */
export function nativeRootId(input: {
  host_id: string;
  mode: string;
  config_space: string;
  native_root_ref: string;
  identity_pin: { device_id: string; file_id: string };
}): string {
  const hash = canonicalHash({
    schema_version: "rsi.host_native_root_id/1",
    host_id: input.host_id,
    mode: input.mode,
    config_space: input.config_space,
    native_root_ref: input.native_root_ref,
    identity_pin: { device_id: input.identity_pin.device_id, file_id: input.identity_pin.file_id }
  });
  return `root:${hash.slice("sha256:".length)}`;
}

/** `service_profile_key` (DD-HOST-002). */
export function serviceProfileKey(input: {
  provider_scope: string;
  backend_id: string;
  host_id: string;
  mode: string;
  config_space: string;
  request_max_tokens: number;
  question_max_tokens: number;
  max_output_tokens: number;
  rpm: number | null;
  concurrency: number | null;
  pricing:
    | { status: "known"; input_micros_per_million: number; output_micros_per_million: number; fixed_micros: number }
    | { status: "unknown" };
}): Hash {
  return canonicalHash({
    schema_version: "rsi.service_profile_key/1",
    provider_scope: input.provider_scope,
    backend_id: input.backend_id,
    host_id: input.host_id,
    mode: input.mode,
    config_space: input.config_space,
    request_max_tokens: input.request_max_tokens,
    question_max_tokens: input.question_max_tokens,
    max_output_tokens: input.max_output_tokens,
    rpm: input.rpm,
    concurrency: input.concurrency,
    pricing: pricingJson(input.pricing)
  });
}

export function pricingJson(
  pricing:
    | { status: "known"; input_micros_per_million: number; output_micros_per_million: number; fixed_micros: number }
    | { status: "unknown" }
): JsonValue {
  if (pricing.status === "unknown") {
    return { status: "unknown" };
  }
  return {
    status: "known",
    input_micros_per_million: pricing.input_micros_per_million,
    output_micros_per_million: pricing.output_micros_per_million,
    fixed_micros: pricing.fixed_micros
  };
}

/** `confirm_control_plane` probe expected value (DD-HOST-001). */
export function controlPlaneProbeExpected(input: { subject_hash: Hash; challenge_nonce: string }): Hash {
  return canonicalHash({
    schema_version: "rsi.confirm_control_plane_probe/1",
    subject_hash: input.subject_hash,
    challenge_nonce: input.challenge_nonce
  });
}

/** `subject_hash = sha256(JCS(subject))` for adapter install approvals. */
export function adapterInstallSubjectHash(subject: import("./types.js").AdapterInstallSubject): Hash {
  return canonicalHash({
    schema_version: subject.schema_version,
    purpose: subject.purpose,
    host_id: subject.host_id,
    mode: subject.mode,
    config_space: subject.config_space,
    adapter_id: subject.adapter_id,
    adapter_version: subject.adapter_version,
    implementation_hash: subject.implementation_hash,
    target_id: subject.target_id,
    artifact_hash: subject.artifact_hash,
    expected_previous_hash: subject.expected_previous_hash
  });
}

/** Deterministic approval consumption key (DD-HOST-001). */
export function installConsumeIdempotencyKey(approvalId: string, registrationHashValue: Hash): string {
  return `install.consume:${approvalId}:${registrationHashValue}`;
}

/** `purpose` values accepted by `verifyControlPlane`. */
export const CONTROL_PLANE_PURPOSES: readonly (
  | "replay_approve"
  | "replay_revoke"
  | "replay_reject"
  | "replay_reconcile"
  | "egress_approve"
  | "grant_issue"
  | "grant_revoke"
  | "adapter_install"
)[] = [
  "replay_approve",
  "replay_revoke",
  "replay_reject",
  "replay_reconcile",
  "egress_approve",
  "grant_issue",
  "grant_revoke",
  "adapter_install"
];

export type { ConstructionPath, PendingKind, OriginKind };
