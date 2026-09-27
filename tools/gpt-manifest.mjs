import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import yaml from "yaml"

// Hafezi GPT's built-in skills live in vault-private/gpt/skills/<name>/SKILL.md (agentskills.io
// format: frontmatter `name` + `description`, a Markdown body, optional references/*.md). The
// member build bakes them into worker/generated/gpt-skills.json; they never become site pages.
export const SKILLS_DIR = path.join("gpt", "skills")
const NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/
const MAX_BODY = 40_000
const MAX_REFERENCE = 60_000

export function gptSkills(privateRoot) {
  const dir = path.join(privateRoot, SKILLS_DIR)
  const skills = []
  const errors = []
  if (!fs.existsSync(dir)) return { skills, errors }
  for (const folder of fs.readdirSync(dir).sort()) {
    const file = path.join(dir, folder, "SKILL.md")
    if (!fs.existsSync(file)) continue
    const text = fs.readFileSync(file, "utf8")
    const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/)
    const front = match ? (yaml.parse(match[1]) ?? {}) : {}
    const body = (match ? match[2] : text).trim()
    const where = path.relative(privateRoot, file)
    if (front.name !== folder || !NAME.test(folder) || folder.length > 64)
      errors.push(`${where}: name must be lowercase-hyphenated and match its folder ("${folder}")`)
    else if (
      typeof front.description !== "string" ||
      !front.description.trim() ||
      front.description.length > 1024
    )
      errors.push(
        `${where}: description (what it does and when to use it, ≤1024 chars) is required`,
      )
    else if (!body || body.length > MAX_BODY)
      errors.push(`${where}: body must be 1–${MAX_BODY} characters`)
    else {
      const refsDir = path.join(dir, folder, "references")
      const references = fs.existsSync(refsDir)
        ? fs
            .readdirSync(refsDir)
            .filter((name) => /\.(md|txt)$/.test(name))
            .sort()
            .map((name) => ({
              path: `references/${name}`,
              content: fs.readFileSync(path.join(refsDir, name), "utf8").slice(0, MAX_REFERENCE),
            }))
        : []
      skills.push({ name: folder, description: front.description.trim(), body, references })
    }
  }
  return { skills, errors }
}

export function writeGptSkills(privateRoot, file = "worker/generated/gpt-skills.json") {
  const { skills, errors } = gptSkills(privateRoot)
  if (errors.length) throw new Error(`invalid Hafezi GPT skills:\n${errors.join("\n")}`)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(
    file,
    JSON.stringify({ generatedAt: new Date().toISOString(), skills }, null, 2) + "\n",
  )
  return { file, count: skills.length }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = process.argv[2] ?? process.env.VAULT_PRIVATE_DIR ?? "../vault-private"
  const { file, count } = writeGptSkills(root)
  console.log(`${count} Hafezi GPT skills written to ${file}`)
}
