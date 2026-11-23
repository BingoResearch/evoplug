#!/usr/bin/env node
// Release package builder: one tarball per host.
//
// Usage:
//   node tools/release-pack/cli.mjs --version 0.1.0-alpha.1 --out release/
//
// Inputs:
//   - the workspace build (`tsc -b tsconfig.build.json` and the kernel bundle)
//   - one single-file runtime artifact per host under `--artifacts`
//     (default `<root>/dist/release-runtime/<host>`), produced by
//     `tools/runtime-artifact/cli.mjs --single-file`.
//
// Each `<out>/evoplug-<version>-<host>.tar.gz` carries only runtime files:
// `bin/evolve`, the CLI and kernel dist JavaScript, the compiled
// `@evoplug/*` packages they import, migrations, schemas, `runtime/<host>/`,
// `LICENSE`, `VERSION`, `INSTALL.md` and `MANIFEST.json`. TypeScript sources,
// declarations, source maps and tests are never copied. The tool also writes
// `<out>/SHA256SUMS` and `<out>/RELEASE-NOTES.md`.
//
// Exit codes: 0 success, 1 build/validation failure, 2 invalid arguments.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = resolve(HERE, "..", "..");
const DEFAULT_ARTIFACTS = join("dist", "release-runtime");
const HOSTS = ["pi", "oh-my-pi", "step-code", "opencode", "openhands-sdk", "claude-code", "codex"];
const PACKAGE_NAME = "evoplug";
const EXCLUDED_PACKAGES = new Set(["@evoplug/test-support"]);
const FORBIDDEN_CREDENTIALS = /sk-or-|sk-ant-|sk-proj-|oc_sk_/u;

const USAGE = `Usage: node tools/release-pack/cli.mjs --version VERSION --out DIR [options]

Options:
  --version VERSION    Release version, for example 0.1.0-alpha.1
  --out DIR            Output directory for tarballs and checksums
  --artifacts DIR      Prebuilt single-file runtime artifacts, one directory
                       per host (default: <root>/${DEFAULT_ARTIFACTS})
  --root DIR           Workspace root (default: repository root)
  --help               Show this message

Exit codes: 0 success, 1 build/validation failure, 2 invalid arguments.
`;

class UsageError extends Error {}

function parseArgs(argv) {
  const options = {
    version: null,
    out: null,
    artifacts: resolve(DEFAULT_ROOT, DEFAULT_ARTIFACTS),
    root: DEFAULT_ROOT,
    help: false
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const take = (name) => {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("-")) {
        throw new UsageError(`${name} requires a value`);
      }
      index += 1;
      return value;
    };
    if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else if (arg === "--version") {
      options.version = take("--version");
    } else if (arg.startsWith("--version=")) {
      options.version = arg.slice("--version=".length);
    } else if (arg === "--out") {
      options.out = resolve(take("--out"));
    } else if (arg.startsWith("--out=")) {
      options.out = resolve(arg.slice("--out=".length));
    } else if (arg === "--artifacts") {
      options.artifacts = resolve(take("--artifacts"));
    } else if (arg.startsWith("--artifacts=")) {
      options.artifacts = resolve(arg.slice("--artifacts=".length));
    } else if (arg === "--root") {
      options.root = resolve(take("--root"));
    } else if (arg.startsWith("--root=")) {
      options.root = resolve(arg.slice("--root=".length));
    } else {
      throw new UsageError(`unknown argument: ${arg}`);
    }
  }
  if (options.version === null) {
    throw new UsageError("--version is required");
  }
  if (options.out === null) {
    throw new UsageError("--out is required");
  }
  if (!/^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/u.test(options.version)) {
    throw new UsageError("--version must be a semver version such as 0.1.0-alpha.1");
  }
  return options;
}

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function git(root, args) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr.trim()}`);
  }
  return result.stdout.trim();
}

function walkFiles(root, prefix = "") {
  const files = [];
  for (const entry of readdirSync(join(root, prefix), { withFileTypes: true })) {
    const path = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      files.push(...walkFiles(root, path));
    } else if (entry.isFile()) {
      files.push(path);
    }
  }
  return files;
}

function copyMatching(sourceRoot, destinationRoot, predicate) {
  for (const path of walkFiles(sourceRoot)) {
    if (!predicate(path)) continue;
    const destination = join(destinationRoot, ...path.split("/"));
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(join(sourceRoot, ...path.split("/")), destination);
  }
}

function isJavaScript(path) {
  return (
    path.endsWith(".js") &&
    !path.endsWith(".test.js") &&
    !path.endsWith(".d.ts") &&
    !path.split("/").includes("testing")
  );
}

function packageDirectory(root, name) {
  const short = name.slice("@evoplug/".length);
  const candidates = [join(root, "packages", short)];
  if (short.startsWith("adapter-")) {
    candidates.push(join(root, "adapters", short.slice("adapter-".length)));
  }
  for (const candidate of candidates) {
    if (existsSync(join(candidate, "package.json"))) {
      return candidate;
    }
  }
  return null;
}

/**
 * Static closure of workspace packages reachable from the CLI and kernel dist
 * JavaScript. Package names are read from quoted `@evoplug/<name>` specifiers;
 * this also catches `import.meta.resolve("@evoplug/...")`.
 */
function workspacePackageClosure(root) {
  const queue = ["@evoplug/core", "@evoplug/ipc", "@evoplug/kernel", "@evoplug/storage"];
  const seen = new Set();
  const scanRoots = [
    join(root, "apps", "cli", "dist"),
    join(root, "apps", "kernel", "dist")
  ];
  for (const root of scanRoots) {
    for (const path of walkFiles(root)) {
      if (!isJavaScript(path)) continue;
      const text = readFileSync(join(root, ...path.split("/")), "utf8");
      for (const match of text.matchAll(/["'](@evoplug\/[a-z0-9-]+)(?:\/[^"']*)?["']/gu)) {
        queue.push(match[1]);
      }
    }
  }
  while (queue.length > 0) {
    const name = queue.shift();
    if (seen.has(name) || EXCLUDED_PACKAGES.has(name)) continue;
    const directory = packageDirectory(root, name);
    if (directory === null) {
      throw new Error(`runtime package not found: ${name}`);
    }
    seen.add(name);
    const dist = join(directory, "dist");
    if (!existsSync(dist)) continue;
    for (const path of walkFiles(dist)) {
      if (!isJavaScript(path)) continue;
      const text = readFileSync(join(dist, ...path.split("/")), "utf8");
      for (const match of text.matchAll(/["'](@evoplug\/[a-z0-9-]+)(?:\/[^"']*)?["']/gu)) {
        queue.push(match[1]);
      }
    }
  }
  return [...seen].sort();
}

function installDocument(hostId, version, compatibility) {
  const hostVariables = {
    pi: ["export PI_CODING_AGENT_DIR=\"$HOME/.pi/agent\"   # Pi agent 目录"],
    "oh-my-pi": [
      "export PI_CODING_AGENT_DIR=\"$HOME/.omp/agent\"   # oh-my-pi agent 目录",
      "export PATH=\"$HOME/.local/share/evoplug-hosts/bun/bin:$PATH\"   # 需要 Bun"
    ],
    "step-code": ["export STEP_CODING_AGENT_DIR=\"$HOME/.stepcode/agent\"   # Step Code agent 目录"],
    opencode: ["export XDG_CONFIG_HOME=\"$HOME/.config\"   # OpenCode 配置与插件根"],
    "openhands-sdk": [
      "export OH_PERSISTENCE_DIR=\"$HOME/.openhands\"",
      "export EVOPLUG_OPENHANDS_PYTHON=\"$HOME/.local/share/evoplug-hosts/openhands/bin/python\""
    ],
    "claude-code": ["export CLAUDE_CONFIG_DIR=\"$HOME/.claude\"   # Claude Code 配置目录"],
    codex: ["export CODEX_HOME=\"$HOME/.codex\"   # Codex 配置目录"]
  }[hostId];
  const attachMode = hostId === "openhands-sdk"
    ? "--mode local_conversation --config-space user_home"
    : "--mode interactive --config-space user";
  return `# evoplug ${version} ${hostId} 安装说明

本包提供 ${hostId} 宿主的运行时产物。运行需要 Node.js ${compatibility.node}；存储层使用 \`node:sqlite\`。

## 解包

\`\`\`sh
tar -xzf evoplug-${version}-${hostId}.tar.gz
cd evoplug-${version}-${hostId}
\`\`\`

包内 \`bin/evolve\`、\`apps/\`、\`node_modules/\`、\`migrations/\`、\`schemas/\` 与 \`runtime/${hostId}/\` 的相对位置不能改动。

## 环境变量

\`\`\`sh
export EVOPLUG_HOME="$HOME/.evoplug"
${hostVariables.join("\n")}
\`\`\`

宿主进程、\`attach\` 与 \`serve\` 使用同一组变量。使用隔离目录测试时，把 \`HOME\`、\`TMPDIR\`、\`EVOPLUG_HOME\` 和宿主目录变量一起指到隔离目录。

## 初始化与接入

\`\`\`sh
bin/evolve init --non-interactive --home "$EVOPLUG_HOME"
bin/evolve attach ${hostId} --artifact-dir runtime/${hostId} ${attachMode} --home "$EVOPLUG_HOME"
\`\`\`

\`runtime/${hostId}/\` 是随包附带的宿主运行时产物，含 \`manifest.json\`。\`attach\` 会校验实现哈希，并把受管根登记为 skill。

## 配置 Jev 与生成

\`\`\`sh
export JEV_TOKEN='<JEV_TOKEN>'
export HOST_TOKEN='<HOST_TOKEN>'

bin/evolve configure jev \\
  --endpoint https://openrouter.ai/api/v1/chat/completions \\
  --model openai/gpt-4.1-nano \\
  --credential-env JEV_TOKEN \\
  --request-max-tokens 16384 --question-max-tokens 8192 \\
  --home "$EVOPLUG_HOME"

bin/evolve configure generation --host ${hostId} \\
  --credential-env HOST_TOKEN --pricing-free \\
  --home "$EVOPLUG_HOME"
\`\`\`

Jev 推荐 \`openai/gpt-4.1-nano\`。\`--pricing-free\` 只用于价格为零的本地或自建模型，付费模型不要加这个参数。凭据只放在环境变量里，不写入配置文件或命令行。

## 启动与检查

\`\`\`sh
bin/evolve serve --home "$EVOPLUG_HOME" \\
  --jev-credential-env JEV_TOKEN --jev-credential-ref env:JEV_TOKEN \\
  --jev-allowed-host openrouter.ai
\`\`\`

另开一个终端，使用同一组环境变量：

\`\`\`sh
bin/evolve status --home "$EVOPLUG_HOME"
bin/evolve doctor --probe generation --home "$EVOPLUG_HOME"
\`\`\`

\`serve\` 的允许主机参数写作 \`--jev-allowed-host\`，是单数形式。本版只交付 skill 闭环，\`managed_blocks\`、\`semantic_judge\`、\`config_autotune\`、\`active_replay\` 四个开关默认关闭。

## 卸载与回滚

\`\`\`sh
bin/evolve skills disable <proposal-id> --home "$EVOPLUG_HOME"
bin/evolve skills revoke <proposal-id> --home "$EVOPLUG_HOME"
bin/evolve detach ${hostId} --home "$EVOPLUG_HOME"
\`\`\`

## 详细文档

完整步骤、逐宿主差异、确认框行为与故障排查见仓库文档 \`docs/evoplug-安装说明-2026-11-18.md\` 的第 1 至 4 节、第 7 节与第 11 节。
`;
}

function releaseNotes(version, compatibility, buildTime) {
  const rows = HOSTS.map((host) => {
    const range = compatibility[host].supported_range;
    return `| ${host} | \`${range}\` |`;
  }).join("\n");
  return `# evoplug ${version} 发布说明

## 版本

版本号：\`${version}\`。七个宿主包见下表。

## 宿主兼容区间

| 宿主 | 兼容区间 |
|---|---|
${rows}

## 本版范围

本版只交付 skill 闭环：会话采集、在线判定、退出后复盘生成 skill 候选、宿主原生确认、受管写入与读回、下次会话生效，以及停用和撤回。

四个开关默认关闭：\`managed_blocks\`、\`semantic_judge\`、\`config_autotune\`、\`active_replay\`。memory 与 instructions 跟随 \`managed_blocks\`，本版不启用。

## 测试结果

- 七个宿主的确定性闭环在最终构建上全部通过。
- unit：2,020 通过、4 失败；all：2,635 通过、10 失败、39 跳过。
- 失败项全部来自 harbor 实验测试，原因是缺少实验数据，不属于产品回归。

打包时间：${buildTime}。
`;
}

function assertCleanPackage(stage) {
  const problems = [];
  for (const path of walkFiles(stage)) {
    if (path.endsWith(".ts") || path.endsWith(".map") || path.endsWith(".d.ts")) {
      problems.push(`forbidden build artifact: ${path}`);
      continue;
    }
    if (path.startsWith("tests/") || path.startsWith("docs/design/") || path.startsWith("paper/")) {
      problems.push(`forbidden directory: ${path}`);
      continue;
    }
    if (path.split("/").includes("testing")) {
      problems.push(`test helper: ${path}`);
      continue;
    }
    if (!/\.(?:js|json|md|sql|sh|py|txt)$/u.test(path)) continue;
    const text = readFileSync(join(stage, ...path.split("/")), "utf8");
    if (text.includes("/Users/")) {
      problems.push(`local user path in ${path}`);
    }
    if (text.includes("/tmp/evo-p")) {
      problems.push(`experiment path in ${path}`);
    }
    const credential = FORBIDDEN_CREDENTIALS.exec(text);
    if (credential !== null) {
      problems.push(`credential pattern "${credential[0]}" in ${path}`);
    }
  }
  return problems;
}

function buildOneHost(options, host, compatibility, source, buildTime) {
  const name = `${PACKAGE_NAME}-${options.version}-${host}`;
  const stageParent = join(options.out, ".stage");
  const stage = join(stageParent, name);
  rmSync(stage, { recursive: true, force: true });
  mkdirSync(stage, { recursive: true, mode: 0o755 });

  // bin/evolve
  mkdirSync(join(stage, "bin"), { recursive: true });
  const evolve = `#!/bin/sh
set -eu
ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
exec node "$ROOT/apps/cli/dist/main.js" "$@"
`;
  writeFileSync(join(stage, "bin", "evolve"), evolve, { mode: 0o755 });
  chmodSync(join(stage, "bin", "evolve"), 0o755);

  // CLI and kernel build outputs. package.json keeps the ESM module type.
  for (const app of ["cli", "kernel"]) {
    const sourceRoot = join(options.root, "apps", app);
    mkdirSync(join(stage, "apps", app), { recursive: true });
    copyFileSync(join(sourceRoot, "package.json"), join(stage, "apps", app, "package.json"));
    const destinationDist = join(stage, "apps", app, "dist");
    mkdirSync(destinationDist, { recursive: true });
    copyMatching(join(sourceRoot, "dist"), destinationDist, isJavaScript);
  }

  // Compiled workspace packages actually imported at runtime.
  for (const packageName of workspacePackageClosure(options.root)) {
    const packageRoot = packageDirectory(options.root, packageName);
    const destination = join(stage, "node_modules", ...packageName.split("/"));
    mkdirSync(destination, { recursive: true });
    copyFileSync(join(packageRoot, "package.json"), join(destination, "package.json"));
    copyMatching(join(packageRoot, "dist"), join(destination, "dist"), isJavaScript);
    const glue = join(packageRoot, "runtime", "generation_local_conversation.py");
    if (existsSync(glue)) {
      mkdirSync(join(destination, "runtime"), { recursive: true });
      copyFileSync(glue, join(destination, "runtime", "generation_local_conversation.py"));
    }
  }

  // Migrations (SQL only; frozen fixtures are test material) and schemas.
  copyMatching(
    join(options.root, "migrations"),
    join(stage, "migrations"),
    (path) => path.endsWith(".sql") && !path.endsWith(".frozen")
  );
  copyMatching(join(options.root, "schemas"), join(stage, "schemas"), () => true);
  // Compiled workspace packages resolve `schemas/` from `<pkg>/node_modules`
  // because they live under `node_modules/@evoplug/<name>/dist` here.
  copyMatching(join(options.root, "schemas"), join(stage, "node_modules", "schemas"), () => true);

  // The host runtime artifact stays under runtime/<host>/.
  const artifact = join(options.artifacts, host);
  const artifactManifest = join(artifact, "evoplug.runtime", "manifest.json");
  if (!existsSync(artifactManifest)) {
    throw new Error(`missing runtime artifact manifest: ${relative(options.root, artifactManifest)}`);
  }
  mkdirSync(join(stage, "runtime"), { recursive: true });
  cpSync(artifact, join(stage, "runtime", host), { recursive: true });
  chmodSync(join(stage, "runtime", host, "evoplug.runtime", "config.json"), 0o600);

  copyFileSync(join(options.root, "LICENSE"), join(stage, "LICENSE"));
  writeFileSync(join(stage, "VERSION"), `${options.version}\n`);
  writeFileSync(
    join(stage, "INSTALL.md"),
    installDocument(host, options.version, compatibility)
  );

  const problems = assertCleanPackage(stage);
  if (problems.length > 0) {
    throw new Error(`package ${name} contains forbidden content:\n  ${problems.join("\n  ")}`);
  }

  const files = walkFiles(stage)
    .sort()
    .map((path) => ({
      path,
      sha256: sha256File(join(stage, ...path.split("/")))
    }));
  const manifest = {
    schema_version: "evoplug.release_package/1",
    package: PACKAGE_NAME,
    version: options.version,
    host,
    host_compatibility: {
      supported_range: compatibility[host].supported_range,
      tested_versions: compatibility[host].tested_versions,
      command: compatibility[host].command
    },
    node: compatibility.node,
    source: source,
    built_at: buildTime,
    files
  };
  writeFileSync(join(stage, "MANIFEST.json"), `${JSON.stringify(manifest, null, 2)}\n`);

  const tarPath = join(options.out, `${name}.tar.gz`);
  rmSync(tarPath, { force: true });
  const tar = spawnSync("tar", ["-czf", tarPath, "-C", stageParent, name], {
    env: { ...process.env, COPYFILE_DISABLE: "1" },
    encoding: "utf8"
  });
  if (tar.status !== 0) {
    throw new Error(`tar failed for ${name}: ${tar.stderr.trim()}`);
  }
  rmSync(stage, { recursive: true, force: true });
  return {
    host,
    file: `${name}.tar.gz`,
    bytes: statSync(tarPath).size,
    sha256: sha256File(tarPath)
  };
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    if (error instanceof UsageError) {
      process.stderr.write(`release-pack: ${error.message}\n`);
      return 2;
    }
    throw error;
  }
  if (options.help) {
    process.stdout.write(USAGE);
    return 0;
  }

  const rootPackage = JSON.parse(readFileSync(join(options.root, "package.json"), "utf8"));
  const hostVersionModule = await import(
    pathToFileURL(join(options.root, "apps", "kernel", "dist", "host-version.js")).href
  );
  const ranges = hostVersionModule.HOST_COMPATIBILITY;
  for (const host of HOSTS) {
    if (ranges[host] === undefined) {
      throw new Error(`missing host compatibility range for ${host}`);
    }
  }
  const compatibility = {
    ...ranges,
    node: rootPackage.engines.node
  };
  const source = {
    commit: git(options.root, ["rev-parse", "HEAD"]),
    dirty: git(options.root, ["status", "--porcelain"]).length > 0
  };
  source.identifier = source.dirty ? `${source.commit}-dirty` : source.commit;
  const buildTime = new Date().toISOString();

  mkdirSync(options.out, { recursive: true, mode: 0o755 });
  const results = [];
  for (const host of HOSTS) {
    results.push(buildOneHost(options, host, compatibility, source, buildTime));
    process.stdout.write(`release-pack: ${results[results.length - 1].file}\n`);
  }

  writeFileSync(
    join(options.out, "SHA256SUMS"),
    results.map((entry) => `${entry.sha256}  ${entry.file}`).join("\n") + "\n"
  );
  writeFileSync(join(options.out, "RELEASE-NOTES.md"), releaseNotes(options.version, compatibility, buildTime));

  process.stdout.write(`${JSON.stringify({ ok: true, version: options.version, packages: results }, null, 2)}\n`);
  return 0;
}

process.exitCode = await main();
