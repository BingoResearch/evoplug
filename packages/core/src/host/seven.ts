/**
 * Seven-host shared rules and exact construction-path mapping (DD-HOST-003,
 * DD-HOST-010 … DD-HOST-070, DD-HOST-100, DD-HOST-110).
 *
 * The table is data, not capability evidence: every listed `host_contract`
 * fact still requires its own probe, and no `product_adapter` record is
 * implied by this module.
 */

import type {
  CapabilityName,
  CapabilityStatus,
  ConfigSpace,
  ConstructionPath,
  EvidenceStage,
  HostId,
  HostMode
} from "./types.js";

export interface InitialCapabilityFact {
  name: CapabilityName;
  status: CapabilityStatus;
  evidence_stage: EvidenceStage;
}

export interface SevenHostRule {
  host_id: HostId;
  source_version: string | null;
  source_commit: string | null;
  binary_version: string | null;
  /**
   * Design-time binary path. It is `null` when the design records no portable
   * path; a machine-specific absolute path must never appear here. Runtime
   * callers resolve the real installed path through attach/probe, never from
   * this table.
   */
  binary_path: string | null;
  mapping: "exact" | "partial" | "unmapped";
  modes: readonly HostMode[];
  config_spaces: readonly ConfigSpace[];
  strict: false;
  strict_reasons: readonly string[];
  pending_state: "unknown";
  initial_capabilities: readonly InitialCapabilityFact[];
  notes: readonly string[];
}

const UNKNOWN: CapabilityStatus = "unknown";
const NONE: EvidenceStage = "none";
const STATIC: EvidenceStage = "static";
const LOADED: EvidenceStage = "loaded";
const ROUNDTRIP: EvidenceStage = "roundtrip";
const VERIFIED: CapabilityStatus = "verified";

/**
 * DD-HOST-010 … DD-HOST-070, condensed to machine-readable facts.
 *
 * This is design data, not a snapshot of the build machine. In particular,
 * `binary_path` is never a host-absolute path; installed locations are
 * resolved at runtime by attach/probe.
 */
export const SEVEN_HOST_RULES: readonly SevenHostRule[] = [
  {
    host_id: "pi",
    source_version: "1.3.0",
    source_commit: "a731ba8b80ac56662b4ca7f09102f94447862d8c",
    binary_version: "0.87.1",
    binary_path: null,
    mapping: "unmapped",
    modes: ["interactive", "print", "rpc", "sdk"],
    config_spaces: ["user", "project_trusted", "project_untrusted"],
    strict: false,
    strict_reasons: ["sync_wait_unknown", "total_budget_unknown", "hard_block_unknown"],
    pending_state: "unknown",
    initial_capabilities: [
      { name: "input_capture", status: VERIFIED, evidence_stage: ROUNDTRIP },
      { name: "online_delivery", status: VERIFIED, evidence_stage: ROUNDTRIP },
      { name: "stable_boundary", status: UNKNOWN, evidence_stage: NONE },
      { name: "host_budget", status: UNKNOWN, evidence_stage: NONE },
      { name: "association", status: UNKNOWN, evidence_stage: NONE }
    ],
    notes: ["print source=interactive is a label only", "no native async work field"]
  },
  {
    host_id: "oh-my-pi",
    source_version: "18.12.3",
    source_commit: "2220e58146ebe31508e7a216242840d373e082d0",
    binary_version: "18.12.3",
    binary_path: null,
    mapping: "exact",
    modes: ["interactive", "print", "rpc", "acp", "sdk"],
    config_spaces: ["user", "project", "project_pi_compat"],
    strict: false,
    strict_reasons: ["handler_timeout_is_not_total_budget", "sync_wait_unknown", "hard_block_unknown"],
    pending_state: "unknown",
    initial_capabilities: [
      { name: "input_capture", status: UNKNOWN, evidence_stage: STATIC },
      { name: "online_delivery", status: VERIFIED, evidence_stage: ROUNDTRIP },
      { name: "stable_boundary", status: UNKNOWN, evidence_stage: NONE },
      { name: "host_budget", status: UNKNOWN, evidence_stage: NONE },
      { name: "association", status: UNKNOWN, evidence_stage: NONE }
    ],
    notes: ["30 s is a single handler timeout", "one-shot has no input event"]
  },
  {
    host_id: "step-code",
    source_version: "0.84.4",
    source_commit: "e08c6dd21310e75b296597d22910094fc786ccd6",
    binary_version: "0.1.5",
    binary_path: null,
    mapping: "unmapped",
    modes: ["interactive", "print", "rpc", "sdk_stdio"],
    config_spaces: ["user", "project_trusted", "project_untrusted"],
    strict: false,
    strict_reasons: ["total_budget_unknown", "sync_wait_unknown", "hard_block_unknown"],
    pending_state: "unknown",
    initial_capabilities: [
      { name: "input_capture", status: VERIFIED, evidence_stage: ROUNDTRIP },
      { name: "online_delivery", status: VERIFIED, evidence_stage: ROUNDTRIP },
      { name: "stable_boundary", status: UNKNOWN, evidence_stage: NONE },
      { name: "host_budget", status: UNKNOWN, evidence_stage: NONE },
      { name: "association", status: UNKNOWN, evidence_stage: NONE }
    ],
    notes: ["sdk_stdio is a separate binding from extension", "Stop block does not continue a turn"]
  },
  {
    host_id: "codex",
    source_version: "0.0.0",
    source_commit: "e18a20d6eb6f5ede32a69fb56e3fe276d5e9d914",
    binary_version: "0.160.1",
    binary_path: null,
    mapping: "unmapped",
    modes: ["interactive", "exec", "app-server", "sdk"],
    config_spaces: ["user", "project_trusted", "project_untrusted", "managed"],
    strict: false,
    strict_reasons: ["probe_blocked", "version_unmapped", "total_budget_unknown"],
    pending_state: "unknown",
    initial_capabilities: [
      { name: "input_capture", status: UNKNOWN, evidence_stage: STATIC },
      { name: "online_delivery", status: UNKNOWN, evidence_stage: STATIC },
      { name: "stable_boundary", status: UNKNOWN, evidence_stage: STATIC },
      { name: "host_budget", status: UNKNOWN, evidence_stage: STATIC },
      { name: "association", status: UNKNOWN, evidence_stage: STATIC }
    ],
    notes: ["0.160.1 probe blocked by region 403", "blocked never becomes a capability status"]
  },
  {
    host_id: "opencode",
    source_version: "2.1.0",
    source_commit: "19b12707cf8dda9b419566eab8d05f6ce03a41e3",
    binary_version: "1.18.32",
    binary_path: null,
    mapping: "unmapped",
    modes: ["interactive", "server"],
    config_spaces: ["user", "project", "managed"],
    strict: false,
    strict_reasons: ["total_budget_unknown", "sync_wait_unknown", "hard_block_unknown"],
    pending_state: "unknown",
    initial_capabilities: [
      { name: "online_delivery", status: UNKNOWN, evidence_stage: STATIC },
      { name: "stable_boundary", status: UNKNOWN, evidence_stage: STATIC },
      { name: "host_budget", status: UNKNOWN, evidence_stage: STATIC },
      { name: "association", status: UNKNOWN, evidence_stage: STATIC }
    ],
    notes: ["2.1.0 and 1.18.32 never share capability records", "session.idle is ephemeral"]
  },
  {
    host_id: "openhands-sdk",
    source_version: "1.56.0",
    source_commit: "0996c33916c2a977ea9fe38deee660ff0e1389f2",
    binary_version: "1.56.0",
    binary_path: null,
    mapping: "partial",
    modes: ["local_conversation", "remote_conversation"],
    config_spaces: ["user_home", "project", "isolated_home"],
    strict: false,
    strict_reasons: ["handler_timeout_is_not_total_budget", "sync_wait_unknown", "hard_block_unknown"],
    pending_state: "unknown",
    initial_capabilities: [
      { name: "input_capture", status: VERIFIED, evidence_stage: ROUNDTRIP },
      { name: "online_delivery", status: UNKNOWN, evidence_stage: LOADED },
      { name: "association", status: UNKNOWN, evidence_stage: ROUNDTRIP },
      { name: "stable_boundary", status: UNKNOWN, evidence_stage: LOADED },
      { name: "compaction_event", status: UNKNOWN, evidence_stage: STATIC },
      { name: "host_budget", status: UNKNOWN, evidence_stage: NONE }
    ],
    notes: ["E0 message_id differs from persisted E1", "Stop fires only on FINISHED"]
  },
  {
    host_id: "claude-code",
    source_version: null,
    source_commit: null,
    binary_version: "2.1.304",
    binary_path: null,
    mapping: "unmapped",
    modes: ["interactive", "print", "sdk"],
    config_spaces: ["user", "project", "local", "managed"],
    strict: false,
    strict_reasons: ["session_end_budget_is_not_total_budget", "sync_wait_unknown", "hard_block_unknown"],
    pending_state: "unknown",
    initial_capabilities: [
      { name: "input_capture", status: VERIFIED, evidence_stage: ROUNDTRIP },
      { name: "online_delivery", status: UNKNOWN, evidence_stage: STATIC },
      { name: "stable_boundary", status: UNKNOWN, evidence_stage: STATIC },
      { name: "host_budget", status: UNKNOWN, evidence_stage: NONE },
      { name: "association", status: UNKNOWN, evidence_stage: STATIC },
      { name: "compaction_event", status: UNKNOWN, evidence_stage: STATIC }
    ],
    notes: ["auto turns carry no origin field", "SessionEnd 1.5 s, max 60 s"]
  }
];

/** Exact `(host_id, mode) -> construction_path` table (DD-HOST-110). */
export const CONSTRUCTION_PATH_BY_HOST_MODE: Readonly<
  Record<HostId, Readonly<Partial<Record<HostMode, ConstructionPath>>>>
> = {
  pi: { interactive: "cli", print: "cli", rpc: "rpc", sdk: "sdk" },
  "oh-my-pi": { interactive: "cli", print: "cli", rpc: "rpc", sdk: "sdk", acp: "acp" },
  "step-code": { interactive: "cli", print: "cli", rpc: "rpc", sdk_stdio: "sdk_stdio" },
  codex: { interactive: "cli", exec: "cli", "app-server": "app_server", sdk: "sdk" },
  opencode: { interactive: "cli", server: "server" },
  "openhands-sdk": {},
  "claude-code": { interactive: "cli", print: "cli", sdk: "sdk" }
};

/** OpenHands requires an explicit choice; mode never implies one. */
export const OPENHANDS_CONSTRUCTION_PATHS: readonly ConstructionPath[] = [
  "server_settings",
  "direct_agent",
  "preset_agent",
  "subagent_factory"
];

export function constructionPathFor(hostId: HostId, mode: HostMode): ConstructionPath | null {
  return CONSTRUCTION_PATH_BY_HOST_MODE[hostId][mode] ?? null;
}

/** Exact pair check; aliases such as `omp`, `step`, `claude_code` are rejected. */
export function isConstructionPathForMode(
  hostId: HostId,
  mode: HostMode,
  path: string
): boolean {
  if (hostId === "openhands-sdk") {
    return OPENHANDS_CONSTRUCTION_PATHS.includes(path);
  }
  return constructionPathFor(hostId, mode) === path;
}

/** Rules shared by all seven hosts (DD-HOST-100). */
export const SEVEN_HOST_SHARED_RULES = {
  all_strict_false: true,
  strict_gap: "total_budget_ms_unknown_and_no_official_hard_block",
  default_pending_state: "unknown",
  openhands_association_default: "unknown",
  openhands_block_with_context: "degraded",
  opencode_version_split: ["2.1.0", "1.18.32"],
  step_stdio_separate_from_extension: true,
  claude_auto_turn_origin: "unknown",
  marker_proves_adoption_only: true,
  transport_body_required_for_inclusion: true
} as const;

/** Compaction order per host; injection must not assume the first request. */
export const COMPACTION_ORDER: Readonly<Record<HostId, readonly string[]>> = {
  pi: ["compaction", "before_agent_start", "context", "payload"],
  "oh-my-pi": ["before_agent_start", "pre_prompt_compaction", "context", "payload"],
  "step-code": ["before_agent_start", "clm_compaction", "prompt"],
  codex: ["PreCompact", "PostCompact"],
  opencode: ["session.compaction hook", "durable session.compaction.* event"],
  "openhands-sdk": [],
  "claude-code": ["PreCompact", "PostCompact"]
};

/** Looks up the documented initial host_contract facts for one host. */
export function initialCapabilitiesFor(hostId: HostId): readonly InitialCapabilityFact[] {
  return SEVEN_HOST_RULES.find((rule) => rule.host_id === hostId)?.initial_capabilities ?? [];
}

/** Every host is currently strict=false with a recorded reason. */
export function hostStrictReason(hostId: HostId): readonly string[] {
  return SEVEN_HOST_RULES.find((rule) => rule.host_id === hostId)?.strict_reasons ?? [];
}
