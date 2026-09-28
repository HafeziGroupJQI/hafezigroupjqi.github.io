// An in-memory stand-in for the parts of GitHub's REST API the vault client uses (refs, commits,
// trees, blobs, contents), holding one branch, main. Tests seed it, read files back and look at
// the commits the Worker made.

type Snapshot = Map<string, Uint8Array>

interface Commit {
  sha: string
  tree: string
  parents: string[]
  message: string
  author: { name: string; email: string }
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

export class FakeVault {
  calls: string[] = []
  commits: Commit[] = []
  trees = new Map<string, Snapshot>()
  blobs = new Map<string, Uint8Array>()
  head = ""
  /** Called once before the next ref update, e.g. to simulate someone else's push. */
  beforeUpdate: (() => void) | null = null
  private counter = 0

  reset(files: Record<string, string | Uint8Array>): void {
    this.calls = []
    this.commits = []
    this.trees.clear()
    this.blobs.clear()
    this.beforeUpdate = null
    const snapshot: Snapshot = new Map()
    for (const [path, content] of Object.entries(files))
      snapshot.set(path, typeof content === "string" ? encoder.encode(content) : content)
    this.head = this.addCommit(this.addTree(snapshot), [], "seed", { name: "seed", email: "" })
  }

  /** A direct push to main (someone else's commit). */
  push(path: string, content: string): void {
    const snapshot = new Map(this.snapshot())
    snapshot.set(path, encoder.encode(content))
    this.head = this.addCommit(this.addTree(snapshot), [this.head], "direct push", {
      name: "other",
      email: "",
    })
  }

  snapshot(sha = this.head): Snapshot {
    const commit = this.commits.find((c) => c.sha === sha)!
    return this.trees.get(commit.tree)!
  }

  text(path: string): string | undefined {
    const bytes = this.snapshot().get(path)
    return bytes && decoder.decode(bytes)
  }

  bytes(path: string): Uint8Array | undefined {
    return this.snapshot().get(path)
  }

  /** Commits made after the seed, oldest first. */
  get made(): Commit[] {
    return this.commits.filter((c) => c.message !== "seed" && c.message !== "direct push")
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
    const sha = this.id("c")
    this.commits.push({ sha, tree, parents, message, author })
    return sha
  }

  fetch = async (input: string, init: RequestInit): Promise<Response> => {
    const url = new URL(input)
    const method = init.method ?? "GET"
    const prefix = "/repos/HafeziGroupJQI/vault"
    this.calls.push(`${method} ${url.pathname.replace(prefix, "")}`)
    if (!url.pathname.startsWith(prefix)) return new Response("", { status: 404 })
    if (!String((init.headers as Record<string, string>)?.authorization).startsWith("Bearer "))
      return new Response("", { status: 401 })
    const path = url.pathname.slice(prefix.length)
    const body = init.body ? JSON.parse(String(init.body)) : null
    if (method === "GET" && path === "/git/ref/heads/main")
      return Response.json({ object: { sha: this.head } })
    let match = path.match(/^\/git\/commits\/(\w+)$/)
    if (method === "GET" && match) {
      const commit = this.commits.find((c) => c.sha === match![1])
      return commit
        ? Response.json({ tree: { sha: commit.tree } })
        : new Response("", { status: 404 })
    }
    match = path.match(/^\/git\/trees\/(\w+)$/)
    if (method === "GET" && match) {
      const tree = this.trees.get(match[1])
      if (!tree) return new Response("", { status: 404 })
      return Response.json({ tree: [...tree.keys()].map((p) => ({ path: p, type: "blob" })) })
    }
    match = path.match(/^\/contents\/(.+)$/)
    if (method === "GET" && match) {
      const bytes = this.snapshot().get(decodeURIComponent(match[1]))
      return bytes
        ? Response.json({ content: b64(bytes), encoding: "base64" })
        : new Response("", { status: 404 })
    }
    if (method === "POST" && path === "/git/blobs") {
      const sha = this.id("b")
      this.blobs.set(sha, unb64(body.content))
      return Response.json({ sha }, { status: 201 })
    }
    if (method === "POST" && path === "/git/trees") {
      const snapshot = new Map(this.trees.get(body.base_tree))
      for (const entry of body.tree)
        if (entry.sha === null) snapshot.delete(entry.path)
        else snapshot.set(entry.path, this.blobs.get(entry.sha)!)
      return Response.json({ sha: this.addTree(snapshot) }, { status: 201 })
    }
    if (method === "POST" && path === "/git/commits") {
      const sha = this.addCommit(body.tree, body.parents, body.message, body.author)
      return Response.json({ sha }, { status: 201 })
    }
    if (method === "PATCH" && path === "/git/refs/heads/main") {
      const hook = this.beforeUpdate
      this.beforeUpdate = null
      hook?.()
      const commit = this.commits.find((c) => c.sha === body.sha)!
      if (commit.parents[0] !== this.head)
        return Response.json({ message: "Update is not a fast forward" }, { status: 422 })
      this.head = body.sha
      return Response.json({ object: { sha: body.sha } })
    }
    return new Response("", { status: 404 })
  }
}

export const vault = new FakeVault()
