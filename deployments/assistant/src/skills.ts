import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { AssistantConfig } from "./config.ts";

/** Skills are markdown procedures, one file per skill, keyed by this slug. */
export const SKILL_NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/;
export const MAX_SKILL_CHARS = 64_000;
export const MAX_SKILLS = 200;
const MAX_DESCRIPTION = 160;
const MAX_INDEX_ENTRIES = 200;

export interface SkillEntry {
  name: string;
  title: string;
  description: string;
  chars: number;
  updatedAt: number;
}

export interface SkillSearchResult {
  name: string;
  line: number;
  snippet: string;
}

export class SkillError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SkillError";
  }
}

export function skillDirectory(config: AssistantConfig, userId: string): string {
  return join(config.agentDir, "users", userId, "skill");
}

export function isValidSkillName(name: string): boolean {
  return SKILL_NAME.test(name);
}

function assertName(name: string): string {
  const value = name.trim();
  if (!isValidSkillName(value)) {
    throw new SkillError(
      `Invalid skill name ${JSON.stringify(value)}; use lowercase letters, digits, '-' or '_' (max 64 chars).`,
    );
  }
  return value;
}

/** First heading becomes the title; the first body line becomes the index description. */
export function describeSkill(content: string): { title: string; description: string } {
  let title = "";
  let description = "";
  for (const raw of content.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith("#")) {
      if (!title) title = line.replace(/^#+\s*/, "").trim();
      continue;
    }
    description = line;
    break;
  }
  const chars = Array.from(description);
  return {
    title: title || "untitled",
    description: chars.length > MAX_DESCRIPTION ? `${chars.slice(0, MAX_DESCRIPTION).join("")}…` : description,
  };
}

function snippet(text: string, query: string): string {
  const index = text.toLowerCase().indexOf(query.toLowerCase());
  if (index < 0) return text.slice(0, 200);
  const start = Math.max(0, index - 60);
  const end = Math.min(text.length, index + query.length + 100);
  return `${start > 0 ? "…" : ""}${text.slice(start, end)}${end < text.length ? "…" : ""}`;
}

/**
 * Per-user, per-agent markdown skills: `BASEDIR/agent/<agent>/users/<user>/skill/<name>.md`.
 * Files are plain markdown so MEMORY.md and handoffs can reference them by name; the
 * prompt gets an index (title + first line), not the contents, so a skill is only read
 * when the model asks for it.
 */
export class SkillStore {
  constructor(readonly dir: string) {}

  file(name: string): string {
    return join(this.dir, `${assertName(name)}.md`);
  }

  async read(name: string): Promise<string | null> {
    try {
      return await readFile(this.file(name), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async list(): Promise<SkillEntry[]> {
    let names: string[];
    try {
      names = (await readdir(this.dir)).filter((entry) => entry.endsWith(".md")).sort();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const entries: SkillEntry[] = [];
    for (const file of names.slice(0, MAX_INDEX_ENTRIES)) {
      const name = file.slice(0, -3);
      if (!isValidSkillName(name)) continue;
      try {
        const [content, info] = await Promise.all([
          readFile(join(this.dir, file), "utf8"),
          stat(join(this.dir, file)),
        ]);
        const { title, description } = describeSkill(content);
        entries.push({ name, title, description, chars: content.length, updatedAt: info.mtimeMs });
      } catch {
        // A skill that disappears between readdir and read is skipped.
      }
    }
    return entries;
  }

  async write(name: string, content: string): Promise<{ name: string; created: boolean }> {
    const value = assertName(name);
    if (!content.trim()) throw new SkillError("Skill content is required and must not be empty.");
    if (content.length > MAX_SKILL_CHARS) {
      throw new SkillError(`Skill is too long (${content.length}/${MAX_SKILL_CHARS} chars).`);
    }
    const existing = await this.read(value);
    const file = this.file(value);
    await mkdir(dirname(file), { recursive: true, mode: 0o700 });
    const temp = `${file}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
    await writeFile(temp, content, { encoding: "utf8", mode: 0o600 });
    await rename(temp, file);
    return { name: value, created: existing === null };
  }

  async remove(name: string): Promise<boolean> {
    try {
      await rm(this.file(name));
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }

  async search(query: string, limit = 10): Promise<SkillSearchResult[]> {
    const needle = query.trim();
    if (!needle) return [];
    const capped = Math.max(1, Math.min(50, Math.floor(limit)));
    const results: SkillSearchResult[] = [];
    for (const entry of await this.list()) {
      const content = await this.read(entry.name);
      if (!content) continue;
      const lines = content.split("\n");
      const line = lines.findIndex((text) => text.toLowerCase().includes(needle.toLowerCase()));
      if (line < 0) continue;
      results.push({
        name: entry.name,
        line: line + 1,
        snippet: snippet(lines[line] ?? "", needle),
      });
      if (results.length >= capped) break;
    }
    return results;
  }
}

const SKILL_REFERENCE = /skill:([a-z0-9][a-z0-9_-]{0,63})/g;

/**
 * Expands `skill:<name>` markers in memory entries with the skill's index line, so a
 * MEMORY.md pointer resolves without the model spending a tool call to discover it.
 * Unknown names are left untouched (the skill may be added later).
 */
export function resolveSkillReferences(entries: string[], skills: SkillEntry[]): string[] {
  const byName = new Map(skills.map((skill) => [skill.name, skill]));
  return entries.map((entry) =>
    entry.replace(SKILL_REFERENCE, (match, name: string) => {
      const skill = byName.get(name);
      return skill ? `skill:${name} (${skill.description || skill.title})` : match;
    }),
  );
}

export function skillsInstructions(entries: SkillEntry[]): string {
  const shown = entries.slice(0, MAX_INDEX_ENTRIES);
  const index = shown.length
    ? shown.map((entry) => `- \`${entry.name}\`: ${entry.description || entry.title}`).join("\n")
    : "(no skills yet)";
  const more = entries.length > shown.length ? `\n(${entries.length - shown.length} more skills not indexed)` : "";
  return `# Skills
Reusable procedures you write as markdown, one file per skill under \`users/<user>/skill/<name>.md\`.
Index:
${index}${more}
Load a skill with \`server_skill_read\` before following it; create or update one with \`server_skill_write\`; find one by text with \`server_skill_search\`; remove one with \`server_skill_delete\`. MEMORY.md may reference skills as \`skill:<name>\`; resolve those with \`server_skill_read\`. To share a skill with another agent or user, send a handoff with \`skill: <name>\`; the recipient saves it with \`server_skill_import\`.`;
}
