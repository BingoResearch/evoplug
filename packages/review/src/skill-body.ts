/**
 * Skill file assembly (Agent Skills frontmatter).
 *
 * The generation content rules ask the model for the markdown body only, with
 * no frontmatter. A host discovers skills by the frontmatter `name` and
 * `description`, so the kernel adds that header once, deterministically, from
 * the proposed target directory and the experience trigger. Static check and
 * adoption both call this function, so the candidate hash and the bytes
 * written to disk describe the same file.
 */

const KEBAB = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

/** The skill directory immediately above `SKILL.md`, when the path is one. */
export function skillNameFromPath(pathOrBlock: string): string | null {
  const normalized = pathOrBlock.replace(/\\/gu, "/");
  const segments = normalized.split("/").filter((segment) => segment.length > 0);
  if (segments.length < 2) return null;
  const file = segments[segments.length - 1];
  if (file !== "SKILL.md") return null;
  const name = segments[segments.length - 2] ?? "";
  return KEBAB.test(name) ? name : null;
}

function yamlScalar(value: string): string {
  // A JSON string is a valid YAML double-quoted scalar, including escapes.
  return JSON.stringify(value);
}

/** True when the body already carries a frontmatter block. */
export function hasFrontmatter(text: string): boolean {
  return text.startsWith("---\n") || text.startsWith("---\r\n");
}

/**
 * Adds the host frontmatter to a generated skill body.
 *
 * Returns the input unchanged when it already has frontmatter, when the
 * target is not a `SKILL.md`, or when the name/description cannot be derived.
 */
export function withSkillFrontmatter(
  body: string,
  input: { readonly path_or_block: string; readonly description: string | null }
): string {
  if (hasFrontmatter(body)) return body;
  const name = skillNameFromPath(input.path_or_block);
  const description = input.description?.trim() ?? "";
  if (name === null || description.length === 0) return body;
  const trimmed = description.length > 1024 ? description.slice(0, 1024) : description;
  return `---\nname: ${name}\ndescription: ${yamlScalar(trimmed)}\n---\n\n${body}`;
}
