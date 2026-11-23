/**
 * `evolve` command table (DD-FND-101, DD-FND-102, DD-FND-096.5).
 *
 * Every command states its positional arguments, its closed option set, and
 * whether it executes through IPC or a local kernel port. The table is the only
 * place command names are spelled; the parser and the executor both read it.
 */

import type { IpcMethod } from "@evoplug/ipc";

type CliOptionKind = "string" | "integer" | "boolean";

export interface CliOptionSpec {
  readonly name: string;
  readonly kind: CliOptionKind;
  readonly required: boolean;
  readonly value_name?: string;
  readonly enum_values?: readonly string[];
  readonly min?: number;
  readonly max?: number;
  /** The value is a path whose contents are read as JSON. */
  readonly file?: boolean;
}

interface CliPositionalSpec {
  readonly name: string;
  readonly required: boolean;
}

type LocalCommandId =
  | "init"
  | "configure"
  | "configure.jev"
  | "configure.generation"
  | "configure.show"
  | "install"
  | "uninstall"
  | "attach"
  | "detach"
  | "serve"
  | "doctor"
  | "review"
  | "skills.pending"
  | "skills.show"
  | "skills.ask"
  | "skills.diff"
  | "skills.adopt"
  | "skills.disable"
  | "skills.revoke"
  | "skills.resolve"
  | "grant.issue"
  | "grant.revoke"
  | "grant.list"
  | "test.confirm"
  | "export"
  | "import";

/**
 * Idempotency handling for an IPC command:
 * `required` — the request envelope carries `--idempotency-key`;
 * `in_params` — the key lives inside `params` (install methods);
 * `forbidden` — read-only methods never send one.
 */
type CliIdempotency = "required" | "forbidden" | "in_params";

type CliExecution =
  | { readonly kind: "ipc"; readonly method: IpcMethod; readonly idempotency: CliIdempotency }
  | { readonly kind: "local"; readonly handler: LocalCommandId };

export interface CliCommandSpec {
  readonly id: string;
  readonly path: readonly string[];
  readonly summary: string;
  readonly positionals: readonly CliPositionalSpec[];
  readonly options: readonly CliOptionSpec[];
  readonly execution: CliExecution;
  /** Hidden commands are parseable but never listed in `--help`. */
  readonly hidden?: boolean;
}

const APPROVAL_TTL_MIN_MS = 1;
const APPROVAL_TTL_MAX_MS = 600_000;

function stringOpt(name: string, required: boolean, valueName: string): CliOptionSpec {
  return { name, kind: "string", required, value_name: valueName };
}

function fileOpt(name: string, required: boolean, valueName = "FILE"): CliOptionSpec {
  return { name, kind: "string", required, value_name: valueName, file: true };
}

function intOpt(name: string, required: boolean, min: number, max: number, valueName: string): CliOptionSpec {
  return { name, kind: "integer", required, value_name: valueName, min, max };
}

function boolOpt(name: string): CliOptionSpec {
  return { name, kind: "boolean", required: false };
}

function enumOpt(name: string, required: boolean, values: readonly string[], valueName: string): CliOptionSpec {
  return { name, kind: "string", required, value_name: valueName, enum_values: values };
}

function ipc(method: IpcMethod, idempotency: CliIdempotency): CliExecution {
  return { kind: "ipc", method, idempotency };
}

function local(handler: LocalCommandId): CliExecution {
  return { kind: "local", handler };
}

function pos(name: string, required = true): CliPositionalSpec {
  return { name, required };
}

export const CLI_COMMANDS: readonly CliCommandSpec[] = [
  {
    id: "init",
    path: ["init"],
    summary: "create the product home, config, database and IPC runtime",
    positionals: [],
    options: [boolOpt("non-interactive"), { ...boolOpt("test-mode") }],
    execution: local("init")
  },
  {
    id: "configure",
    path: ["configure"],
    summary: "write a new config profile and policy references",
    positionals: [],
    options: [
      boolOpt("show"),
      fileOpt("input", false),
      boolOpt("credential-stdin"),
      fileOpt("jev-input", false)
    ],
    execution: local("configure")
  },
  {
    id: "configure.jev",
    path: ["configure", "jev"],
    summary: "register the Jev endpoint, model and credential environment variable (semantic judgement is off: feature semantic_judge 暂时没有启用)",
    positionals: [],
    options: [
      stringOpt("endpoint", true, "URL"),
      stringOpt("model", true, "ID"),
      stringOpt("credential-env", true, "ENV"),
      stringOpt("request-max-tokens", false, "N"),
      stringOpt("question-max-tokens", false, "N"),
      boolOpt("skip-probe")
    ],
    execution: local("configure.jev")
  },
  {
    id: "configure.generation",
    path: ["configure", "generation"],
    summary: "register the generation host and credential environment variable",
    positionals: [],
    options: [
      stringOpt("host", true, "HOST"),
      stringOpt("model", false, "ID"),
      stringOpt("credential-env", true, "ENV"),
      stringOpt("pricing-file", false, "FILE"),
      boolOpt("pricing-free"),
      // Used only when the host CLI's own provider config cannot be read
      // (for example an isolated test home). The value names the receiver
      // recorded in the standing egress policy; it is never contacted here.
      stringOpt("provider-endpoint", false, "URL")
    ],
    execution: local("configure.generation")
  },
  {
    id: "configure.show",
    path: ["configure", "show"],
    summary: "print the persisted config without secrets",
    positionals: [],
    options: [],
    execution: local("configure.show")
  },
  {
    id: "install",
    path: ["install"],
    summary: "install a verified release into the install root",
    positionals: [],
    options: [stringOpt("from", true, "DIR"), boolOpt("dry-run")],
    execution: local("install")
  },
  {
    id: "install.approve",
    path: ["install", "approve"],
    summary: "issue an adapter-install approval",
    positionals: [],
    options: [
      fileOpt("subject", true),
      fileOpt("attestation", true),
      intOpt("ttl-ms", true, APPROVAL_TTL_MIN_MS, APPROVAL_TTL_MAX_MS, "N"),
      stringOpt("idempotency-key", true, "KEY")
    ],
    execution: ipc("install.approve", "in_params")
  },
  {
    id: "install.revoke",
    path: ["install", "revoke"],
    summary: "revoke an active adapter-install approval",
    positionals: [pos("approval_id")],
    options: [
      stringOpt("approval-hash", true, "HASH"),
      fileOpt("attestation", true),
      enumOpt("reason", true, ["human_revoked", "superseded", "security"], "REASON"),
      stringOpt("idempotency-key", true, "KEY")
    ],
    execution: ipc("install.revoke", "in_params")
  },
  {
    id: "install.approval.get",
    path: ["install", "approval", "get"],
    summary: "read an approval by id and subject hash",
    positionals: [pos("approval_id")],
    options: [stringOpt("subject-hash", true, "HASH")],
    execution: ipc("install.approval.get", "forbidden")
  },
  {
    id: "install.approval.consume",
    path: ["install", "approval", "consume"],
    summary: "consume an approval for one registration hash",
    positionals: [pos("approval_id")],
    options: [
      stringOpt("approval-hash", true, "HASH"),
      stringOpt("registration-hash", true, "HASH"),
      stringOpt("request-id", true, "ID"),
      stringOpt("idempotency-key", true, "KEY")
    ],
    execution: ipc("install.approval.consume", "in_params")
  },
  {
    id: "uninstall",
    path: ["uninstall"],
    summary: "remove managed files, keeping user content and data",
    positionals: [],
    options: [boolOpt("purge-data"), boolOpt("dry-run")],
    execution: local("uninstall")
  },
  {
    id: "attach",
    path: ["attach"],
    summary: "attach one host adapter",
    positionals: [pos("host")],
    options: [
      stringOpt("config-space", false, "NAME"),
      stringOpt("mode", false, "MODE"),
      stringOpt("artifact-dir", false, "DIR"),
      stringOpt("target", false, "TARGET_ID"),
      stringOpt("approval-id", false, "ID"),
      stringOpt("approval-hash", false, "HASH")
    ],
    execution: local("attach")
  },
  {
    id: "detach",
    path: ["detach"],
    summary: "detach one host adapter",
    positionals: [pos("host")],
    options: [stringOpt("config-space", false, "NAME")],
    execution: local("detach")
  },
  {
    id: "serve",
    path: ["serve"],
    summary: "run the kernel until SIGTERM",
    positionals: [],
    options: [
      boolOpt("foreground"),
      stringOpt("generation-binding-key", false, "HASH"),
      fileOpt("generation-executable", false),
      stringOpt("jev-credential-env", false, "ENV"),
      stringOpt("jev-credential-ref", false, "REF"),
      stringOpt("jev-allowed-hosts", false, "HOSTS"),
      stringOpt("config-reload-host", false, "HOST_ID"),
      stringOpt("config-reload-executable", false, "FILE"),
      stringOpt("config-reload-workspace", false, "DIR")
    ],
    execution: local("serve")
  },
  {
    id: "status",
    path: ["status"],
    summary: "read the SystemStatus axes (active_replay, config_autotune, semantic_judge, managed_blocks: 暂时没有启用 by default)",
    positionals: [],
    options: [],
    execution: ipc("status.get", "forbidden")
  },
  {
    id: "doctor",
    path: ["doctor"],
    summary: "read-only permission, journal and schema probes",
    positionals: [],
    options: [enumOpt("probe", false, ["generation"], "KIND")],
    execution: local("doctor")
  },
  {
    id: "review",
    path: ["review"],
    summary: "enqueue a review job for an explicit task",
    positionals: [pos("task", false)],
    options: [],
    execution: local("review")
  },
  {
    id: "skills.pending",
    path: ["skills", "pending"],
    summary: "list candidates waiting for a native confirmation",
    positionals: [],
    options: [],
    execution: local("skills.pending")
  },
  {
    id: "skills.show",
    path: ["skills", "show"],
    summary: "show a candidate's full content",
    positionals: [pos("id")],
    options: [],
    execution: local("skills.show")
  },
  {
    id: "skills.ask",
    path: ["skills", "ask"],
    summary: "ask a pending candidate once at the next session start",
    positionals: [pos("id")],
    options: [],
    execution: local("skills.ask")
  },
  {
    id: "skills.diff",
    path: ["skills", "diff"],
    summary: "show the candidate diff",
    positionals: [pos("id")],
    options: [],
    execution: local("skills.diff")
  },
  {
    id: "skills.adopt",
    path: ["skills", "adopt"],
    summary: "apply a verified candidate through write.apply",
    positionals: [pos("id")],
    options: [fileOpt("request", true), stringOpt("idempotency-key", true, "KEY")],
    execution: local("skills.adopt")
  },
  {
    id: "skills.disable",
    path: ["skills", "disable"],
    summary: "stop loading an adopted candidate without rewriting its content",
    positionals: [pos("id")],
    options: [],
    execution: local("skills.disable")
  },
  {
    id: "test.confirm",
    path: ["test", "confirm"],
    summary: "test-only confirmation backdoor (test-mode homes only)",
    positionals: [pos("candidate_id")],
    options: [],
    execution: local("test.confirm"),
    hidden: true
  },
  {
    id: "skills.revoke",
    path: ["skills", "revoke"],
    summary: "revoke a candidate",
    positionals: [pos("id")],
    options: [],
    execution: local("skills.revoke")
  },
  {
    id: "skills.resolve",
    path: ["skills", "resolve"],
    summary: "record a three-way diff choice",
    positionals: [pos("id")],
    options: [],
    execution: local("skills.resolve")
  },
  {
    id: "grant.issue",
    path: ["grant", "issue"],
    summary: "issue an AuthorizationGrant from a human attestation",
    positionals: [],
    options: [fileOpt("request", true), fileOpt("attestation", true), stringOpt("idempotency-key", true, "KEY")],
    execution: ipc("grant.issue", "required")
  },
  {
    id: "grant.revoke",
    path: ["grant", "revoke"],
    summary: "revoke an AuthorizationGrant",
    positionals: [pos("grant_id")],
    options: [
      stringOpt("expected-hash", true, "HASH"),
      fileOpt("attestation", true),
      enumOpt("reason", true, ["human_revoked", "policy_replaced"], "REASON"),
      stringOpt("idempotency-key", true, "KEY")
    ],
    execution: ipc("grant.revoke", "required")
  },
  {
    id: "grant.list",
    path: ["grant", "list"],
    summary: "list grants without attestation text",
    positionals: [],
    options: [
      stringOpt("object-type", false, "TYPE"),
      enumOpt("state", false, ["active", "revoked", "expired", "consumed"], "STATE"),
      intOpt("limit", false, 1, 1000, "N")
    ],
    execution: ipc("grant.list", "forbidden")
  },
  {
    id: "replay.create",
    path: ["replay", "create"],
    summary: "validate and persist a ReplayPlanDraft (暂时没有启用)",
    positionals: [],
    options: [fileOpt("plan", true), stringOpt("idempotency-key", true, "KEY")],
    execution: ipc("replay.create", "required")
  },
  {
    id: "replay.approve",
    path: ["replay", "approve"],
    summary: "issue a live_external replay approval (暂时没有启用)",
    positionals: [pos("replay_plan_id")],
    options: [
      stringOpt("plan-hash", true, "HASH"),
      intOpt("ttl-ms", true, APPROVAL_TTL_MIN_MS, APPROVAL_TTL_MAX_MS, "N"),
      fileOpt("attestation", true),
      stringOpt("reason", true, "TEXT"),
      stringOpt("idempotency-key", true, "KEY")
    ],
    execution: ipc("replay.approve", "required")
  },
  {
    id: "replay.revoke",
    path: ["replay", "revoke"],
    summary: "revoke an active replay approval (暂时没有启用)",
    positionals: [pos("approval_id")],
    options: [
      stringOpt("approval-hash", true, "HASH"),
      fileOpt("attestation", true),
      enumOpt("reason", true, ["human_revoked", "policy_replaced"], "REASON"),
      stringOpt("idempotency-key", true, "KEY")
    ],
    execution: ipc("replay.revoke", "required")
  },
  {
    id: "replay.reject",
    path: ["replay", "reject"],
    summary: "reject a plan and revoke its active approvals (暂时没有启用)",
    positionals: [pos("replay_plan_id")],
    options: [
      stringOpt("plan-hash", true, "HASH"),
      fileOpt("attestation", true),
      stringOpt("reason", true, "TEXT"),
      stringOpt("idempotency-key", true, "KEY")
    ],
    execution: ipc("replay.reject", "required")
  },
  {
    id: "replay.reconcile",
    path: ["replay", "reconcile"],
    summary: "clear the unknown fence after proving no process survives (暂时没有启用)",
    positionals: [pos("execution_id")],
    options: [
      stringOpt("fencing-token", true, "TOKEN"),
      stringOpt("evidence", true, "REF"),
      fileOpt("attestation", true),
      stringOpt("reason", true, "TEXT"),
      stringOpt("idempotency-key", true, "KEY")
    ],
    execution: ipc("replay.reconcile", "required")
  },
  {
    id: "replay.execute",
    path: ["replay", "execute"],
    summary: "authorize and start one replay execution (暂时没有启用)",
    positionals: [pos("replay_plan_id")],
    options: [
      stringOpt("plan-hash", true, "HASH"),
      stringOpt("approval", false, "ID"),
      stringOpt("idempotency-key", true, "KEY")
    ],
    execution: ipc("replay.execute", "required")
  },
  {
    id: "replay.result",
    path: ["replay", "result"],
    summary: "read one replay execution (暂时没有启用)",
    positionals: [pos("execution_id")],
    options: [],
    execution: ipc("replay.result", "forbidden")
  },
  {
    id: "egress.approve",
    path: ["egress", "approve"],
    summary: "approve one complete egress request preimage",
    positionals: [],
    options: [
      fileOpt("request", true),
      fileOpt("attestation", true),
      intOpt("ttl-ms", true, APPROVAL_TTL_MIN_MS, APPROVAL_TTL_MAX_MS, "N"),
      stringOpt("idempotency-key", true, "KEY")
    ],
    execution: ipc("egress.approve", "required")
  },
  {
    id: "session.fork",
    path: ["session", "fork"],
    summary: "fork a branch at a committed watermark",
    positionals: [pos("branch")],
    options: [
      intOpt("at-watermark", true, 0, Number.MAX_SAFE_INTEGER, "N"),
      enumOpt("reason", false, ["user_fork", "host_fork"], "REASON"),
      stringOpt("idempotency-key", true, "KEY")
    ],
    execution: ipc("identity.fork", "required")
  },
  {
    id: "session.resume",
    path: ["session", "resume"],
    summary: "append identity.resume for an observed watermark",
    positionals: [pos("session")],
    options: [
      intOpt("observed-watermark", true, 0, Number.MAX_SAFE_INTEGER, "N"),
      stringOpt("host", true, "HOST"),
      stringOpt("config-space", true, "NAME"),
      stringOpt("idempotency-key", true, "KEY")
    ],
    execution: ipc("identity.resume", "required")
  },
  {
    id: "gc",
    path: ["gc"],
    summary: "run blob/idempotency garbage collection (default dry_run)",
    positionals: [],
    options: [boolOpt("dry-run"), boolOpt("apply"), stringOpt("idempotency-key", false, "KEY")],
    execution: ipc("maintenance.gc", "required")
  },
  {
    id: "export",
    path: ["export"],
    summary: "export a consistent snapshot, journal and blob manifest",
    positionals: [],
    options: [stringOpt("out", true, "FILE")],
    execution: local("export")
  },
  {
    id: "import",
    path: ["import"],
    summary: "import an export package into an empty home",
    positionals: [],
    options: [stringOpt("in", true, "FILE")],
    execution: local("import")
  }
];

const BY_PATH: ReadonlyMap<string, CliCommandSpec> = new Map(
  CLI_COMMANDS.map((spec) => [spec.path.join(" "), spec])
);

export function commandByPath(path: readonly string[]): CliCommandSpec | null {
  return BY_PATH.get(path.join(" ")) ?? null;
}

/** True when `word` continues `prefix` into at least one command path. */
export function isCommandPrefix(prefix: readonly string[], word: string): boolean {
  const candidate = [...prefix, word];
  for (const spec of CLI_COMMANDS) {
    if (spec.path.length < candidate.length) {
      continue;
    }
    let matches = true;
    for (let index = 0; index < candidate.length; index += 1) {
      if (spec.path[index] !== candidate[index]) {
        matches = false;
        break;
      }
    }
    if (matches) {
      return true;
    }
  }
  return false;
}

