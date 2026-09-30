import type { Auditor } from "../audit"
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
  send,
  stagedKey,
} from "../uploads/drafts"
import { DraftRepo, REPO_NAMES, type RepoName } from "../uploads/github"
import { SENDS_PER_DAY, ownDraft, underLimit } from "../uploads/routes"
import { readPage } from "./public"
import { publishEdit } from "./publish"
import {
  type EditKind,
  blobSha,
  cleanSummary,
  contentReport,
  editAccess,
  editText,
  editablePath,
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

const DRAFT = /^\/api\/edit\/drafts\/([0-9a-f]{12})(?:\/(send))?$/
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true })

const CONTENT_TYPES: Record<EditKind, string> = {
  md: "text/markdown; charset=utf-8",
  qmd: "text/markdown; charset=utf-8",
  ipynb: "application/x-ipynb+json",
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

/** Other members' live drafts of a file: "others are editing this page". */
async function othersEditing(env: Env, login: string, repo: RepoName, path: string) {
  const { results } = await env.DB.prepare(
    `SELECT d.login, d.kind, d.status, d.sent_at, d.due_at FROM upload_drafts d
     JOIN upload_changes c ON c.draft_id = d.id
     WHERE d.repo = ? AND (c.path = ? OR c.from_path = ?) AND d.login != ? COLLATE NOCASE
       AND d.${LIVE_SQL}
     ORDER BY d.updated_at DESC LIMIT 10`,
  )
    .bind(repo, path, path, login)
    .all<Pick<DraftRow, "login" | "kind" | "status" | "sent_at" | "due_at">>()
  return results
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
  const repoOf = (name: RepoName) => new DraftRepo(env, fetchers[name], name)
  const view = async (row: DraftRow) =>
    draftView(repoOf(row.repo).repo, row, await changesOf(env, row.id))

  // A page's file at main, the member's own draft of it, and who else is editing it.
  if (path === "/api/edit/source" && request.method === "GET") {
    const name = repoParam(url.searchParams.get("repo"))
    const { path: file, kind } = editablePath(name, url.searchParams.get("path"))
    const repo = repoOf(name)
    const [main, mine, others] = await Promise.all([
      repo.file(file),
      liveEdit(env, session.login, name, file),
      othersEditing(env, session.login, name, file),
    ])
    if (!main && !mine) throw new HttpError(404, `${file} isn't in the vault`)
    const text = main ? decode(main.bytes, file) : null
    return json({
      repo: name,
      repo_name: repo.repo,
      path: file,
      kind,
      main: main ? { sha: main.sha, size: main.size, text } : null,
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
      // When a draft sent now would go in: the end of the hour after this one.
      due_at: dueAt(Date.now()),
      github_url: `https://github.com/${repo.repo}/blob/main/${encodePath(file)}`,
    })
  }

  // A new draft of a page: the text the member wrote, on the blob they loaded.
  if (path === "/api/edit/drafts" && request.method === "POST") {
    requireMutation(request, env)
    const body = (await readJson(request)) as Record<string, unknown>
    const name = repoParam(body.repo)
    const { path: file, kind } = editablePath(name, body.path)
    const text = editText(body.text)
    const base = blobSha(body.base_sha)
    const summary = cleanSummary(body.summary)
    const repo = repoOf(name)
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
    const report = checkEdit(name, file, text)
    const id = [...crypto.getRandomValues(new Uint8Array(6))]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("")
    const now = Date.now()
    await env.ARTIFACTS.put(stagedKey(id, file), text, {
      httpMetadata: { contentType: CONTENT_TYPES[kind] },
    })
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO upload_drafts
           (id, login, repo, kind, summary, note, created_at, edited_at, updated_at)
         VALUES (?, ?, ?, 'edit', ?, '', ?, ?, ?)`,
      ).bind(id, session.login, name, summary, now, now, now),
      env.DB.prepare(
        `INSERT INTO upload_changes
           (draft_id, path, action, from_path, base_sha, size, content_type, review, staged_at)
         VALUES (?, ?, 'replace', NULL, ?, ?, ?, ?, ?)`,
      ).bind(
        id,
        file,
        base,
        new TextEncoder().encode(text).length,
        CONTENT_TYPES[kind],
        report.review,
        now,
      ),
    ])
    record("edit.create", file, { draft: id, repo: name })
    const row = (await draftRow(env, id))!
    return json({ ...(await view(row)), base_sha: base, problems: report.problems }, 201)
  }

  const match = path.match(DRAFT)
  if (!match) throw new HttpError(404, "not found")
  const [, id, part] = match

  // The member's draft (an admin may look at anyone's) with its text and base.
  if (!part && request.method === "GET") {
    const row = await ownDraft(env, id, session, { kind: "edit" })
    const [change] = await changesOf(env, row.id)
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
    const [change] = await changesOf(env, row.id)
    const body = (await readJson(request)) as Record<string, unknown>
    const access = await editAccess(env, session, row.repo, change.path)
    if (!access.can_edit) throw new HttpError(403, access.why ?? "you can't edit this page")
    await underLimit(env, session.login, ["edit.create", "edit.save"], SAVES_PER_DAY, "saves")
    const now = Date.now()
    const statements: D1PreparedStatement[] = []
    let problems: string[] = []
    if ("text" in body) {
      const text = editText(body.text)
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
    if ("summary" in body)
      statements.push(
        env.DB.prepare("UPDATE upload_drafts SET summary = ? WHERE id = ?").bind(
          cleanSummary(body.summary),
          row.id,
        ),
      )
    if ("base_sha" in body) {
      const base = blobSha(body.base_sha)
      const main = await repoOf(row.repo).file(change.path)
      if (main?.sha !== base)
        throw new HttpError(409, "that isn't main's version of the page; load it again")
      statements.push(
        env.DB.prepare(
          "UPDATE upload_changes SET base_sha = ? WHERE draft_id = ? AND path = ?",
        ).bind(base, row.id, change.path),
      )
    }
    if (!statements.length) throw new HttpError(422, "send the text, the summary or a base_sha")
    statements.push(
      env.DB.prepare("UPDATE upload_drafts SET edited_at = ?, updated_at = ? WHERE id = ?").bind(
        now,
        now,
        row.id,
      ),
    )
    await env.DB.batch(statements)
    record("edit.save", change.path, { draft: row.id, fields: Object.keys(body) })
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
    const changes = await changesOf(env, row.id)
    const [change] = changes
    if (!row.summary) throw new HttpError(422, "say in a line what you changed, then send it")
    const access = await editAccess(env, session, row.repo, change.path)
    if (!access.can_edit) throw new HttpError(403, access.why ?? "you can't edit this page")
    const text = await stagedText(env, row, change.path)
    const report = checkEdit(row.repo, change.path, text)
    if (report.problems.length) throw new HttpError(422, report.problems.join("; "))
    await underLimit(env, session.login, ["uploads.send", "edit.send"], SENDS_PER_DAY, "sends")
    const repo = repoOf(row.repo)
    const { display_name } = await navIdentity(env, session)
    if (row.repo === "vault") {
      const author = plainName(display_name, session.login)
      const refused = await publishEdit(env, repo, row, change, text, { ...access, author })
      if (refused)
        return json(
          {
            detail: refused.incoming
              ? "the page changed on main since you started editing: look at what changed, take it into your version, then publish again"
              : "the page was moved or deleted on main since you started editing",
            incoming: refused.incoming,
          },
          409,
        )
      const published = await view((await draftRow(env, row.id))!)
      record("edit.send", change.path, {
        draft: row.id,
        repo: "vault",
        due_at: published.due_at,
        revision: row.sent_at !== null,
      })
      return json(published)
    }
    // Someone else's change to the page since the member loaded it comes back with the refusal,
    // so the editor can show what changed.
    const main = await repo.file(change.path)
    if (main?.sha !== change.base_sha)
      return json(
        {
          detail: main
            ? "the page changed on main since you started editing: look at what changed, take it into your version, then send again"
            : "the page was moved or deleted on main since you started editing",
          incoming: main ? { sha: main.sha, text: decode(main.bytes, change.path) } : null,
        },
        409,
      )
    if (decode(main.bytes, change.path) === text)
      throw new HttpError(422, "nothing changed: the page is the same as on main")
    await send(env, repo, row, changes, display_name)
    const sent = await view((await draftRow(env, row.id))!)
    record("edit.send", change.path, {
      draft: row.id,
      pull: sent.pull?.number,
      due_at: sent.due_at,
      revision: row.sent_at !== null,
    })
    return json(sent)
  }

  // Take the draft back: its pull request (if any) closes and its text is dropped.
  if (!part && request.method === "DELETE") {
    requireMutation(request, env)
    const row = await ownDraft(env, id, session, { change: true, kind: "edit" })
    await discard(env, repoOf(row.repo), row, "discarded by its author")
    record("edit.discard", row.id, { pull: row.pr_number })
    return json(await view((await draftRow(env, row.id))!))
  }

  throw new HttpError(405, "method not allowed")
}
