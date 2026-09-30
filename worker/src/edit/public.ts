import jsyaml from "js-yaml"
import { parse as parseYaml } from "yaml"
import type { TreeEntry } from "../repo"
import { schemaProblems } from "./schema"

// What the public vault's check (its tools/validate.mjs, run on every push to main) would refuse in
// a page edited on the site: an edit of a public page is committed straight to main by the hourly
// run (publish.ts), with no pull request to check it first, so the Worker checks it the same way,
// as far as it can see: the front matter (parsed as the check parses it, js-yaml, and as the site's
// build parses it, yaml), a title, the tags, the page's record schema (the vault's own
// schema/<type>.schema.json), links and images it adds that lead nowhere, and the places and
// equipment records the page names. It is stricter where it can't see as far: a link it adds must
// name a page by its path (the vault's links all do), not by a title.
// It also keeps what only an admin changes: who a People page belongs to, a person's role and
// group (as /settings does), a record's id (other pages name it), and HTML that runs in browsers.

export const TAG = /^[a-z0-9]+(?:-[a-z0-9]+)*(?:\/[a-z0-9]+(?:-[a-z0-9]+)*)?$/
const FRONT = /^---\n([\s\S]*?)\n---\n/
const WIKILINK = /(!?)\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]/g
const IMAGE = /!\[[^\]]*\]\(([^)]+)\)/g
/** Front matter only an admin changes on a People page (/settings keeps them too). */
const PERSON_LOCKED = ["github", "role", "group"]

export type FrontMatter = Record<string, unknown>

export interface Page {
  fm: FrontMatter | null
  body: string
  problems: string[]
}

/** A page's front matter, read as the vault's check reads it (and as the site's build does). */
export function readPage(text: string): Page {
  const match = text.match(FRONT)
  if (!match)
    return {
      fm: null,
      body: text,
      problems: ["no front matter: a title and tags between --- lines at the top"],
    }
  const body = text.slice(match[0].length)
  let fm: unknown
  try {
    fm = jsyaml.load(match[1]) ?? {}
  } catch (error) {
    const reason = error instanceof jsyaml.YAMLException ? error.reason : String(error)
    const line = error instanceof jsyaml.YAMLException ? error.mark?.line : undefined
    return {
      fm: null,
      body,
      problems: [
        `its front matter isn't valid YAML${line === undefined ? "" : ` (line ${line + 2})`}: ${reason}`,
      ],
    }
  }
  try {
    parseYaml(match[1])
  } catch (error) {
    return {
      fm: null,
      body,
      problems: [
        `the site can't read its front matter: ${String((error as Error).message).split("\n")[0]}`,
      ],
    }
  }
  if (typeof fm !== "object" || fm === null || Array.isArray(fm))
    return { fm: null, body, problems: ["its front matter must be keys and values"] }
  return { fm: fm as FrontMatter, body, problems: [] }
}

const withoutCode = (text: string) =>
  text.replace(/^(```+|~~~+)[^\n]*\n[\s\S]*?^\1\s*$/gm, "").replace(/`[^`\n]+`/g, "")

// HTML that runs or takes over a page (as uploads/rules.ts activeHtml judges it), by the pieces
// that make it so, so an edit adds one only if its text has more of them than the page had.
const ACTIVE =
  /<\s*\/?\s*(?:script|iframe|frame|frameset|object|embed|applet|base|meta|link|form|style|svg|math|template|portal)\b|<[^>]*\s(?:on[a-z]+|srcdoc|formaction)\s*=|(?:javascript|vbscript)\s*:|data:text\/html/gi

function activePieces(text: string): Map<string, number> {
  const counts = new Map<string, number>()
  for (const [piece] of withoutCode(text).matchAll(ACTIVE)) {
    const key = piece.toLowerCase().replace(/\s+/g, "")
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  return counts
}

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null)

/**
 * The problems of an edited public page that need nothing but the page and the version it was
 * edited from (`base`, main's text when the edit began): its front matter, title and tags, and what
 * only an admin changes.
 */
export function pageProblems(text: string, base: string | null, admin: boolean): string[] {
  const page = readPage(text)
  if (!page.fm) return page.problems
  const fm = page.fm
  const problems: string[] = []
  if (!fm.title) problems.push("no title")
  if (fm.tags !== undefined && fm.tags !== null && !Array.isArray(fm.tags))
    problems.push("tags must be a list")
  const tags = Array.isArray(fm.tags) ? fm.tags : []
  for (const tag of tags)
    if (typeof tag !== "string" || !TAG.test(tag)) problems.push(`invalid tag ${tag}`)
  if (tags.includes("internal") || tags.includes("private"))
    problems.push(
      "a public page can't be tagged internal or private (those pages go in the private vault)",
    )
  if (fm.draft === true) problems.push("a public page can't be made a draft from the site")
  const before = base === null ? null : readPage(base).fm
  if (before) {
    if (!admin && fm.type === "person")
      for (const key of PERSON_LOCKED)
        if (!same(fm[key], before[key])) problems.push(`only an admin can change a person's ${key}`)
    if ((fm.type === "equipment" || fm.type === "setup") && !same(fm.id, before.id))
      problems.push("changing a record's id breaks the pages that name it: ask an admin")
  }
  if (!admin) {
    const had = activePieces(base ?? "")
    const added = [...activePieces(text)].filter(([piece, n]) => n > (had.get(piece) ?? 0))
    if (added.length)
      problems.push(
        `HTML that runs in the browser (${added.map(([piece]) => piece).join(", ")}) can only be added by an admin`,
      )
  }
  return problems
}

/** Everything a wikilink or image in content/ may lead to, as the vault's check lists them. */
export function linkTargets(files: Map<string, TreeEntry>): Set<string> {
  const targets = new Set<string>()
  const basename = (path: string) => path.split("/").pop()!
  for (const [path, entry] of files) {
    if (entry.type !== "blob" || !path.startsWith("content/")) continue
    const rel = path.slice("content/".length)
    if (/\.(?:md|qmd)$/.test(rel)) {
      const noExt = rel.replace(/\.(?:md|qmd)$/, "")
      targets.add(noExt)
      targets.add(basename(noExt))
      if (noExt.endsWith("/index")) targets.add(noExt.slice(0, -6))
    } else {
      targets.add(rel)
      targets.add(rel.replace(/\.[^./]+$/, ""))
    }
  }
  return targets
}

const wikilinks = (body: string) =>
  new Set([...body.matchAll(WIKILINK)].map((match) => match[2].trim().replace(/\\$/, "")))
const images = (body: string) =>
  new Set([...body.matchAll(IMAGE)].map((match) => match[1]).filter((raw) => !/^https?:/.test(raw)))

/** A path inside the vault from a page's folder, or null when it leaves the vault. */
function resolve(folder: string, raw: string): string | null {
  const parts = folder.split("/")
  for (const part of raw.split(/[ )]/)[0].split("/")) {
    if (part === "..") {
      if (parts.length <= 1) return null
      parts.pop()
    } else if (part && part !== ".") parts.push(decodeURIComponent(part))
  }
  return parts.join("/")
}

export interface VaultView {
  /** Every file and folder at main (the git tree). */
  files: Map<string, TreeEntry>
  /** A JSON or YAML file of the vault at main, parsed (null when there is none). */
  data(path: string): Promise<unknown>
}

/**
 * The problems of an edited public page that need the vault at main: its schema, the links and
 * images it adds, and the places and records it names.
 */
export async function vaultProblems(
  path: string,
  text: string,
  base: string | null,
  vault: VaultView,
): Promise<string[]> {
  const page = readPage(text)
  if (!page.fm) return page.problems
  const fm = page.fm
  const problems: string[] = []
  const type = typeof fm.type === "string" ? fm.type : null
  if (type && vault.files.has(`schema/${type}.schema.json`)) {
    const schema = await vault.data(`schema/${type}.schema.json`)
    if (schema && typeof schema === "object")
      problems.push(...schemaProblems(schema as Record<string, unknown>, fm))
  }
  const before = base === null ? { body: "" } : readPage(base)
  const targets = linkTargets(vault.files)
  const had = wikilinks(before.body)
  for (const raw of wikilinks(page.body)) {
    if (had.has(raw)) continue
    const target = raw.replace(/\.(?:md|qmd)$/, "")
    if (target.startsWith("tags/")) continue
    if (!targets.has(target) && !targets.has(target.split("/").pop()!))
      problems.push(
        `[[${raw}]] doesn't lead to a page or file in the vault (name a page by its path, like [[people/index]])`,
      )
  }
  const folder = path.split("/").slice(0, -1).join("/")
  const shown = images(before.body)
  for (const raw of images(page.body)) {
    if (shown.has(raw)) continue
    const file = resolve(folder, raw)
    if (!file || !vault.files.has(file)) problems.push(`missing image ${raw}`)
  }
  const slug = path.split("/").pop()!.replace(/\.md$/, "")
  if (type === "person") {
    const data = (await vault.data("content/places/places.yml")) as {
      places?: { id: string; occupants?: string[] }[]
    } | null
    const places = new Map((data?.places ?? []).map((place) => [place.id, place]))
    const mine = Array.isArray(fm.places) ? (fm.places as string[]) : []
    for (const id of mine) {
      if (!places.has(id)) problems.push(`unknown place ${id}`)
      else if (!(places.get(id)!.occupants ?? []).includes(slug))
        problems.push(
          `places/places.yml doesn't list this person in ${id}: ask an admin to add them there`,
        )
    }
    for (const place of places.values())
      if ((place.occupants ?? []).includes(slug) && !mine.includes(place.id))
        problems.push(`places/places.yml lists this person in ${place.id}: keep it in places`)
  }
  const named = (list: unknown, folderName: string) =>
    (Array.isArray(list) ? list : []).map((item) =>
      String(item).replace(new RegExp(`^\\[\\[${folderName}/|\\]\\]$`, "g"), ""),
    )
  if (type === "equipment")
    for (const id of named(fm.setups, "setups"))
      if (!vault.files.has(`content/setups/${id}.md`)) problems.push(`unknown setup ${id}`)
  if (type === "setup")
    for (const id of named(fm.equipment, "equipment"))
      if (!vault.files.has(`content/equipment/${id}.md`)) problems.push(`unknown equipment ${id}`)
  return problems
}
