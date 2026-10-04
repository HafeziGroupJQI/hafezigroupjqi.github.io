import { aclViewer, requireRead } from "../acl/index"
import { type Auditor, isAdmin } from "../audit"
import { requireMutation } from "../auth"
import type { Env } from "../env"
import { HttpError, json, readJson } from "../http"
import { dueAt, navIdentity } from "../profile/routes"
import type { RepoFetch } from "../repo"
import type { Session } from "../session"
import {
  type ChangeRow,
  type DraftRow,
  LIVE,
  LIVE_SQL,
  changesOf,
  discard,
  draftRow,
  draftView,
  plainName,
  publishedKey,
  send,
  stagedKey,
} from "../uploads/drafts"
import { DraftRepo, REPO_NAMES, type RepoName, draftRepoName } from "../uploads/github"
import { PRIVATE_VAULT, vaultOf } from "../vaults"
import { SENDS_PER_DAY, ownDraft, underLimit } from "../uploads/routes"
import { draftChanges, recordChanges, unsentChanges } from "../changes"
import {
  CLAIM_MS,
  CONFLICTS_OPEN_MAX,
  CONFLICT_SELECT,
  type ConflictRow,
  baseKey,
  baseText,
  checkSend,
  conflictView,
  newId,
  openConflict,
  openConflictOf,
  mergeable,
  refusal,
  sentText,
  UNCLAIMED,
  unsentAfter,
} from "./conflicts"
import { gitBlobSha, threeWay } from "./merge"
import { pageProblems, readPage, vaultProblems } from "./public"
import { publishEdit, vaultView } from "./publish"
import {
  type EditKind,
  blobSha,
  cleanSummary,
  contentReport,
  editAccess,
  editText,
  editTitle,
  editablePath,
  indexTemplate,
  newIndexPath,
} from "./rules"

// The site's page editor (/edit, frontend/edit/): a page's own file in its vault, as its author
// wrote it (a Quarto page's .qmd, a notebook page's .ipynb), never the page the site made from it.
// The editor loads the file at main with its blob sha, the base of the member's edit. Saving keeps
// a draft in the uploads pipeline (src/uploads/: D1 upload_drafts with kind 'edit', one
// upload_changes row whose base_sha is that blob, the text in R2), which only its author sees.
// Sending a private page's edit makes it a pull request on vault-private, merged by the hourly run
// once its check passes, like an upload; publishing a public page's edit queues it for the hourly
// run that commits it to the public vault's main (publish.ts). A page that changed on main since
// the member loaded it is refused with main's new version, so nothing anyone else wrote is
// overwritten. Signed-in members only, never a lab ticket; every action is audited, with limits.

/** Page edits one member may have open at once (one per page). */
export const EDIT_DRAFTS_MAX = 10
/** Saves of edits (new drafts and new versions of one) per member in 24 hours. */
export const SAVES_PER_DAY = 500

const DRAFT = /^\/api\/edit\/drafts\/([0-9a-f]{12})(?:\/(send|queue))?$/
const CONFLICT = /^\/api\/edit\/conflicts\/([0-9a-f]{12})(?:\/(withdraw|resolve))?$/
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true })

const CONTENT_TYPES: Record<EditKind, string> = {
  md: "text/markdown; charset=utf-8",
  qmd: "text/markdown; charset=utf-8",
  ipynb: "application/x-ipynb+json",
}

/** What a revert restores (a commit's version of the page) or undoes (a commit's change). */
function revertParam(value: unknown): { rev: string; mode: "restore" | "undo" } {
  const { rev, mode } = (value ?? {}) as Record<string, unknown>
  if (typeof rev !== "string" || !/^[0-9a-f]{40}$/.test(rev))
    throw new HttpError(422, "rev must be a commit's full sha")
  if (mode !== "restore" && mode !== "undo")
    throw new HttpError(422, "mode must be restore or undo")
  return { rev, mode }
}

/** A draft's id, as a request names one. */
function draftId(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-f]{12}$/.test(value))
    throw new HttpError(422, "that isn't a draft's id")
  return value
}

function repoParam(value: unknown): RepoName {
  if (!REPO_NAMES.includes(value as RepoName))
    throw new HttpError(422, `repo must be ${REPO_NAMES.join(" or ")}`)
  return value as RepoName
}

const encodePath = (path: string) => path.split("/").map(encodeURIComponent).join("/")

function decode(bytes: Uint8Array, path: string): string {
  try {
    return decoder.decode(bytes)
  } catch {
    throw new HttpError(422, `${path} isn't UTF-8 text, so the editor can't open it`)
  }
}

/** A member's live edit of a file, with its one change. */
async function liveEdit(
  env: Env,
  login: string,
  repo: RepoName,
  path: string,
): Promise<{ row: DraftRow; change: ChangeRow } | null> {
  const row = await env.DB.prepare(
    `SELECT d.* FROM upload_drafts d JOIN upload_changes c ON c.draft_id = d.id
     WHERE d.login = ? COLLATE NOCASE AND d.kind = 'edit' AND d.repo = ? AND c.path = ?
       AND d.${LIVE_SQL}
     ORDER BY d.created_at DESC LIMIT 1`,
  )
    .bind(login, repo, path)
    .first<DraftRow>()
  if (!row) return null
  const [change] = await changesOf(env, row.id)
  return change ? { row, change } : null
}

/**
 * Other members' live drafts of a file: "others are editing this page". Who sent one and when
 * shows; an unsent draft is a name and nothing else.
 */
async function othersEditing(env: Env, login: string, repo: RepoName, path: string) {
  const { results } = await env.DB.prepare(
    `SELECT d.id, d.login, d.author, d.kind, d.status, d.sent_at, d.due_at FROM upload_drafts d
     JOIN upload_changes c ON c.draft_id = d.id
     WHERE d.repo = ? AND (c.path = ? OR c.from_path = ?) AND d.login != ? COLLATE NOCASE
       AND d.${LIVE_SQL}
     ORDER BY d.updated_at DESC LIMIT 10`,
  )
    .bind(repo, path, path, login)
    .all<Pick<DraftRow, "id" | "login" | "author" | "kind" | "status" | "sent_at" | "due_at">>()
  return results.map(({ id, author, ...other }) => {
    const sent = other.sent_at !== null && (other.status === "open" || other.status === "review")
    return { ...other, author: sent ? author || other.login : null, draft: sent ? id : null }
  })
}

/** Refuse to change a draft held in a conflict: its author withdraws it first. */
async function notHeld(env: Env, row: DraftRow) {
  if (row.status !== "conflict") return
  if (await openConflictOf(env, row.id))
    throw new HttpError(
      409,
      "this change is waiting to be settled: withdraw it first to change it yourself",
    )
}

/**
 * What the vault's check would refuse in a page's text (its problems: saving keeps them, sending
 * refuses them) and why an admin must merge it (review). A public page's full check, against the
 * vault at main, is made when it is published (publish.ts).
 */
function checkEdit(repo: RepoName, path: string, text: string) {
  if (repo === "vault-private") return contentReport(path, text)
  return { problems: readPage(text).problems, review: null }
}

async function stagedText(env: Env, row: DraftRow, path: string): Promise<string> {
  const object = await env.ARTIFACTS.get(stagedKey(row.id, path))
  if (!object) throw new HttpError(409, "this draft's text is gone; discard it and start again")
  return object.text()
}

export async function editRoutes(
  request: Request,
  url: URL,
  env: Env,
  session: Session,
  record: Auditor,
  fetchers: Record<RepoName, RepoFetch>,
): Promise<Response | null> {
  const path = url.pathname
  if (path !== "/api/edit" && !path.startsWith("/api/edit/")) return null
  // Code in a member's lab can read its ticket; what reaches a vault comes from the site.
  if (session.lab) throw new HttpError(403, "pages are edited from the members site")
  // A page's repository: the public vault, vault-private, or the restricted vault mounted where
  // the page is (src/vaults.ts). An edit is one page, so its draft is in that page's repository.
  const repoOf = (name: RepoName, path: string) =>
    new DraftRepo(env, fetchers[name], name, name === "vault" ? PRIVATE_VAULT : vaultOf(path))
  const view = async (row: DraftRow) => {
    const changes = await changesOf(env, row.id)
    return draftView(draftRepoName(env, row, changes), row, changes)
  }
  // Restricted pages (src/acl/): a private page the member may not read is, for the editor, not in
  // the vault; writing one takes reading every path it touches.
  const mayRead = (name: RepoName, paths: string[], message = `${paths[0]} isn't in the vault`) =>
    name === "vault" ? Promise.resolve() : requireRead(env, session, paths, record, message)

  // A page's file at main, the member's own draft of it, and who else is editing it.
  if (path === "/api/edit/source" && request.method === "GET") {
    const name = repoParam(url.searchParams.get("repo"))
    const { path: file, kind } = editablePath(name, url.searchParams.get("path"))
    await mayRead(name, [file])
    // A folder's own page that isn't there yet (from its automatic folder page).
    const making = url.searchParams.get("new") === "1" ? newIndexPath(name, file) : null
    const repo = repoOf(name, file)
    const [main, mine, others, admin] = await Promise.all([
      repo.file(file),
      liveEdit(env, session.login, name, file),
      othersEditing(env, session.login, name, file),
      isAdmin(env, session),
    ])
    const viewer = { login: session.login, admin }
    // Open conflicts on this page: the member's own draft held in one, and those they may settle.
    const { results: open } = await env.DB.prepare(
      `${CONFLICT_SELECT} WHERE x.repo = ? AND x.path = ? AND x.state = 'open'
       ORDER BY x.opened_at LIMIT 20`,
    )
      .bind(name, file)
      .all<ConflictRow & { author: string | null; summary: string | null }>()
    const conflicts = open.map((row) => conflictView(row, viewer))
    if (!main && !mine && (!making || !(await repo.list(making.folder))))
      throw new HttpError(404, `${making ? making.folder : file} isn't in the vault`)
    const text = main ? decode(main.bytes, file) : null
    return json({
      repo: name,
      repo_name: repo.repo,
      path: file,
      kind,
      main: main ? { sha: main.sha, size: main.size, text } : null,
      // A new page's first text, until the member saves one.
      new: Boolean(making) && !main,
      template: making && !main ? indexTemplate(making.folder) : null,
      ...(await editAccess(env, session, name, file)),
      // Something in a private page runs (Quarto code cells, HTML): an admin merges it on GitHub.
      review: text === null || name === "vault" ? null : contentReport(file, text).review,
      draft: mine
        ? {
            ...(await view(mine.row)),
            base_sha: mine.change.base_sha,
            text: await stagedText(env, mine.row, file),
          }
        : null,
      others,
      conflict: conflicts.find((conflict) => conflict.draft === mine?.row.id) ?? null,
      to_settle: conflicts.filter((conflict) => conflict.can_settle),
      // When a draft sent now would go in: the end of the hour after this one.
      due_at: dueAt(Date.now()),
      github_url: `https://github.com/${repo.repo}/blob/main/${encodePath(file)}`,
    })
  }

  // A page as it was at a commit (restore), or as it is now without that commit's change (undo),
  // for the editor to open as a new draft: from a page's History. Nothing is saved here; a
  // revert is a normal draft, sent and checked like any other.
  if (path === "/api/edit/revert" && request.method === "GET") {
    const name = repoParam(url.searchParams.get("repo"))
    const { path: file, kind } = editablePath(name, url.searchParams.get("path"))
    const { rev, mode } = revertParam({
      rev: url.searchParams.get("rev"),
      mode: url.searchParams.get("mode"),
    })
    // A page renamed since: its version at the commit is under its old name.
    const from = url.searchParams.get("from")
    const then = from ? editablePath(name, from).path : file
    await mayRead(name, [file, then])
    if (mode === "undo" && kind === "ipynb")
      throw new HttpError(422, "a notebook's change can't be undone on its own: restore a version")
    const repo = repoOf(name, file)
    const [commit, at, main] = await Promise.all([
      repo.commitInfo(rev),
      repo.file(then, rev),
      repo.file(file),
    ])
    if (!commit || !at) throw new HttpError(404, "that version of the page isn't in the vault")
    if (!main) throw new HttpError(404, "the page isn't on main now, so it can't be reverted here")
    const atText = decode(at.bytes, then)
    const mainText = decode(main.bytes, file)
    let text = atText
    let clean = true
    if (mode === "undo") {
      const parent = commit.parents[0]
      const before = parent ? await repo.file(then, parent) : null
      if (!before)
        throw new HttpError(
          422,
          "that change made the page: there is nothing before it to go back to",
        )
      // Take that commit's change back out of the page as it is now, as `git revert` would.
      const merge = threeWay(atText, mainText, decode(before.bytes, then))
      clean = merge.clean
      text = clean ? merge.text : mainText
    }
    const by = commit.author.replace(/[@`<>[\]]/g, "").trim()
    return json({
      rev,
      mode,
      text,
      clean,
      base_sha: main.sha,
      summary: cleanSummary(
        `${mode === "restore" ? "revert to" : "undo"} ${rev.slice(0, 7)}${by ? ` by ${by}` : ""}`,
      ).toLowerCase(),
    })
  }

  // A new draft of a page: the text the member wrote, on the blob they loaded.
  if (path === "/api/edit/drafts" && request.method === "POST") {
    requireMutation(request, env)
    const body = (await readJson(request)) as Record<string, unknown>
    const name = repoParam(body.repo)
    const { path: file, kind } = editablePath(name, body.path)
    await mayRead(name, [file])
    const text = editText(body.text)
    // A folder's new page (index.md) has no base: it isn't in the vault yet.
    const making = body.new === true ? newIndexPath(name, file) : null
    const base = making ? null : blobSha(body.base_sha)
    const summary = cleanSummary(body.summary)
    // A revert from the page's History says what it restores or undoes.
    const revert =
      body.revert === undefined || body.revert === null ? null : revertParam(body.revert)
    const repo = repoOf(name, file)
    if (!repo.ready) throw new HttpError(503, "editing isn't set up yet: ask an admin")
    const access = await editAccess(env, session, name, file)
    if (!access.can_edit) throw new HttpError(403, access.why ?? "you can't edit this page")
    const existing = await liveEdit(env, session.login, name, file)
    if (existing)
      return json({ detail: "you already have a draft of this page", draft: existing.row.id }, 409)
    const open = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM upload_drafts
       WHERE login = ? COLLATE NOCASE AND kind = 'edit' AND ${LIVE_SQL}`,
    )
      .bind(session.login)
      .first<{ n: number }>()
    if ((open?.n ?? 0) >= EDIT_DRAFTS_MAX)
      throw new HttpError(
        409,
        `you have ${EDIT_DRAFTS_MAX} page edits open; send or discard one first`,
      )
    await underLimit(env, session.login, ["edit.create", "edit.save"], SAVES_PER_DAY, "saves")
    // The base is a version of a file the vault holds: main's, or an older one the member's
    // page was built from. A made-up base would hide what changed since.
    if (making) {
      if (await repo.file(file))
        throw new HttpError(409, "this page is in the vault now: open it and edit that")
      if (!(await repo.list(making.folder)))
        throw new HttpError(404, `${making.folder} isn't a folder of the vault`)
    } else if ((await repo.file(file))?.sha !== base && !(await repo.blobBytes(base!)))
      throw new HttpError(409, "that isn't a version of this page; load it again")
    const report = checkEdit(name, file, text)
    const id = [...crypto.getRandomValues(new Uint8Array(6))]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("")
    const now = Date.now()
    await env.ARTIFACTS.put(stagedKey(id, file), text, {
      httpMetadata: { contentType: CONTENT_TYPES[kind] },
    })
    // One live edit of a page per member: two first saves at once (two tabs, two devices) make
    // one draft, not two that would later overwrite each other. The check above is for the
    // message; this one is in the same statement as the insert.
    const [inserted] = await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO upload_drafts
           (id, login, repo, kind, summary, note, created_at, edited_at, updated_at, revert_json)
         SELECT ?1, ?2, ?3, 'edit', ?4, '', ?5, ?5, ?5, ?7
         WHERE NOT EXISTS (
           SELECT 1 FROM upload_drafts d JOIN upload_changes c ON c.draft_id = d.id
           WHERE d.login = ?2 COLLATE NOCASE AND d.kind = 'edit' AND d.repo = ?3 AND c.path = ?6
             AND d.${LIVE_SQL})`,
      ).bind(id, session.login, name, summary, now, file, revert && JSON.stringify(revert)),
      env.DB.prepare(
        `INSERT INTO upload_changes
           (draft_id, path, action, from_path, base_sha, size, content_type, review, staged_at)
         SELECT ?1, ?2, ?8, NULL, ?3, ?4, ?5, ?6, ?7
         WHERE EXISTS (SELECT 1 FROM upload_drafts WHERE id = ?1)`,
      ).bind(
        id,
        file,
        base,
        new TextEncoder().encode(text).length,
        CONTENT_TYPES[kind],
        report.review,
        now,
        making ? "add" : "replace",
      ),
    ])
    if (!inserted.meta.changes) {
      await env.ARTIFACTS.delete(stagedKey(id, file))
      const other = await liveEdit(env, session.login, name, file)
      return json({ detail: "you already have a draft of this page", draft: other?.row.id }, 409)
    }
    record("edit.create", file, { draft: id, repo: name, ...(revert ? { revert } : {}) })
    if (revert) record("edit.revert", file, { draft: id, repo: name, ...revert })
    const row = (await draftRow(env, id))!
    return json({ ...(await view(row)), base_sha: base, problems: report.problems }, 201)
  }

  const conflictMatch = path.match(CONFLICT)
  if (conflictMatch) return conflictRoutes(request, env, session, record, conflictMatch, repoOf)

  // Conflicts the member is in: theirs held (role=mine), those they may settle (first), and for
  // admins every open one (all). The counts are for the lists' badges.
  if (path === "/api/edit/conflicts" && request.method === "GET") {
    const admin = await isAdmin(env, session)
    const role = url.searchParams.get("role") ?? "mine"
    if (!["mine", "first", "all"].includes(role) || (role === "all" && !admin))
      throw new HttpError(422, "role must be mine, first or (for admins) all")
    const me = session.login
    const where = {
      mine: "x.login = ?1 COLLATE NOCASE",
      first: admin
        ? "(x.first_login = ?1 COLLATE NOCASE OR x.login != ?1 COLLATE NOCASE)"
        : "x.first_login = ?1 COLLATE NOCASE",
      all: "?1 IS NOT NULL",
    }
    const { results } = await env.DB.prepare(
      `${CONFLICT_SELECT} WHERE x.state = 'open' AND ${where[role as keyof typeof where]}
       ORDER BY x.opened_at LIMIT 100`,
    )
      .bind(me)
      .all<ConflictRow & { author: string | null; summary: string | null }>()
    // Conflicts over pages the member may not read aren't theirs to see, nor to count.
    const acl = await aclViewer(env, session)
    const shown = (row: { repo: string; path: string }) =>
      row.repo === "vault" || acl.canRead(row.path)
    const { results: counted } = await env.DB.prepare(
      `SELECT x.repo, x.path, ${where.mine} AS mine, ${where.first} AS first
       FROM edit_conflicts x WHERE x.state = 'open' AND (${where.mine} OR ${where.first})`,
    )
      .bind(me)
      .all<{ repo: string; path: string; mine: number; first: number }>()
    const counts = counted.filter(shown)
    return json({
      conflicts: results.filter(shown).map((row) => conflictView(row, { login: me, admin })),
      counts: {
        mine: counts.filter((row) => row.mine).length,
        first: counts.filter((row) => row.first).length,
      },
    })
  }

  const match = path.match(DRAFT)
  if (!match) throw new HttpError(404, "not found")
  const [, id, part] = match

  // The member's draft (an admin may look at anyone's) with its text and base.
  if (!part && request.method === "GET") {
    const row = await ownDraft(env, id, session, { kind: "edit" })
    const [change] = await changesOf(env, row.id)
    if (change) await mayRead(row.repo, [change.path], "no such draft")
    const shown = await view(row)
    return json({
      ...shown,
      base_sha: change?.base_sha ?? null,
      // A settled draft's text is gone: merged, it is main's; discarded, it is dropped.
      text: change && LIVE.includes(row.status) ? await stagedText(env, row, change.path) : null,
    })
  }

  // Save a new version of the text or summary, or move the draft's base to main's version of
  // the page (once the member has taken in what changed there).
  if (!part && request.method === "PUT") {
    requireMutation(request, env)
    const row = await ownDraft(env, id, session, { change: true, kind: "edit" })
    await notHeld(env, row)
    const [change] = await changesOf(env, row.id)
    await mayRead(row.repo, [change.path], "no such draft")
    const body = (await readJson(request)) as Record<string, unknown>
    const access = await editAccess(env, session, row.repo, change.path)
    if (!access.can_edit) throw new HttpError(403, access.why ?? "you can't edit this page")
    await underLimit(env, session.login, ["edit.create", "edit.save"], SAVES_PER_DAY, "saves")
    const now = Date.now()
    // Everything is checked before anything is kept: a save refused in part changes nothing.
    const text = "text" in body ? editText(body.text) : null
    const summary = "summary" in body ? cleanSummary(body.summary) : null
    const base = "base_sha" in body ? blobSha(body.base_sha) : null
    const stackOn = "stack_on" in body ? draftId(body.stack_on) : null
    if (text === null && summary === null && base === null && stackOn === null)
      throw new HttpError(422, "send the text, the summary, a base_sha or stack_on")
    if (base !== null && stackOn !== null)
      throw new HttpError(422, "a draft is made on main's version or on another change, not both")
    // A save names the version it was typed over: one made over an older version (a stale tab,
    // another device) is refused with the newer text, so it is never overwritten unseen.
    if ("version" in body && body.version !== row.version)
      return json(
        {
          detail: "you saved a newer version of this draft somewhere else",
          kind: "stale",
          text: await stagedText(env, row, change.path),
          summary: row.summary,
          version: row.version,
          edited_at: row.edited_at,
        },
        409,
      )
    // Moving the base to main's version says the member took in what changed there. Whether
    // their text is what a line-by-line merge gives is recorded (edit.rebase), so a change of
    // someone else's that was dropped on the way shows in the audit log.
    let rebase: { from: string | null; to: string; clean: boolean } | null = null
    if (base !== null) {
      const repo = repoOf(row.repo, change.path)
      const main = await repo.file(change.path)
      if (main?.sha !== base)
        throw new HttpError(409, "that isn't main's version of the page; load it again")
      if (base !== change.base_sha) {
        const before = await baseText(env, repo, row, change)
        const mine = await stagedText(env, row, change.path)
        const merged =
          before === null ? null : threeWay(before, decode(main.bytes, change.path), mine)
        rebase = {
          from: change.base_sha,
          to: base,
          clean: Boolean(merged?.clean) && (text ?? mine) === merged!.text,
        }
      }
    }
    // Edit on top of another member's sent change to the page: its text becomes this draft's
    // base, kept beside it, and this draft goes in after it (conflicts.ts firstState).
    let stacked: { on: string; text: string; sha: string } | null = null
    if (stackOn !== null) {
      const first = await draftRow(env, stackOn)
      const [theirs] = first ? await changesOf(env, first.id) : []
      if (
        !first ||
        first.kind !== "edit" ||
        first.repo !== row.repo ||
        theirs?.path !== change.path ||
        first.login.toLowerCase() === session.login.toLowerCase() ||
        // Made on top of this one: stacking this on it would make each wait for the other.
        first.after_draft === row.id ||
        !(first.status === "open" || first.status === "review") ||
        first.sent_at === null
      )
        throw new HttpError(409, "that isn't a sent change to this page")
      const their = await sentText(env, repoOf(row.repo, change.path), first, change.path)
      if (their === null) throw new HttpError(409, "that change's text is gone")
      // The member built on the version they were shown: if its author sent a new one since,
      // this draft would drop what that one added.
      const sha = await gitBlobSha(their)
      if (body.stack_sha !== sha)
        throw new HttpError(
          409,
          "they changed their version since you looked: send yours again to see their new one",
        )
      stacked = { on: first.id, text: their, sha }
    }
    const statements: D1PreparedStatement[] = []
    let problems: string[] = []
    if (text !== null) {
      const report = checkEdit(row.repo, change.path, text)
      problems = report.problems
      await env.ARTIFACTS.put(stagedKey(row.id, change.path), text, {
        httpMetadata: { contentType: change.content_type ?? "text/plain; charset=utf-8" },
      })
      statements.push(
        env.DB.prepare(
          `UPDATE upload_changes SET size = ?, review = ?, staged_at = ?
           WHERE draft_id = ? AND path = ?`,
        ).bind(new TextEncoder().encode(text).length, report.review, now, row.id, change.path),
      )
    }
    if (summary !== null)
      statements.push(
        env.DB.prepare("UPDATE upload_drafts SET summary = ? WHERE id = ?").bind(summary, row.id),
      )
    if (base !== null || stacked !== null)
      statements.push(
        env.DB.prepare(
          "UPDATE upload_changes SET base_sha = ? WHERE draft_id = ? AND path = ?",
        ).bind(stacked?.sha ?? base, row.id, change.path),
        env.DB.prepare("UPDATE upload_drafts SET after_draft = ? WHERE id = ?").bind(
          stacked?.on ?? null,
          row.id,
        ),
      )
    if (stacked !== null)
      await env.ARTIFACTS.put(baseKey(row.id, change.path), stacked.text, {
        httpMetadata: { contentType: change.content_type ?? "text/plain; charset=utf-8" },
      })
    else if (base !== null) await env.ARTIFACTS.delete(baseKey(row.id, change.path))
    statements.push(
      env.DB.prepare(
        "UPDATE upload_drafts SET edited_at = ?, updated_at = ?, version = version + 1 WHERE id = ?",
      ).bind(now, now, row.id),
    )
    await env.DB.batch(statements)
    record("edit.save", change.path, { draft: row.id, fields: Object.keys(body) })
    if (rebase) record("edit.rebase", change.path, { draft: row.id, ...rebase })
    if (stacked) record("edit.stack", change.path, { draft: row.id, on: stacked.on })
    const [saved] = await changesOf(env, row.id)
    return json({
      ...(await view((await draftRow(env, row.id))!)),
      base_sha: saved.base_sha,
      problems,
    })
  }

  // Send the draft: a private page's becomes a pull request on vault-private, a public page's
  // goes into the public vault; either at the end of the hour after this one.
  if (part === "send" && request.method === "POST") {
    requireMutation(request, env)
    const row = await ownDraft(env, id, session, { change: true, kind: "edit" })
    await notHeld(env, row)
    const changes = await changesOf(env, row.id)
    const [change] = changes
    await mayRead(row.repo, [change.path], "no such draft")
    if (!row.summary) throw new HttpError(422, "say in a line what you changed, then send it")
    const access = await editAccess(env, session, row.repo, change.path)
    if (!access.can_edit) throw new HttpError(403, access.why ?? "you can't edit this page")
    const text = await stagedText(env, row, change.path)
    const report = checkEdit(row.repo, change.path, text)
    if (report.problems.length) throw new HttpError(422, report.problems.join("; "))
    await underLimit(env, session.login, ["uploads.send", "edit.send"], SENDS_PER_DAY, "sends")
    const repo = repoOf(row.repo, change.path)
    const { display_name } = await navIdentity(env, session)
    // Main as it is now: a page that changed there since the member loaded it comes back merged
    // with their text, or with what changed for them to take in (conflicts.ts).
    const check = await checkSend(env, repo, row, change, text, access)
    if (check.kind !== "ok")
      return json(refusal(check, row.repo === "vault" ? "publish" : "send"), 409)
    if (check.mainText === text)
      throw new HttpError(422, "nothing changed: the page is the same as on main")
    if (row.repo === "vault") {
      const author = plainName(display_name, session.login)
      await publishEdit(env, repo, row, change, text, { ...access, author, base: check.mainText })
      const published = await view((await draftRow(env, row.id))!)
      record("edit.send", change.path, {
        draft: row.id,
        repo: "vault",
        due_at: published.due_at,
        revision: row.sent_at !== null,
      })
      return json({ ...published, beside: check.beside })
    }
    await send(env, repo, row, changes, display_name)
    const sent = await view((await draftRow(env, row.id))!)
    record("edit.send", change.path, {
      draft: row.id,
      pull: sent.pull?.number,
      due_at: sent.due_at,
      revision: row.sent_at !== null,
    })
    return json({ ...sent, beside: check.beside })
  }

  // Queue the draft for review: it conflicts with another member's sent change (or with main),
  // and waits, held, until the first editor or an admin settles it. The Worker finds the overlap
  // itself; nothing in the request says what it conflicts with. A private draft's pull request, if
  // it has one, closes meanwhile: settling it sends it again.
  if (part === "queue" && request.method === "POST") {
    requireMutation(request, env)
    const row = await ownDraft(env, id, session, { change: true, kind: "edit" })
    await notHeld(env, row)
    const [change] = await changesOf(env, row.id)
    await mayRead(row.repo, [change.path], "no such draft")
    if (!row.summary) throw new HttpError(422, "say in a line what you changed, then queue it")
    const access = await editAccess(env, session, row.repo, change.path)
    if (!access.can_edit) throw new HttpError(403, access.why ?? "you can't edit this page")
    const text = await stagedText(env, row, change.path)
    const report = checkEdit(row.repo, change.path, text)
    if (report.problems.length) throw new HttpError(422, report.problems.join("; "))
    await underLimit(
      env,
      session.login,
      ["uploads.send", "edit.send", "edit.conflict.queue"],
      SENDS_PER_DAY,
      "sends",
    )
    const held = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM edit_conflicts WHERE login = ? COLLATE NOCASE AND state = 'open'",
    )
      .bind(session.login)
      .first<{ n: number }>()
    if ((held?.n ?? 0) >= CONFLICTS_OPEN_MAX)
      throw new HttpError(
        429,
        `you have ${CONFLICTS_OPEN_MAX} changes waiting to be settled; withdraw one first`,
      )
    const repo = repoOf(row.repo, change.path)
    const check = await checkSend(env, repo, row, change, text, access)
    if (check.kind !== "pending" && check.kind !== "main")
      throw new HttpError(
        409,
        check.kind === "moved"
          ? "the page was moved or deleted on main: there is nothing to settle it with"
          : "nothing conflicts with this change now: send it",
      )
    const { display_name } = await navIdentity(env, session)
    const author = plainName(display_name, session.login)
    if (row.pr_number) {
      const pull = await repo.pull(row.pr_number)
      if (pull.state === "open") await repo.updatePull(row.pr_number, { state: "closed" })
    }
    if (row.branch) await repo.deleteBranch(row.branch)
    const now = Date.now()
    const conflict = newId()
    const first =
      check.kind === "pending"
        ? { id: check.with.draft, login: check.with.login, author: check.with.author }
        : null
    const title = editTitle(change.path, author, row.summary)
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE upload_drafts SET status = 'conflict', title = ?, author = ?, detail_json = ?,
           branch = NULL, pr_number = NULL, head_sha = NULL, updated_at = ?
         WHERE id = ?`,
      ).bind(
        title,
        author,
        JSON.stringify({
          message: `waiting to be settled by ${first ? `${first.author} or ` : ""}an admin`,
        }),
        now,
        row.id,
      ),
      openConflict(env, {
        id: conflict,
        repo: row.repo,
        path: change.path,
        draft: row.id,
        login: session.login,
        first,
        blob: check.kind === "main" ? check.incoming.sha : null,
        reason: check.kind,
        now,
      }),
      // The site's recent changes (src/changes.ts): the page's change, waiting to be settled.
      unsentChanges(env, row.id),
      recordChanges(
        env,
        draftChanges(row, [change], { at: now, author, summary: title, pull: null }).map(
          (item) => ({ ...item, state: "conflict" as const }),
        ),
      ),
    ])
    record("edit.conflict.queue", change.path, {
      draft: row.id,
      conflict,
      reason: check.kind,
      first: first?.login ?? null,
    })
    const held2 = await openConflictOf(env, row.id)
    return json({
      draft: await view((await draftRow(env, row.id))!),
      conflict: held2 && conflictView(held2, { login: session.login, admin: access.admin }),
    })
  }

  // Take the draft back: its pull request (if any) closes and its text is dropped.
  if (!part && request.method === "DELETE") {
    requireMutation(request, env)
    const row = await ownDraft(env, id, session, { change: true, kind: "edit" })
    const [change] = await changesOf(env, row.id)
    await discard(env, repoOf(row.repo, change?.path ?? ""), row, "discarded by its author")
    record("edit.discard", row.id, { pull: row.pr_number })
    return json(await view((await draftRow(env, row.id))!))
  }

  throw new HttpError(405, "method not allowed")
}

/** A conflict the viewer may see: its two editors and admins. Anyone else is told it isn't there. */
async function visibleConflict(env: Env, session: Session, id: string) {
  const row = await env.DB.prepare(`${CONFLICT_SELECT} WHERE x.id = ?`)
    .bind(id)
    .first<ConflictRow & { author: string | null; summary: string | null }>()
  const admin = await isAdmin(env, session)
  const me = session.login.toLowerCase()
  if (!row || (!admin && row.login.toLowerCase() !== me && row.first_login?.toLowerCase() !== me))
    throw new HttpError(404, "no such conflict")
  // Nor a conflict over a page the member may not read (src/acl/): neither text shows.
  if (row.repo !== "vault" && !(await aclViewer(env, session)).canRead(row.path))
    throw new HttpError(404, "no such conflict")
  return { row, admin, view: conflictView(row, { login: session.login, admin }) }
}

/**
 * The texts of a conflict: the version the second change was made from, the first change's (its
 * sent text while it waits, else main's), the second's as held, and the two merged with the
 * second's lines where both changed the same ones.
 */
async function conflictTexts(env: Env, repo: DraftRepo, row: ConflictRow) {
  const second = (await draftRow(env, row.draft_id))!
  const [change] = await changesOf(env, second.id)
  const firstRow = row.first_draft_id ? await draftRow(env, row.first_draft_id) : null
  const waiting = firstRow && (firstRow.status === "open" || firstRow.status === "review")
  const pending = waiting ? await sentText(env, repo, firstRow, row.path) : null
  const main = pending === null ? await repo.file(row.path) : null
  const first = pending ?? (main ? decode(main.bytes, row.path) : null)
  if (first === null)
    throw new HttpError(409, "the page was moved or deleted on main: there is nothing to settle")
  const secondText = await stagedText(env, second, row.path)
  const base = (await baseText(env, repo, second, change)) ?? first
  const merge = mergeable(row.path) ? threeWay(base, first, secondText) : null
  return {
    second,
    change,
    // What a settled draft is made on: the first change while it waits, else main's version.
    on: pending !== null ? { draft: firstRow!.id, text: first } : { sha: main!.sha, text: first },
    texts: {
      base_text: base,
      first_text: first,
      second_text: secondText,
      proposed: merge?.text ?? secondText,
      clean: merge?.clean ?? false,
    },
  }
}

async function conflictRoutes(
  request: Request,
  env: Env,
  session: Session,
  record: Auditor,
  [, id, part]: RegExpMatchArray,
  repoOf: (name: RepoName, path: string) => DraftRepo,
): Promise<Response> {
  // The two changes and a proposed merge, for the settle view (/edit?conflict=<id>): its two
  // editors and admins only.
  if (!part && request.method === "GET") {
    const { row, view } = await visibleConflict(env, session, id)
    if (row.state !== "open") return json({ conflict: view, due_at: null })
    const { texts } = await conflictTexts(env, repoOf(row.repo, row.path), row)
    return json({
      conflict: view,
      ...texts,
      // A settlement names the first change's version it was made against (first_sha).
      first_sha: await gitBlobSha(texts.first_text),
      due_at: dueAt(Date.now()),
    })
  }

  // Settle it: keep the first change (the second goes back to its author), take the second
  // where both changed the same lines, or a merged text. Only the first editor or an admin, and
  // never the second editor on their own conflict, even an admin.
  if (part === "resolve" && request.method === "POST") {
    requireMutation(request, env)
    const { row, view, admin } = await visibleConflict(env, session, id)
    const me = session.login.toLowerCase()
    if (row.login.toLowerCase() === me && row.first_login?.toLowerCase() !== me)
      throw new HttpError(403, "you can't settle a conflict with your own change")
    if (!view.can_settle)
      throw new HttpError(
        row.state === "open" ? 403 : 409,
        row.state === "open"
          ? "only the member who sent the first change or an admin can settle this"
          : "this conflict is settled already",
      )
    const body = (await readJson(request)) as Record<string, unknown>
    const choice = body.choice
    if (choice !== "first" && choice !== "second" && choice !== "merged")
      throw new HttpError(422, "choice must be first, second or merged")
    const repo = repoOf(row.repo, row.path)
    const { display_name } = await navIdentity(env, session)
    const settler = plainName(display_name, session.login)
    const now = Date.now()
    // One settles it: a second answer (another admin, the first editor) finds it taken.
    const claim = async () => {
      const claimed = await env.DB.prepare(
        `UPDATE edit_conflicts SET resolved_by = ?, resolved_at = ? WHERE id = ? AND state = 'open'
           AND ${UNCLAIMED}`,
      )
        .bind(session.login, now, row.id, now - CLAIM_MS)
        .run()
      if (!claimed.meta.changes) throw new HttpError(409, "this conflict is settled already")
    }
    const release = () =>
      // Only this settlement's own mark, not one a later settlement made after it lapsed.
      env.DB.prepare(
        `UPDATE edit_conflicts SET resolved_by = NULL, resolved_at = NULL
         WHERE id = ? AND state = 'open' AND resolved_by = ? AND resolved_at = ?`,
      )
        .bind(row.id, session.login, now)
        .run()
    const finish = (state: "resolved" | "rejected") =>
      env.DB.prepare(
        `UPDATE edit_conflicts SET state = ?, resolution = ?, resolved_at = ?
         WHERE id = ? AND state = 'open' AND resolved_by = ? AND resolved_at = ?`,
      ).bind(state, choice, now, row.id, session.login, now)

    if (choice === "first") {
      await claim()
      await env.DB.batch([
        finish("rejected"),
        env.DB.prepare(
          `UPDATE upload_drafts SET status = 'editing', detail_json = ?, updated_at = ?
           WHERE id = ? AND status = 'conflict'`,
        ).bind(
          JSON.stringify({
            message: `${settler} kept the first change: yours is a draft again, with your text`,
          }),
          now,
          row.draft_id,
        ),
        unsentChanges(env, row.draft_id),
      ])
      record("edit.conflict.resolve", row.path, {
        conflict: row.id,
        choice,
        first: row.first_login,
        second: row.login,
      })
      return json({ conflict: { ...view, state: "rejected", can_settle: false } })
    }

    const { second, change, on, texts } = await conflictTexts(env, repo, row)
    // Settled against the first change's version the settler saw: if its author sent a new one
    // since, a merged text made from the old one would drop what the new one added.
    if (body.first_sha !== (await gitBlobSha(texts.first_text)))
      throw new HttpError(
        409,
        "the first change is different now: load the conflict again to see its newest version",
      )
    const text = choice === "second" ? texts.proposed : editText(body.text)
    // Checked as any edit of the page is, against the first change's text, with the settler's
    // own rights: a member who settles adds nothing only an admin may add, whoever wrote it.
    const rights = admin
    const problems =
      row.repo === "vault-private"
        ? contentReport(row.path, text).problems
        : [
            ...pageProblems(text, texts.first_text, rights),
            ...(await vaultProblems(
              row.path,
              text,
              texts.first_text,
              vaultView(repo, await repo.tree((await repo.head()).tree)),
            )),
          ]
    if (problems.length) throw new HttpError(422, `this text can't go in: ${problems.join("; ")}`)
    if (text === texts.first_text)
      throw new HttpError(422, "that is the first change's text: keep the first change instead")
    await claim()
    try {
      // Still held: a draft taken back meanwhile is its author's again, and isn't sent.
      if ((await draftRow(env, second.id))?.status !== "conflict")
        throw new HttpError(409, "this change was taken back by its author")
      const summary = cleanSummary(`${second.summary ?? ""} (settled by ${settler})`.slice(-120))
      const author = second.author || second.login
      await env.ARTIFACTS.put(stagedKey(second.id, row.path), text, {
        httpMetadata: { contentType: change.content_type ?? "text/plain; charset=utf-8" },
      })
      const stacked = "draft" in on
      if (stacked) await env.ARTIFACTS.put(baseKey(second.id, row.path), on.text)
      else await env.ARTIFACTS.delete(baseKey(second.id, row.path))
      const base = stacked ? await gitBlobSha(on.text) : on.sha
      const after = stacked ? on.draft : null
      await env.DB.batch([
        env.DB.prepare(
          `UPDATE upload_changes SET base_sha = ?, size = ?, review = ?, staged_at = ?
           WHERE draft_id = ? AND path = ?`,
        ).bind(
          base,
          new TextEncoder().encode(text).length,
          // Why an admin merges it, for the text as settled: the hourly run trusts this.
          checkEdit(row.repo, row.path, text).review,
          now,
          second.id,
          row.path,
        ),
        env.DB.prepare(
          `UPDATE upload_drafts SET after_draft = ?, edited_at = ?, version = version + 1
           WHERE id = ?`,
        ).bind(after, now, second.id),
      ])
      const settled: DraftRow = { ...second, summary, after_draft: after ?? null, edited_at: now }
      const [staged] = await changesOf(env, second.id)
      if (row.repo === "vault") {
        const title = editTitle(row.path, author, summary)
        await env.ARTIFACTS.put(publishedKey(second.id, row.path), text, {
          httpMetadata: { contentType: change.content_type ?? "text/markdown; charset=utf-8" },
        })
        const [opened] = await env.DB.batch([
          env.DB.prepare(
            `UPDATE upload_drafts SET status = 'open', title = ?, detail_json = NULL, sent_at = ?,
               due_at = ?, updated_at = ?
             WHERE id = ? AND status = 'conflict'`,
          ).bind(title, now, dueAt(now), now, second.id),
          unsentChanges(env, second.id),
          recordChanges(
            env,
            draftChanges(settled, [staged], { at: now, author, summary: title, pull: null }),
          ),
        ])
        if (!opened.meta.changes)
          throw new HttpError(409, "this change was taken back by its author")
      } else await send(env, repo, settled, [staged], author, now)
      const [finished] = await env.DB.batch([finish("resolved")])
      if (!finished.meta.changes) throw new HttpError(409, "this conflict is settled already")
    } catch (error) {
      await release()
      throw error
    }
    record("edit.conflict.resolve", row.path, {
      conflict: row.id,
      choice,
      first: row.first_login,
      second: row.login,
    })
    const draft = (await draftRow(env, row.draft_id))!
    return json({
      conflict: { ...view, state: "resolved", resolution: choice, can_settle: false },
      draft: draftView(
        draftRepoName(env, draft, await changesOf(env, draft.id)),
        draft,
        await changesOf(env, draft.id),
      ),
    })
  }

  // The second editor takes their change back: it is their draft again, unsent.
  if (part === "withdraw" && request.method === "POST") {
    requireMutation(request, env)
    const { row, view } = await visibleConflict(env, session, id)
    if (row.login.toLowerCase() !== session.login.toLowerCase())
      throw new HttpError(403, "only the member who sent this change can withdraw it")
    if (row.state !== "open") throw new HttpError(409, "this conflict is settled already")
    const now = Date.now()
    const [closed] = await env.DB.batch([
      env.DB.prepare(
        `UPDATE edit_conflicts SET state = 'withdrawn', resolved_by = ?, resolved_at = ?
         WHERE id = ? AND state = 'open' AND ${UNCLAIMED}`,
      ).bind(session.login, now, row.id, now - CLAIM_MS),
      env.DB.prepare(
        `UPDATE upload_drafts SET status = 'editing', detail_json = NULL, updated_at = ?
         WHERE id = ? AND status = 'conflict'
           AND EXISTS (SELECT 1 FROM edit_conflicts WHERE id = ? AND state = 'withdrawn'
                         AND resolved_at = ?)`,
      ).bind(now, row.draft_id, row.id, now),
      unsentAfter(env, row.draft_id, row.id, "withdrawn", now),
    ])
    if (!closed.meta.changes)
      throw new HttpError(409, "this conflict is being settled or is settled already")
    record("edit.conflict.withdraw", row.path, { conflict: row.id, draft: row.draft_id })
    const draft = (await draftRow(env, row.draft_id))!
    return json({
      conflict: { ...view, state: "withdrawn", can_settle: false, can_withdraw: false },
      draft: draftView(
        draftRepoName(env, draft, await changesOf(env, draft.id)),
        draft,
        await changesOf(env, draft.id),
      ),
    })
  }
  throw new HttpError(405, "method not allowed")
}
