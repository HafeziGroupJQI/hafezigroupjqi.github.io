import fs from "node:fs"
import path from "node:path"

// The members build's restricted pages, as Quartz sees them (tools/acl/): a page an access rule
// matches is unlisted, so Quartz's content index (@quartz-community/content-index) leaves it out.
// This writes, to the file SITE_ACL_PAGES names, what the build needs of every private page for
// its access outputs (tools/acl/outputs.mjs):
//   entries  each restricted page's content index entry, by rule, made as content-index makes them
//            (the Worker splices a rule's into contentIndex.json for the members it lets in);
//   pages    each private page's site path (its slug) and its own file in the vault;
//   aliases  each private page's alias pages and its case-preserving redirect (alias-redirects),
//            which name the page they lead to.
// Without SITE_ACL_PAGES (the public edition) it writes nothing.
export const manifest = {
  name: "acl-index",
  displayName: "Restricted pages",
  description: "Records the restricted pages' search index entries and every private page's file",
  version: "1.0.0",
  category: "emitter",
}

/** A page's access rule, or null when no rule restricts it. */
const aclOf = (frontmatter) =>
  typeof frontmatter?.acl === "string" && frontmatter.acl ? frontmatter.acl : null

/**
 * A private page's own file in the vault: its edit_path (tools/prepare-unified.mjs,
 * tools/notebooks/), or for a restricted page without one, its path under resources/.
 */
export function pageVaultPath(data) {
  const { edit_repo: repo, edit_path: file } = data?.frontmatter ?? {}
  if (repo === "vault-private" && typeof file === "string" && file) return file
  const relative = data?.relativePath
  if (aclOf(data?.frontmatter) && typeof relative === "string" && relative.startsWith("resources/"))
    return relative.slice("resources/".length)
  return null
}

/** A page's content index entry, as @quartz-community/content-index 0.1 makes it. */
export function indexEntry(data) {
  const frontmatter = data.frontmatter ?? {}
  return {
    slug: data.slug,
    filePath: data.relativePath,
    title: frontmatter.title ?? "",
    links: data.links ?? [],
    tags: frontmatter.tags ?? [],
    content: data.text ?? "",
  }
}

// alias-redirects' case-preserving slug of a file path (@quartz-community/alias-redirects 0.1, MIT):
// where it writes a redirect to a page whose path has capitals.
function preserveCase(relativePath) {
  const file = relativePath.replace(/^\/+|\/+$/g, "")
  const ext = /\.[A-Za-z0-9]+$/.exec(file)?.[0]
  const stem = ext ? file.slice(0, -ext.length) : file
  let slug = stem
    .split("/")
    .map((segment) =>
      segment
        .replace(/\s/g, "-")
        .replace(/&/g, "-and-")
        .replace(/%/g, "-percent")
        .replace(/\?/g, "")
        .replace(/#/g, ""),
    )
    .join("/")
    .replace(/\/$/, "")
  if (slug.endsWith("_index")) slug = slug.replace(/_index$/, "index")
  const segments = slug.split("/")
  if (segments.length >= 2 && segments.at(-1) === segments.at(-2)) {
    segments[segments.length - 1] = "index"
    slug = segments.join("/")
  }
  return slug + ([".md", ".html", undefined].includes(ext) ? "" : ext)
}

/** What the build records of the pages: `{entries, pages, aliases}` (see above). */
export function aclPages(content) {
  const entries = {}
  const pages = {}
  const aliases = {}
  for (const [, file] of content) {
    const data = file.data ?? {}
    if (!data.slug) continue
    const vaultPath = pageVaultPath(data)
    const acl = aclOf(data.frontmatter)
    if (acl && data.unlisted === true) (entries[acl] ??= {})[data.slug] = indexEntry(data)
    if (!vaultPath) continue
    pages[data.slug] = vaultPath
    for (const alias of data.aliases ?? []) aliases[String(alias)] = vaultPath
    if (typeof data.relativePath === "string") {
      const preserved = preserveCase(data.relativePath)
      if (preserved !== data.slug) aliases[preserved] = vaultPath
    }
  }
  return { entries, pages, aliases }
}

export default () => ({
  name: "AclIndex",
  async *emit(_ctx, content) {
    const destination = process.env.SITE_ACL_PAGES
    if (!destination) return
    await fs.promises.mkdir(path.dirname(destination), { recursive: true })
    await fs.promises.writeFile(destination, JSON.stringify(aclPages(content)))
  },
})
