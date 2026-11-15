/**
 * Strict JSON scanner for generator output (DD-REV-041 step 3).
 *
 * `JSON.parse` silently keeps the last duplicate key, so the line parser uses
 * this scanner instead. It rejects duplicate keys, trailing content, control
 * characters in strings, non-finite numbers and nesting deeper than 64.
 */

import type { JsonValue } from "@evoplug/core";

export type StrictJsonResult<T, E> = { ok: true; value: T } | { ok: false; error: E };

export type StrictJsonErrorKind = "syntax" | "duplicate_key" | "depth";

export interface StrictJsonError {
  kind: StrictJsonErrorKind;
  offset: number;
  message: string;
}

export const STRICT_JSON_MAX_DEPTH = 64;

export function parseStrictJson(text: string): StrictJsonResult<JsonValue, StrictJsonError> {
  try {
    const parser = new StrictJsonParser(text);
    const value = parser.parseDocument();
    return { ok: true, value };
  } catch (error) {
    if (error instanceof StrictJsonFailure) {
      return {
        ok: false,
        error: { kind: error.kind, offset: error.offset, message: error.message }
      };
    }
    throw error;
  }
}

class StrictJsonFailure extends Error {
  readonly kind: StrictJsonErrorKind;
  readonly offset: number;

  constructor(kind: StrictJsonErrorKind, offset: number, message: string) {
    super(message);
    this.name = "StrictJsonFailure";
    this.kind = kind;
    this.offset = offset;
  }
}

class StrictJsonParser {
  private readonly text: string;
  private index = 0;

  constructor(text: string) {
    this.text = text;
  }

  parseDocument(): JsonValue {
    this.skipWhitespace();
    const value = this.parseValue(0);
    this.skipWhitespace();
    if (this.index !== this.text.length) {
      this.fail("syntax", "trailing content");
    }
    return value;
  }

  private parseValue(depth: number): JsonValue {
    if (depth > STRICT_JSON_MAX_DEPTH) {
      this.fail("depth", "nesting too deep");
    }
    this.skipWhitespace();
    const char = this.peek();
    if (char === undefined) {
      this.fail("syntax", "unexpected end of input");
    }
    switch (char) {
      case "{":
        return this.parseObject(depth + 1);
      case "[":
        return this.parseArray(depth + 1);
      case '"':
        return this.parseString();
      case "t":
        this.expectLiteral("true");
        return true;
      case "f":
        this.expectLiteral("false");
        return false;
      case "n":
        this.expectLiteral("null");
        return null;
      default:
        return this.parseNumber();
    }
  }

  private parseObject(depth: number): JsonValue {
    this.index += 1;
    const result: { [key: string]: JsonValue } = {};
    const keys = new Set<string>();
    this.skipWhitespace();
    if (this.peek() === "}") {
      this.index += 1;
      return result;
    }
    for (;;) {
      this.skipWhitespace();
      if (this.peek() !== '"') {
        this.fail("syntax", "object key must be a string");
      }
      const key = this.parseString();
      if (keys.has(key)) {
        this.fail("duplicate_key", `duplicate key ${JSON.stringify(key)}`);
      }
      keys.add(key);
      this.skipWhitespace();
      if (this.peek() !== ":") {
        this.fail("syntax", "missing colon");
      }
      this.index += 1;
      result[key] = this.parseValue(depth);
      this.skipWhitespace();
      const next = this.peek();
      if (next === ",") {
        this.index += 1;
        continue;
      }
      if (next === "}") {
        this.index += 1;
        return result;
      }
      this.fail("syntax", "expected comma or closing brace");
    }
  }

  private parseArray(depth: number): JsonValue {
    this.index += 1;
    const result: JsonValue[] = [];
    this.skipWhitespace();
    if (this.peek() === "]") {
      this.index += 1;
      return result;
    }
    for (;;) {
      result.push(this.parseValue(depth));
      this.skipWhitespace();
      const next = this.peek();
      if (next === ",") {
        this.index += 1;
        continue;
      }
      if (next === "]") {
        this.index += 1;
        return result;
      }
      this.fail("syntax", "expected comma or closing bracket");
    }
  }

  private parseString(): string {
    this.index += 1;
    let result = "";
    for (;;) {
      const char = this.peek();
      if (char === undefined) {
        this.fail("syntax", "unterminated string");
      }
      if (char === '"') {
        this.index += 1;
        return result;
      }
      if (char === "\\") {
        this.index += 1;
        result += this.parseEscape();
        continue;
      }
      const code = char.charCodeAt(0);
      if (code < 0x20) {
        this.fail("syntax", "control character in string");
      }
      result += char;
      this.index += 1;
    }
  }

  private parseEscape(): string {
    const char = this.peek();
    if (char === undefined) {
      this.fail("syntax", "unterminated escape");
    }
    this.index += 1;
    switch (char) {
      case '"':
        return '"';
      case "\\":
        return "\\";
      case "/":
        return "/";
      case "b":
        return "\b";
      case "f":
        return "\f";
      case "n":
        return "\n";
      case "r":
        return "\r";
      case "t":
        return "\t";
      case "u": {
        const hex = this.text.slice(this.index, this.index + 4);
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
          this.fail("syntax", "invalid unicode escape");
        }
        this.index += 4;
        return String.fromCharCode(Number.parseInt(hex, 16));
      }
      default:
        this.fail("syntax", "invalid escape");
    }
  }

  private parseNumber(): JsonValue {
    const start = this.index;
    if (this.peek() === "-") {
      this.index += 1;
    }
    const integerStart = this.index;
    if (this.peek() === "0") {
      this.index += 1;
    } else if (this.isDigit(this.peek())) {
      while (this.isDigit(this.peek())) {
        this.index += 1;
      }
    } else {
      this.fail("syntax", "invalid number");
    }
    if (this.index === integerStart) {
      this.fail("syntax", "invalid number");
    }
    if (this.peek() === ".") {
      this.index += 1;
      if (!this.isDigit(this.peek())) {
        this.fail("syntax", "invalid fraction");
      }
      while (this.isDigit(this.peek())) {
        this.index += 1;
      }
    }
    if (this.peek() === "e" || this.peek() === "E") {
      this.index += 1;
      if (this.peek() === "+" || this.peek() === "-") {
        this.index += 1;
      }
      if (!this.isDigit(this.peek())) {
        this.fail("syntax", "invalid exponent");
      }
      while (this.isDigit(this.peek())) {
        this.index += 1;
      }
    }
    const raw = this.text.slice(start, this.index);
    const value = Number(raw);
    if (!Number.isFinite(value)) {
      this.fail("syntax", "non-finite number");
    }
    return value;
  }

  private isDigit(char: string | undefined): boolean {
    return char !== undefined && char >= "0" && char <= "9";
  }

  private expectLiteral(literal: string): void {
    if (this.text.slice(this.index, this.index + literal.length) !== literal) {
      this.fail("syntax", `expected ${literal}`);
    }
    this.index += literal.length;
  }

  private skipWhitespace(): void {
    for (;;) {
      const char = this.peek();
      if (char === " " || char === "\t" || char === "\n" || char === "\r") {
        this.index += 1;
        continue;
      }
      return;
    }
  }

  private peek(): string | undefined {
    return this.text[this.index];
  }

  private fail(kind: StrictJsonErrorKind, message: string): never {
    throw new StrictJsonFailure(kind, this.index, message);
  }
}
