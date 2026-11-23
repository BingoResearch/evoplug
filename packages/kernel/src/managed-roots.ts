/**
 * Managed-write roots for host-owned experience directories (design §7, G6).
 *
 * `attach` registers one root per object kind the adapter declares. Roots are
 * persisted with state `pending_approval`; the first adoption confirmation
 * approves them, and `detach` revokes them.
 *
 * Appendix H.1: the absolute path is resolved exactly once, at attach time,
 * from the attach caller's host environment. It is stored as an absolute
 * `file://` URI in `root_registration.native_root_ref`. `write.apply`, static
 * checks and directory creation only read that registration; no code path
 * derives a host directory from the kernel process's own environment. A write
 * is only accepted inside the registered root, and inside an `evoplug`
 * subdirectory or managed block of it.
 */

import { mkdirSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

import { applyManagedBlockEdit } from "@evoplug/auth";

import { canonicalHash, type ErrorEnvelope, type Hash, type Id, type Result } from "@evoplug/core";
import { err, makeErrorEnvelope, ok } from "@evoplug/core";
import type { HostId, HostMode } from "@evoplug/core/host";
import type { SqlRow, SqliteConnection } from "@evoplug/storage";

export type ManagedObjectKind = "skill" | "memory" | "instructions";
export type ManagedRootState = "pending_approval" | "approved" | "revoked";

/**
 * Appendix M.1's `project_id` column arrives with a later domain migration.
 * Older fixtures and upgraded-in-place homes may not have it yet; the code
 * degrades to no project binding instead of failing registration.
 */
function tableHasColumn(
  connection: Pick<SqliteConnection, "prepare">,
  table: string,
  column: string
): boolean {
  try {
    const rows = connection.prepare<SqlRow>(`PRAGMA table_info(${table})`).all();
    return rows.some((row) => row["name"] === column);
  } catch {
    return false;
  }
}

export interface ManagedRootDeclaration {
  readonly kind: ManagedObjectKind;
  /** Path below the host's own configuration directory or the project root. */
  readonly relative_path: string;
  readonly write_mode: "whole_file" | "managed_block";
  readonly block_selector?: string;
  /** Path prefix a candidate must stay inside, relative to the root. */
  readonly target_prefix: string;
  /**
   * Appendix K.1: instructions are the *project* instruction file the host
   * loads, while skills (and a host's native memory directory) live below the
   * host configuration directory.
   */
  readonly base: "host_home" | "project_root";
}

export interface HostManagedRoots {
  readonly host_id: HostId;
  /** Resolves the host directory from an explicit environment snapshot. */
  readonly host_home: (env: HostEnvironment) => string | null;
  readonly declarations: readonly ManagedRootDeclaration[];
}

/** The attach caller's environment. Never the long-lived kernel's own env. */
export type HostEnvironment = Readonly<Record<string, string | undefined>>;

function present(value: string | undefined): value is string {
  return value !== undefined && value.length > 0;
}

function envPath(env: HostEnvironment, name: string, fallback: string | null): string | null {
  const value = env[name];
  return present(value) ? value : fallback;
}

const SKILL: ManagedRootDeclaration = {
  kind: "skill",
  relative_path: "skills",
  write_mode: "whole_file",
  target_prefix: "evoplug/",
  base: "host_home"
};

/**
 * oh-my-pi and OpenHands SDK discover `skills/<name>/SKILL.md` one level below
 * the skills directory; the shared `evoplug/` namespace is invisible to them.
 */
const OMP_SKILL: ManagedRootDeclaration = {
  kind: "skill",
  relative_path: "skills",
  write_mode: "whole_file",
  target_prefix: "",
  base: "host_home"
};

/**
 * Appendix K.1, measured on Claude Code 2.1.326: the user-level
 * `$CLAUDE_CONFIG_DIR/skills` directory is not advertised in print mode or in
 * an attached session. A plugin's `skills/<name>/SKILL.md` is advertised
 * whenever the plugin is loaded (`claude --plugin-dir <root>` in the closure,
 * a marketplace install in production), and attach already writes that plugin
 * below the host config directory. Writing evoplug's skill there keeps the
 * native loading path and the managed root identical.
 */
const CLAUDE_SKILL: ManagedRootDeclaration = {
  kind: "skill",
  relative_path: "plugins/evoplug/skills",
  write_mode: "whole_file",
  target_prefix: "",
  base: "host_home"
};

/**
 * Appendix K.1: the instructions object is the project instruction file the
 * host reads at session start, not a file below the host's own config
 * directory. A managed block keeps user text outside the markers byte-identical.
 */

/**
 * Appendix K.1 memory fallback: the host's user-level global instruction file
 * is loaded in every session. The memory block uses its own selector so it is
 * independent of the project instructions block in a different file.
 *
 * Measured on 2026-11-19: Pi/OMP/Step load `<agent>/AGENTS.md`; OpenCode loads
 * `<XDG_CONFIG_HOME>/opencode/AGENTS.md`.
 */
const GLOBAL_MEMORY: ManagedRootDeclaration = {
  kind: "memory",
  relative_path: ".",
  write_mode: "managed_block",
  block_selector: "evoplug-memory",
  target_prefix: "",
  base: "host_home"
};
const PROJECT_INSTRUCTIONS: ManagedRootDeclaration = {
  kind: "instructions",
  relative_path: ".",
  write_mode: "managed_block",
  block_selector: "evoplug",
  target_prefix: "",
  base: "project_root"
};

/**
 * Declaration table kept in one place so every attach path uses the same
 * coordinates. The adapter packages own the host directory environment names;
 * this table mirrors them rather than inventing a second convention.
 */
export const MANAGED_ROOTS: Readonly<Record<HostId, HostManagedRoots>> = {
  pi: {
    host_id: "pi",
    host_home: (env) => {
      const home = envPath(env, "HOME", null);
      return envPath(env, "PI_CODING_AGENT_DIR", home === null ? null : join(home, ".pi", "agent"));
    },
    declarations: [SKILL, GLOBAL_MEMORY, PROJECT_INSTRUCTIONS]
  },
  "oh-my-pi": {
    host_id: "oh-my-pi",
    host_home: (env) => {
      const home = envPath(env, "HOME", null);
      // oh-my-pi reads `PI_CODING_AGENT_DIR` as the agent dir. `OMP_PROFILE`
      // is a profile *name*, not a path: its agent dir is
      // `<home>/.omp/profiles/<name>/agent`. Treating the name as a path made
      // attach register roots the host never reads.
      const agent = envPath(env, "PI_CODING_AGENT_DIR", null);
      if (agent !== null) return agent;
      const profile = envPath(env, "OMP_PROFILE", null);
      if (profile !== null && home !== null) {
        return join(home, ".omp", "profiles", profile, "agent");
      }
      return home === null ? null : join(home, ".omp", "agent");
    },
    declarations: [OMP_SKILL, GLOBAL_MEMORY, PROJECT_INSTRUCTIONS]
  },
  "claude-code": {
    host_id: "claude-code",
    host_home: (env) => {
      const home = envPath(env, "HOME", null);
      return envPath(env, "CLAUDE_CONFIG_DIR", home === null ? null : join(home, ".claude"));
    },
    // Measured on 2.1.326: `$CLAUDE_CONFIG_DIR/CLAUDE.md` is loaded in every
    // session as the user-level memory file, and a plugin skill is loaded
    // through the plugin root attach writes.
    declarations: [CLAUDE_SKILL, GLOBAL_MEMORY, PROJECT_INSTRUCTIONS]
  },
  codex: {
    host_id: "codex",
    host_home: (env) => {
      const home = envPath(env, "HOME", null);
      return envPath(env, "CODEX_HOME", home === null ? null : join(home, ".codex"));
    },
    // Measured on 0.160.1: `$CODEX_HOME/AGENTS.md` is loaded in every session
    // as the user-level instruction file.
    declarations: [SKILL, GLOBAL_MEMORY, PROJECT_INSTRUCTIONS]
  },
  opencode: {
    host_id: "opencode",
    host_home: (env) => {
      const home = envPath(env, "HOME", null);
      const config = envPath(env, "XDG_CONFIG_HOME", home === null ? null : join(home, ".config"));
      return config === null ? null : join(config, "opencode");
    },
    declarations: [SKILL, GLOBAL_MEMORY, PROJECT_INSTRUCTIONS]
  },
  "step-code": {
    host_id: "step-code",
    host_home: (env) => {
      const home = envPath(env, "HOME", null);
      return envPath(env, "STEP_CODING_AGENT_DIR", home === null ? null : join(home, ".stepcode", "agent"));
    },
    declarations: [SKILL, GLOBAL_MEMORY, PROJECT_INSTRUCTIONS]
  },
  "openhands-sdk": {
    host_id: "openhands-sdk",
    host_home: (env) => {
      const home = envPath(env, "HOME", null);
      return envPath(env, "OH_PERSISTENCE_DIR", home === null ? null : join(home, ".openhands"));
    },
    // Measured on SDK 1.56.0: AGENTS.md and ~/.openhands/memory/MEMORY.md are
    // loaded only when the embedding application sets load_project_skills /
    // load_memory on AgentContext. Both default to false, and a plugin cannot
    // set them, so neither object has a native loading path for this adapter.
    // The skill loader reads one level (`skills/<name>/SKILL.md`).
    declarations: [OMP_SKILL]
  }
};

export function hostManagedRoots(host_id: string): HostManagedRoots | null {
  return (MANAGED_ROOTS as Record<string, HostManagedRoots | undefined>)[host_id] ?? null;
}

/**
 * Appendix Q.1: with `managed_blocks` off, attach registers the skill root
 * only. Memory and instructions declarations stay in the table so enabling
 * the flag later restores them without a code change.
 */
export function activeManagedDeclarations(
  roots: HostManagedRoots,
  managed_blocks: boolean
): readonly ManagedRootDeclaration[] {
  return managed_blocks
    ? roots.declarations
    : roots.declarations.filter((declaration) => declaration.kind === "skill");
}

/**
 * Appendix M.1: a project id is derived from the project root's realpath, so
 * it is stable across attach calls and independent of the kernel process.
 */
export function deriveProjectId(projectRoot: string): string {
  return `proj:${canonicalHash({
    schema_version: "rsi.project_id/1",
    root: projectRoot
  }).slice("sha256:".length, "sha256:".length + 32)}`;
}

/** The host directory implied by one attach caller's environment snapshot. */
export function hostHomePath(host_id: string, env: HostEnvironment): string | null {
  const roots = hostManagedRoots(host_id);
  return roots === null ? null : roots.host_home(env);
}

/**
 * The instructions file each host loads from its own configuration directory.
 * A managed root for `instructions` points at that directory (relative_path
 * "."), so the concrete file name is a host fact rather than a root fact.
 */
export const HOST_INSTRUCTIONS_FILE: Readonly<Record<HostId, string>> = Object.freeze({
  pi: "AGENTS.md",
  "oh-my-pi": "AGENTS.md",
  "claude-code": "CLAUDE.md",
  codex: "AGENTS.md",
  opencode: "AGENTS.md",
  "step-code": "AGENTS.md",
  "openhands-sdk": "AGENTS.md"
});

/**
 * Appendix K.1: disabling an instructions object detaches only the managed
 * block. Text outside the markers is returned byte-for-byte unchanged, so a
 * user's own instructions never disappear with the adopted block.
 */
export function detachManagedBlock(
  bytes: Uint8Array,
  selector: string
): Result<Uint8Array, ErrorEnvelope> {
  const edited = applyManagedBlockEdit({
    bytes,
    selector,
    block_action: "detach",
    content: null
  });
  return edited.ok ? ok(edited.value.bytes) : edited;
}

/** Normalises a managed root's directory and its evoplug prefix into one path. */export function managedTargetPrefix(relative_path: string, target_prefix: string): string {
  const base =
    relative_path === "." || relative_path === ""
      ? ""
      : `${relative_path.replace(/\/+$/u, "")}/`;
  return `${base}${target_prefix.replace(/^\/+/u, "")}`;
}

export interface ManagedTargetRefSource {
  readonly kind: ManagedObjectKind;
  readonly relative_path: string;
  readonly target_prefix: string;
  readonly block_selector: string | null;
  readonly write_mode?: "whole_file" | "managed_block";
}

/**
 * Concrete target templates for one host's registered managed roots.
 *
 * Generation prompts and the static check both consume this list (Appendix
 * F.4): `<name>` is the only placeholder, so a prompt can never advertise a
 * target shape the checker does not accept.
 */
export function managedTargetRefTemplates(
  host_id: string,
  roots: readonly ManagedTargetRefSource[]
): string[] {
  const refs = new Set<string>();
  for (const root of roots) {
    const prefix = managedTargetPrefix(root.relative_path, root.target_prefix);
    if (root.kind === "skill") {
      refs.add(`${prefix}<name>/SKILL.md`);
    } else if (root.kind === "memory") {
      if (root.write_mode === "managed_block") {
        // Appendix M.2: `path_or_block` is the file path only; the block
        // selector is a separate `block_id` field on the target.
        const file = HOST_INSTRUCTIONS_FILE[host_id as HostId] ?? "AGENTS.md";
        refs.add(file);
      } else {
        refs.add(`${prefix}<name>.md`);
      }
    } else {
      const file = HOST_INSTRUCTIONS_FILE[host_id as HostId] ?? "AGENTS.md";
      refs.add(file);
    }
  }
  return [...refs].sort();
}

/**
 * Checks one candidate target against the managed root's shape. Returns a
 * machine-readable rule name when the target is outside the advertised shape,
 * or null when it is acceptable.
 */
export function validateManagedTargetShape(input: {
  readonly kind: ManagedObjectKind;
  readonly relative_path: string;
  readonly target_prefix: string;
  readonly block_selector: string | null;
  readonly path_or_block: string;
  readonly requested_write_mode: "whole_file" | "managed_block";
  readonly block_id?: string | null;
}): string | null {
  // `path_or_block` is already relative to the managed root (the caller
  // stripped `relative_path`), so only the evoplug prefix applies here.
  const prefix = managedTargetPrefix("", input.target_prefix);
  const rest = input.path_or_block.startsWith(prefix)
    ? input.path_or_block.slice(prefix.length)
    : null;
  if (input.kind === "skill") {
    if (rest === null) return "target_prefix";
    const segments = rest.split("/");
    if (
      segments.length !== 2 ||
      segments[1] !== "SKILL.md" ||
      !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(segments[0] ?? "")
    ) {
      return "skill_shape";
    }
    if (input.requested_write_mode !== "whole_file") return "write_mode";
    return null;
  }
  if (input.kind === "memory") {
    if (input.requested_write_mode === "managed_block") {
      // Appendix K.1 memory fallback: a block in the user-level global
      // instruction file, separate from the project instructions block.
      const block = input.block_selector ?? "evoplug-memory";
      if (input.block_id !== block) return "block_selector";
      const file = input.path_or_block.split("#")[0] ?? "";
      if (file.length === 0 || file.includes("..") || file.startsWith("/")) return "memory_shape";
      return null;
    }
    if (rest === null) return "target_prefix";
    const segments = rest.split("/");
    if (segments.length !== 1 || !/^[A-Za-z0-9][A-Za-z0-9._-]*\.md$/u.test(segments[0] ?? "")) {
      return "memory_shape";
    }
    if (input.requested_write_mode !== "whole_file") return "write_mode";
    return null;
  }
  if (input.requested_write_mode !== "managed_block") return "write_mode";
  const block = input.block_selector ?? "evoplug";
  if (input.block_id !== block) return "block_selector";
  const file = input.path_or_block.split("#")[0] ?? "";
  if (file.length === 0 || file.includes("..") || file.startsWith("/")) return "instructions_shape";
  return null;
}

export interface ManagedRootRow {
  readonly root_id: string;
  readonly host_id: string;
  readonly mode: string;
  readonly config_space: string;
  readonly adapter_id: string;
  readonly kind: ManagedObjectKind;
  readonly relative_path: string;
  readonly write_mode: "whole_file" | "managed_block";
  readonly block_selector: string | null;
  readonly target_prefix: string;
  readonly state: ManagedRootState;
  readonly registration_hash: Hash;
  /**
   * Appendix M.1: the project a `project_root` declaration belongs to. Null
   * for roots below the host configuration directory.
   */
  readonly project_id: string | null;
  /**
   * Absolute `file://` URI recorded at attach time. Null when no registration
   * row exists, which fails closed: there is no fallback to the kernel env.
   */
  readonly native_root_ref: string | null;
}

export function managedRootId(
  host_id: string,
  config_space: string,
  kind: ManagedObjectKind
): string {
  return `root:${canonicalHash({ schema_version: "rsi.managed_root_id/1", host_id, config_space, kind }).slice("sha256:".length)}`;
}

function pinFor(path: string): { identity_kind: "dev_inode" | "file_id"; device_id: string; file_id: string } {
  const stats = statSync(path, { bigint: true });
  if (process.platform === "win32") {
    return { identity_kind: "file_id", device_id: String(stats.dev), file_id: String(stats.ino) };
  }
  return { identity_kind: "dev_inode", device_id: String(stats.dev), file_id: String(stats.ino) };
}

function rootFailure(path: string, rule: string): ErrorEnvelope {
  return makeErrorEnvelope({
    code: "E_ROOT_UNAVAILABLE",
    category: "policy",
    message_key: "error.root.unavailable",
    stage: "managed_root",
    retryable: false,
    side_effect: "none",
    details: { kind: "field", path, rule }
  });
}

/**
 * Registers the declared roots for one attached host. Existing rows keep their
 * state: re-attach must not silently approve a pending root.
 */
export function registerManagedRoots(input: {
  readonly connection: SqliteConnection;
  readonly host_id: HostId;
  readonly mode: HostMode;
  readonly config_space: string;
  readonly adapter_id: Id<"adp">;
  /** Snapshot of the attach caller's environment, not the kernel's own. */
  readonly host_env: HostEnvironment;
  /**
   * Attach caller's project directory. Instructions roots resolve here
   * (appendix K.1); the long-lived kernel never derives it from its own cwd.
   */
  readonly project_root?: string;
  /**
   * Appendix I.1: when a running `serve` registers on behalf of a local
   * attach, the caller resolves each host directory from its own environment
   * and passes the absolute paths here. `host_env` is then unused.
   */
  readonly resolved_roots?: readonly {
    readonly kind: ManagedObjectKind;
    readonly absolute_path: string;
  }[];
  /**
   * Appendix Q.1: `features: ["managed_blocks"]`. Off by default, so a caller
   * that omits it registers skills only.
   */
  readonly managed_blocks?: boolean;
  readonly now: number;
}): Result<readonly ManagedRootRow[], ErrorEnvelope> {
  const roots = hostManagedRoots(input.host_id);
  if (roots === null) return ok([]);
  const declarations = activeManagedDeclarations(roots, input.managed_blocks === true);
  const resolvedByKind = new Map(
    (input.resolved_roots ?? []).map((entry) => [entry.kind, entry.absolute_path])
  );
  const homeDir = resolvedByKind.size > 0 ? null : roots.host_home(input.host_env);
  if (resolvedByKind.size === 0 && (homeDir === null || !isAbsolute(homeDir))) {
    return err(rootFailure("host_env", "unresolved_host_home"));
  }
  const projectRoot = resolvedByKind.size > 0
    ? null
    : input.project_root ?? input.host_env["EVOPLUG_PROJECT_ROOT"] ?? null;
  if (
    resolvedByKind.size === 0 &&
    declarations.some((declaration) => declaration.base === "project_root") &&
    (projectRoot === null || !isAbsolute(projectRoot))
  ) {
    return err(rootFailure("project_root", "unresolved_project_root"));
  }
  const written: ManagedRootRow[] = [];
  for (const declaration of declarations) {
    const explicit = resolvedByKind.get(declaration.kind);
    if (resolvedByKind.size > 0 && (explicit === undefined || !isAbsolute(explicit))) {
      return err(rootFailure(declaration.relative_path, "resolved_root_missing"));
    }
    const base = declaration.base === "project_root" ? projectRoot : homeDir;
    const absolute = explicit ?? join(base as string, declaration.relative_path);
    try {
      mkdirSync(absolute, { recursive: true });
    } catch {
      return err(rootFailure(declaration.relative_path, "mkdir_failed"));
    }
    // `/tmp` and `/var` are symlinks on macOS; the root registry rejects a
    // path that is not its own realpath. Register the resolved directory.
    let resolvedRoot: string;
    try {
      resolvedRoot = realpathSync(absolute);
    } catch {
      return err(rootFailure(declaration.relative_path, "realpath_failed"));
    }
    let pin: ReturnType<typeof pinFor>;
    try {
      pin = pinFor(resolvedRoot);
    } catch {
      return err(rootFailure(declaration.relative_path, "stat_failed"));
    }
    const rootId = managedRootId(input.host_id, input.config_space, declaration.kind);
    const registrationHash = canonicalHash({
      schema_version: "rsi.managed_root/1",
      root_id: rootId,
      host_id: input.host_id,
      kind: declaration.kind,
      relative_path: declaration.relative_path
    });
    const existing = input.connection
      .prepare<SqlRow>("SELECT state FROM managed_root WHERE root_id = :root_id")
      .get({ root_id: rootId });
    const revive = existing !== undefined && existing["state"] === "revoked";
    if (revive) {
      // Re-attach revives a root that detach revoked, still pending approval.
      input.connection
        .prepare("UPDATE managed_root SET state = 'pending_approval', updated_at = :now WHERE root_id = :root_id")
        .run({ root_id: rootId, now: input.now });
    }
    if (existing === undefined) {
      input.connection
        .prepare(
          `INSERT INTO managed_root (
             root_id, host_id, mode, config_space, adapter_id, kind, relative_path,
             write_mode, block_selector, target_prefix, state, registration_hash,
             created_at, updated_at
           ) VALUES (
             :root_id, :host_id, :mode, :config_space, :adapter_id, :kind, :relative_path,
             :write_mode, :block_selector, :target_prefix, 'pending_approval',
             :registration_hash, :created_at, :updated_at
           )`
        )
        .run({
          root_id: rootId,
          host_id: input.host_id,
          mode: input.mode,
          config_space: input.config_space,
          adapter_id: input.adapter_id,
          kind: declaration.kind,
          relative_path: declaration.relative_path,
          write_mode: declaration.write_mode,
          block_selector: declaration.block_selector ?? null,
          target_prefix: declaration.target_prefix,
          registration_hash: registrationHash,
          created_at: input.now,
          updated_at: input.now
        });
    }
    // Always refresh the registration row: re-attach may run in a different
    // host environment (for example a test home), and the registered absolute
    // path is the only source write.apply may use afterwards. The root state
    // stays untouched, so this never approves a pending root. Update in place:
    // a REPLACE would delete the row and trip the ON DELETE RESTRICT
    // references from adoption/write records created since the first attach.
    // Appendix M.1: a project root also records the project id derived from
    // its realpath; sessions are bound to that project at task creation.
    const projectId = declaration.base === "project_root" ? deriveProjectId(resolvedRoot) : null;
    const hasProjectId = tableHasColumn(input.connection, "root_registration", "project_id");
    input.connection
      .prepare(
        `INSERT INTO root_registration (
           root_id, registration_hash, host_id, mode, config_space, adapter_id,
           native_root_ref, identity_kind, device_id, file_id, registered_at,
           row_version${hasProjectId ? ", project_id" : ""}
         ) VALUES (
           :root_id, :registration_hash, :host_id, :mode, :config_space, :adapter_id,
           :native_root_ref, :identity_kind, :device_id, :file_id, :registered_at,
           1${hasProjectId ? ", :project_id" : ""}
         )
         ON CONFLICT(root_id) DO UPDATE SET
           registration_hash = excluded.registration_hash,
           host_id = excluded.host_id,
           mode = excluded.mode,
           config_space = excluded.config_space,
           adapter_id = excluded.adapter_id,
           native_root_ref = excluded.native_root_ref,
           identity_kind = excluded.identity_kind,
           device_id = excluded.device_id,
           file_id = excluded.file_id,
           registered_at = excluded.registered_at,
           row_version = root_registration.row_version + 1${hasProjectId ? ",\n           project_id = excluded.project_id" : ""}`
      )
      .run({
        root_id: rootId,
        registration_hash: registrationHash,
        host_id: input.host_id,
        mode: input.mode,
        config_space: input.config_space,
        adapter_id: input.adapter_id,
        native_root_ref: pathToFileURL(resolvedRoot).href,
        identity_kind: pin.identity_kind,
        device_id: pin.device_id,
        file_id: pin.file_id,
        registered_at: input.now,
        ...(hasProjectId ? { project_id: projectId } : {})
      });
    const stored = readManagedRoot(input.connection, rootId);
    if (!stored.ok) return stored;
    if (stored.value !== null) written.push(stored.value);
  }
  return ok(written);
}

export function readManagedRoot(
  connection: SqliteConnection,
  root_id: string
): Result<ManagedRootRow | null, ErrorEnvelope> {
  const hasProjectId = tableHasColumn(connection, "root_registration", "project_id");
  const row = connection
    .prepare<SqlRow>(
      `SELECT m.*, r.native_root_ref AS native_root_ref,
              ${hasProjectId ? "r.project_id" : "NULL"} AS project_id
         FROM managed_root m
         LEFT JOIN root_registration r ON r.root_id = m.root_id
        WHERE m.root_id = :root_id`
    )
    .get({ root_id });
  if (row === undefined) return ok(null);
  const state = row["state"];
  if (state !== "pending_approval" && state !== "approved" && state !== "revoked") {
    return err(rootFailure("state", "invalid_state"));
  }
  const nativeRootRef = row["native_root_ref"];
  return ok({
    root_id: String(row["root_id"]),
    host_id: String(row["host_id"]),
    mode: String(row["mode"]),
    config_space: String(row["config_space"]),
    adapter_id: String(row["adapter_id"]),
    kind: row["kind"] as ManagedObjectKind,
    relative_path: String(row["relative_path"]),
    write_mode: row["write_mode"] as "whole_file" | "managed_block",
    block_selector: row["block_selector"] === null ? null : String(row["block_selector"]),
    target_prefix: String(row["target_prefix"]),
    state,
    registration_hash: row["registration_hash"] as Hash,
    project_id: row["project_id"] === null || row["project_id"] === undefined
      ? null
      : String(row["project_id"]),
    native_root_ref: typeof nativeRootRef === "string" ? nativeRootRef : null
  });
}

/**
 * Appendix M.1: binds a new task to the project whose registered instructions
 * root contains the session's working directory. The runtime session row is
 * written on `ready`, before the first event upload. A missing working
 * directory, an unreadable path or no matching root returns null, and the
 * session then has no project (no instructions candidates).
 */
export function resolveProjectIdForSession(
  connection: Pick<SqliteConnection, "prepare">,
  input: {
    readonly host_id: string;
    readonly config_space: string;
    readonly native_session_id: string;
  }
): string | null {
  // Older fixtures lack the additive Appendix M columns; binding is simply
  // unavailable there, never an error in the ingest path.
  if (
    !tableHasColumn(connection, "host_runtime_session", "working_directory") ||
    !tableHasColumn(connection, "root_registration", "project_id")
  ) {
    return null;
  }
  const runtime = connection
    .prepare<SqlRow>(
      `SELECT working_directory FROM host_runtime_session
        WHERE host_id = :host_id AND config_space = :config_space
          AND native_session_id = :native_session_id
          AND working_directory IS NOT NULL
        ORDER BY last_seen_at DESC LIMIT 1`
    )
    .get({
      host_id: input.host_id,
      config_space: input.config_space,
      native_session_id: input.native_session_id
    });
  const raw = runtime?.["working_directory"];
  if (process.env["EVOPLUG_DEBUG_IPC"] === "1") {
    const all = connection
      .prepare<SqlRow>(
        `SELECT session_id, working_directory, state FROM host_runtime_session
          WHERE host_id = :host_id AND config_space = :config_space
            AND native_session_id = :native_session_id`
      )
      .all({
        host_id: input.host_id,
        config_space: input.config_space,
        native_session_id: input.native_session_id
      });
    process.stderr.write(
      `evoplug kernel: project_bind_dbg host=${input.host_id} config=${input.config_space} native=${input.native_session_id} raw=${String(raw)} rows=${JSON.stringify(all)}\n`
    );
  }
  if (typeof raw !== "string" || raw.length === 0) return null;
  let workingDirectory: string;
  try {
    workingDirectory = realpathSync(raw);
  } catch {
    return null;
  }
  const roots = connection
    .prepare<SqlRow>(
      `SELECT rr.native_root_ref AS native_root_ref, rr.project_id AS project_id
         FROM root_registration rr
         JOIN managed_root m ON m.root_id = rr.root_id
        WHERE m.host_id = :host_id AND m.config_space = :config_space
          AND m.kind = 'instructions'
          AND m.state IN ('pending_approval','approved')
          AND rr.project_id IS NOT NULL`
    )
    .all({ host_id: input.host_id, config_space: input.config_space });
  let best: { root: string; project_id: string } | null = null;
  for (const row of roots) {
    const ref = row["native_root_ref"];
    const projectId = row["project_id"];
    if (typeof ref !== "string" || typeof projectId !== "string" || projectId.length === 0) {
      continue;
    }
    let root: string;
    try {
      root = realpathSync(fileURLToPath(ref));
    } catch {
      continue;
    }
    const inside =
      workingDirectory === root ||
      workingDirectory.startsWith(root.endsWith("/") ? root : `${root}/`);
    if (process.env["EVOPLUG_DEBUG_IPC"] === "1") {
      process.stderr.write(
        `evoplug kernel: project_bind_root ref=${ref} root=${root} inside=${String(inside)}\n`
      );
    }
    if (!inside) continue;
    if (best === null || root.length > best.root.length) {
      best = { root, project_id: projectId };
    }
  }
  return best?.project_id ?? null;
}

export function listManagedRoots(  connection: SqliteConnection,
  filter: { readonly host_id?: string; readonly config_space?: string } = {}
): readonly ManagedRootRow[] {
  const clauses: string[] = [];
  const params: Record<string, unknown> = {};
  if (filter.host_id !== undefined) {
    clauses.push("host_id = :host_id");
    params["host_id"] = filter.host_id;
  }
  if (filter.config_space !== undefined) {
    clauses.push("config_space = :config_space");
    params["config_space"] = filter.config_space;
  }
  const where = clauses.length === 0 ? "" : ` WHERE ${clauses.join(" AND ")}`;
  const rows = connection
    .prepare<SqlRow>(`SELECT root_id FROM managed_root${where} ORDER BY root_id ASC`)
    .all(params);
  const out: ManagedRootRow[] = [];
  for (const row of rows) {
    const read = readManagedRoot(connection, String(row["root_id"]));
    if (read.ok && read.value !== null) out.push(read.value);
  }
  return out;
}

export function approveManagedRoots(
  connection: SqliteConnection,
  root_ids: readonly string[],
  now: number
): number {
  let changed = 0;
  for (const rootId of root_ids) {
    const result = connection
      .prepare(
        "UPDATE managed_root SET state = 'approved', updated_at = :now WHERE root_id = :root_id AND state = 'pending_approval'"
      )
      .run({ root_id: rootId, now });
    changed += result.changes;
  }
  return changed;
}

/** Root ids for one host that are still waiting for their first adoption. */
export function pendingManagedRootsForHost(
  connection: SqliteConnection,
  host_id: string
): readonly string[] {
  return connection
    .prepare<SqlRow>(
      "SELECT root_id FROM managed_root WHERE host_id = :host_id AND state = 'pending_approval' ORDER BY root_id ASC"
    )
    .all({ host_id })
    .map((row) => String(row["root_id"]));
}

/** Detach revokes the host's roots; files already written are left in place. */
export function revokeManagedRootsForHost(
  connection: SqliteConnection,
  host_id: string,
  now: number
): number {
  const result = connection
    .prepare("UPDATE managed_root SET state = 'revoked', updated_at = :now WHERE host_id = :host_id")
    .run({ host_id, now });
  connection
    .prepare("DELETE FROM root_registration WHERE root_id IN (SELECT root_id FROM managed_root WHERE host_id = :host_id)")
    .run({ host_id });
  return result.changes;
}

/**
 * Resolves a managed root from its attach-time registration only.
 *
 * Appendix H.1: the kernel never recomputes this path from its own environment.
 * A missing or malformed registration fails closed; callers translate the
 * throw into `E_ROOT_UNAVAILABLE/not_registered`.
 */
export function resolveManagedRootPath(row: ManagedRootRow): string {
  const ref = row.native_root_ref;
  if (ref === null || ref.length === 0 || !ref.startsWith("file://")) {
    throw new Error("native_root_ref_missing");
  }
  let path: string;
  try {
    const parsed = new URL(ref);
    // Legacy rows used `file://${encodeURI(path)}`, which leaves `#` and `?`
    // unescaped and would silently truncate through URL parsing. Only trust
    // the URL form when it carries no fragment or query.
    if (parsed.hash.length > 0 || parsed.search.length > 0) {
      throw new Error("legacy_ref");
    }
    path = fileURLToPath(parsed);
  } catch {
    try {
      path = decodeURI(ref.slice("file://".length));
    } catch {
      throw new Error("native_root_ref_invalid");
    }
  }
  if (!isAbsolute(path) || path.includes("\u0000")) {
    throw new Error("native_root_ref_not_absolute");
  }
  const resolved = realpathSync(path);
  if (resolved !== path) {
    throw new Error("native_root_ref_not_realpath");
  }
  return resolved;
}

/** True when `target` is the registered root or a strict descendant. */
export function isTargetInsideRoot(rootPath: string, target: string): boolean {
  const root = rootPath.endsWith("/") ? rootPath.slice(0, -1) : rootPath;
  return target === root || target.startsWith(`${root}/`);
}

/** Resolver passed to `createWriteApplyHandler`; approved roots only. */
export function createManagedRootResolver(connection: SqliteConnection): {
  resolve(input: {
    readonly root_id: string;
    readonly request_id: Id<"ipc">;
    readonly deadline_ms: number;
    readonly signal: AbortSignal;
  }): Promise<Result<{
    approved_root: string;
    root_identity_pin: {
      schema_version: "rsi.root_identity/1";
      root_id: string;
      identity_kind: "dev_inode" | "file_id";
      device_id: string;
      file_id: string;
    };
    root_registration_hash: Hash;
  }, ErrorEnvelope>>;
} {
  return {
    async resolve(input) {
      const read = readManagedRoot(connection, input.root_id);
      if (!read.ok) return read;
      const row = read.value;
      if (row === null || row.state !== "approved") {
        return err(rootFailure("root_id", "not_approved"));
      }
      const registration = connection
        .prepare<SqlRow>(
          "SELECT registration_hash, identity_kind, device_id, file_id FROM root_registration WHERE root_id = :root_id"
        )
        .get({ root_id: row.root_id });
      if (registration === undefined) {
        if (process.env["EVOPLUG_DEBUG_IPC"] === "1") {
          const count = connection
            .prepare<{ n: number }>("SELECT COUNT(*) AS n FROM root_registration")
            .get();
          process.stderr.write(
            `evoplug kernel: root_resolve_failed root_id=${row.root_id} registrations=${String(count?.n ?? 0)} db=${String((connection.prepare<{ file: string }>("PRAGMA database_list").get() as { file?: string } | undefined)?.file ?? "")}\n`
          );
        }
        return err(rootFailure("root_id", "not_registered"));
      }
      let path: string;
      try {
        path = resolveManagedRootPath(row);
      } catch {
        return err(rootFailure("root_id", "unresolvable"));
      }
      let pin: ReturnType<typeof pinFor>;
      try {
        pin = pinFor(path);
      } catch {
        return err(rootFailure("root_id", "unreadable"));
      }
      if (
        pin.identity_kind !== registration["identity_kind"] ||
        pin.device_id !== String(registration["device_id"]) ||
        pin.file_id !== String(registration["file_id"])
      ) {
        return err(rootFailure("root_id", "identity_mismatch"));
      }
      return ok({
        approved_root: path,
        root_identity_pin: {
          schema_version: "rsi.root_identity/1",
          root_id: row.root_id,
          identity_kind: pin.identity_kind,
          device_id: pin.device_id,
          file_id: pin.file_id
        },
        root_registration_hash: registration["registration_hash"] as Hash
      });
    }
  };
}
