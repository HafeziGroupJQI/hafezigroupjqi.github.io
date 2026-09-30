import { HttpError } from "../http"
import { checkContent, vaultPath } from "../uploads/rules"
import type { RepoName } from "../uploads/github"

// What members may edit from the site's editor (/edit, routes.ts): a page's own file in its
// vault, as its author wrote it, never the page the site made from it. In vault-private these are
// its pages (.md, and .qmd, whose code runs when the site builds) and Jupyter notebooks (.ipynb)
// under the folders uploads may change (uploads/rules.ts); a Wolfram notebook (.nb) is edited in
// the Scratchpad and a drawing is replaced whole on /uploads. An edit is a draft of the uploads
// pipeline (one change, whose base is the blob the member loaded), checked here as uploads are.

export type EditKind = "md" | "qmd" | "ipynb"

/** At most this much text: pages are a few KB; the vault's largest notebook is about 400 KB. */
export const EDIT_MAX = 2 * 1024 * 1024
/** A summary is one line, like a commit's subject. */
export const SUMMARY_MAX = 120

const KINDS: Record<string, EditKind> = { md: "md", qmd: "qmd", ipynb: "ipynb" }
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/

/** A path the editor opens in `repo`, and what kind of file it is; a 422 says why not. */
export function editablePath(repo: RepoName, raw: unknown): { path: string; kind: EditKind } {
  if (repo !== "vault-private")
    throw new HttpError(422, "only the private vault's pages can be edited from the site")
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
