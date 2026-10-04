import fs from "node:fs"
import path from "node:path"
import { PRIVATE_REPO, readVaults, vaultOf } from "../../../../tools/acl/vaults.mjs"

// Each page's revisions, written next to its HTML (<slug>.history.json beside <slug>.html), for the
// page's History button (frontend/page-history/). A page gets one when the build recorded its own
// file in a vault (edit_repo and edit_path in its front matter: tools/prepare-site.mjs,
// tools/prepare-unified.mjs, tools/notebooks/); the revisions are that file's, from the vaults' git
// history (tools/history.mjs), which the build writes to the file SITE_HISTORY names. A history goes
// wherever its page goes: a public page's to GitHub Pages (the public vault is public anyway), a
// private page's into the Worker's assets, which only a signed-in member reaches.
export const manifest = {
  name: "page-history",
  displayName: "Page history",
  description: "Writes each page's revisions next to its HTML",
  version: "1.0.0",
  category: "emitter",
}

/** The page's own file in its vault, from the build's front matter keys, or null. */
export function vaultFile(frontmatter) {
  const { edit_repo: repo, edit_path: file, edit_sha: sha } = frontmatter ?? {}
  if (!["vault", "vault-private"].includes(repo) || typeof file !== "string" || !file) return null
  return { repo, path: file, sha: typeof sha === "string" ? sha : null }
}

/** Where a page's history goes in the output: beside its HTML, or nowhere without a vault file. */
export function historyPath(output, data) {
  const { slug, frontmatter } = data ?? {}
  if (!slug || !vaultFile(frontmatter)) return null
  return path.join(output, slug + ".history.json")
}

/**
 * A page's history file: its vault file and that file's revisions, newest first. A file of a
 * restricted vault mounted in the private one (`vaults`, worker/vaults.json) names that vault's
 * GitHub repository (`github`), for the History's commit links; only its members get the file.
 */
export function pageHistory(frontmatter, histories, vaults = []) {
  const file = vaultFile(frontmatter)
  const { revisions = [], more = false } = histories[`${file.repo}:${file.path}`] ?? {}
  const vault = file.repo === PRIVATE_REPO ? vaultOf(vaults, file.path) : file.repo
  return {
    ...file,
    ...(vault !== file.repo ? { github: `HafeziGroupJQI/${vault}` } : {}),
    revisions,
    more,
  }
}

export default () => ({
  name: "PageHistory",
  async *emit(ctx, content) {
    const source = process.env.SITE_HISTORY
    const histories =
      source && fs.existsSync(source) ? JSON.parse(await fs.promises.readFile(source, "utf8")) : {}
    const vaults = readVaults()
    for (const [, file] of content) {
      const destination = historyPath(ctx.argv.output, file.data)
      if (!destination) continue
      await fs.promises.mkdir(path.dirname(destination), { recursive: true })
      await fs.promises.writeFile(
        destination,
        JSON.stringify(pageHistory(file.data.frontmatter, histories, vaults)),
      )
      yield destination
    }
  },
})
