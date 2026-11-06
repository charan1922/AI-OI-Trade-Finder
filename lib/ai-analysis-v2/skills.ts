/**
 * AI Analysis v2 skills — the SKILL.md format the operator's reference agent uses (and Anthropic's): a folder per
 * skill with YAML front matter `name` and `description`, then the instructions. The agent's instructions list only
 * each name and description; the agent calls `load_skill` when a request matches and then reads the body.
 *
 * The files live next to this module (lib/ai-analysis-v2/skills/<name>/SKILL.md). The Docker image ships the whole
 * repo (`COPY --from=builder /app ./`), so they are on disk at runtime too.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { NeutralToolDef } from '@/lib/auto-trade/tools/defs';

export interface Skill {
  name: string;
  description: string;
  body: string;
}

export const SKILLS_DIR = path.join(process.cwd(), 'lib', 'ai-analysis-v2', 'skills');

const unquote = (v: string) => v.trim().replace(/^(["'])(.*)\1$/, '$2');

/** Every `<dir>/<folder>/SKILL.md` with both a name and a description, by folder name. A file without them is skipped. */
export function loadSkills(dir: string = SKILLS_DIR): Skill[] {
  // The image ships the whole app folder (Dockerfile: not `output: standalone`), so the SKILL.md files are on disk;
  // the ignore comments stop Turbopack tracing the whole project because of this dynamic path.
  if (!fs.existsSync(/*turbopackIgnore: true*/ dir)) return [];
  const skills: Skill[] = [];
  for (const folder of fs.readdirSync(/*turbopackIgnore: true*/ dir).sort()) {
    const file = path.join(dir, folder, 'SKILL.md');
    if (!fs.existsSync(file)) continue;
    const text = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
    const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text);
    if (!m) continue;
    const meta: Record<string, string> = {};
    for (const line of m[1].split('\n')) {
      const kv = /^([A-Za-z_-]+):\s*(.*)$/.exec(line);
      if (kv) meta[kv[1]] = unquote(kv[2]);
    }
    if (!meta.name || !meta.description) continue;
    skills.push({ name: meta.name, description: meta.description, body: m[2].trim() });
  }
  return skills;
}

let cached: Skill[] | null = null;

/** Read once per process (a deploy restarts the process, so an edited SKILL.md is picked up on the next deploy). */
export function skills(): Skill[] {
  cached ??= loadSkills();
  return cached;
}

/** One line per skill for the instructions — never the bodies. */
export function skillIndex(list: readonly Skill[] = skills()): string {
  return list.map((s) => `- ${s.name}: ${s.description}`).join('\n');
}

export const LOAD_SKILL_TOOL: NeutralToolDef = {
  name: 'load_skill',
  description:
    'Load one of the skills listed in your instructions (a checked workflow for one kind of request) when the request matches its description. Load a skill once per turn.',
  parameters: {
    type: 'object',
    properties: { name: { type: 'string', description: 'The skill name, as listed' } },
    required: ['name'],
  },
};

export function loadSkillBody(name: unknown): { ok: true; skill: Skill } | { ok: false; error: string } {
  const all = skills();
  const skill = all.find((s) => s.name === name);
  if (!skill) return { ok: false, error: `No skill "${String(name)}". Skills: ${all.map((s) => s.name).join(', ')}` };
  return { ok: true, skill };
}
