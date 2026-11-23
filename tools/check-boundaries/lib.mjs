// Boundary checker for the evoplug workspace.
//
// Implements DD-FND-021 dependency rules over two sources of truth:
//   1. each workspace package.json: declared workspace dependencies;
//   2. the actual import specifiers found in package sources.
//
// The checker is intentionally dependency free and only uses the Node.js
// standard library, matching DD-FND-022 ("tools/check-boundaries is a
// package.json plus a directly runnable ESM cli.mjs").

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, extname, join, relative, resolve, sep } from "node:path";

const CORE = "@evoplug/core";
const STORAGE = "@evoplug/storage";
const IPC = "@evoplug/ipc";
const KERNEL = "@evoplug/kernel";
const EVIDENCE = "@evoplug/evidence";
const REVIEW = "@evoplug/review";
const TEST_SUPPORT = "@evoplug/test-support";
const HOST_RUNTIME = "@evoplug/host-runtime";

const LEDGER_PEERS = Object.freeze([
  "@evoplug/ledger",
  "@evoplug/budget",
  "@evoplug/auth",
  "@evoplug/egress",
  "@evoplug/replay",
  "@evoplug/delivery"
]);

const ADAPTER_PREFIX = "@evoplug/adapter-";
const ADAPTER_KIT = "@evoplug/adapter-kit";

const EXPLICIT_RULES = new Map([
  [CORE, Object.freeze({ allow: [] })],
  // DD-FND-021 graph: adapters -> IPC -> kernel services. The IPC method table
  // carries the FND wire DTOs from the ledger group, so IPC may import their
  // public types. Runtime coupling stays one-way: those packages never import IPC.
  [IPC, Object.freeze({ allow: [CORE, ...LEDGER_PEERS] })],
  // DD-FND-021 rule 2: storage depends on core only and must not depend on
  // ledger/evidence/review/delivery or the core host/config submodules.
  [STORAGE, Object.freeze({ allow: [CORE] })],
  // DD-FND-021 rule 3: the ledger group depends on core, storage and each
  // other's public read-only ports.
  ...LEDGER_PEERS.map((name) => [name, Object.freeze({ allow: [CORE, STORAGE, ...LEDGER_PEERS] })]),
  // DD-FND-021 rule 4: evidence/review use FND only through public ports.
  [EVIDENCE, Object.freeze({ allow: [CORE, STORAGE, IPC] })],
  [REVIEW, Object.freeze({ allow: [CORE, STORAGE, IPC, EVIDENCE] })],
  [KERNEL, Object.freeze({ allow: [CORE, STORAGE, IPC, ...LEDGER_PEERS, EVIDENCE, REVIEW] })],
  [TEST_SUPPORT, Object.freeze({ allow: [CORE, STORAGE] })],
  // DD-HOST-200: the host-side runtime artifact may use IPC and the shared
  // core types only. It must never see kernel, storage, SQLite or adapters.
  ["@evoplug/host-runtime", Object.freeze({ allow: [CORE, IPC] })],
  ["@evoplug/app-kernel", Object.freeze({
    allow: [
      CORE,
      STORAGE,
      IPC,
      KERNEL,
      // DD-FND-021: the compose root is the only place that may see adapter
      // packages; the kernel itself stays adapter-free.
      `${ADAPTER_PREFIX}claude-code`,
      `${ADAPTER_PREFIX}codex`,
      `${ADAPTER_PREFIX}oh-my-pi`,
      `${ADAPTER_PREFIX}opencode`,
      `${ADAPTER_PREFIX}openhands-sdk`,
      `${ADAPTER_PREFIX}pi`,
      `${ADAPTER_PREFIX}step-code`
    ]
  })],
  ["@evoplug/cli", Object.freeze({ allow: [CORE, IPC] })]
]);

const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"]);
const TYPESCRIPT_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts"]);
const SKIP_DIRECTORIES = new Set(["node_modules", "dist", "coverage", ".git", "schemas", ".turbo"]);

export const BOUNDARY_CODES = Object.freeze({
  dependency: "E_BOUNDARY_DEPENDENCY",
  import: "E_BOUNDARY_IMPORT",
  undeclared: "E_BOUNDARY_UNDECLARED_DEPENDENCY",
  deepImport: "E_BOUNDARY_DEEP_IMPORT",
  relativeExtension: "E_BOUNDARY_RELATIVE_EXTENSION",
  pathEscape: "E_BOUNDARY_PATH_ESCAPE",
  sqlite: "E_BOUNDARY_SQLITE_DIRECT_IMPORT",
  unknownPackage: "E_BOUNDARY_UNKNOWN_PACKAGE",
  cycle: "E_BOUNDARY_CYCLE"
});

/**
 * Read the `packages` patterns from pnpm-workspace.yaml without a YAML parser.
 * Only the simple `- 'dir/*'` list form used by this repository is accepted.
 */
export function readWorkspacePatterns(rootDir) {
  const file = join(rootDir, "pnpm-workspace.yaml");
  if (!existsSync(file)) {
    return [];
  }
  const patterns = [];
  let inPackages = false;
  for (const raw of readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) {
      continue;
    }
    if (/^packages\s*:/.test(line)) {
      inPackages = true;
      continue;
    }
    if (/^[A-Za-z][A-Za-z0-9_-]*\s*:/.test(line)) {
      inPackages = false;
      continue;
    }
    if (!inPackages) {
      continue;
    }
    const match = /^-\s*['"]?([^'"]+)['"]?$/.exec(line);
    if (match) {
      patterns.push(match[1]);
    }
  }
  return patterns;
}

function expandPattern(rootDir, pattern) {
  const normalized = pattern.replace(/\\/g, "/").replace(/\/+$/, "");
  if (normalized.endsWith("/*")) {
    const base = normalizeWorkspacePath(normalized.slice(0, -2));
    const absolute = join(rootDir, base);
    if (!existsSync(absolute)) {
      return [];
    }
    return readdirSync(absolute, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => `${base}/${entry.name}`);
  }
  return [normalized];
}

function normalizeWorkspacePath(value) {
  return value.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
}

/**
 * Load every workspace package declared by pnpm-workspace.yaml that has a
 * package.json. Directory order follows the workspace pattern order.
 */
export function loadWorkspacePackages(rootDir) {
  const patterns = readWorkspacePatterns(rootDir);
  const seen = new Set();
  const packages = [];
  for (const pattern of patterns) {
    for (const relDir of expandPattern(rootDir, pattern)) {
      const dir = join(rootDir, relDir);
      const manifestPath = join(dir, "package.json");
      if (!existsSync(manifestPath) || seen.has(relDir)) {
        continue;
      }
      seen.add(relDir);
      let manifest;
      try {
        manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      } catch (error) {
        throw new Error(`cannot parse ${manifestPath}: ${error instanceof Error ? error.message : String(error)}`);
      }
      if (typeof manifest.name !== "string" || manifest.name === "") {
        throw new Error(`${manifestPath} has no package name`);
      }
      packages.push({
        name: manifest.name,
        dir,
        relativeDir: relDir,
        kind: relDir.split("/")[0],
        manifest
      });
    }
  }
  packages.sort((a, b) => (a.relativeDir < b.relativeDir ? -1 : a.relativeDir > b.relativeDir ? 1 : 0));
  return packages;
}

function declaredWorkspaceDependencies(manifest) {
  const declared = new Map();
  for (const field of ["dependencies", "peerDependencies", "optionalDependencies"]) {
    const value = manifest[field];
    if (value === undefined || value === null || typeof value !== "object") {
      continue;
    }
    for (const [name, version] of Object.entries(value)) {
      if (typeof version === "string" && version.startsWith("workspace:")) {
        declared.set(name, field);
      }
    }
  }
  return declared;
}

/**
 * Resolve the allow-list for a package. Adapters only see core + ipc; tools are
 * development-only CLIs with no workspace dependencies.
 */
export function resolveBoundaryRule(pkg) {
  if (pkg.kind === "tools") {
    return { allow: [] };
  }
  if (pkg.kind === "adapters" || pkg.name.startsWith(ADAPTER_PREFIX)) {
    // Adapter-hosted runtime entries (DD-HOST-200) import the runtime package;
    // the adapter library itself sees core, IPC and the shared adapter kit.
    return { allow: [CORE, IPC, HOST_RUNTIME, ADAPTER_KIT] };
  }
  return EXPLICIT_RULES.get(pkg.name) ?? null;
}

function lineStarts(source) {
  const starts = [0];
  for (let index = 0; index < source.length; index += 1) {
    if (source[index] === "\n") {
      starts.push(index + 1);
    }
  }
  return starts;
}

function lineAt(starts, offset) {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (starts[middle] <= offset) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  return low + 1;
}

/**
 * Replace comments and string/template literals with spaces while remembering
 * literal positions, so import scanning cannot match inside comments or
 * ordinary strings.
 */
function maskSource(source) {
  const masked = source.split("");
  const literals = [];
  let index = 0;
  while (index < source.length) {
    const char = source[index];
    const next = source[index + 1];
    if (char === "/" && next === "/") {
      while (index < source.length && source[index] !== "\n") {
        masked[index] = " ";
        index += 1;
      }
      continue;
    }
    if (char === "/" && next === "*") {
      masked[index] = " ";
      masked[index + 1] = " ";
      index += 2;
      while (index < source.length && !(source[index] === "*" && source[index + 1] === "/")) {
        if (source[index] !== "\n") {
          masked[index] = " ";
        }
        index += 1;
      }
      if (index < source.length) {
        masked[index] = " ";
        masked[index + 1] = " ";
        index += 2;
      }
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      const start = index;
      const quote = char;
      index += 1;
      let value = "";
      while (index < source.length) {
        const current = source[index];
        if (current === "\\") {
          value += source[index] ?? "";
          value += source[index + 1] ?? "";
          if (source[index] !== "\n") {
            masked[index] = " ";
          }
          if (source[index + 1] !== "\n") {
            masked[index + 1] = " ";
          }
          index += 2;
          continue;
        }
        if (current === quote) {
          masked[index] = " ";
          index += 1;
          break;
        }
        value += current;
        if (current !== "\n") {
          masked[index] = " ";
        }
        index += 1;
      }
      // Keep the opening quote so specifier lookups can stop on it; the
      // literal body stays masked.
      literals.push({ start, value });
      continue;
    }
    index += 1;
  }
  return { code: masked.join(""), literals };
}

function isIdentifierChar(char) {
  return char !== undefined && /[A-Za-z0-9_$]/.test(char);
}

function skipSpaces(code, index) {
  let cursor = index;
  while (cursor < code.length && /\s/.test(code[cursor])) {
    cursor += 1;
  }
  return cursor;
}

/**
 * Extract static/dynamic import specifiers and re-export specifiers together
 * with their 1-based source line.
 */
export function extractModuleSpecifiers(source) {
  const starts = lineStarts(source);
  const { code, literals } = maskSource(source);
  const literalByStart = new Map(literals.map((literal) => [literal.start, literal.value]));
  const found = [];
  const keywordPattern = /(^|[^A-Za-z0-9_$.])(import|export|require)\b/g;
  let match;
  while ((match = keywordPattern.exec(code)) !== null) {
    const keyword = match[2];
    const keywordEnd = match.index + match[1].length + keyword.length;
    let cursor = skipSpaces(code, keywordEnd);
    if (keyword === "require") {
      if (code[cursor] !== "(") {
        continue;
      }
      cursor = skipSpaces(code, cursor + 1);
      const value = literalByStart.get(cursor);
      if (value !== undefined) {
        found.push({ specifier: value, line: lineAt(starts, cursor) });
      }
      continue;
    }
    if (code[cursor] === "(") {
      cursor = skipSpaces(code, cursor + 1);
      const value = literalByStart.get(cursor);
      if (value !== undefined) {
        found.push({ specifier: value, line: lineAt(starts, cursor) });
      }
      continue;
    }
    const direct = literalByStart.get(cursor);
    if (direct !== undefined) {
      found.push({ specifier: direct, line: lineAt(starts, cursor) });
      continue;
    }
    let depth = 0;
    let scan = keywordEnd;
    while (scan < code.length) {
      const char = code[scan];
      if (char === "{") {
        depth += 1;
      } else if (char === "}") {
        depth = Math.max(0, depth - 1);
      } else if (char === ";" && depth === 0) {
        break;
      }
      if (
        depth === 0 &&
        code.startsWith("from", scan) &&
        !isIdentifierChar(code[scan - 1]) &&
        !isIdentifierChar(code[scan + 4])
      ) {
        const valueIndex = skipSpaces(code, scan + 4);
        const value = literalByStart.get(valueIndex);
        if (value !== undefined) {
          found.push({ specifier: value, line: lineAt(starts, valueIndex) });
        }
        break;
      }
      scan += 1;
    }
  }
  return found;
}

function listSourceFiles(dir) {
  const output = [];
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop();
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRECTORIES.has(entry.name)) {
          stack.push(path);
        }
        continue;
      }
      if (entry.isFile() && SOURCE_EXTENSIONS.has(extname(entry.name))) {
        output.push(path);
      }
    }
  }
  output.sort();
  return output;
}

function splitWorkspaceSpecifier(specifier) {
  const match = /^(@evoplug\/[^/]+)(\/.*)?$/.exec(specifier);
  if (!match) {
    return null;
  }
  return { packageName: match[1], subpath: match[2] ?? "" };
}

function isExportedSubpath(subpath) {
  return (
    subpath === "" ||
    subpath === "/testing" ||
    subpath === "/host" ||
    subpath === "/config" ||
    // QP owner submodule; published as `@evoplug/core/evidence`.
    subpath === "/evidence" ||
    subpath.startsWith("/schemas/")
  );
}

function isInsidePackage(pkgDir, target) {
  const normalized = resolve(target);
  return normalized === pkgDir || normalized.startsWith(pkgDir + sep);
}

/**
 * Evaluate one package. Returns violations without touching other packages.
 */
export function evaluatePackage(pkg, allPackages) {
  const violations = [];
  const rule = resolveBoundaryRule(pkg);
  const workspaceNames = new Set(allPackages.map((entry) => entry.name));
  if (rule === null) {
    violations.push({
      code: BOUNDARY_CODES.unknownPackage,
      package: pkg.name,
      file: join(pkg.dir, "package.json"),
      line: null,
      message: `workspace package ${pkg.name} has no boundary rule in DD-FND-021`
    });
    return violations;
  }
  const allow = new Set(rule.allow);
  const declared = declaredWorkspaceDependencies(pkg.manifest);

  for (const [dependency, field] of declared) {
    if (!workspaceNames.has(dependency)) {
      continue;
    }
    if (!allow.has(dependency)) {
      violations.push({
        code: BOUNDARY_CODES.dependency,
        package: pkg.name,
        file: join(pkg.dir, "package.json"),
        line: null,
        message: `${pkg.name} declares ${field} "${dependency}" but DD-FND-021 does not allow it`
      });
    }
  }

  // Node package.json "imports" entries are import specifiers as well; validate
  // any workspace target against the same allow-list.
  const importsField = pkg.manifest.imports;
  if (importsField !== undefined && importsField !== null && typeof importsField === "object") {
    for (const [alias, target] of Object.entries(importsField)) {
      const targetSpecifier =
        typeof target === "string" ? target : typeof target === "object" && target !== null ? target.default : undefined;
      if (typeof targetSpecifier !== "string") {
        continue;
      }
      const split = splitWorkspaceSpecifier(targetSpecifier);
      if (split === null) {
        continue;
      }
      if (!workspaceNames.has(split.packageName)) {
        violations.push({
          code: BOUNDARY_CODES.unknownPackage,
          package: pkg.name,
          file: join(pkg.dir, "package.json"),
          line: null,
          message: `imports["${alias}"] references ${split.packageName}, which is not a workspace package`
        });
      } else if (!allow.has(split.packageName)) {
        violations.push({
          code: BOUNDARY_CODES.dependency,
          package: pkg.name,
          file: join(pkg.dir, "package.json"),
          line: null,
          message: `imports["${alias}"] targets ${split.packageName}, which DD-FND-021 does not allow for ${pkg.name}`
        });
      }
    }
  }

  if (pkg.kind === "tools") {
    return violations;
  }

  for (const file of listSourceFiles(pkg.dir)) {
    const source = readFileSync(file, "utf8");
    const extension = extname(file);
    for (const { specifier, line } of extractModuleSpecifiers(source)) {
      if (specifier.startsWith("node:")) {
        if (specifier === "node:sqlite" && pkg.name !== STORAGE) {
          violations.push({
            code: BOUNDARY_CODES.sqlite,
            package: pkg.name,
            file,
            line,
            message: `only @evoplug/storage may import node:sqlite (DD-FND-003); found in ${pkg.name}`
          });
        }
        continue;
      }
      if (specifier.startsWith(".")) {
        if (TYPESCRIPT_EXTENSIONS.has(extension) && !/\.(js|json|mjs|cjs)$/.test(specifier)) {
          violations.push({
            code: BOUNDARY_CODES.relativeExtension,
            package: pkg.name,
            file,
            line,
            message: `relative import "${specifier}" must keep the .js suffix in TypeScript sources`
          });
        }
        {
          const target = resolve(dirname(file), specifier);
          if (!isInsidePackage(pkg.dir, target)) {
            violations.push({
              code: BOUNDARY_CODES.pathEscape,
              package: pkg.name,
              file,
              line,
              message: `relative import "${specifier}" escapes the package root`
            });
          }
        }
        continue;
      }
      const split = splitWorkspaceSpecifier(specifier);
      if (split === null) {
        continue;
      }
      const { packageName, subpath } = split;
      if (!workspaceNames.has(packageName)) {
        violations.push({
          code: BOUNDARY_CODES.unknownPackage,
          package: pkg.name,
          file,
          line,
          message: `import "${specifier}" references ${packageName}, which is not a workspace package`
        });
        continue;
      }
      if (!isExportedSubpath(subpath)) {
        violations.push({
          code: BOUNDARY_CODES.deepImport,
          package: pkg.name,
          file,
          line,
          message: `import "${specifier}" is not a declared package export; only ".", "./testing" and "./schemas/*" are exported`
        });
        continue;
      }
      if (packageName === pkg.name) {
        continue;
      }
      if (!allow.has(packageName)) {
        violations.push({
          code: BOUNDARY_CODES.import,
          package: pkg.name,
          file,
          line,
          message: `${pkg.name} imports ${packageName}, which DD-FND-021 does not allow`
        });
        continue;
      }
      if (!declared.has(packageName)) {
        violations.push({
          code: BOUNDARY_CODES.undeclared,
          package: pkg.name,
          file,
          line,
          message: `${pkg.name} imports ${packageName} without declaring it in package.json dependencies`
        });
      }
    }
  }
  return violations;
}

/**
 * Detect cycles in the declared workspace dependency graph.
 */
export function detectDependencyCycles(packages) {
  const byName = new Map(packages.map((pkg) => [pkg.name, pkg]));
  const edges = new Map();
  for (const pkg of packages) {
    const targets = [];
    for (const dependency of declaredWorkspaceDependencies(pkg.manifest).keys()) {
      if (byName.has(dependency)) {
        targets.push(dependency);
      }
    }
    edges.set(pkg.name, targets);
  }
  const state = new Map();
  const stack = [];
  const violations = [];
  const reported = new Set();
  const visit = (name) => {
    state.set(name, "visiting");
    stack.push(name);
    for (const target of edges.get(name) ?? []) {
      const targetState = state.get(target);
      if (targetState === "visiting") {
        const start = stack.indexOf(target);
        const cycle = [...stack.slice(start), target];
        const key = [...cycle].sort().join("->");
        if (!reported.has(key)) {
          reported.add(key);
          const pkg = byName.get(target);
          violations.push({
            code: BOUNDARY_CODES.cycle,
            package: target,
            file: pkg ? join(pkg.dir, "package.json") : "",
            line: null,
            message: `workspace dependency cycle: ${cycle.join(" -> ")}`
          });
        }
      } else if (targetState === undefined) {
        visit(target);
      }
    }
    stack.pop();
    state.set(name, "done");
  };
  for (const name of edges.keys()) {
    if (state.get(name) === undefined) {
      visit(name);
    }
  }
  return violations;
}

/**
 * Run the full boundary check for a workspace root.
 */
export function checkWorkspace(rootDir) {
  const packages = loadWorkspacePackages(rootDir);
  const violations = [];
  for (const pkg of packages) {
    violations.push(...evaluatePackage(pkg, packages));
  }
  violations.push(...detectDependencyCycles(packages));
  violations.sort((a, b) => {
    const fileCompare = (a.file ?? "").localeCompare(b.file ?? "");
    if (fileCompare !== 0) {
      return fileCompare;
    }
    return (a.line ?? 0) - (b.line ?? 0);
  });
  return {
    ok: violations.length === 0,
    root: rootDir,
    packages: packages.map((pkg) => ({ name: pkg.name, dir: relative(rootDir, pkg.dir) || "." })),
    violations
  };
}
