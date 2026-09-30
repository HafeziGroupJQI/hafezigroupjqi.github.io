import { isAdmin } from "../audit"
import type { Env } from "../env"
import { HttpError } from "../http"
import { PEOPLE_PAGE } from "../profile/vault"
import type { Session } from "../session"
import type { RepoName } from "../uploads/github"
import { FORBIDDEN, checkContent, vaultPath } from "../uploads/rules"

// What members may edit from the site's editor (/edit, routes.ts): a page's own file in its
// vault, as its author wrote it, never the page the site made from it. In vault-private these are
// its pages (.md, and .qmd, whose code runs when the site builds) and Jupyter notebooks (.ipynb)
// under the folders uploads may change (uploads/rules.ts); a Wolfram notebook (.nb) is edited in
// the Scratchpad and a drawing is replaced whole on /uploads. In the public vault they are its
// pages (content/**.md), a People page only by its own member or an admin, and the home and
// privacy pages only by an admin. An edit is a draft of the uploads pipeline (one change, whose
// base is the blob the member loaded), checked here as uploads are, and a public page's by
// public.ts as the public vault's own check would.

export type EditKind = "md" | "qmd" | "ipynb"

/** At most this much text: pages are a few KB; the vault's largest notebook is about 400 KB. */
export const EDIT_MAX = 2 * 1024 * 1024
/** A summary is one line, like a commit's subject. */
export const SUMMARY_MAX = 120

const KINDS: Record<string, EditKind> = { md: "md", qmd: "qmd", ipynb: "ipynb" }
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/

/** Public pages the site makes whole from other pages: their own file never shows. */
const GENERATED = new Set([
  "content/people/index.md",
  "content/people/alumni/index.md",
  "content/research/index.md",
  "content/news/index.md",
  "content/publications/index.md",
])
/** Public pages only an admin edits: the home page and the privacy notice. */
export const ADMIN_ONLY = new Set(["content/index.md", "content/privacy.md"])

/** A public vault page's path: a Markdown file under content/, not an asset. */
function publicPath(raw: unknown): string {
  if (typeof raw !== "string" || !raw.trim()) throw new HttpError(422, "choose a page")
  const path = raw.normalize("NFC")
  if (path.length > 300) throw new HttpError(422, "that path is longer than 300 characters")
  if (FORBIDDEN.test(path)) throw new HttpError(422, "that isn't a page's path")
  const segments = path.split("/")
  if (
    segments[0] !== "content" ||
    segments.length < 2 ||
    segments.some((segment) => !segment || segment.startsWith(".") || segment !== segment.trim())
  )
    throw new HttpError(422, "a public page is a file under content/")
  if (segments[1] === "assets" || !path.endsWith(".md"))
    throw new HttpError(422, "the editor opens the public vault's pages (.md files)")
  if (GENERATED.has(path))
    throw new HttpError(422, "the site makes this page from other pages, so its file never shows")
  return path
}

/** A path the editor opens in `repo`, and what kind of file it is; a 422 says why not. */
export function editablePath(repo: RepoName, raw: unknown): { path: string; kind: EditKind } {
  if (repo === "vault") return { path: publicPath(raw), kind: "md" }
  const path = vaultPath(raw)
  const name = path.split("/").pop()!
  const extension = name.slice(name.lastIndexOf(".") + 1).toLowerCase()
  if (extension === "nb")
    throw new HttpError(
      422,
      "Wolfram notebooks are edited in the Scratchpad: use Edit in Scratchpad on the page",
    )
  if (/\.excalidraw\.md$/i.test(name))
    throw new HttpError(422, "drawings are replaced whole: use Replace this file on the page")
  const kind = KINDS[extension]
  if (!kind)
    throw new HttpError(
      422,
      "the editor opens pages (.md, .qmd) and Jupyter notebooks (.ipynb); replace other files from Uploads",
    )
  return { path, kind }
}

/**
 * A new page the editor may make: a folder's own page, index.md, in the private vault, where the
 * folder has none (the site shows an automatic folder page there). Any other new file is added on
 * /uploads. The path is checked as any edit's is (no "..", no hidden or reserved names).
 */
export function newIndexPath(repo: RepoName, raw: unknown): { path: string; folder: string } {
  if (repo !== "vault-private")
    throw new HttpError(422, "the editor makes new pages only in the private vault")
  const { path } = editablePath(repo, raw)
  const segments = path.split("/")
  if (segments.length < 2 || segments.at(-1) !== "index.md")
    throw new HttpError(422, "the editor makes only a folder's own page, <folder>/index.md")
  return { path, folder: segments.slice(0, -1).join("/") }
}

/** A new folder page's first text: front matter the vault's check takes, named for the folder. */
export function indexTemplate(folder: string): string {
  const name = folder.split("/").pop()!.replace(/[-_]+/g, " ").trim()
  const title = `${name.charAt(0).toUpperCase()}${name.slice(1)} index`
  return `---\ntitle: ${JSON.stringify(title)}\ntype: note\ntags: [internal]\n---\n\n`
}

/** The text of an edit as the member sent it: well-formed Unicode, no NUL, at most EDIT_MAX. */
export function editText(value: unknown): string {
  if (typeof value !== "string") throw new HttpError(422, "the page's text is missing")
  if (LONE_SURROGATE.test(value)) throw new HttpError(422, "the text isn't well-formed Unicode")
  if (value.includes("\u0000")) throw new HttpError(422, "the text can't contain NUL characters")
  if (new TextEncoder().encode(value).length > EDIT_MAX)
    throw new HttpError(413, `a page can be at most ${EDIT_MAX / 1024 / 1024} MB`)
  return value
}

/** A summary of an edit: one line of at most SUMMARY_MAX characters ("" when there is none). */
export function cleanSummary(value: unknown): string {
  if (value === undefined || value === null) return ""
  if (typeof value !== "string") throw new HttpError(422, "the summary must be text")
  const summary = value.replace(/\s+/g, " ").trim()
  if (/[\p{Cc}\u2028\u2029]/u.test(summary))
    throw new HttpError(422, "the summary can't contain control characters")
  if (summary.length > SUMMARY_MAX)
    throw new HttpError(422, `the summary is longer than ${SUMMARY_MAX} characters`)
  return summary
}

/** A blob sha, as GitHub gives a file's. */
export function blobSha(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-z]{7,64}$/i.test(value))
    throw new HttpError(422, "base_sha must be the blob sha of the version you started from")
  return value
}

/**
 * What the vault's check would refuse in a page's text (problems), and why a person must merge it
 * even so (review: something in it runs), as uploads check a staged file (uploads/rules.ts).
 * Saving a draft keeps it either way; sending one with problems is refused.
 */
export function contentReport(
  path: string,
  text: string,
): { problems: string[]; review: string | null } {
  try {
    return { problems: [], review: checkContent(path, new TextEncoder().encode(text)) }
  } catch (error) {
    if (error instanceof HttpError && error.status === 422)
      return { problems: [error.detail], review: null }
    throw error
  }
}

/**
 * An edit's commit and pull request title: "edit <path> by <name>: <summary>", lowercase like the
 * vault's history and at most 110 characters, so its commit message, "… from the members site
 * editor", stays under 150. No @mention, code or link from the summary gets into it.
 */
export function editTitle(path: string, name: string, summary: string): string {
  const head = `edit ${path} by ${name.replace(/\s+/g, " ").trim()}`
  const said = summary
    .replace(/[@`<>[\]]/g, "")
    .replace(/\s+/g, " ")
    .trim()
  let title = said ? `${head}: ${said}` : head
  if (title.length > 110) title = `${title.slice(0, 109).trimEnd()}…`
  return title.toLowerCase()
}

/** The message of an edit's commit, which a rebase merge puts on main as it is. */
export const editMessage = (title: string) => `${title} from the members site editor`

/** Where a Quarto document's frozen results are kept (vault-private's _freeze). */
export const freezeDir = (path: string) => `_freeze/${path.replace(/\.qmd$/i, "")}`

/**
 * Whether the member may change a file (can_edit), and if not why, in a sentence for the editor.
 * Any member may edit the private vault's pages and most public ones; a People page is its own
 * member's (their approved link, /settings) or an admin's, and the home and privacy pages an
 * admin's. Admins may also add what runs in browsers to a public page (public.ts).
 */
export async function editAccess(
  env: Env,
  session: Session,
  repo: RepoName,
  path: string,
): Promise<{ can_edit: boolean; why: string | null; admin: boolean }> {
  const admin = await isAdmin(env, session)
  if (repo === "vault-private" || admin) return { can_edit: true, why: null, admin }
  if (ADMIN_ONLY.has(path))
    return { can_edit: false, why: "Only an admin can edit this page.", admin }
  if (PEOPLE_PAGE.test(path) && !path.endsWith("/index.md")) {
    const owner = await env.DB.prepare(
      "SELECT login, name FROM profiles WHERE path = ? AND status = 'approved'",
    )
      .bind(path)
      .first<{ login: string; name: string | null }>()
    if (owner?.login.toLowerCase() === session.login.toLowerCase())
      return { can_edit: true, why: null, admin }
    return {
      can_edit: false,
      why: owner
        ? `Only ${owner.name || owner.login} or an admin can edit this People page.`
        : "Only the person on this page (once they link it in Settings) or an admin can edit it.",
      admin,
    }
  }
  return { can_edit: true, why: null, admin }
}
