/**
 * Runtime-side first-session setup and candidate-adoption prompts
 * (closure design §5.2, §5.3).
 *
 * The kernel queues a `probe` call with `probe_action="confirm_human_setup"` or
 * `"confirm_candidate"`. This module only renders the host's own dialog and
 * reports the user's decision. It never answers on its own: a missing UI,
 * print/json mode, a thrown dialog or a dismissed prompt becomes
 * `unsupported`/`unknown`, and the kernel keeps the capability unknown or the
 * candidate pending.
 */

import { appendFileSync } from "node:fs";

import type { JsonValue } from "@evoplug/core";
import {
  capabilityBindingKey,
  type Hash,
  type HostProbeObservation,
  type RuntimeCall,
  type RuntimeProbeRequest
} from "@evoplug/core/host";

import type { HostRuntime, HostRuntimeResultOutcome } from "./runtime.js";
import type { RuntimeCallHandled } from "./runtime-probe.js";
import type { NativeChoice } from "./runtime-confirmation.js";

type NativeConfirm = (prompt: { readonly title: string; readonly message: string }) => Promise<
  "confirmed" | "not_confirmed" | "unsupported" | "unknown"
>;

type NativeChoose = (prompt: {
  readonly title: string;
  readonly message: string;
  readonly options: readonly string[];
  readonly codes?: readonly NativeChoice[];
}) => Promise<NativeChoice>;

export interface SessionConfirmationOptions {
  /** Yes/no dialog; absent means the mode has no UI. */
  readonly confirm_native?: NativeConfirm | null;
  /** Four-option chooser; absent falls back to the two-way dialog. */
  readonly choose_native?: NativeChoose | null;
  /** Optional free-text reason after "内容不对". */
  readonly ask_reason_native?:
    | ((prompt: { readonly title: string; readonly message: string }) => Promise<string | null>)
    | null;
  readonly observed_at?: number;
  /**
   * Channel that produced the answer (appendix K.2). `mcp_elicitation` names
   * the stdio MCP channel; a host-native dialog leaves it unset.
   */
  readonly mechanism?: string | null;
  /**
   * Channel binding, read at observation time because the elicitation request
   * id is only known after the user answers. For `mcp_elicitation` the kernel
   * requires `session_id` to equal the authenticated runtime session and
   * `request_id` to name the elicitation this answer belongs to.
   */
  readonly channel?: (() => {
    readonly server: string;
    readonly session_id: string;
    readonly request_id: number | null;
  } | null) | null;
}

function channelFields(options: SessionConfirmationOptions): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  if (typeof options.mechanism === "string" && options.mechanism.length > 0) {
    fields["mechanism"] = options.mechanism;
  }
  const channel = options.channel === undefined || options.channel === null ? null : options.channel();
  if (channel !== null) {
    fields["channel"] = {
      server: channel.server,
      session_id: channel.session_id,
      request_id: channel.request_id
    };
  }
  return fields;
}

function report(
  runtime: HostRuntime,
  call: RuntimeCall,
  request: RuntimeProbeRequest,
  observed: JsonValue,
  observedAt: number
): Promise<HostRuntimeResultOutcome> {
  const observation: HostProbeObservation = {
    probe_id: request.probe_id,
    probe_action: request.probe_action,
    binding_key: capabilityBindingKey(request.binding) as Hash,
    observed,
    checked_at: observedAt,
    evidence_refs: []
  };
  return runtime.reportResult(call.call_id, { kind: "probe", state: "observed", observation });
}

export async function handleSessionConfirmationCall(
  runtime: HostRuntime,
  call: RuntimeCall,
  options: SessionConfirmationOptions
): Promise<RuntimeCallHandled> {
  if (call.kind !== "probe") {
    return { handled: false, kind: null, evidence_ref: null };
  }
  const request = call.request;
  const observedAt = options.observed_at ?? Date.now();
  if (request.probe_action === "confirm_human_setup") {
    const setup = request.human_setup;
    if (setup === undefined) {
      return { handled: false, kind: null, evidence_ref: null };
    }
    let answer: "confirmed" | "not_confirmed" | "unsupported" | "unknown" = "unsupported";
    if (process.env["EVOPLUG_DEBUG_IPC"] === "1") {
      process.stderr.write(
        `evoplug runtime: confirm_human_setup begin call=${call.call_id} nonce=${setup.challenge_nonce} has_native=${String(options.confirm_native !== null && options.confirm_native !== undefined)} at=${Date.now()}\n`
      );
    }
    if (options.confirm_native !== null && options.confirm_native !== undefined) {
      try {
        answer = await options.confirm_native({ title: setup.title, message: setup.message });
      } catch {
        answer = "unknown";
      }
    }
    if (process.env["EVOPLUG_DEBUG_IPC"] === "1") {
      process.stderr.write(
        `evoplug runtime: confirm_human_setup answer=${answer} has_native=${String(options.confirm_native !== null && options.confirm_native !== undefined)}\n`
      );
    }
    const observed = {
      schema_version: "rsi.runtime_confirmation/1",
      action: "human_setup",
      decision: answer,
      nonce: setup.challenge_nonce,
      native_session_id: setup.native_session_id,
      candidate_id: null,
      subject_hash: null,
      decided_at: answer === "confirmed" || answer === "not_confirmed" ? observedAt : null,
      ...channelFields(options)
    } as unknown as JsonValue;
    const outcome = await report(runtime, call, request, observed, observedAt);
    if (process.env["EVOPLUG_DEBUG_IPC"] === "1") {
      process.stderr.write(
        `evoplug runtime: confirm_human_setup report ok=${String(outcome.ok)} recorded=${String(outcome.recorded)} error=${String(outcome.error?.code ?? null)} at=${Date.now()}\n`
      );
    }
    return { handled: outcome.ok, kind: "probe", evidence_ref: null };
  }
  if (request.probe_action !== "confirm_candidate") {
    return { handled: false, kind: null, evidence_ref: null };
  }
  const candidate = request.candidate_confirmation;
  if (candidate === undefined) {
    return { handled: false, kind: null, evidence_ref: null };
  }
  const display = candidate.display;
  const message = display === undefined
    ? [
        `对象：${candidate.object_type}`,
        `路径：${candidate.target_path}`,
        `变更：${candidate.change_summary}`,
        `依据：${candidate.basis_evidence_refs.length === 0 ? "（无）" : candidate.basis_evidence_refs.join(", ")}`,
        `验证：${candidate.verification_plan}`
      ].join("\n")
    : [
        `名称：${display.name}`,
        `用途：${display.description.length === 0 ? "（未提供描述）" : display.description}`,
        `变更：${display.change}`,
        "依据：",
        display.basis.length === 0 ? "（无）" : display.basis.map((quote) => `· ${quote}`).join("\n"),
        "内容预览：",
        display.content.length === 0 ? "（无法读取预览）" : display.content,
        `完整内容：${display.preview_path.length === 0 ? "（见下一条命令）" : display.preview_path}`,
        `命令：${display.show_command}`
      ].join("\n");
  const optionCodes: NativeChoice[] = ["adopt"];
  const optionLabels: string[] = [candidate.options.adopt];
  if (typeof candidate.options.incomplete === "string") {
    optionCodes.push("incomplete");
    optionLabels.push(candidate.options.incomplete);
  }
  optionCodes.push("reject");
  optionLabels.push(candidate.options.reject);
  const prompt = {
    title: candidate.title,
    message,
    options: optionLabels,
    codes: optionCodes
  };
  let choice: NativeChoice = "unsupported";
  if (options.choose_native !== null && options.choose_native !== undefined) {
    try {
      choice = await options.choose_native(prompt);
    } catch {
      choice = "unknown";
    }
  } else if (options.confirm_native !== null && options.confirm_native !== undefined) {
    // A host with only a yes/no dialog cannot express the other answers; No
    // means the content was wrong.
    const answer = await options.confirm_native({ title: candidate.title, message: prompt.message });
    choice = answer === "confirmed" ? "adopt" : answer === "not_confirmed" ? "reject" : answer;
  }
  const decision =
    choice === "adopt" || choice === "incomplete" || choice === "reject"
      ? choice
      : choice === "unsupported"
        ? "unsupported"
        : "unknown";
  let reason: string | null = null;
  if (decision === "reject" && options.ask_reason_native !== undefined && options.ask_reason_native !== null) {
    try {
      reason = await options.ask_reason_native({
        title: "可填写原因（可留空）",
        message: ""
      });
    } catch {
      reason = null;
    }
  }
  const observed = {
    schema_version: "rsi.runtime_confirmation/1",
    action: "candidate_adoption",
    decision,
    ...(reason === null ? {} : { reason }),
    nonce: candidate.challenge_nonce,
    native_session_id: candidate.native_session_id,
    candidate_id: candidate.candidate_id,
    subject_hash: candidate.subject_hash,
    decided_at:
      decision === "adopt" || decision === "incomplete" || decision === "reject"
        ? observedAt
        : null,
    ...channelFields(options)
  } as unknown as JsonValue;
  const outcome = await report(runtime, call, request, observed, observedAt);
  if (process.env["EVOPLUG_DEBUG_IPC"] === "1") {
    const logPath = process.env["EVOPLUG_MCP_CONFIRM_LOG"];
    if (typeof logPath === "string" && logPath.length > 0) {
      try {
        appendFileSync(logPath, `${JSON.stringify({
          at: Date.now(),
          event: "candidate_report",
          call_id: call.call_id,
          decision,
          ok: outcome.ok,
          recorded: outcome.recorded,
          error: outcome.ok ? null : outcome.error?.code ?? null,
          error_json: outcome.ok ? null : JSON.stringify(outcome.error ?? null)
        })}\n`);
      } catch {
        // Diagnostics never change the decision.
      }
    }
  }
  return { handled: outcome.ok, kind: "probe", evidence_ref: null };
}
