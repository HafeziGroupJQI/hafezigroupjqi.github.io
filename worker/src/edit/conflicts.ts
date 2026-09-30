import type { Env } from "../env"
import type { RepoBlob } from "../repo"
import type { ChangeRow, DraftRow } from "../uploads/drafts"
import type { DraftRepo } from "../uploads/github"
import { threeWay } from "./merge"
import { pageProblems, readPage } from "./public"
import { contentReport } from "./rules"

// When edits of one page meet. A send is checked against main: a page that changed there since
// the member loaded it is merged with their text line by line (merge.ts). Changes to different
// lines go together and the member looks the result over; changes to the same lines are a
// conflict, which the member settles in the editor on top of main's version. Nothing anyone else
// wrote is replaced without the member seeing it.

const decoder = new TextDecoder()

/** A draft's base kept beside its text: the text it was made on top of, when that is not a blob
 *  of the vault (another member's sent draft). No vault path starts with a dot. */
export const baseKey = (id: string, path: string) => `uploads/${id}/.base/${path}`

/** The text a draft was made from: its kept base, else the blob it names; null when unknown. */
export async function baseText(
  env: Env,
  repo: DraftRepo,
  row: Pick<DraftRow, "id">,
  change: Pick<ChangeRow, "path" | "base_sha">,
): Promise<string | null> {
  const kept = await env.ARTIFACTS.get(baseKey(row.id, change.path))
  if (kept) return kept.text()
  if (!change.base_sha) return null
  const bytes = await repo.blobBytes(change.base_sha)
  return bytes && decoder.decode(bytes)
}

/** How long an unsettled conflict stays open before its draft goes back to its author. */
export const CONFLICT_DAYS = 14

/** An id like a draft's: six random bytes in hex. */
export const newId = () =>
  [...crypto.getRandomValues(new Uint8Array(6))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")

export type ConflictReason = "pending" | "main" | "base-gone" | "moved"

export interface ConflictRow {
  id: string
  repo: DraftRow["repo"]
  path: string
  /** The held draft: the second one sent. */
  draft_id: string
  /** The second editor. */
  login: string
  first_draft_id: string | null
  /** Who may settle it besides admins; null when only admins may. */
  first_login: string | null
  first_author: string | null
  first_blob: string | null
  reason: ConflictReason
  state: "open" | "resolved" | "rejected" | "withdrawn" | "expired"
  resolution: "first" | "second" | "merged" | null
  resolved_by: string | null
  opened_at: number
  resolved_at: number | null
  expires_at: number
}

/**
 * The statement that opens a conflict on a draft, once that draft stands as one
 * (upload_drafts.status 'conflict'); a draft has at most one open. Who the first editor is comes
 * from the Worker's own rows, never from a request.
 */
export function openConflict(
  env: Pick<Env, "DB">,
  conflict: {
    id?: string
    repo: DraftRow["repo"]
    path: string
    draft: string
    login: string
    first?: { id: string | null; login: string | null; author: string | null } | null
    blob?: string | null
    reason: ConflictReason
    now: number
  },
): D1PreparedStatement {
  return env.DB.prepare(
    `INSERT OR IGNORE INTO edit_conflicts
       (id, repo, path, draft_id, login, first_draft_id, first_login, first_author, first_blob,
        reason, opened_at, expires_at)
     SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12
     WHERE EXISTS (SELECT 1 FROM upload_drafts WHERE id = ?4 AND status = 'conflict')`,
  ).bind(
    conflict.id ?? newId(),
    conflict.repo,
    conflict.path,
    conflict.draft,
    conflict.login,
    conflict.first?.id ?? null,
    conflict.first?.login ?? null,
    conflict.first?.author ?? null,
    conflict.blob ?? null,
    conflict.reason,
    conflict.now,
    conflict.now + CONFLICT_DAYS * 86_400_000,
  )
}

/** What would refuse a merged text before anyone looked at it: the page's own checks. */
export function mergedProblems(
  repo: DraftRow["repo"],
  path: string,
  text: string,
  before: string,
  admin: boolean,
): string[] {
  if (repo === "vault-private") return contentReport(path, text).problems
  const page = readPage(text)
  return page.problems.length ? page.problems : pageProblems(text, before, admin)
}

/** Notebooks are JSON: merged line by line they would often be broken, so any two edits of one
 *  are a conflict. */
export const mergeable = (path: string) => !/\.ipynb$/i.test(path)

export type SendCheck =
  | { kind: "ok"; main: RepoBlob; mainText: string }
  /** The page is gone from main: moved or deleted. */
  | { kind: "moved" }
  /** Main changed other lines: the merged text, for the member to look over. */
  | { kind: "rebase"; incoming: { sha: string; text: string }; merged_text: string }
  /** Main changed the same lines: `proposed` has main's other changes, and the member's lines. */
  | {
      kind: "main"
      incoming: { sha: string; text: string }
      base_text: string | null
      proposed: string
    }

/** Check a draft about to be sent against main as it is now. */
export async function checkSend(
  env: Env,
  repo: DraftRepo,
  row: DraftRow,
  change: ChangeRow,
  text: string,
  { admin }: { admin: boolean },
): Promise<SendCheck> {
  const main = await repo.file(change.path)
  if (!main) return { kind: "moved" }
  const mainText = decoder.decode(main.bytes)
  if (main.sha === change.base_sha) return { kind: "ok", main, mainText }
  const incoming = { sha: main.sha, text: mainText }
  const base = await baseText(env, repo, row, change)
  if (base !== null && mergeable(change.path)) {
    const merged = threeWay(base, mainText, text)
    if (merged.clean && !mergedProblems(row.repo, change.path, merged.text, mainText, admin).length)
      return { kind: "rebase", incoming, merged_text: merged.text }
    return { kind: "main", incoming, base_text: base, proposed: merged.text }
  }
  return { kind: "main", incoming, base_text: base, proposed: text }
}

/** The refusal (409) a send answers with, for the editor. `incoming` is main's version. */
export function refusal(check: Exclude<SendCheck, { kind: "ok" }>, verb: "send" | "publish") {
  switch (check.kind) {
    case "moved":
      return {
        kind: check.kind,
        detail: "the page was moved or deleted on main since you started editing",
        incoming: null,
      }
    case "rebase":
      return {
        ...check,
        detail: `the page changed on main while you were editing, on other lines than yours: look over the merged text, then ${verb} again`,
      }
    case "main":
      return {
        ...check,
        detail: `the page changed on main since you started editing: look at what changed, take it into your version, then ${verb} again`,
      }
  }
}
