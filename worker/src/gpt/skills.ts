import { HttpError } from "../http"
import type { GptStore, SkillRow, Visibility } from "./store"

// Skills are SKILL.md-shaped instructions (agentskills.io): a name, a one-line "what and when"
// description that always sits in the system prompt, and a body loaded only when used — by the
// model through use_skill, or by the member typing /name. Repo skills are versioned in
// vault-private/gpt/skills/ and baked into generated/gpt-skills.json at build time; members can
// also write their own (D1), private or shared with the group.

export interface RepoSkill {
  name: string
  description: string
  body: string
  references?: Array<{ path: string; content: string }>
}

export interface SkillsManifest {
  generatedAt?: string
  skills: RepoSkill[]
}

export interface Skill {
  id: string | null
  name: string
  description: string
  body: string
  source: "repo" | "member"
  owner: string | null
  visibility: Visibility | "repo"
  references: Array<{ path: string; content: string }>
}

export const SKILL_NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/

export async function allSkills(
  manifest: SkillsManifest,
  store: GptStore,
  login: string,
): Promise<Skill[]> {
  const repo: Skill[] = manifest.skills.map((s) => ({
    id: null,
    name: s.name,
    description: s.description,
    body: s.body,
    source: "repo",
    owner: null,
    visibility: "repo",
    references: s.references ?? [],
  }))
  const taken = new Set(repo.map((s) => s.name))
  const member: Skill[] = (await store.listSkills(login))
    .filter((s) => !taken.has(s.name))
    .map((s: SkillRow) => ({
      id: s.id,
      name: s.name,
      description: s.description,
      body: s.body,
      source: "member",
      owner: s.owner,
      visibility: s.visibility,
      references: [],
    }))
  return [...repo, ...member].sort((a, b) => a.name.localeCompare(b.name))
}

export function validateSkill(body: Record<string, unknown>, repoNames: Set<string>) {
  const name = typeof body.name === "string" ? body.name.trim().toLowerCase() : ""
  const description = typeof body.description === "string" ? body.description.trim() : ""
  const text = typeof body.body === "string" ? body.body.trim() : ""
  if (!SKILL_NAME.test(name) || name.length > 64)
    throw new HttpError(422, "skill names are lowercase words joined by hyphens, like scpi-helper")
  if (repoNames.has(name)) throw new HttpError(409, `"${name}" is a built-in skill`)
  if (!description || description.length > 1024)
    throw new HttpError(
      422,
      "describe what the skill does and when to use it (up to 1024 characters)",
    )
  if (!text || text.length > 40_000)
    throw new HttpError(422, "the instructions must be 1–40,000 characters")
  return {
    name,
    description,
    body: text,
    visibility: (body.visibility === "group" ? "group" : "private") as Visibility,
  }
}
