/**
 * Kernel-side capability binding assembly for runtime probes (W1/D6).
 *
 * A `CapabilityBinding` names the exact source, binary, root, construction path
 * and execution environment a capability claim applies to. The kernel knows the
 * registration facts, but it cannot know how an adapter was constructed inside
 * a host. Rather than branching per host, the kernel asks the adapter (through
 * an injected declaration port) for the fields only the adapter can know.
 *
 * Fail-closed rules:
 * - no port -> `E_PROBE_UNSUPPORTED` (the host has no probe channel at all);
 * - port returns `null` -> same, treated as "this adapter cannot bind a probe";
 * - any missing or malformed declaration field -> `E_SCHEMA`, never a default;
 * - the assembled binding must pass `validateCapabilityBinding`.
 */

import {
  err,
  makeErrorEnvelope,
  ok,
  type ErrorEnvelope,
  type Hash,
  type Id,
  type Result
} from "@evoplug/core";
import type {
  BinaryPin,
  CapabilityBinding,
  ConfigSpace,
  ConstructionPath,
  ExecutionEnvironment,
  HostId,
  HostMode,
  SourcePin
} from "@evoplug/core/host";
import { validateCapabilityBinding } from "@evoplug/core/host";

/** Registration/session facts read from committed rows, never from a caller. */
export interface ProbeBindingRegistrationFacts {
  readonly registration_hash: Hash;
  readonly adapter_id: Id<"adp">;
  readonly adapter_version: string;
  readonly host_id: HostId;
  readonly mode: HostMode;
  readonly config_space: ConfigSpace;
  readonly artifact_hash: Hash;
}

export interface ProbeBindingDeclarationInput {
  readonly registration: ProbeBindingRegistrationFacts;
  readonly host_version: string;
  readonly binary_hash: Hash | null;
  readonly native_session_id: string | null;
}

/**
 * Adapter-declared fields. `host_id`, `mode`, `config_space` and
 * `adapter_version` are injected from the registration; a declaration that
 * repeats them is ignored for those fields.
 */
export interface CapabilityBindingDeclaration {
  readonly source_pin: SourcePin;
  readonly binary_pin: BinaryPin;
  readonly root_id: string;
  readonly construction_path: ConstructionPath;
  readonly execution_environment: ExecutionEnvironment;
  /**
   * How the probed object maps to the declared capability. Required: a silent
   * `exact` default would let a probe upgrade a capability it never observed.
   */
  readonly mapping: "exact" | "partial" | "unmapped";
  readonly backend_id?: string;
}

/** The only host-shaped input the kernel accepts from an adapter. */
export interface CapabilityBindingDeclarationPort {
  declare(
    input: ProbeBindingDeclarationInput
  ):
    | Result<CapabilityBindingDeclaration | null, ErrorEnvelope>
    | Promise<Result<CapabilityBindingDeclaration | null, ErrorEnvelope>>;
}

interface ProbeBindingDeps {
  readonly declaration?: CapabilityBindingDeclarationPort;
}

/** `E_PROBE_UNSUPPORTED`: the host exposes no probe channel. */
export function probeUnsupportedError(stage: string): ErrorEnvelope {
  return makeErrorEnvelope({
    code: "E_PROBE_UNSUPPORTED",
    category: "policy",
    message_key: "error.probe.unsupported",
    stage,
    retryable: false,
    side_effect: "none",
    details: { kind: "none" }
  });
}

function declarationError(path: string, rule: string): ErrorEnvelope {
  return makeErrorEnvelope({
    code: "E_SCHEMA",
    category: "schema",
    message_key: "error.schema",
    stage: "probe_binding_declaration",
    retryable: false,
    side_effect: "none",
    details: { kind: "field", path, rule }
  });
}

/** Fills kernel-known fields around the adapter declaration and validates it. */
export function assembleCapabilityBinding(
  registration: ProbeBindingRegistrationFacts,
  declaration: CapabilityBindingDeclaration
): Result<CapabilityBinding, ErrorEnvelope> {
  if (declaration.root_id.length === 0) {
    return err(declarationError("root_id", "non_empty_string"));
  }
  if (declaration.construction_path.length === 0) {
    return err(declarationError("construction_path", "non_empty_string"));
  }
  const binding: CapabilityBinding = {
    host_id: registration.host_id,
    source_pin: declaration.source_pin,
    binary_pin: declaration.binary_pin,
    adapter_version: registration.adapter_version,
    subject: "product_adapter",
    mode: registration.mode,
    config_space: registration.config_space,
    root_id: declaration.root_id,
    construction_path: declaration.construction_path,
    execution_environment: declaration.execution_environment,
    mapping: declaration.mapping,
    ...(declaration.backend_id === undefined ? {} : { backend_id: declaration.backend_id })
  };
  const validated = validateCapabilityBinding(binding);
  if (!validated.ok) {
    return err(validated.error);
  }
  return ok(validated.value);
}

/**
 * Asks the adapter for a binding declaration and assembles it.
 *
 * Returns `null` only for the explicit "this host has no probe channel" case.
 * A declaration that is present but invalid is an error so that a broken
 * adapter cannot silently keep `stable_boundary` unknown forever.
 */
export async function declareCapabilityBinding(
  deps: ProbeBindingDeps,
  input: ProbeBindingDeclarationInput
): Promise<Result<CapabilityBinding | null, ErrorEnvelope>> {
  if (deps.declaration === undefined) {
    return err(probeUnsupportedError("probe_binding_declaration"));
  }
  let declared: Result<CapabilityBindingDeclaration | null, ErrorEnvelope>;
  try {
    declared = await deps.declaration.declare(input);
  } catch {
    return err(
      makeErrorEnvelope({
        code: "E_PROBE_UNSUPPORTED",
        category: "policy",
        message_key: "error.probe.unsupported",
        stage: "probe_binding_declaration",
        retryable: true,
        side_effect: "none",
        details: { kind: "none" }
      })
    );
  }
  if (!declared.ok) {
    return declared;
  }
  if (declared.value === null) {
    return err(probeUnsupportedError("probe_binding_declaration"));
  }
  const assembled = assembleCapabilityBinding(input.registration, declared.value);
  if (!assembled.ok) {
    return assembled;
  }
  return ok(assembled.value);
}

/* ------------------------------------------------------------------ */
/* Adapter probe specs                                                 */
/* ------------------------------------------------------------------ */

/**
 * Structural twin of `AdapterProbeSpec` from `@evoplug/host-runtime`. The
 * kernel does not depend on the runtime package, so the registry passes the
 * literal object and this factory validates only the fields it uses.
 */
export interface AdapterProbeSpecLike {
  readonly adapter_id: string;
  readonly construction_path: string;
  readonly isolation: "local" | "container" | "remote";
  readonly mapping: "exact" | "partial" | "unmapped";
  readonly backend_id?: string;
}

/**
 * Turns an adapter-declared spec into the declaration port's value. `root_id`
 * is the adapter id (one artifact root per adapter on a host) and the source
 * pin records the host version the runtime reported during ready.
 */
export function declarationFromAdapterProbeSpec(
  spec: AdapterProbeSpecLike,
  input: {
    readonly host_version: string;
    readonly binary_hash: Hash | null;
    readonly adapter_version: string;
    readonly native_session_id: string | null;
    readonly os: string;
    readonly arch: string;
  }
): CapabilityBindingDeclaration {
  return {
    source_pin: {
      host_version: input.host_version,
      host_version_kind: "release",
      source_commit: null
    },
    binary_pin: {
      binary_version: null,
      binary_hash: input.binary_hash
    },
    root_id: spec.adapter_id,
    construction_path: spec.construction_path,
    execution_environment: {
      os: input.os,
      arch: input.arch,
      isolation: spec.isolation
    },
    mapping: spec.mapping,
    ...(spec.backend_id === undefined ? {} : { backend_id: spec.backend_id })
  };
}
