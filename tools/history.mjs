// The vaults' history, from git: each page's revisions (the History button's per-page files,
// quartz/plugins/local/page-history/), the members' Recently modified page (recent-changes.mjs) and
// the deploy's import into the Worker's changes table (changes-import.mjs) all read it through
// this. Git keeps the content; this says who changed which file, when, and how.
import { spawnSync } from "node:child_process"

/** The members site's name on the commits that hold several members' Settings edits at once. */
export const SITE_AUTHOR = "hafezi members site"
/** Revisions kept per file; older ones are on GitHub. */
export const MAX_REVISIONS = 100

const KINDS = { A: "new", C: "new", M: "edit", T: "edit", D: "delete", R: "rename" }
const FORMAT = "%x1e%H%x1f%P%x1f%an%x1f%ae%x1f%at%x1f%aI%x1f%s"

function git(dir, args) {
  const run = spawnSync("git", ["-c", "safe.directory=*", "-C", dir, ...args], {
    encoding: "utf8",
    maxBuffer: 512 * 1024 * 1024,
  })
  return run.status === 0 ? run.stdout : null
}

/** The files whose changes are counted in lines: pages. Counting a 40 MB Wolfram notebook's or a
 *  PDF's takes git seconds, and says nothing. */
export const COUNTED = ["*.md", "*.qmd", "*.ipynb"]

/**
 * The commits of the git work tree that holds `dir`, newest first, each with the files it changed:
 * `{root, prefix, commits}`, where `prefix` is `dir`'s place in the work tree ("content/") and a
 * commit is `{sha, parents, name, email, at (ms), date (ISO, in the author's zone), subject, files}`.
 * A file is `{status (A, M, D, R, T), path, from (a rename's old path), added, removed}`, paths from
 * the top of the work tree; only COUNTED files have line counts, and not when binary. Renames are
 * found (-M). A shallow clone's oldest commit would list every file as new, so its files are left
 * out. null when `dir` isn't in a git work tree; a work tree without commits has none.
 */
export function readLog(dir, { commits = 10000 } = {}) {
  const root = git(dir, ["rev-parse", "--show-toplevel"])?.trim()
  if (!root) return null
  const prefix = git(dir, ["rev-parse", "--show-prefix"])?.trim() ?? ""
  const shallow = git(dir, ["rev-parse", "--is-shallow-repository"])?.trim() === "true"
  const log = (...args) => git(root, ["log", `-n${commits}`, "-M", "-z", ...args])
  const raw = log("--raw", "--no-abbrev", `--format=${FORMAT}`)
  if (!raw) return { root, prefix, commits: [] }
  const list = parseLog(raw, { shallow })
  const counts = log("--numstat", "--format=%x1e%H", "--", ...COUNTED)
  if (counts) addCounts(list, counts)
  return { root, prefix, commits: list }
}

/** `git log -z --raw` in FORMAT, as commits (readLog), without line counts. */
export function parseLog(text, { shallow = false } = {}) {
  const commits = []
  for (const block of text.split("\x1e").slice(1)) {
    const end = block.indexOf("\0")
    const [sha, parents, name, email, at, date, subject] = (
      end < 0 ? block : block.slice(0, end)
    ).split("\x1f")
    const commit = {
      sha,
      parents: parents ? parents.split(" ") : [],
      name,
      email,
      at: Number(at) * 1000,
      date,
      subject: (subject ?? "").trim(),
      files: [],
    }
    commits.push(commit)
    // A shallow clone's oldest commit has lost its parents: what it changed is unknown.
    if (end < 0 || (shallow && !commit.parents.length)) continue
    const tokens = block.slice(end + 1).split("\0")
    for (let i = 0; i < tokens.length; i++) {
      // ":100644 100644 <blob> <blob> R087", then the path, or a rename's old and new paths.
      const token = tokens[i].replace(/^\n/, "")
      if (!token.startsWith(":")) continue
      const status = token.slice(token.lastIndexOf(" ") + 1)[0]
      const from = status === "R" || status === "C" ? tokens[++i] : null
      commit.files.push({ status, path: tokens[++i], from, added: null, removed: null })
    }
  }
  return commits
}

/** Line counts from `git log -z --numstat --format=%x1e%H` onto readLog's commits' files. */
export function addCounts(commits, text) {
  const bySha = new Map(commits.map((commit) => [commit.sha, commit]))
  for (const block of text.split("\x1e").slice(1)) {
    const tokens = block.split("\0")
    const commit = bySha.get(tokens[0])
    if (!commit) continue
    for (let i = 1; i < tokens.length; i++) {
      // "<added>\t<removed>\t<path>", or for a rename "<added>\t<removed>\t" then both paths.
      const counts = /^(\d+|-)\t(\d+|-)\t(.*)$/s.exec(tokens[i].replace(/^\n/, ""))
      if (!counts) continue
      const path = counts[3] || tokens[(i += 2)]
      const file = commit.files.find((f) => f.path === path)
      if (!file) continue
      file.added = counts[1] === "-" ? null : Number(counts[1])
      file.removed = counts[2] === "-" ? null : Number(counts[2])
    }
  }
}

/**
 * Who's who, from the People pages (records from prepare-site: `{slug, fm}`): each GitHub login a
 * page is linked to (`github:`), with the person's name and page, by login, by name and by the
 * page's own name ("ada-lovelace").
 */
export function people(records) {
  const byLogin = new Map()
  const byName = new Map()
  const byPage = new Map()
  for (const record of records) {
    const login = typeof record.fm?.github === "string" ? record.fm.github.trim() : ""
    if (record.fm?.type !== "person" || !login) continue
    const person = { login, name: String(record.fm.title ?? record.slug).trim(), slug: record.slug }
    byLogin.set(login.toLowerCase(), person)
    byName.set(person.name.toLowerCase(), person)
    byPage.set(record.slug.split("/").at(-1), person)
  }
  return { byLogin, byName, byPage }
}

// A People page or its photo, by the page's own name: the site's commits of several members'
// Settings edits change only these.
const PERSON_FILE = /(?:^|\/)(?:people\/(?:alumni\/)?|assets\/people\/)([^/]+?)\.\w+$/

/**
 * Who made the change to `path` in `commit`: `{login, name}`, the login null when unknown. A GitHub
 * noreply address, or an author name that is a linked login, gives the login; else a People page
 * titled with the author's name does. The site's own commits (several members' Settings edits at
 * once) are credited to each page's person. Never an email address.
 */
export function creditOf(commit, path, known) {
  if (commit.name === SITE_AUTHOR) {
    const person = known.byPage.get(PERSON_FILE.exec(path)?.[1])
    return person ? { login: person.login, name: person.name } : { login: null, name: SITE_AUTHOR }
  }
  const noreply = /^(?:\d+\+)?([^@\s]+)@users\.noreply\.github\.com$/i.exec(commit.email)?.[1]
  const person =
    known.byLogin.get((noreply ?? commit.name).toLowerCase()) ??
    (noreply ? undefined : known.byName.get(commit.name.toLowerCase()))
  return person
    ? { login: person.login, name: person.name }
    : { login: noreply ?? null, name: commit.name }
}

/** One file's change in one commit, as a page's history lists it. */
export function revision(commit, file, known) {
  const { login, name } = creditOf(commit, file.path, known)
  return {
    commit: commit.sha,
    parent: commit.parents[0] ?? null,
    date: commit.date,
    author: name,
    login,
    summary: commit.subject,
    kind: KINDS[file.status] ?? "edit",
    path: file.path,
    from: file.from,
    added: file.added,
    removed: file.removed,
  }
}

/**
 * Each file's revisions, newest first: a Map from the file's path at its newest revision to them.
 * Renames are followed back, so a moved page keeps its history; a path that held another file
 * before (deleted, or renamed away) shares its history, as `git log -- <path>` would show it.
 */
export function fileHistories(commits, known) {
  const histories = new Map()
  // Older names of renamed files, to the name their history is under.
  const renamed = new Map()
  for (const commit of commits)
    for (const file of commit.files) {
      const key = renamed.get(file.path) ?? file.path
      if (!histories.has(key)) histories.set(key, [])
      histories.get(key).push(revision(commit, file, known))
      if (file.from && file.from !== file.path) renamed.set(file.from, key)
    }
  return histories
}

/**
 * The vaults' page histories for the History button: `{"<repo>:<path>": {revisions, more}}`, each
 * page's newest MAX_REVISIONS revisions and whether it has older ones. `vaults` is
 * `[{repo: "vault", dir}, …]`, any folder of each vault's work tree; `pages` picks the files kept.
 */
export function pageHistories(vaults, records, { pages = () => true, limit = MAX_REVISIONS } = {}) {
  const known = people(records)
  const out = {}
  for (const { repo, dir } of vaults) {
    const log = readLog(dir)
    if (!log) continue
    for (const [path, revisions] of fileHistories(log.commits, known))
      if (pages(path))
        out[`${repo}:${path}`] = {
          revisions: revisions.slice(0, limit),
          more: revisions.length > limit,
        }
  }
  return out
}
