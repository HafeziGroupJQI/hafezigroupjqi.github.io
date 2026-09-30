// An in-memory stand-in for the parts of GitHub's REST API the repository client uses (refs,
// commits, trees, blobs, contents), and for vault-private the pull requests, commit statuses and
// the one GraphQL mutation the uploads use. Tests seed it, read files back and look at the
// commits, branches and pull requests the Worker made.

import { threeWay } from "../src/edit/merge"

type Snapshot = Map<string, Uint8Array>

interface Commit {
  sha: string
  tree: string
  parents: string[]
  message: string
  author: { name: string; email: string }
}

export interface FakePull {
  number: number
  node_id: string
  title: string
  body: string
  head: string
  base: string
  draft: boolean
  state: "open" | "closed"
  merged: boolean
  mergeable: boolean | null
  merge_commit_sha: string | null
  merge_title?: string
  merge_message?: string
  merge_method?: string
}

export interface FakeStatus {
  context: string
  state: "pending" | "success" | "failure" | "error"
  target_url: string | null
  description: string | null
}

const encoder = new TextEncoder()
const decoder = new TextDecoder()

function b64(bytes: Uint8Array): string {
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

function unb64(text: string): Uint8Array {
  const binary = atob(text)
  return Uint8Array.from(binary, (c) => c.charCodeAt(0))
}

/** A stable stand-in for a git blob sha: the same bytes always get the same one. */
function blobSha(bytes: Uint8Array): string {
  let a = 0x811c9dc5
  let b = 0x01000193
  for (const byte of bytes) {
    a = Math.imul(a ^ byte, 0x01000193) >>> 0
    b = Math.imul(b ^ byte, 0x811c9dc5) >>> 0
  }
  return `b${a.toString(16).padStart(8, "0")}${b.toString(16).padStart(8, "0")}${bytes.length}`
}

export class FakeVault {
  calls: string[] = []
  commits: Commit[] = []
  trees = new Map<string, Snapshot>()
  blobs = new Map<string, Uint8Array>()
  refs = new Map<string, string>()
  pulls = new Map<number, FakePull>()
  statuses = new Map<string, FakeStatus[]>()
  /** Called once before the next update of main, e.g. to simulate someone else's push. */
  beforeUpdate: (() => void) | null = null
  private counter = 0

  constructor(
    readonly repo = "HafeziGroupJQI/vault",
    private token = "test-vault-token",
  ) {}

  get head(): string {
    return this.refs.get("main")!
  }

  set head(sha: string) {
    this.refs.set("main", sha)
  }

  reset(files: Record<string, string | Uint8Array>): void {
    this.calls = []
    this.commits = []
    this.trees.clear()
    this.blobs.clear()
    this.refs.clear()
    this.pulls.clear()
    this.statuses.clear()
    this.beforeUpdate = null
    const snapshot: Snapshot = new Map()
    for (const [path, content] of Object.entries(files))
      snapshot.set(path, typeof content === "string" ? encoder.encode(content) : content)
    this.head = this.addCommit(this.addTree(snapshot), [], "seed", { name: "seed", email: "" })
  }

  /** A direct push to main (someone else's commit); null deletes the file. */
  push(path: string, content: string | null): void {
    const snapshot = new Map(this.snapshot())
    if (content === null) snapshot.delete(path)
    else snapshot.set(path, encoder.encode(content))
    this.head = this.addCommit(this.addTree(snapshot), [this.head], "direct push", {
      name: "other",
      email: "",
    })
  }

  snapshot(sha = this.head): Snapshot {
    const commit = this.commits.find((c) => c.sha === sha)!
    return this.trees.get(commit.tree)!
  }

  /** A file's text on a branch (default main). */
  text(path: string, branch = "main"): string | undefined {
    const bytes = this.snapshot(this.refs.get(branch)).get(path)
    return bytes && decoder.decode(bytes)
  }

  bytes(path: string, branch = "main"): Uint8Array | undefined {
    return this.snapshot(this.refs.get(branch)).get(path)
  }

  sha(path: string): string {
    return blobSha(this.snapshot().get(path)!)
  }

  commit(sha: string): Commit {
    return this.commits.find((c) => c.sha === sha)!
  }

  /** Commits made after the seed, oldest first. */
  get made(): Commit[] {
    return this.commits.filter((c) => c.message !== "seed" && c.message !== "direct push")
  }

  /** Report a commit status, as vault-private's validate workflow does. */
  report(sha: string, state: FakeStatus["state"], context = "validate"): void {
    const list = (this.statuses.get(sha) ?? []).filter((s) => s.context !== context)
    list.unshift({
      context,
      state,
      target_url: `https://github.com/runs/${sha}`,
      description: state,
    })
    this.statuses.set(sha, list)
  }

  private id(kind: string): string {
    return `${kind}${String(++this.counter).padStart(8, "0")}`
  }

  private addTree(snapshot: Snapshot): string {
    const sha = this.id("t")
    this.trees.set(sha, snapshot)
    return sha
  }

  private addCommit(tree: string, parents: string[], message: string, author: Commit["author"]) {
    // A commit's sha is 40 hex digits, as git's are.
    const sha = this.id("c").padEnd(40, "0")
    this.commits.push({ sha, tree, parents, message, author })
    return sha
  }

  private pullJson(pull: FakePull) {
    return {
      number: pull.number,
      node_id: pull.node_id,
      html_url: `https://github.com/${this.repo}/pull/${pull.number}`,
      title: pull.title,
      body: pull.body,
      state: pull.state,
      draft: pull.draft,
      merged: pull.merged,
      mergeable: this.mergeable(pull),
      merge_commit_sha: pull.merge_commit_sha,
      head: { ref: pull.head, sha: this.refs.get(pull.head) ?? null },
    }
  }

  /** main's snapshot with a commit's changes (since its first parent) applied over it. */
  private applied(commit: Commit): Snapshot {
    const before = this.snapshot(commit.parents[0])
    const after = this.trees.get(commit.tree)!
    const snapshot = new Map(this.snapshot())
    for (const path of new Set([...before.keys(), ...after.keys()])) {
      const next = after.get(path)
      if (next === before.get(path)) continue
      if (next) snapshot.set(path, next)
      else snapshot.delete(path)
    }
    return snapshot
  }

  /**
   * Whether a pull request merges cleanly into main, as GitHub works it out: a test's own answer
   * (false, or null for "not worked out yet"), else a line-by-line merge of each file its branch
   * changes with what main did to that file since the branch began.
   */
  private mergeable(pull: FakePull): boolean | null {
    if (pull.mergeable !== true) return pull.mergeable
    const tip = this.refs.get(pull.head)
    const head = tip ? this.commit(tip) : undefined
    if (!head?.parents[0]) return true
    const before = this.snapshot(head.parents[0])
    const after = this.trees.get(head.tree)!
    const main = this.snapshot()
    const same = (a?: Uint8Array, b?: Uint8Array) => (a && blobSha(a)) === (b && blobSha(b))
    for (const path of new Set([...before.keys(), ...after.keys()])) {
      const [was, mine, now] = [before.get(path), after.get(path), main.get(path)]
      if (same(was, mine) || same(was, now) || same(mine, now)) continue
      if (!was || !mine || !now) return false
      if (!threeWay(decoder.decode(was), decoder.decode(now), decoder.decode(mine)).clean)
        return false
    }
    return true
  }

  /** Squash a pull request onto main: its branch's changes since its parent, applied to main. */
  private squash(pull: FakePull, title: string): string {
    const head = this.commit(this.refs.get(pull.head)!)
    this.head = this.addCommit(this.addTree(this.applied(head)), [this.head], title, {
      name: "merger",
      email: "",
    })
    return this.head
  }

  /** Rebase a pull request onto main: each of its branch's commits (those main doesn't have),
   *  replayed in order with its own message and author, as GitHub does. */
  private rebase(pull: FakePull): string {
    const onMain = new Set<string>()
    for (let sha: string | undefined = this.head; sha; sha = this.commit(sha).parents[0])
      onMain.add(sha)
    const own: Commit[] = []
    let sha = this.refs.get(pull.head)
    while (sha && !onMain.has(sha)) {
      const commit = this.commit(sha)
      own.unshift(commit)
      sha = commit.parents[0]
    }
    for (const commit of own)
      this.head = this.addCommit(
        this.addTree(this.applied(commit)),
        [this.head],
        commit.message,
        commit.author,
      )
    return this.head
  }

  fetch = async (input: string, init: RequestInit): Promise<Response> => {
    const url = new URL(input)
    const method = init.method ?? "GET"
    const prefix = `/repos/${this.repo}`
    const graphql = url.pathname === "/graphql"
    this.calls.push(`${method} ${graphql ? "/graphql" : url.pathname.replace(prefix, "")}`)
    if (!graphql && url.pathname !== prefix && !url.pathname.startsWith(prefix + "/"))
      return new Response("", { status: 404 })
    if ((init.headers as Record<string, string>)?.authorization !== `Bearer ${this.token}`)
      return new Response("", { status: 401 })
    const path = url.pathname.slice(prefix.length)
    // Blobs may be streamed (base64 written as it is read).
    const raw =
      init.body instanceof ReadableStream ? await new Response(init.body).text() : init.body
    const body = raw ? JSON.parse(String(raw)) : null
    if (graphql) {
      const pull = [...this.pulls.values()].find((p) => p.node_id === body.variables.id)
      if (!pull || !body.query.includes("markPullRequestReadyForReview"))
        return Response.json({ errors: [{ message: "not found" }] })
      pull.draft = false
      return Response.json({
        data: { markPullRequestReadyForReview: { pullRequest: { isDraft: false } } },
      })
    }
    let match = path.match(/^\/git\/ref\/heads\/(.+)$/)
    if (method === "GET" && match) {
      const sha = this.refs.get(match[1])
      return sha ? Response.json({ object: { sha } }) : new Response("", { status: 404 })
    }
    match = path.match(/^\/git\/commits\/(\w+)$/)
    if (method === "GET" && match) {
      const commit = this.commits.find((c) => c.sha === match![1])
      return commit
        ? Response.json({
            sha: commit.sha,
            tree: { sha: commit.tree },
            parents: commit.parents.map((sha) => ({ sha })),
            author: commit.author,
            message: commit.message,
          })
        : new Response("", { status: 404 })
    }
    match = path.match(/^\/git\/trees\/(\w+)$/)
    if (method === "GET" && match) {
      const tree = this.trees.get(match[1])
      if (!tree) return new Response("", { status: 404 })
      const folders = new Set<string>()
      for (const file of tree.keys())
        file
          .split("/")
          .slice(0, -1)
          .forEach((_, i, parts) => folders.add(parts.slice(0, i + 1).join("/")))
      return Response.json({
        tree: [
          ...[...folders].map((p) => ({ path: p, type: "tree", sha: `t-${p}` })),
          ...[...tree].map(([p, bytes]) => ({
            path: p,
            type: "blob",
            sha: blobSha(bytes),
            size: bytes.length,
          })),
        ],
        truncated: false,
      })
    }
    match = path.match(/^\/contents\/(.*)$/)
    if (method === "GET" && match) {
      const wanted = decodeURIComponent(match[1]).replace(/\/$/, "")
      // A branch, or a commit's sha.
      const ref = url.searchParams.get("ref") ?? "main"
      const at = this.refs.get(ref) ?? this.commits.find((c) => c.sha === ref)?.sha
      if (!at) return new Response("", { status: 404 })
      const tree = this.snapshot(at)
      const bytes = tree.get(wanted)
      // As GitHub does, a file over 1 MB comes without its content (the blob API has it).
      const large = bytes && bytes.length > 1024 * 1024
      if (bytes)
        return Response.json({
          type: "file",
          name: wanted.split("/").pop(),
          path: wanted,
          sha: blobSha(bytes),
          size: bytes.length,
          content: large ? "" : b64(bytes),
          encoding: large ? "none" : "base64",
        })
      const children = new Map<string, object>()
      const prefix = wanted ? wanted + "/" : ""
      for (const [file, content] of tree) {
        if (!file.startsWith(prefix)) continue
        const [name, ...rest] = file.slice(prefix.length).split("/")
        children.set(
          name,
          rest.length
            ? { type: "dir", name, path: prefix + name, sha: `t-${prefix + name}`, size: 0 }
            : { type: "file", name, path: file, sha: blobSha(content), size: content.length },
        )
      }
      return children.size
        ? Response.json([...children.values()])
        : new Response("", { status: 404 })
    }
    match = path.match(/^\/git\/blobs\/(\w+)$/)
    if (method === "GET" && match) {
      const bytes =
        this.blobs.get(match[1]) ??
        [...this.trees.values()]
          .flatMap((t) => [...t.values()])
          .find((b) => blobSha(b) === match![1])
      return bytes
        ? Response.json({
            sha: match[1],
            size: bytes.length,
            content: b64(bytes),
            encoding: "base64",
          })
        : new Response("", { status: 404 })
    }
    if (method === "POST" && path === "/git/blobs") {
      const bytes = unb64(body.content)
      const sha = blobSha(bytes)
      this.blobs.set(sha, bytes)
      return Response.json({ sha }, { status: 201 })
    }
    if (method === "POST" && path === "/git/trees") {
      const base = this.trees.get(body.base_tree)
      if (!base) return new Response("", { status: 422 })
      const snapshot = new Map(base)
      for (const entry of body.tree)
        if (typeof entry.content === "string")
          snapshot.set(entry.path, encoder.encode(entry.content))
        else if (entry.sha === null) snapshot.delete(entry.path)
        else {
          const bytes =
            this.blobs.get(entry.sha) ?? [...base.values()].find((b) => blobSha(b) === entry.sha)
          if (!bytes) return new Response("", { status: 422 })
          snapshot.set(entry.path, bytes)
        }
      return Response.json({ sha: this.addTree(snapshot) }, { status: 201 })
    }
    if (method === "POST" && path === "/git/commits") {
      const sha = this.addCommit(body.tree, body.parents, body.message, body.author)
      return Response.json({ sha }, { status: 201 })
    }
    if (method === "POST" && path === "/git/refs") {
      const branch = String(body.ref).replace(/^refs\/heads\//, "")
      if (this.refs.has(branch))
        return Response.json({ message: "Reference already exists" }, { status: 422 })
      this.refs.set(branch, body.sha)
      return Response.json({ ref: body.ref, object: { sha: body.sha } }, { status: 201 })
    }
    match = path.match(/^\/git\/refs\/heads\/(.+)$/)
    if (method === "PATCH" && match) {
      const branch = match[1]
      if (branch === "main") {
        const hook = this.beforeUpdate
        this.beforeUpdate = null
        hook?.()
      }
      if (!this.refs.has(branch))
        return Response.json({ message: "Reference does not exist" }, { status: 422 })
      // A fast-forward: the branch's tip is among the new commit's ancestors.
      const ancestors = new Set<string>()
      let sha: string | undefined = body.sha
      while (sha && !ancestors.has(sha)) {
        ancestors.add(sha)
        const at: string = sha
        sha = this.commits.find((c) => c.sha === at)?.parents[0]
      }
      if (!body.force && !ancestors.has(this.refs.get(branch)!))
        return Response.json({ message: "Update is not a fast forward" }, { status: 422 })
      this.refs.set(branch, body.sha)
      return Response.json({ object: { sha: body.sha } })
    }
    if (method === "DELETE" && match) {
      if (!this.refs.delete(match[1]))
        return Response.json({ message: "Reference does not exist" }, { status: 422 })
      return new Response(null, { status: 204 })
    }
    if (method === "POST" && path === "/pulls") {
      if (!this.refs.has(body.head)) return Response.json({ message: "no head" }, { status: 422 })
      const number = this.pulls.size + 1
      const pull: FakePull = {
        number,
        node_id: `PR_${number}`,
        title: body.title,
        body: body.body,
        head: body.head,
        base: body.base,
        draft: body.draft === true,
        state: "open",
        merged: false,
        mergeable: true,
        merge_commit_sha: null,
      }
      this.pulls.set(number, pull)
      return Response.json(this.pullJson(pull), { status: 201 })
    }
    match = path.match(/^\/pulls\/(\d+)(\/merge)?$/)
    const pull = match ? this.pulls.get(Number(match[1])) : undefined
    if (match && !pull) return new Response("", { status: 404 })
    if (method === "GET" && pull && !match![2]) return Response.json(this.pullJson(pull))
    if (method === "PATCH" && pull && !match![2]) {
      for (const key of ["title", "body", "state"] as const) if (key in body) pull[key] = body[key]
      return Response.json(this.pullJson(pull))
    }
    if (method === "PUT" && pull && match![2]) {
      if (pull.draft)
        return Response.json({ message: "Pull Request is still a draft" }, { status: 405 })
      if (pull.state !== "open" || this.mergeable(pull) === false)
        return Response.json({ message: "Pull Request is not mergeable" }, { status: 405 })
      if (body.sha !== this.refs.get(pull.head))
        return Response.json({ message: "Head branch was modified" }, { status: 409 })
      pull.merge_method = body.merge_method ?? "merge"
      pull.merge_title = body.commit_title
      pull.merge_message = body.commit_message
      pull.merge_commit_sha =
        body.merge_method === "rebase" ? this.rebase(pull) : this.squash(pull, body.commit_title)
      pull.merged = true
      pull.state = "closed"
      return Response.json({ sha: pull.merge_commit_sha, merged: true })
    }
    match = path.match(/^\/commits\/(\w+)\/status$/)
    if (method === "GET" && match) {
      const statuses = this.statuses.get(match[1]) ?? []
      return Response.json({ state: statuses[0]?.state ?? "pending", statuses })
    }
    return new Response("", { status: 404 })
  }
}

export const vault = new FakeVault()
/** vault-private, where members' uploads go. */
export const privateVault = new FakeVault(
  "HafeziGroupJQI/vault-private",
  "test-vault-private-token",
)
