/**
 * `evolve serve` process entrypoint (DD-FND-101).
 *
 * Flags: `--foreground` (always foreground; accepted for the documented
 * command line), `--json` (serve has no stdout business output), `--home DIR`.
 * The config-reload triple (`--config-reload-host`,
 * `--config-reload-executable`, `--config-reload-workspace`) is all-or-none and
 * must contain an absolute executable and workspace; it selects the persisted
 * approved host binding and never discovers a path from the user's home.
 * Exit codes: 0 on SIGTERM, 130 on SIGINT/SIGTERM-as-user-cancel, 2 on bad
 * arguments, 3 when uninitialized or schema-unsupported, 4 when another kernel
 * holds the lock, 5 when startup ends degraded.
 */

import { pathToFileURL } from "node:url";
import { isAbsolute } from "node:path";
import { isHash, isHostId, type ErrorEnvelope, type Hash, type HostId } from "@evoplug/core";
import {
  kernelError,
  resolveEvoplugHome,
  type JevTransportInjection
} from "@evoplug/kernel";
import { bootstrapKernel } from "./bootstrap.js";
import type { PersistedConfigCompositionOptions } from "./config-persisted-composition.js";

export const PRODUCT_VERSION = "0.0.0";

export interface ServeArguments {
  readonly home: string;
  readonly json: boolean;
  readonly foreground: boolean;
  readonly generation_binding_key?: Hash;
  readonly generation_executable?: string;
  /** Explicit host-owned credential environment variable name. */
  readonly jev_credential_env?: string;
  /** Persisted credential reference this process is authorized to resolve. */
  readonly jev_credential_ref?: string;
  /** Explicit endpoint host authorization supplied by the invoking host. */
  readonly jev_allowed_hosts: readonly string[];
  /**
   * Selected persisted host for the default config-reload path. Present only
   * together with the executable and workspace.
   */
  readonly config_reload_host?: HostId;
  /** Absolute native executable of the selected approved host binding. */
  readonly config_reload_executable?: string;
  /** Absolute workspace passed to the host SDK. */
  readonly config_reload_workspace?: string;
}

export type ServeParse =
  | { readonly ok: true; readonly value: ServeArguments }
  | { readonly ok: false; readonly error: ErrorEnvelope };

/** Parses `serve` arguments; unknown flags are exit-2 schema errors. */
export function parseServeArguments(argv: readonly string[], env: { readonly [key: string]: string | undefined }): ServeParse {
  let home: string | undefined;
  let json = false;
  let foreground = false;
  let generationBindingKey: Hash | undefined;
  let generationExecutable: string | undefined;
  let jevCredentialEnv: string | undefined;
  let jevCredentialRef: string | undefined;
  let configReloadHost: HostId | undefined;
  let configReloadExecutable: string | undefined;
  let configReloadWorkspace: string | undefined;
  const jevAllowedHosts: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === undefined) {
      continue;
    }
    if (arg === "--json") {
      json = true;
      continue;
    }
    if (arg === "--foreground") {
      foreground = true;
      continue;
    }
    if (arg === "--generation-binding-key" || arg.startsWith("--generation-binding-key=") ||
        arg === "--generation-executable" || arg.startsWith("--generation-executable=")) {
      const name = arg.split("=")[0]!;
      const inline = arg.includes("=");
      const value = inline ? arg.slice(name.length + 1) : argv[index + 1];
      if (value === undefined || value.length === 0 ||
          (name === "--generation-binding-key" ? !isHash(value) : !isAbsolute(value))) {
        return { ok: false, error: kernelError("E_SCHEMA", {
          details: { kind: "field", path: name, rule: name === "--generation-binding-key" ? "sha256_hash" : "absolute_executable" }
        }) };
      }
      if (name === "--generation-binding-key") generationBindingKey = value as Hash;
      else generationExecutable = value;
      if (!inline) index += 1;
      continue;
    }
    if (arg === "--jev-credential-env") {
      const value = argv[index + 1];
      if (value === undefined || value.length === 0) {
        return {
          ok: false,
          error: kernelError("E_SCHEMA", { details: { kind: "field", path: "--jev-credential-env", rule: "missing_value" } })
        };
      }
      jevCredentialEnv = value;
      index += 1;
      continue;
    }
    if (arg.startsWith("--jev-credential-env=")) {
      const value = arg.slice("--jev-credential-env=".length);
      if (value.length === 0) {
        return {
          ok: false,
          error: kernelError("E_SCHEMA", { details: { kind: "field", path: "--jev-credential-env", rule: "empty_value" } })
        };
      }
      jevCredentialEnv = value;
      continue;
    }
    if (arg === "--jev-credential-ref") {
      const value = argv[index + 1];
      if (value === undefined || value.length === 0) {
        return {
          ok: false,
          error: kernelError("E_SCHEMA", { details: { kind: "field", path: "--jev-credential-ref", rule: "missing_value" } })
        };
      }
      jevCredentialRef = value;
      index += 1;
      continue;
    }
    if (arg.startsWith("--jev-credential-ref=")) {
      const value = arg.slice("--jev-credential-ref=".length);
      if (value.length === 0) {
        return {
          ok: false,
          error: kernelError("E_SCHEMA", { details: { kind: "field", path: "--jev-credential-ref", rule: "empty_value" } })
        };
      }
      jevCredentialRef = value;
      continue;
    }
    if (arg === "--jev-allowed-host") {
      const value = argv[index + 1];
      if (value === undefined || value.length === 0) {
        return {
          ok: false,
          error: kernelError("E_SCHEMA", { details: { kind: "field", path: "--jev-allowed-host", rule: "missing_value" } })
        };
      }
      jevAllowedHosts.push(value);
      index += 1;
      continue;
    }
    if (arg.startsWith("--jev-allowed-host=")) {
      const value = arg.slice("--jev-allowed-host=".length);
      if (value.length === 0) {
        return {
          ok: false,
          error: kernelError("E_SCHEMA", { details: { kind: "field", path: "--jev-allowed-host", rule: "empty_value" } })
        };
      }
      jevAllowedHosts.push(value);
      continue;
    }
    const reloadFlag = (
      arg === "--config-reload-host" || arg.startsWith("--config-reload-host=")
        ? "--config-reload-host"
        : arg === "--config-reload-executable" || arg.startsWith("--config-reload-executable=")
          ? "--config-reload-executable"
          : arg === "--config-reload-workspace" || arg.startsWith("--config-reload-workspace=")
            ? "--config-reload-workspace"
            : null
    );
    if (reloadFlag !== null) {
      const inline = arg.includes("=");
      const value = inline ? arg.slice(reloadFlag.length + 1) : argv[index + 1];
      if (value === undefined) {
        return {
          ok: false,
          error: kernelError("E_SCHEMA", {
            details: { kind: "field", path: reloadFlag, rule: "missing_value" }
          })
        };
      }
      if (value.length === 0) {
        return {
          ok: false,
          error: kernelError("E_SCHEMA", {
            details: { kind: "field", path: reloadFlag, rule: "empty_value" }
          })
        };
      }
      if (reloadFlag === "--config-reload-host") {
        if (!isHostId(value)) {
          return {
            ok: false,
            error: kernelError("E_SCHEMA", {
              details: { kind: "field", path: reloadFlag, rule: "host_id" }
            })
          };
        }
        configReloadHost = value;
      } else {
        if (!isAbsolute(value)) {
          return {
            ok: false,
            error: kernelError("E_SCHEMA", {
              details: { kind: "field", path: reloadFlag, rule: "absolute_path" }
            })
          };
        }
        if (reloadFlag === "--config-reload-executable") configReloadExecutable = value;
        else configReloadWorkspace = value;
      }
      if (!inline) index += 1;
      continue;
    }
    if (arg === "--home") {
      const value = argv[index + 1];
      if (value === undefined) {
        return {
          ok: false,
          error: kernelError("E_SCHEMA", { details: { kind: "field", path: "--home", rule: "missing_value" } })
        };
      }
      home = value;
      index += 1;
      continue;
    }
    if (arg.startsWith("--home=")) {
      home = arg.slice("--home=".length);
      continue;
    }
    return {
      ok: false,
      error: kernelError("E_SCHEMA", { details: { kind: "field", path: arg, rule: "unknown_flag" } })
    };
  }
  if (generationExecutable !== undefined && generationBindingKey === undefined) {
    return { ok: false, error: kernelError("E_SCHEMA", {
      details: { kind: "field", path: "--generation-executable", rule: "generation_binding_key_required" }
    }) };
  }
  const reloadProvided =
    configReloadHost !== undefined ||
    configReloadExecutable !== undefined ||
    configReloadWorkspace !== undefined;
  if (
    reloadProvided &&
    (configReloadHost === undefined ||
      configReloadExecutable === undefined ||
      configReloadWorkspace === undefined)
  ) {
    const missing =
      configReloadHost === undefined
        ? "--config-reload-host"
        : configReloadExecutable === undefined
          ? "--config-reload-executable"
          : "--config-reload-workspace";
    return {
      ok: false,
      error: kernelError("E_SCHEMA", {
        details: { kind: "field", path: missing, rule: "config_reload_triplet_incomplete" }
      })
    };
  }
  const resolved = resolveEvoplugHome({ explicit: home, env });
  if (!resolved.ok) {
    return { ok: false, error: resolved.error };
  }
  return {
    ok: true,
    value: {
      home: resolved.value,
      json,
      foreground,
      ...(generationBindingKey === undefined ? {} : { generation_binding_key: generationBindingKey }),
      ...(generationExecutable === undefined ? {} : { generation_executable: generationExecutable }),
      ...(jevCredentialEnv === undefined ? {} : { jev_credential_env: jevCredentialEnv }),
      ...(jevCredentialRef === undefined ? {} : { jev_credential_ref: jevCredentialRef }),
      ...(configReloadHost === undefined ? {} : { config_reload_host: configReloadHost }),
      ...(configReloadExecutable === undefined
        ? {}
        : { config_reload_executable: configReloadExecutable }),
      ...(configReloadWorkspace === undefined
        ? {}
        : { config_reload_workspace: configReloadWorkspace }),
      jev_allowed_hosts: [...new Set(jevAllowedHosts)]
    }
  };
}

function writeStderr(line: string): void {
  process.stderr.write(`${line}\n`);
}

/**
 * Builds the process boundary from explicit host flags. The kernel never looks
 * up a provider, cc-switch database, keychain or default endpoint. A host may
 * name one environment variable containing its already-authorized credential;
 * the value is consumed only for the in-memory HTTP request and is never put in
 * diagnostics or durable state.
 */
export function createJevTransportInjection(
  args: ServeArguments,
  env: { readonly [key: string]: string | undefined }
): JevTransportInjection | undefined {
  const credentialEnv = args.jev_credential_env;
  const credentialRef = args.jev_credential_ref;
  if (credentialEnv === undefined && args.jev_allowed_hosts.length === 0) return undefined;
  if (
    credentialEnv !== undefined &&
    (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(credentialEnv) || credentialRef === undefined)
  ) {
    return undefined;
  }
  const credentials =
    credentialEnv === undefined || credentialRef === undefined
      ? undefined
      : {
          async resolve(reference: string): Promise<{ authorization_header: string } | null> {
            if (reference !== credentialRef) return null;
            const value = env[credentialEnv];
            if (value === undefined || value.length === 0) return null;
            return {
              authorization_header: /^Bearer\s/u.test(value) ? value : `Bearer ${value}`
            };
          }
        };
  const http = {
    async request(input: {
      readonly url: string;
      readonly method: "POST";
      readonly headers: Readonly<Record<string, string>>;
      readonly body: Uint8Array;
      readonly signal: AbortSignal;
    }): Promise<{ status: number; body: Uint8Array }> {
      const response = await fetch(input.url, {
        method: input.method,
        headers: input.headers,
        body: input.body,
        signal: input.signal
      });
      return {
        status: response.status,
        body: new Uint8Array(await response.arrayBuffer())
      };
    }
  };
  return {
    ...(credentials === undefined ? {} : { credentials }),
    http,
    allowed_hosts: args.jev_allowed_hosts
  };
}

export type ConfigReloadAutotune = Pick<
  PersistedConfigCompositionOptions,
  "selected" | "reload_sources"
>;

/**
 * Maps the explicit serve triple to the persisted composition inputs. The
 * selected host is only a filter: the approved root, capability binding and
 * model still come from persisted state and the host registry. Without the
 * complete triple no source is supplied and the default resolver stays off.
 */
export function createConfigReloadAutotune(
  args: ServeArguments
): ConfigReloadAutotune | undefined {
  const host = args.config_reload_host;
  const executable = args.config_reload_executable;
  const workspace = args.config_reload_workspace;
  if (host === undefined || executable === undefined || workspace === undefined) {
    return undefined;
  }
  return {
    selected: { host_id: host },
    reload_sources: {
      [host]: { native_executable: executable, workspace }
    }
  };
}

export interface ServeProcessResult {
  readonly exit_code: number;
}

/** Runs the kernel until a signal arrives. */
export async function runServe(argv: readonly string[], env: { readonly [key: string]: string | undefined }): Promise<ServeProcessResult> {
  const parsed = parseServeArguments(argv, env);
  if (!parsed.ok) {
    writeStderr(JSON.stringify(parsed.error));
    return { exit_code: 2 };
  }
  // The shutdown signal handler is armed before the bootstrap so a signal
  // that lands during the startup window still takes the documented exit
  // path instead of the default OS action (terminate by signal).
  const pending: { resolve: (code: number) => void } = { resolve: () => undefined };
  const earlyExit = new Promise<number>((resolvePromise) => {
    pending.resolve = resolvePromise;
  });
  let bootstrapped: Awaited<ReturnType<typeof bootstrapKernel>> | null = null;
  let exitRequested = false;
  const onSignal = (code: number): void => {
    exitRequested = true;
    if (bootstrapped !== null && bootstrapped.ok) {
      void bootstrapped.shutdown().then(
        () => pending.resolve(code),
        () => pending.resolve(code)
      );
      return;
    }
    pending.resolve(code);
  };
  process.once("SIGTERM", () => {
    onSignal(0);
  });
  process.once("SIGINT", () => {
    onSignal(130);
  });

  const jevInjection = createJevTransportInjection(parsed.value, env);
  const configAutotune = createConfigReloadAutotune(parsed.value);
  bootstrapped = await bootstrapKernel({
    home: parsed.value.home,
    product_version: PRODUCT_VERSION,
    ...(parsed.value.generation_binding_key === undefined ? {} : {
      native_review_generation: {
        binding_key: parsed.value.generation_binding_key,
        ...(parsed.value.generation_executable === undefined ? {} : { executable: parsed.value.generation_executable })
      }
    }),
    ...(configAutotune === undefined ? {} : { config_autotune: configAutotune }),
    ...(jevInjection === undefined ? {} : { jev_transport_composition: jevInjection })
  });
  const started = bootstrapped;
  if (!started.ok) {
    writeStderr(JSON.stringify(started.error));
    return { exit_code: started.exit_code };
  }
  if (exitRequested) {
    await started.shutdown();
    return { exit_code: 0 };
  }
  if (started.missing_methods.length > 0) {
    writeStderr(
      JSON.stringify({
        level: "warn",
        message: "kernel.domain_services_unwired",
        methods: started.missing_methods,
        sqlite_version: started.sqlite_version
      })
    );
  }
  if (started.unavailable_methods.length > 0) {
    writeStderr(
      JSON.stringify({
        level: "warn",
        message: "kernel.domain_services_unavailable",
        methods: started.unavailable_methods,
        sqlite_version: started.sqlite_version
      })
    );
  }
  if (started.online_pipeline.status === "not_composed") {
    writeStderr(
      JSON.stringify({
        level: "warn",
        message: "kernel.online_pipeline_not_composed",
        reason: started.online_pipeline.reason,
        detail: started.online_pipeline.detail,
        sqlite_version: started.sqlite_version
      })
    );
  }
  if (started.jev_transport.status === "blocked") {
    writeStderr(
      JSON.stringify({
        level: "warn",
        message: "kernel.jev_transport_blocked",
        reason: started.jev_transport.reason,
        detail: started.jev_transport.detail,
        error_code: started.jev_transport.error?.code ?? null,
        sqlite_version: started.sqlite_version
      })
    );
  }
  if (started.config_autotune.status === "blocked") {
    writeStderr(JSON.stringify({
      level: "warn",
      message: "kernel.config_autotune_blocked",
      error_code: started.config_autotune.error.code,
      sqlite_version: started.sqlite_version
    }));
  }
  if (started.review_generation.status === "disabled") {
    writeStderr(
      JSON.stringify({
        level: "warn",
        message: "kernel.review_generation_disabled",
        reason: started.review_generation.reason,
        detail: started.review_generation.detail,
        sqlite_version: started.sqlite_version
      })
    );
  }
  const exitCode = await earlyExit;
  return { exit_code: exitCode };
}

export async function main(argv: readonly string[]): Promise<void> {
  const result = await runServe(argv, process.env);
  process.exitCode = result.exit_code;
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && import.meta.url === pathToFileURL(invokedPath).href) {
  const argv = process.argv.slice(2);
  void main(argv[0] === "serve" ? argv.slice(1) : argv);
}
