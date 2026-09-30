// The members' "Recently modified" page: the public vault's pages newest-changed first, and who
// changed them, from the vault's git history (tools/history.mjs). The site is rebuilt whenever the
// vault changes (at most hourly for edits made in the members site's Settings), so the page follows
// each update.
import { creditOf, people, readLog } from "./history.mjs"

/**
 * The newest change to each page that exists (`records`, from prepare-site), newest first.
 * `contentDir` is the vault's content folder inside its git work tree; git needs its history
 * (a full clone, not depth 1). Anything git can't answer gives an empty list.
 */
export function recentChanges(contentDir, records, { limit = 50, commits = 500 } = {}) {
  const log = readLog(contentDir, { commits })
  if (!log) return []
  const known = people(records)
  const pages = new Map(records.map((record) => [record.slug, record]))
  const seen = new Set()
  const out = []
  for (const commit of log.commits)
    for (const file of commit.files) {
      if (file.status === "D" || !file.path.startsWith(log.prefix) || !file.path.endsWith(".md"))
        continue
      const slug = file.path.slice(log.prefix.length).replace(/\.md$/, "")
      const page = pages.get(slug)
      if (!page || seen.has(slug)) continue
      seen.add(slug)
      out.push({
        slug,
        title: String(page.fm.title ?? slug).trim(),
        by: creditOf(commit, file.path, known).name,
        at: commit.date,
      })
      if (out.length >= limit) return out
    }
  return out
}
