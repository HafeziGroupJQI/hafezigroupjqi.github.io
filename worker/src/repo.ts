import { HttpError } from "./http"

// One GitHub repository through the REST API, with a token that may write it: the public vault's
// People pages (src/profile/vault.ts) commit through it. A commit is blobs, a tree over the
// branch's tree, a commit on its tip and a fast-forward of the branch.

const GITHUB_API = "https://api.github.com"
const USER_AGENT = "hafezi-members-worker"

/** Outbound fetch for a repository's GitHub API; tests substitute an in-memory repository. */
export type RepoFetch = (input: string, init: RequestInit) => Promise<Response>

export interface RepoFile {
  path: string
  /** null deletes the file. */
  content: Uint8Array | string | null
}

export interface Author {
  name: string
  email: string
}

export class GitRepo {
  constructor(
    protected fetcher: RepoFetch,
    /** "owner/name" */
    readonly repo: string,
    private token: string | undefined,
    /** What a member is told while the site has no token for this repository. */
    private unready: string,
  ) {}

  get ready(): boolean {
    return Boolean(this.token)
  }

  protected async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    if (!this.token) throw new HttpError(503, this.unready)
    const response = await this.fetcher(`${GITHUB_API}/repos/${this.repo}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.token}`,
        accept: "application/vnd.github+json",
        "user-agent": USER_AGENT,
        "x-github-api-version": "2022-11-28",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    if (response.status === 404) throw new RepoMissing(path)
    if (response.status === 409 || response.status === 422) throw new RepoConflict(path)
    if (!response.ok) {
      console.error(`${this.repo} ${method} ${path}: ${response.status}`)
      throw new HttpError(502, "GitHub did not accept the request; try again shortly")
    }
    return (await response.json()) as T
  }

  /** The commit and tree at the tip of a branch. */
  async head(branch = "main"): Promise<{ commit: string; tree: string }> {
    const ref = await this.call<{ object: { sha: string } }>("GET", `/git/ref/heads/${branch}`)
    const commit = await this.call<{ tree: { sha: string } }>(
      "GET",
      `/git/commits/${ref.object.sha}`,
    )
    return { commit: ref.object.sha, tree: commit.tree.sha }
  }

  /** A text file at a branch, or null when it does not exist. */
  async read(path: string, branch = "main"): Promise<string | null> {
    try {
      const file = await this.call<{ content: string; encoding: string }>(
        "GET",
        `/contents/${path.split("/").map(encodeURIComponent).join("/")}?ref=${branch}`,
      )
      return new TextDecoder().decode(fromBase64(file.content.replace(/\s/g, "")))
    } catch (error) {
      if (error instanceof RepoMissing) return null
      throw error
    }
  }

  /**
   * One commit on a branch with every file in `files`. `build` reads what it needs at the current
   * tip and returns the files and message, so a concurrent push (the ref moved) is retried on top
   * of it, once. With `skipEmpty`, a build with no files commits nothing and returns null. The
   * build may name the commit's author (say, once it knows whose edits it holds); else `author` is.
   */
  async commit(
    author: Author,
    build: () => Promise<{ files: RepoFile[]; message: string; author?: Author }>,
    { skipEmpty = false, branch = "main" } = {},
  ): Promise<string | null> {
    for (let attempt = 0; ; attempt++) {
      const tip = await this.head(branch)
      const { files, message, author: by = author } = await build()
      if (!files.length) {
        if (skipEmpty) return null
        throw new Error("a commit needs at least one file")
      }
      const tree = await this.call<{ sha: string }>("POST", "/git/trees", {
        base_tree: tip.tree,
        tree: await Promise.all(
          files.map(async (file) => ({
            path: file.path,
            mode: "100644",
            type: "blob",
            sha: file.content === null ? null : await this.blob(file.content),
          })),
        ),
      })
      const commit = await this.call<{ sha: string }>("POST", "/git/commits", {
        message,
        tree: tree.sha,
        parents: [tip.commit],
        author: { ...by, date: new Date().toISOString() },
      })
      try {
        await this.call("PATCH", `/git/refs/heads/${branch}`, { sha: commit.sha, force: false })
        return commit.sha
      } catch (error) {
        if (!(error instanceof RepoConflict) || attempt > 0) throw error
      }
    }
  }

  protected async blob(content: Uint8Array | string): Promise<string> {
    const bytes = typeof content === "string" ? new TextEncoder().encode(content) : content
    const blob = await this.call<{ sha: string }>("POST", "/git/blobs", {
      content: toBase64(bytes),
      encoding: "base64",
    })
    return blob.sha
  }
}

export class RepoMissing extends HttpError {
  constructor(path: string) {
    super(404, `not in the repository: ${path}`)
  }
}

export class RepoConflict extends HttpError {
  constructor(path: string) {
    super(409, `the repository changed while saving (${path}); try again`)
  }
}

export function toBase64(bytes: Uint8Array): string {
  let binary = ""
  for (let i = 0; i < bytes.length; i += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(binary)
}

function fromBase64(text: string): Uint8Array {
  const binary = atob(text)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}
