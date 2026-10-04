import type { Env } from "../env"
import { type AclRefs, type AclViewer, aclRefs } from "./index"
import type { AclPolicy } from "./policy"

// The site's content index (static/contentIndex.json: search, the graph, the explorer, the
// editor's page completion) as one member may read it. The build leaves restricted pages out of it
// and writes each rule's pages to a shard of their own (static/acl-index/<rule>.json, the same
// serialization: "{" + entries joined by "," + "}", each JSON.stringify(slug) + ":" +
// JSON.stringify(value)), with each entry's offsets in the index (contentIndex.offsets.json).
// The Worker never parses the 2.6 MB index per request (Workers Free gives a request 10 ms of
// CPU): a member it hides nothing from gets the build's file as it is; otherwise the shards they
// may read are spliced in and any entry a live rule (newer than the build) keeps from them is cut
// out by its offsets. What a view comes to is kept per isolate by the rules it lets a member read.

interface ShardEntry {
  slug: string
  /** Its vault path, by which the live rules decide it. */
  path: string | null
  text: string
}

interface Parts {
  /** Base entries some live rule decides, with their offsets, for a policy version. */
  restricted: { version: number; entries: { path: string; at: [number, number] }[] } | null
  base: Promise<string> | null
  offsets: Promise<Record<string, [number, number]> | null> | null
  shards: Map<string, Promise<ShardEntry[]>>
  views: Map<string, Uint8Array>
}

/** Views of the index kept per isolate (each about the index's size). */
const VIEWS_KEPT = 4
let partsMemo = new WeakMap<object, Parts>()

/** Forget what this isolate keeps (tests). */
export const resetContentIndex = () => {
  partsMemo = new WeakMap()
}

const parts = (env: Pick<Env, "ASSETS">): Parts => {
  let kept = partsMemo.get(env.ASSETS)
  if (!kept) {
    kept = { restricted: null, base: null, offsets: null, shards: new Map(), views: new Map() }
    partsMemo.set(env.ASSETS, kept)
  }
  return kept
}

const asset = (env: Pick<Env, "ASSETS">, path: string) =>
  env.ASSETS.fetch(new Request(`https://assets.local/${path}`))

/** A page's vault path: the build's map says, else its site path under resources/ is it; a page
 *  elsewhere (the public site's) is in no rule's reach (null). */
export const slugPath = (refs: AclRefs, slug: string): string | null =>
  (Object.hasOwn(refs.pages, slug) ? refs.pages[slug] : undefined) ??
  (slug.startsWith("resources/") ? slug.slice("resources/".length) : null)

/** A rule's shard: its pages, each with its vault path and serialized entry (none: empty). */
export function shard(
  env: Pick<Env, "ASSETS">,
  refs: AclRefs,
  rule: string,
): Promise<ShardEntry[]> {
  const kept = parts(env)
  let entries = kept.shards.get(rule)
  if (!entries) {
    entries = asset(env, `static/acl-index/${encodeURIComponent(rule)}.json`)
      .then(async (response) => {
        if (!response.ok) return []
        const raw = (await response.json()) as Record<string, unknown>
        return Object.entries(raw).map(([slug, value]) => ({
          slug,
          path: slugPath(refs, slug),
          text: `${JSON.stringify(slug)}:${JSON.stringify(value)}`,
        }))
      })
      .catch(() => [])
    kept.shards.set(rule, entries)
  }
  return entries
}

/** The shards of every live rule, parsed: what Hafezi GPT adds to the index it searches. */
export async function shardValues(
  env: Pick<Env, "ASSETS">,
  policy: AclPolicy,
): Promise<Record<string, unknown>> {
  const refs = await aclRefs(env)
  const out: Record<string, unknown> = {}
  for (const rule of policy.rules)
    for (const entry of await shard(env, refs, rule.id))
      out[entry.slug] = JSON.parse(entry.text.slice(JSON.stringify(entry.slug).length + 1))
  return out
}

async function restrictedBase(env: Pick<Env, "ASSETS">, policy: AclPolicy, refs: AclRefs) {
  const kept = parts(env)
  if (kept.restricted?.version === policy.version) return kept.restricted.entries
  kept.offsets ??= asset(env, "static/contentIndex.offsets.json")
    .then((response) => (response.ok ? response.json() : null))
    .catch(() => null) as Promise<Record<string, [number, number]> | null>
  const offsets = await kept.offsets
  const entries: { path: string; at: [number, number] }[] = []
  if (offsets && !policy.empty)
    for (const [slug, at] of Object.entries(offsets)) {
      const path = slugPath(refs, slug)
      if (path !== null && policy.ruleFor(path)) entries.push({ path, at })
    }
  kept.restricted = { version: policy.version, entries }
  return entries
}

/**
 * GET /api/site/static/contentIndex.json for a member: `index` is the build's file as ASSETS
 * answered it. A member that sees everything the build left in and no shard gets it untouched.
 */
export async function contentIndexFor(
  env: Pick<Env, "ASSETS">,
  viewer: AclViewer,
  index: Response,
): Promise<Response> {
  if (!index.ok || viewer.policy.empty) return index
  const refs = await aclRefs(env)
  const cuts = viewer.open
    ? []
    : (await restrictedBase(env, viewer.policy, refs)).filter(
        (entry) => !viewer.canRead(entry.path),
      )
  const added: string[] = []
  for (const rule of viewer.policy.rules)
    for (const entry of await shard(env, refs, rule.id))
      if (entry.path === null || viewer.canRead(entry.path)) added.push(entry.text)
  if (!cuts.length && !added.length) return index
  const kept = parts(env)
  let body = kept.views.get(viewer.key)
  if (!body) {
    kept.base ??= index
      .clone()
      .text()
      .catch((error) => {
        kept.base = null
        throw error
      })
    body = new TextEncoder().encode(
      splice(
        await kept.base,
        cuts.map((cut) => cut.at),
        added,
      ),
    )
    if (kept.views.size >= VIEWS_KEPT) kept.views.delete(kept.views.keys().next().value!)
    kept.views.set(viewer.key, body)
  }
  await index.body?.cancel()
  const headers = new Headers(index.headers)
  headers.set("content-length", String(body.byteLength))
  headers.delete("etag")
  return new Response(body, { status: 200, headers })
}

/**
 * The index without the entries at `cuts` (each with the comma that joined it) and with `added`
 * entries before its closing brace.
 */
export function splice(base: string, cuts: [number, number][], added: string[]): string {
  const pieces: string[] = []
  let from = 0
  for (const [start, end] of [...cuts].sort((a, b) => a[0] - b[0])) {
    pieces.push(base.slice(from, start))
    // The comma after it; the last entry has none, and the one before it goes below.
    from = base[end] === "," ? end + 1 : end
  }
  pieces.push(base.slice(from))
  const out = pieces.join("")
  const close = out.lastIndexOf("}")
  let head = out.slice(0, close).replace(/,(\s*)$/, "$1")
  if (added.length) head = `${head}${/\{\s*$/.test(head) ? "" : ","}${added.join(",")}`
  return head + out.slice(close)
}
