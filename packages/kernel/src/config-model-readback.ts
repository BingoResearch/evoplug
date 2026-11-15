/**
 * W10 host-native model identity.
 *
 * `config_autotune` needs one `ModelRef` before any composition can be built.
 * This module derives it from facts the host already holds:
 *
 * - the host's persisted model selection (`settings.json`, `config.toml`, …);
 * - the host's declared read-only metadata command (`--list-models`, `models`).
 *
 * Neither source is inferred from a provider name: `ServiceProfile.provider_scope`
 * alone is not a model, and a caller-supplied model is `explicit`, never
 * `host_readback`. Missing or ambiguous data fails with `E_CFG_MODEL_UNBOUND`.
 */

import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { join } from "node:path";

import type { ErrorEnvelope, Result } from "@evoplug/core";
import { newId } from "@evoplug/core";
import type {
  ConfigError,
  ConfigResult,
  DocumentFormat,
  ModelRef,
  SemanticTree
} from "@evoplug/core/config";
import { configError, fail, getNode, parseDocument, succeed } from "@evoplug/core/config";
import type { CapabilityBinding } from "@evoplug/core/host";
import type { ConfigLayerTarget } from "@evoplug/core/config";

import type {
  ServiceProfileNativeReadback,
  ServiceProfileNativeSource
} from "./host-service-profile-producer.js";

const DEFAULT_MAX_BYTES = 1_048_576;

export interface HostModelSelectionSpec {
  /** JSON pointer to the selected model value. */
  readonly model_pointer: string;
  /** JSON pointer to the selected provider, when it is a separate key. */
  readonly provider_pointer?: string;
  /**
   * The `model_pointer` value already contains `provider/model`. An optional
   * `#variant` suffix is split off; the first `/` divides provider and model.
   */
  readonly combined?: boolean;
  /** Provider fixed by the host itself, not by the file (for example Claude). */
  readonly static_provider?: string;
  /** Optional JSON pointer to a variant value. */
  readonly variant_pointer?: string;
}

export interface ReadHostModelSelectionInput {
  /** Host id used only in error details. */
  readonly host_id: string;
  /** Live, approved root directory for the selected layer. */
  readonly root_path: string;
  /** The exact layer whose file carries the host's selection. */
  readonly layer: Pick<ConfigLayerTarget, "relative_path" | "format">;
  readonly spec: HostModelSelectionSpec;
  readonly max_bytes?: number;
}

type DocumentFormatInput = ConfigLayerTarget["format"];
function modelUnbound(reason: string, extra: readonly [string, string | number][] = []): ConfigError {
  return configError("E_CFG_MODEL_UNBOUND", {
    details: [
      { key: "dimension", value: "native_model" },
      { key: "reason", value: reason },
      ...extra.map(([key, value]) => ({ key, value }))
    ]
  });
}

function readBounded(path: string, maxBytes: number): ConfigResult<Uint8Array> {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return fail(modelUnbound("selection_file_unavailable"));
  }
  try {
    const stats = fstatSync(fd);
    if (!stats.isFile() || stats.size < 0 || stats.size > maxBytes) {
      return fail(modelUnbound("selection_file_invalid_size"));
    }
    const bytes = new Uint8Array(stats.size);
    let offset = 0;
    while (offset < bytes.byteLength) {
      const read = readSync(fd, bytes, offset, bytes.byteLength - offset, offset);
      if (read <= 0) return fail(modelUnbound("selection_file_short_read"));
      offset += read;
    }
    return { ok: true, value: bytes };
  } catch {
    return fail(modelUnbound("selection_file_read_failed"));
  } finally {
    try {
      closeSync(fd);
    } catch {
      // The read result is already decided; a failed close does not change it.
    }
  }
}

function pointerString(tree: SemanticTree, pointer: string): string | null {
  const node = getNode(tree, pointer);
  if (node === undefined || node.kind !== "scalar" || node.scalar_type !== "string") return null;
  if (typeof node.value !== "string") return null;
  const value = node.value.trim();
  return value.length === 0 ? null : value;
}

function formatFromLayer(format: DocumentFormatInput): DocumentFormat {
  return format;
}

/**
 * Reads one host selection file read-only and returns the exact selected model.
 *
 * The file is bounded and parsed by the same semantic parser the config write
 * path uses; unknown keys survive because only the declared pointers are read.
 */
export function readHostModelSelection(input: ReadHostModelSelectionInput): ConfigResult<ModelRef> {
  const bytes = readBounded(
    join(input.root_path, input.layer.relative_path),
    input.max_bytes ?? DEFAULT_MAX_BYTES
  );
  if (!bytes.ok) return bytes;
  const parsed = parseDocument(bytes.value, formatFromLayer(input.layer.format));
  if (!parsed.ok) {
    return fail(modelUnbound("selection_parse_failed", [["parser", parsed.error.code]]));
  }
  const tree = parsed.value.tree;
  const rawModel = pointerString(tree, input.spec.model_pointer);
  if (rawModel === null) return fail(modelUnbound("selection_model_missing"));

  const rawVariant =
    input.spec.variant_pointer === undefined
      ? null
      : pointerString(tree, input.spec.variant_pointer);

  let provider: string | null;
  let modelId: string;
  let variant: string | null = rawVariant;
  if (input.spec.combined === true) {
    const [head, ...rest] = rawModel.split("#");
    const combined = head ?? "";
    variant = rawVariant ?? (rest.length === 0 ? null : rest.join("#"));
    const slash = combined.indexOf("/");
    if (slash <= 0 || slash === combined.length - 1) {
      return fail(modelUnbound("selection_model_shape"));
    }
    provider = combined.slice(0, slash);
    modelId = combined.slice(slash + 1);
  } else {
    modelId = rawModel;
    provider =
      input.spec.static_provider ??
      (input.spec.provider_pointer === undefined
        ? null
        : pointerString(tree, input.spec.provider_pointer));
  }
  if (provider === null || provider.length === 0) {
    return fail(modelUnbound("selection_provider_missing"));
  }
  return succeed({
    provider,
    model_id: modelId,
    variant: variant === null || variant.length === 0 ? null : variant,
    resolution_source: "host_readback"
  });
}

export interface NativeReadbackModelInput {
  readonly provider_scope: string | null;
  readonly model_id?: string | null;
}

/**
 * Maps a real host metadata readback to `ModelRef`. A provider fixed by the
 * host (Claude `doctor`) is accepted; a provider name without a model is not.
 */
export function modelRefFromNativeReadback(input: NativeReadbackModelInput): ConfigResult<ModelRef> {
  const rawModel = input.model_id?.trim() ?? "";
  if (rawModel.length === 0) return fail(modelUnbound("readback_model_missing"));
  let provider = input.provider_scope?.trim() ?? "";
  let modelId = rawModel;
  if (provider.length === 0) {
    const slash = rawModel.indexOf("/");
    if (slash > 0 && slash < rawModel.length - 1) {
      provider = rawModel.slice(0, slash);
      modelId = rawModel.slice(slash + 1);
    }
  }
  if (provider.length === 0) return fail(modelUnbound("readback_provider_missing"));
  return succeed({
    provider,
    model_id: modelId,
    variant: null,
    resolution_source: "host_readback"
  });
}

export interface HostReadbackModelRefFactoryOptions {
  /** The real read-only metadata source; it never runs inference. */
  readonly source: ServiceProfileNativeSource;
  readonly binding: CapabilityBinding;
  readonly backend_id: string;
  readonly request_id?: () => string;
  readonly deadline_ms?: number;
  readonly signal?: AbortSignal;
}

/**
 * Runs the declared metadata readback once and derives the boot `ModelRef`.
 *
 * A metadata source that needs a configured selector must be constructed with
 * that selector by the host glue; the returned identity still comes from the
 * native document, never from the selector itself.
 */
export function createHostReadbackModelRefFactory(
  options: HostReadbackModelRefFactoryOptions
): () => Promise<ConfigResult<ModelRef>> {
  return async () => {
    let read: Result<ServiceProfileNativeReadback, ErrorEnvelope>;
    try {
      read = await options.source.read({
        request_id: options.request_id?.() ?? newId("ev"),
        binding: options.binding,
        backend_id: options.backend_id,
        deadline_ms: options.deadline_ms ?? 20_000,
        ...(options.signal === undefined ? {} : { signal: options.signal })
      });
    } catch {
      return fail(modelUnbound("readback_threw"));
    }
    if (!read.ok) {
      return fail(modelUnbound("readback_failed", [["cause", read.error.code]]));
    }
    return modelRefFromNativeReadback(read.value);
  };
}
