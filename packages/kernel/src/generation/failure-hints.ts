/**
 * User-facing next steps for a classified generation failure.
 *
 * The classifier reports what failed; this module says what to do about it.
 * Hints follow the existing `next_steps` style: a short imperative sentence.
 * The reproduce shape names the declared argv template with placeholders, so a
 * prompt body or credential never reaches a log or an attach/status report.
 */

import { redactCredentialMaterial } from "@evoplug/review";

import type { GenerationFailure, GenerationFailureCode } from "./cli-backend.js";

export interface GenerationFailureHintOptions {
  readonly host_id?: string;
  readonly executable?: string;
  readonly argv_template?: readonly string[];
}

const CODES: ReadonlySet<string> = new Set<GenerationFailureCode>([
  "auth_rejected",
  "provider_rejected",
  "process_exit_nonzero",
  "output_unparseable",
  "protocol_mismatch"
]);

function reproduceShape(options: GenerationFailureHintOptions | undefined): string {
  const binary = options?.executable ?? "<host-binary>";
  const template = options?.argv_template;
  if (template === undefined || template.length === 0) {
    return `复现：在隔离环境运行宿主生成命令（固定探针 prompt）；不要粘贴 prompt 正文或凭据`;
  }
  const shape = template
    .map((arg) =>
      arg === "{{prompt}}"
        ? "<prompt>"
        : arg === "{{prompt_file}}"
          ? "<prompt-file>"
          : arg === "{{glue}}"
            ? "<glue>"
            : arg
    )
    .join(" ");
  return `复现：在隔离环境运行 ${binary} ${shape}；不要粘贴 prompt 正文或凭据`;
}

/** One next-step sentence for a classified generation failure. */
export function generationFailureNextStep(
  failure: Pick<GenerationFailure, "code" | "provider_code"> | null,
  options?: GenerationFailureHintOptions
): string | null {
  const hint = hintForFailure(failure, options);
  return hint === null ? null : redactCredentialMaterial(hint);
}

function hintForFailure(
  failure: Pick<GenerationFailure, "code" | "provider_code"> | null,
  options?: GenerationFailureHintOptions
): string | null {
  if (failure === null) return null;
  switch (failure.code) {
    case "auth_rejected":
      return "检查宿主登录状态或凭据环境变量后重试";
    case "provider_rejected":
      if (options?.host_id === "oh-my-pi" && failure.provider_code === "MissingSessionID") {
        return "把 models.json 中该 provider 键改为 opencode-zen 并设置 config.yml 的 modelRoles.default，见安装说明第 7.2 节";
      }
      return "检查宿主 provider 配置（provider 键、endpoint 与模型名）后重试";
    case "process_exit_nonzero":
      return reproduceShape(options);
    case "output_unparseable":
    case "protocol_mismatch":
      return "宿主版本与 adapter 输出协议可能不匹配，升级或降级宿主、更新 adapter 后重试";
    default:
      return null;
  }
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validProviderCode(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z][A-Za-z0-9_.-]{1,63}$/u.test(value);
}

/**
 * Re-reads `failure` and `next_step` from a persisted `host_probe.observed`
 * string. Unknown or legacy shapes yield nulls instead of guessed values.
 */
export function storedGenerationFailure(observed: unknown): {
  readonly failure: GenerationFailure | null;
  readonly next_step: string | null;
} {
  let value: unknown = observed;
  if (typeof observed === "string") {
    try {
      value = JSON.parse(observed) as unknown;
    } catch {
      return { failure: null, next_step: null };
    }
  }
  if (!isRecord(value)) return { failure: null, next_step: null };
  const raw = value["failure"];
  let failure: GenerationFailure | null = null;
  if (isRecord(raw) && typeof raw["code"] === "string" && CODES.has(raw["code"])) {
    const providerStatus = raw["provider_status"];
    const exitCode = raw["exit_code"];
    failure = {
      code: raw["code"] as GenerationFailureCode,
      detail: typeof raw["detail"] === "string"
        ? redactCredentialMaterial(raw["detail"]).slice(0, 240)
        : "",
      ...(typeof providerStatus === "number" &&
      Number.isInteger(providerStatus) &&
      providerStatus >= 100 &&
      providerStatus <= 599
        ? { provider_status: providerStatus }
        : {}),
      ...(validProviderCode(raw["provider_code"]) ? { provider_code: raw["provider_code"] } : {}),
      ...(typeof exitCode === "number" && Number.isInteger(exitCode) ? { exit_code: exitCode } : {})
    };
  }
  const nextStep = value["next_step"];
  return {
    failure,
    next_step: typeof nextStep === "string" ? redactCredentialMaterial(nextStep) : null
  };
}
