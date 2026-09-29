// The public site's "Recently modified" page: the vault's pages newest-changed first, and who
// changed them, from the vault's git history. The site is rebuilt whenever the vault changes (at
// most hourly for edits made in the members site's Settings), so the page follows each update.
import { spawnSync } from "node:child_process"

const SITE_AUTHOR = "hafezi members site"

/**
 * The newest change to each page that exists (`records`, from prepare-site), newest first.
 * `contentDir` is the vault's content folder inside its git work tree; git needs its history
 * (a full clone, not depth 1). Anything git can't answer gives an empty list.
 */
export function recentChanges(contentDir, records, { limit = 50, commits = 500 } = {}) {
  const run = spawnSync(
    "git",
    [
      "-c",
      "safe.directory=*",
      "-C",
      contentDir,
      "log",
      "--relative",
      `-n${commits}`,
      "--format=%x1e%an%x1f%ae%x1f%aI",
      "--name-status",
      "--no-renames",
      "--",
      ".",
    ],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  )
  if (run.status !== 0 || !run.stdout) return []
  const pages = new Map(records.map((record) => [record.slug, record]))
  // A GitHub login, as it appears in People pages' `github:`, to that person's name.
  const byLogin = new Map(
    records
      .filter((r) => r.fm.type === "person" && typeof r.fm.github === "string")
      .map((r) => [r.fm.github.toLowerCase(), String(r.fm.title ?? r.slug).trim()]),
  )
  const person = (name, email) => {
    const login = /^([^@]+)@users\.noreply\.github\.com$/.exec(email)?.[1] ?? name
    return byLogin.get(String(login).toLowerCase()) ?? name
  }
  const seen = new Set()
  const out = []
  for (const block of run.stdout.split("\x1e").slice(1)) {
    const [header, ...lines] = block.split("\n")
    const [name, email, at] = header.split("\x1f")
    for (const line of lines) {
      const [status, file] = line.split("\t")
      if (!file || status === "D" || !file.endsWith(".md")) continue
      const slug = file.replace(/\.md$/, "")
      const page = pages.get(slug)
      if (!page || seen.has(slug)) continue
      seen.add(slug)
      // Members' Settings edits go in together under the site's name: credit the page's person.
      const own =
        typeof page.fm.github === "string" ? byLogin.get(page.fm.github.toLowerCase()) : null
      out.push({
        slug,
        title: String(page.fm.title ?? slug).trim(),
        by: name === SITE_AUTHOR && own ? own : person(name, email),
        at,
      })
      if (out.length >= limit) return out
    }
  }
  return out
}
