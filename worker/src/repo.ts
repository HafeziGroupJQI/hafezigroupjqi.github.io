import { HttpError } from "./http"

// One GitHub repository through the REST API, with a token that may write it: the public vault's
// People pages (src/profile/vault.ts) and members' uploads to vault-private (src/uploads/) commit
// through it. A commit is blobs, a tree over the branch's tree, a commit on its tip and a
// fast-forward of the branch (or, for an upload's own branch, a new ref or a forced one).

const GITHUB_API = "https://api.github.com"
const USER_AGENT = "hafezi-members-worker"
const encoder = new TextEncoder()

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

  /** A request to GitHub's API as the repository's token, answered as it comes. */
  protected async request(
    method: string,
    path: string,
    body?: BodyInit,
    { url = `${GITHUB_API}/repos/${this.repo}${path}` } = {},
  ): Promise<Response> {
    if (!this.token) throw new HttpError(503, this.unready)
    return this.fetcher(url, {
      method,
      headers: {
        authorization: `Bearer ${this.token}`,
        accept: "application/vnd.github+json",
        "user-agent": USER_AGENT,
        "x-github-api-version": "2022-11-28",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body,
    })
  }

  /** A response's JSON, or the error a member sees (204 answers null). */
  protected async answer<T>(response: Response, method: string, path: string): Promise<T> {
    if (response.status === 404) throw new RepoMissing(path)
    if (response.status === 409 || response.status === 422) throw new RepoConflict(path)
    if (!response.ok) {
      console.error(`${this.repo} ${method} ${path}: ${response.status}`)
      throw new HttpError(502, "GitHub did not accept the request; try again shortly")
    }
    if (response.status === 204) return null as T
    return (await response.json()) as T
  }

  protected async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await this.request(
      method,
      path,
      body === undefined ? undefined : JSON.stringify(body),
    )
    return this.answer<T>(response, method, path)
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

  /** Every file and folder of a tree, by path. */
  async tree(sha: string): Promise<Map<string, TreeEntry>> {
    const listing = await this.call<{ tree: TreeEntry[]; truncated?: boolean }>(
      "GET",
      `/git/trees/${sha}?recursive=1`,
    )
    if (listing.truncated) throw new HttpError(502, "the repository is too large to list at once")
    return new Map(listing.tree.map((entry) => [entry.path, entry]))
  }

  /** A folder's entries at a branch, or null when there is no such folder. */
  async list(folder: string, branch = "main"): Promise<ListEntry[] | null> {
    try {
      const listing = await this.call<ListEntry[] | ListEntry>(
        "GET",
        `/contents/${folder.split("/").map(encodeURIComponent).join("/")}?ref=${branch}`,
      )
      return Array.isArray(listing) ? listing : null
    } catch (error) {
      if (error instanceof RepoMissing) return null
      throw error
    }
  }

  /** A tree over `base`: each entry's blob, or null to delete that path. */
  async createTree(base: string, entries: { path: string; sha: string | null }[]): Promise<string> {
    const tree = await this.call<{ sha: string }>("POST", "/git/trees", {
      base_tree: base,
      tree: entries.map(({ path, sha }) => ({ path, mode: "100644", type: "blob", sha })),
    })
    return tree.sha
  }

  async createCommit(
    message: string,
    tree: string,
    parents: string[],
    author: Author,
  ): Promise<string> {
    const commit = await this.call<{ sha: string }>("POST", "/git/commits", {
      message,
      tree,
      parents,
      author: { ...author, date: new Date().toISOString() },
    })
    return commit.sha
  }

  async createBranch(branch: string, sha: string): Promise<void> {
    await this.call("POST", "/git/refs", { ref: `refs/heads/${branch}`, sha })
  }

  /** Move a branch to a commit: a fast-forward, or with `force` any commit. */
  async moveBranch(branch: string, sha: string, force = false): Promise<void> {
    await this.call("PATCH", `/git/refs/heads/${branch}`, { sha, force })
  }

  /** Delete a branch; one that is already gone is fine. */
  async deleteBranch(branch: string): Promise<void> {
    try {
      await this.call("DELETE", `/git/refs/heads/${branch}`)
    } catch (error) {
      if (!(error instanceof RepoMissing) && !(error instanceof RepoConflict)) throw error
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
      const tree = await this.createTree(
        tip.tree,
        await Promise.all(
          files.map(async (file) => ({
            path: file.path,
            sha: file.content === null ? null : await this.blob(file.content),
          })),
        ),
      )
      const commit = await this.createCommit(message, tree, [tip.commit], by)
      try {
        await this.moveBranch(branch, commit)
        return commit
      } catch (error) {
        if (!(error instanceof RepoConflict) || attempt > 0) throw error
      }
    }
  }

  protected async blob(content: Uint8Array | string): Promise<string> {
    const bytes = typeof content === "string" ? encoder.encode(content) : content
    const blob = await this.call<{ sha: string }>("POST", "/git/blobs", {
      content: toBase64(bytes),
      encoding: "base64",
    })
    return blob.sha
  }

  /**
   * A blob from a stream of `size` bytes (an R2 object's body), base64-encoded as it is sent, so a
   * large file is never in memory whole, let alone as bytes, base64 and JSON at once.
   */
  async streamBlob(source: ReadableStream<Uint8Array>, size: number): Promise<string> {
    const head = encoder.encode('{"encoding":"base64","content":"')
    const tail = encoder.encode('"}')
    const { readable, writable } = new FixedLengthStream(
      head.length + 4 * Math.ceil(size / 3) + tail.length,
    )
    const writer = writable.getWriter()
    const pumping = pumpBase64(source, writer, head, tail)
    pumping.catch(() => {})
    try {
      const response = await this.request("POST", "/git/blobs", readable)
      const blob = await this.answer<{ sha: string }>(response, "POST", "/git/blobs")
      await pumping
      return blob.sha
    } catch (error) {
      await writer.abort(error).catch(() => {})
      await source.cancel().catch(() => {})
      throw error
    }
  }
}

export interface TreeEntry {
  path: string
  type: "blob" | "tree" | "commit"
  sha: string
  size?: number
}

export interface ListEntry {
  name: string
  path: string
  type: "file" | "dir" | "symlink" | "submodule"
  sha: string
  size: number
}

/** Write `head`, the source's bytes as base64 (three bytes at a time across chunks), then `tail`. */
async function pumpBase64(
  source: ReadableStream<Uint8Array>,
  writer: WritableStreamDefaultWriter<Uint8Array>,
  head: Uint8Array,
  tail: Uint8Array,
): Promise<void> {
  try {
    await writer.write(head)
    const reader = source.getReader()
    let carry = new Uint8Array(0)
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      let chunk = value
      if (carry.length) {
        chunk = new Uint8Array(carry.length + value.length)
        chunk.set(carry)
        chunk.set(value, carry.length)
      }
      const whole = chunk.length - (chunk.length % 3)
      if (whole) await writer.write(encoder.encode(toBase64(chunk.subarray(0, whole))))
      carry = chunk.slice(whole)
    }
    if (carry.length) await writer.write(encoder.encode(toBase64(carry)))
    await writer.write(tail)
    await writer.close()
  } catch (error) {
    await writer.abort(error).catch(() => {})
    throw error
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
