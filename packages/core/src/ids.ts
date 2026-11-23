/**
 * Local identifier algebra (DD-FND-006, DD-FND-030).
 *
 * `Id` is always `<registered-prefix>:<ULID>`; `Hash` is never an `Id` and
 * deterministic content keys use `Hash` or `ContentKey`, never a ULID form.
 * The prefix set mirrors `schemas/common/id-prefix-registry.json`, which is
 * the single machine source consumed by the schema code generator.
 */

import { randomBytes } from "node:crypto";

export type Ulid = string & { readonly __ulid: unique symbol };

/**
 * Registered ULID prefixes. Mirrors `schemas/common/id-prefix-registry.json`;
 * unregistered prefixes are rejected at parse and generation time.
 */
export type IdPrefix =
  | "ev"
  | "ipc"
  | "corr"
  | "task"
  | "br"
  | "sess"
  | "input"
  | "run"
  | "req"
  | "reqop"
  | "fact"
  | "fb"
  | "uc"
  | "lcor"
  | "gsnap"
  | "nmap"
  | "sev"
  | "dec"
  | "del"
  | "grant"
  | "wi"
  | "wsnap"
  | "cwi"
  | "resv"
  | "chg"
  | "puse"
  | "egr"
  | "rpl"
  | "rpa"
  | "rex"
  | "cfgp"
  | "mnt"
  | "issue"
  | "plan"
  | "judg"
  | "unit"
  | "splan"
  | "shard"
  | "pack"
  | "omis"
  | "best"
  | "svcp"
  | "bind"
  | "env"
  | "agg"
  | "jreq"
  | "snap"
  | "job"
  | "rat"
  | "prop"
  | "hand"
  | "exp"
  | "vp"
  | "prj"
  | "usg"
  | "lif"
  | "pol"
  | "trg"
  | "nev"
  | "pen"
  | "chk"
  | "cap"
  | "prb"
  | "adp"
  | "rts"
  | "iap"
  | "trial"
  | "ctr"
  | "fld"
  | "out"
  | "ob"
  | "bud";

/** Every registered prefix, in registry order. */
export const ID_PREFIXES: readonly IdPrefix[] = [
  "ev",
  "ipc",
  "corr",
  "task",
  "br",
  "sess",
  "input",
  "run",
  "req",
  "reqop",
  "fact",
  "fb",
  "uc",
  "lcor",
  "gsnap",
  "nmap",
  "sev",
  "dec",
  "del",
  "grant",
  "wi",
  "wsnap",
  "cwi",
  "resv",
  "chg",
  "puse",
  "egr",
  "rpl",
  "rpa",
  "rex",
  "cfgp",
  "mnt",
  "issue",
  "plan",
  "judg",
  "unit",
  "splan",
  "shard",
  "pack",
  "omis",
  "best",
  "svcp",
  "bind",
  "env",
  "agg",
  "jreq",
  "snap",
  "job",
  "rat",
  "prop",
  "hand",
  "exp",
  "vp",
  "prj",
  "usg",
  "lif",
  "pol",
  "trg",
  "nev",
  "pen",
  "chk",
  "cap",
  "prb",
  "adp",
  "rts",
  "iap",
  "trial",
  "ctr",
  "fld",
  "out",
  "ob",
  "bud"
];

export type Id<P extends IdPrefix = IdPrefix> = `${P}:${Ulid}`;

type ContentKeyPrefix = "propo";

export type ContentKey<P extends ContentKeyPrefix = ContentKeyPrefix> = `${P}:${string}`;

/** Length of a ULID in characters. */
export const ULID_LENGTH = 26;

const CROCKFORD_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const ULID_TIME_MAX = 281_474_976_710_655;
const ULID_RANDOM_BITS = 80n;
const ULID_RANDOM_MASK = (1n << ULID_RANDOM_BITS) - 1n;
const REGISTERED_PREFIXES: ReadonlySet<string> = new Set(ID_PREFIXES);

let lastTimeMs = -1;
let lastRandom = 0n;

type IdParseErrorCode = "E_ID_PREFIX_UNKNOWN" | "E_SCHEMA";

/** Raised when an identifier or content key fails syntax validation. */
export class IdParseError extends Error {
  readonly code: IdParseErrorCode;
  readonly path: string;
  readonly rule: string;

  constructor(code: IdParseErrorCode, path: string, rule: string) {
    super(`${code}: ${path} violates ${rule}`);
    this.name = "IdParseError";
    this.code = code;
    this.path = path;
    this.rule = rule;
  }
}

/** Returns true when `prefix` is registered. */
export function isRegisteredPrefix(prefix: string): prefix is IdPrefix {
  return REGISTERED_PREFIXES.has(prefix);
}

/** Returns true for a 26-character Crockford Base32 identifier. */
function isUlid(value: string): value is Ulid {
  if (value.length !== ULID_LENGTH) {
    return false;
  }
  for (let index = 0; index < value.length; index += 1) {
    if (!CROCKFORD_ALPHABET.includes(value.charAt(index))) {
      return false;
    }
  }
  return true;
}

/**
 * Allocates a new identifier. ULIDs generated in the same process are
 * monotonic: within one millisecond the random component increments, and a
 * backwards wall clock reuses the last timestamp (DD-FND-030 rule 1).
 */
export function newId<P extends IdPrefix>(prefix: P, now: number = Date.now()): Id<P> {
  if (!isRegisteredPrefix(prefix)) {
    throw new IdParseError("E_ID_PREFIX_UNKNOWN", "id.prefix", "registered");
  }
  if (!Number.isSafeInteger(now) || now < 0 || now > ULID_TIME_MAX) {
    throw new RangeError(`now must be an integer in 0..${String(ULID_TIME_MAX)}, received ${String(now)}`);
  }
  let timeMs = now;
  let randomValue: bigint;
  if (timeMs > lastTimeMs) {
    lastTimeMs = timeMs;
    lastRandom = randomUlidBits();
    randomValue = lastRandom;
  } else {
    timeMs = lastTimeMs;
    lastRandom = (lastRandom + 1n) & ULID_RANDOM_MASK;
    if (lastRandom === 0n) {
      lastTimeMs += 1;
      if (lastTimeMs > ULID_TIME_MAX) {
        throw new RangeError("ULID timestamp overflow");
      }
      timeMs = lastTimeMs;
    }
    randomValue = lastRandom;
  }
  const ulid = encodeUlid(timeMs, randomValue);
  return `${prefix}:${ulid}` as Id<P>;
}

/**
 * Parses `prefix:ULID`.
 *
 * @throws {IdParseError} `E_ID_PREFIX_UNKNOWN` for an unregistered prefix,
 * `E_SCHEMA` for any malformed identifier.
 */
export function parseId(value: string): { prefix: IdPrefix; ulid: Ulid } {
  if (typeof value !== "string") {
    throw new IdParseError("E_SCHEMA", "id", "prefix:ulid");
  }
  const separator = value.indexOf(":");
  if (separator <= 0 || separator === value.length - 1) {
    throw new IdParseError("E_SCHEMA", "id", "prefix:ulid");
  }
  const prefix = value.slice(0, separator);
  const ulid = value.slice(separator + 1);
  if (!isRegisteredPrefix(prefix)) {
    throw new IdParseError("E_ID_PREFIX_UNKNOWN", "id.prefix", "registered");
  }
  if (!isUlid(ulid)) {
    throw new IdParseError("E_SCHEMA", "id.ulid", "crockford_base32_26");
  }
  return { prefix, ulid };
}

/** Non-throwing identifier check; optionally pins the expected prefix. */
export function isId<P extends IdPrefix>(value: string, prefix?: P): value is Id<P> {
  if (typeof value !== "string") {
    return false;
  }
  const separator = value.indexOf(":");
  if (separator <= 0 || separator === value.length - 1) {
    return false;
  }
  const actualPrefix = value.slice(0, separator);
  if (!isRegisteredPrefix(actualPrefix)) {
    return false;
  }
  if (prefix !== undefined && actualPrefix !== prefix) {
    return false;
  }
  return isUlid(value.slice(separator + 1));
}

/**
 * True for `propo:<64 lowercase hex>`. Proposition keys are deterministic
 * content keys, not `Id`s: no ULID form, no `prop:` spelling.
 */
export function isContentKey(value: string): value is ContentKey {
  return /^propo:[0-9a-f]{64}$/.test(value);
}

/**
 * @throws {IdParseError} `E_SCHEMA` when the value is not a proposition key.
 */
export function parseContentKey(value: string): ContentKey {
  if (!isContentKey(value)) {
    throw new IdParseError("E_SCHEMA", "content_key", "propo_sha256_hex");
  }
  return value;
}

function randomUlidBits(): bigint {
  const bytes = randomBytes(10);
  let value = 0n;
  for (const byte of bytes) {
    value = (value << 8n) | BigInt(byte);
  }
  return value;
}

function encodeUlid(timeMs: number, random: bigint): Ulid {
  const timeChars: string[] = new Array<string>(10);
  let remainingTime = timeMs;
  for (let index = 9; index >= 0; index -= 1) {
    timeChars[index] = characterAt(remainingTime % 32);
    remainingTime = Math.floor(remainingTime / 32);
  }
  const randomChars: string[] = new Array<string>(16);
  let remainingRandom = random;
  for (let index = 15; index >= 0; index -= 1) {
    randomChars[index] = characterAt(Number(remainingRandom & 31n));
    remainingRandom >>= 5n;
  }
  return `${timeChars.join("")}${randomChars.join("")}` as Ulid;
}

function characterAt(index: number): string {
  const character = CROCKFORD_ALPHABET.charAt(index);
  if (character === "") {
    throw new RangeError(`ULID alphabet index out of range: ${String(index)}`);
  }
  return character;
}
