/**
 * Runtime-side native human confirmation (DD-CAP-009).
 *
 * The kernel cannot render host UI: adapters loaded in the kernel process have
 * no native session and no dialog surface. A `confirm_human_event` probe is
 * therefore delivered to the host runtime, which asks the host itself for a
 * real yes/no answer. The runtime never answers on its own, never treats an
 * automatic prompt as human, and never upgrades a capability:
 *
 * - the prompt is rendered by the host's own UI implementation (`ctx.ui.confirm`
 *   for Pi/OMP, and the equivalent for any future host);
 * - only a `true`/confirmed answer produces `rsi.human_proof_evidence/1`;
 * - the evidence bytes are published through the frozen upload carrier so the
 *   kernel receives a real CAS reference;
 * - hosts without a dialog surface, or running headless already report
 *   `unsupported`/`unknown` and the ledger stays failed.
 *
 * The kernel independently re-reads the evidence and binds it to the nonce,
 * event and authenticated session before it writes a passed probe.
 */

import {
  type Hash,
  type JsonValue,
  type SourceRef
} from "@evoplug/core";
import {
  capabilityBindingKey,
  type RuntimeCall,
  type RuntimeCallResult,
  type RuntimeHumanConfirmation,
  type RuntimeHumanConfirmationObserved
} from "@evoplug/core/host";
import { toJsonValue } from "@evoplug/ipc";

import type { HostRuntime } from "./runtime.js";
import type { RuntimeCallHandled } from "./runtime-probe.js";

/** Host-facing prompt. The host renders it; this package never fakes an answer. */
interface NativeHumanConfirmationPrompt {
  readonly title: string;
  readonly message: string;
  readonly signal: AbortSignal;
}

export type MonotonicClock = () => number;

/**
 * An answer that arrives sooner than this after the dialog appears cannot be
 * a reaction to it: it is a key that was already queued (for example the Enter
 * that submitted the prompt that opened the dialog). Swift handlers are not a
 * human decision and are discarded. Not a user setting.
 */
export const NATIVE_CONFIRMATION_MIN_ANSWER_MS = 300;

export function defaultMonotonicClock(): number {
  return performance.now();
}

/** Optional clock injection; production callers use the monotonic default. */
export interface NativeConfirmationTiming {
  readonly clock?: MonotonicClock;
}

interface TimedAnswer<T> {
  readonly value: T;
  readonly premature: boolean;
}

async function askHumanOnce<T>(
  show: () => Promise<T>,
  clock: MonotonicClock
): Promise<TimedAnswer<T>> {
  const started = clock();
  const value = await show();
  return { value, premature: clock() - started < NATIVE_CONFIRMATION_MIN_ANSWER_MS };
}

/**
 * Shows a native dialog and applies the early-key rule: a first answer that
 * arrives too soon is dropped and the same dialog is shown one more time; a
 * second early answer is recorded as no decision. When the host resolves
 * without a real choice (dismissal, abort, unsupported), that is returned
 * as-is instead of re-prompting.
 */
export async function askHumanWithEarlyKeyGuard<T>(
  show: () => Promise<T>,
  options: {
    readonly clock?: MonotonicClock | undefined;
    readonly isAnswer: (value: T) => boolean;
    readonly noDecision: T;
  }
): Promise<T> {
  const clock = options.clock ?? defaultMonotonicClock;
  const first = await askHumanOnce(show, clock);
  if (!first.premature || !options.isAnswer(first.value)) return first.value;
  const second = await askHumanOnce(show, clock);
  if (!second.premature || !options.isAnswer(second.value)) return second.value;
  return options.noDecision;
}

function isDecidedChoice(value: NativeChoice): boolean {
  return value === "adopt" || value === "incomplete" || value === "reject";
}


export type NativeHumanConfirmationState =
  | "confirmed"
  | "not_confirmed"
  | "unsupported"
  | "unknown";

type NativeHumanConfirmer = (
  prompt: NativeHumanConfirmationPrompt
) => Promise<NativeHumanConfirmationState>;

interface RuntimeHumanConfirmationOptions {
  /** Registered input-family event used only as the frozen CAS carrier. */
  readonly carrier_event: string;
  /**
   * Real native dialog. Absent or `null` means the host has no dialog surface
   * and the result is an honest `unsupported`, never a confirmation.
   */
  readonly confirm_native?: NativeHumanConfirmer | null;
  readonly observed_at?: number;
}

/** The subset of a Pi/OMP/OpenCode extension context this adapter needs. */
interface NativeUiContext {
  readonly hasUI?: boolean;
  readonly ui?: {
    readonly confirm?: (
      title: string,
      message: string,
      options?: unknown
    ) => Promise<boolean>;
    readonly select?: (
      title: string,
      options: readonly string[]
    ) => Promise<string | undefined>;
    readonly notify?: (message: string, type?: string, options?: unknown) => unknown;
    readonly input?: (title: string, placeholder?: string, options?: unknown) => Promise<string | undefined>;
    readonly editor?: (title: string, initial?: string, options?: unknown) => Promise<string | undefined>;
    readonly dialog?: {
      readonly confirm?: (input: { readonly title: string; readonly message: string }) => Promise<boolean | undefined>;
      readonly select?: (input: {
        readonly title: string;
        readonly options: readonly { readonly value: string; readonly label: string }[];
      }) => Promise<unknown>;
    };
  };
}

/**
 * Adapts any host extension context that exposes a yes/no dialog. The common
 * shapes seen across hosts are `ctx.ui.confirm` (Pi, OMP, Step Code) and
 * `ctx.ui.dialog.confirm` (OpenCode TUI). A context without a dialog, or a
 * non-interactive mode, returns `null` and the caller records `unsupported`.
 */
export function nativeConfirmerFromHostContext(
  ctx: unknown,
  timing: NativeConfirmationTiming = {}
): NativeHumanConfirmer | null {
  const direct = nativeConfirmerFromUiContext(ctx, timing);
  if (direct !== null) return direct;
  if (typeof ctx !== "object" || ctx === null) return null;
  // A dialog helper without an explicit UI capability can be a headless
  // default-answer shim; it is not a human confirmation.
  if ((ctx as { hasUI?: unknown }).hasUI !== true) return null;
  const ui = (ctx as { ui?: { dialog?: { confirm?: unknown } } }).ui;
  const confirm = ui?.dialog?.confirm;
  if (typeof confirm !== "function") return null;
  return async (prompt) => {
    if (prompt.signal.aborted) return "unknown";
    try {
      return await askHumanWithEarlyKeyGuard(
        async () => {
          const answer = await (confirm as (options: unknown) => Promise<boolean>)({
            title: prompt.title,
            message: prompt.message
          });
          if (prompt.signal.aborted) return "unknown" as const;
          return answer === true ? "confirmed" as const : "not_confirmed" as const;
        },
        {
          clock: timing.clock,
          isAnswer: (state) => state === "confirmed" || state === "not_confirmed",
          noDecision: "unknown"
        }
      );
    } catch {
      return "unknown";
    }
  };
}

/** Four-option native choice used by the candidate adoption prompt. */
export type NativeChoice = "adopt" | "incomplete" | "reject" | "unsupported" | "unknown";

export function nativeChooserFromHostContext(
  ctx: unknown,
  timing: NativeConfirmationTiming = {}
): ((prompt: NativeHumanConfirmationPrompt & {
  readonly options: readonly string[];
  readonly codes?: readonly NativeChoice[];
}) => Promise<NativeChoice>) | null {
  if (typeof ctx !== "object" || ctx === null) return null;
  const candidate = ctx as NativeUiContext;
  const dialog = candidate.ui?.dialog;
  const dialogSelect = dialog?.select;
  const select = candidate.ui?.select;
  if (
    candidate.hasUI !== true &&
    typeof dialogSelect !== "function" &&
    typeof select !== "function"
  ) {
    return null;
  }
  // `ui.select` without `hasUI` can be a non-rendering helper that resolves
  // the first option immediately; that must never be treated as a human
  // answer. Prefer the explicit dialog surface, then the yes/no confirm
  // fallback.
  const selectable = typeof dialogSelect === "function" ||
    (candidate.hasUI === true && typeof select === "function");
  const toChoice = (
    answer: unknown,
    options: readonly string[],
    codes: readonly NativeChoice[] | undefined
  ): NativeChoice => {
    const value = typeof answer === "object" && answer !== null && "value" in answer
      ? (answer as { value?: unknown }).value
      : answer;
    if (typeof value !== "string") return "unknown";
    const index = options.indexOf(value);
    const code = index < 0 ? undefined : codes?.[index];
    return code === "adopt" || code === "incomplete" || code === "reject" ? code : "unknown";
  };
  if (!selectable) {
    // Fall back to two confirmations when the host only offers yes/no.
    const confirm = nativeConfirmerFromHostContext(ctx, timing);
    if (confirm === null) return null;
    return async (prompt) => {
      const adopt = await confirm(prompt);
      if (adopt !== "confirmed") return adopt === "not_confirmed" ? "reject" : adopt;
      return "adopt";
    };
  }
  return async (prompt) => {
    if (prompt.signal.aborted) return "unknown";
    // A three-way select renders only its title and options on Pi, oh-my-pi
    // and Step Code. Put the confirmation summary into the title so object
    // type, target path, change summary, basis and verification plan are
    // visible in the same native dialog (design §5.3). When the host also
    // offers a notification surface, show the summary there first.
    const summaryTitle =
      prompt.message.length === 0 ? prompt.title : `${prompt.title}\n\n${prompt.message}`;
    const notify = candidate.ui?.notify;
    if (typeof notify === "function") {
      try {
        await (notify as (message: string, type?: string) => unknown).call(
          candidate.ui,
          prompt.message,
          "info"
        );
      } catch {
        // A notification surface is optional; the title still carries the summary.
      }
    }
    if (prompt.signal.aborted) return "unknown";
    try {
      // A host may expose both surfaces. `ui.dialog.select` is the rendering,
      // user-facing dialog; `ui.select` can be an auto-resolving helper in
      // non-interactive hook contexts, so prefer the dialog when present.
      if (typeof dialogSelect === "function") {
        return await askHumanWithEarlyKeyGuard(
          async () => {
            const answer = await dialogSelect.call(dialog, {
              title: summaryTitle,
              options: prompt.options.map((entry) => ({ value: entry, label: entry }))
            });
            if (prompt.signal.aborted) return "unknown" as NativeChoice;
            return toChoice(answer, prompt.options, prompt.codes);
          },
          { clock: timing.clock, isAnswer: isDecidedChoice, noDecision: "unknown" }
        );
      }
      if (candidate.hasUI === true && typeof select === "function") {
        return await askHumanWithEarlyKeyGuard(
          async () => {
            const answer = await select.call(candidate.ui, summaryTitle, prompt.options);
            if (prompt.signal.aborted) return "unknown" as NativeChoice;
            return toChoice(answer, prompt.options, prompt.codes);
          },
          { clock: timing.clock, isAnswer: isDecidedChoice, noDecision: "unknown" }
        );
      }
      return "unknown";
    } catch {
      return "unknown";
    }
  };
}

/**
 * Appendix Q.5: optional free-text reason after "内容不对". Uses the host's own
 * text surface (`ctx.ui.input` or `ctx.ui.editor`). A host without one returns
 * `null` and the answer is recorded without a reason.
 */
export function nativeReasonAskerFromHostContext(
  ctx: unknown,
  timing: NativeConfirmationTiming = {}
): ((prompt: { readonly title: string; readonly message: string }) => Promise<string | null>) | null {
  if (typeof ctx !== "object" || ctx === null) return null;
  const candidate = ctx as NativeUiContext;
  const input = candidate.ui?.input;
  const editor = candidate.ui?.editor;
  if (typeof input !== "function" && typeof editor !== "function") return null;
  return async (prompt) => {
    try {
      return await askHumanWithEarlyKeyGuard(
        async () => {
          const answer = typeof editor === "function"
            ? await editor.call(candidate.ui, prompt.title, "")
            : await input!.call(candidate.ui, prompt.title, "可选：哪里不符合预期");
          return typeof answer === "string" && answer.trim().length > 0 ? answer.trim() : null;
        },
        {
          clock: timing.clock,
          isAnswer: (value) => typeof value === "string",
          noDecision: null
        }
      );
    } catch {
      return null;
    }
  };
}

/**
 * Adapts a host extension context to a confirmer. It fails closed (returns
 * `null`) in print/json modes or when the host does not expose a dialog.
 */
export function nativeConfirmerFromUiContext(
  ctx: unknown,
  timing: NativeConfirmationTiming = {}
): NativeHumanConfirmer | null {
  if (typeof ctx !== "object" || ctx === null) return null;
  const candidate = ctx as NativeUiContext;
  // Only a context that declares a UI can produce a human confirmation.
  // A callable helper without that declaration may return a default answer.
  if (candidate.hasUI !== true) return null;
  const confirm = candidate.ui?.confirm;
  if (typeof confirm !== "function") return null;
  return async (prompt) => {
    if (prompt.signal.aborted) return "unknown";
    try {
      return await askHumanWithEarlyKeyGuard(
        async () => {
          const answer = await confirm.call(candidate.ui, prompt.title, prompt.message);
          if (prompt.signal.aborted) return "unknown" as const;
          return answer === true ? "confirmed" as const : "not_confirmed" as const;
        },
        {
          clock: timing.clock,
          isAnswer: (state) => state === "confirmed" || state === "not_confirmed",
          noDecision: "unknown"
        }
      );
    } catch {
      return "unknown";
    }
  };
}

function promptFor(
  request: RuntimeHumanConfirmation,
  deadlineMs: number
): NativeHumanConfirmationPrompt {
  const event = request.event_identity_key.startsWith("sha256:")
    ? request.event_identity_key.slice("sha256:".length, "sha256:".length + 16)
    : request.event_identity_key.slice(0, 16);
  return {
    title: "EvoPlug confirmation",
    message:
      `Confirm this action as the human user of this host session.\n` +
      `Event: ${event}\n` +
      `Nonce: ${request.challenge_nonce}\n` +
      `This prompt is generated by EvoPlug; selecting No leaves the event unverified.`,
    signal: AbortSignal.timeout(Math.max(1, deadlineMs))
  };
}

async function publishEvidence(
  runtime: HostRuntime,
  carrierEvent: string,
  evidence: JsonValue,
  observedAt: number
): Promise<SourceRef | null> {
  const json = toJsonValue(evidence);
  if (!json.ok) return null;
  try {
    // The carrier upload is rejected in phase B, but the kernel has already
    // persisted these exact bytes as a CAS blob. `detail_ref` is therefore the
    // evidence reference the issuer later re-reads; it must name the bare
    // `rsi.human_proof_evidence/1` object, not a wrapper it cannot parse.
    const outcome = await runtime.submitHostEvent(carrierEvent, {}, json.value, observedAt);
    const rejection = outcome.rejection;
    return rejection !== null && rejection.phase === "B" ? rejection.detail_ref : null;
  } catch {
    return null;
  }
}

function evidenceValue(
  request: RuntimeHumanConfirmation,
  binding: { host_id: string; mode: string; config_space: string },
  confirmedAt: number
): JsonValue | null {
  const value = toJsonValue({
    schema_version: "rsi.human_proof_evidence/1",
    capability_id: request.capability_id,
    proof_kind: "host_native_confirmation",
    host_id: binding.host_id,
    host_version: request.host_version,
    mode: binding.mode,
    config_space: binding.config_space,
    subject: {
      kind: "event_key",
      event_key: request.event_identity_key,
      native_session_id: request.native_session_id
    },
    confirmed_at: confirmedAt,
    nonce: request.challenge_nonce
  });
  return value.ok ? value.value : null;
}

/**
 * Answers one `confirm_human_event` probe call. Returns `handled:false` for
 * every other kind/action so the caller keeps its normal runtime routing.
 */
export async function handleHumanConfirmationCall(
  runtime: HostRuntime,
  call: RuntimeCall,
  options: RuntimeHumanConfirmationOptions
): Promise<RuntimeCallHandled> {
  if (
    call.kind !== "probe" ||
    call.request.probe_action !== "confirm_human_event" ||
    call.request.human_confirmation === undefined
  ) {
    return { handled: false, kind: null, evidence_ref: null };
  }
  const confirmation = call.request.human_confirmation;
  const binding = call.request.binding;
  const observedAt = options.observed_at ?? Date.now();
  let state: NativeHumanConfirmationState = "unknown";
  let confirmedAt: number | null = null;
  let evidenceRef: SourceRef | null = null;

  if (
    confirmation.event_identity_key !== call.request.host_binding.event_identity_key ||
    confirmation.capability_id.length === 0
  ) {
    state = "unknown";
  } else if (options.confirm_native === undefined || options.confirm_native === null) {
    state = "unsupported";
  } else if (call.deadline_ms < 1) {
    state = "unknown";
  } else {
    try {
      state = await options.confirm_native(promptFor(confirmation, call.deadline_ms));
    } catch {
      state = "unknown";
    }
    if (state === "confirmed") {
      const at = Date.now();
      const value = evidenceValue(confirmation, binding, at);
      if (value === null) {
        state = "unknown";
      } else {
        evidenceRef = await publishEvidence(
          runtime,
          options.carrier_event,
          value,
          observedAt
        );
        if (evidenceRef === null) {
          state = "unknown";
        } else {
          confirmedAt = at;
        }
      }
    }
  }

  const observed: RuntimeHumanConfirmationObserved = {
    schema_version: "rsi.runtime_human_confirmation/1",
    state,
    nonce: confirmation.challenge_nonce,
    event_identity_key: confirmation.event_identity_key,
    native_session_id: confirmation.native_session_id,
    confirmed_at: state === "confirmed" ? confirmedAt : null,
    evidence_ref: state === "confirmed" ? evidenceRef : null
  };
  const observedValue = toJsonValue(observed);
  if (!observedValue.ok) {
    return { handled: false, kind: null, evidence_ref: null };
  }
  const evidenceRefs = evidenceRef === null ? [] : [evidenceRef];
  const result: RuntimeCallResult = {
    kind: "probe",
    state: "observed",
    observation: {
      probe_id: call.request.probe_id,
      probe_action: "confirm_human_event",
      binding_key: bindingKeyOf(call),
      observed: observedValue.value,
      ...(evidenceRef === null ? {} : { claimed_evidence_stage: "loaded" as const }),
      claimed_status: state === "unsupported" ? "unsupported" : "unknown",
      checked_at: observedAt,
      evidence_refs: evidenceRefs
    }
  };
  const reported = await runtime.reportResult(call.call_id, result);
  const handled = reported.ok && reported.recorded;
  return {
    handled,
    kind: handled ? "probe" : null,
    evidence_ref: evidenceRef
  };
}

function bindingKeyOf(call: Extract<RuntimeCall, { kind: "probe" }>): Hash {
  // The canonical key is exactly the one the request carries.
  return capabilityBindingKey(call.request.binding);
}
