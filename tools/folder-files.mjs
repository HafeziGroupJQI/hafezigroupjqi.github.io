// The private vault's folders, for the members edition's automatic folder pages
// (quartz/plugins/local/folder-index/): every folder that holds a page or a document, with its own
// path in the vault and its documents as the Worker serves them (docs-manifest.mjs). The build
// writes it to the file SITE_FOLDERS names. Images are a page's own assets and notebooks and Quarto
// documents have a page each, so neither is listed as a file; a folder of images alone has no entry.
import path from "node:path"
import { documentKey, imagePattern, isDocument, listVaultFiles } from "./docs-manifest.mjs"

const rendered = /\.(?:qmd|ipynb|nb)$/i

/** A vault folder's place on the site: "notes/Group Meeting" is "resources/notes/group-meeting". */
export const folderSlug = (folder, prefix = "resources") =>
  path.posix.dirname(documentKey(`${folder}/index.md`, prefix))

const byName = (a, b) => a.name.localeCompare(b.name, "en", { numeric: true, sensitivity: "base" })

/**
 * `{<folder's slug>: {name, path, files}}` from the vault's tracked files
 * (`{path, size}`), where a file is `{name, href, size, type}`. Every folder above a listed one has
 * an entry too, so each can be reached from its parent; the vault's root has none.
 */
export function folderMap(files, { prefix = "resources" } = {}) {
  const folders = {}
  const entry = (folder) => {
    const key = folderSlug(folder, prefix)
    if (!folders[key]) {
      folders[key] = { name: path.posix.basename(folder), path: folder, files: [] }
      const parent = path.posix.dirname(folder)
      if (parent !== ".") entry(parent)
    }
    return folders[key]
  }
  for (const file of files) {
    const folder = path.posix.dirname(file.path)
    if (folder === "." || imagePattern.test(file.path)) continue
    const own = entry(folder)
    if (!isDocument(file.path) || rendered.test(file.path)) continue
    own.files.push({
      name: path.posix.basename(file.path),
      href: "/" + documentKey(file.path, prefix),
      size: file.size,
      type: path.posix.extname(file.path).slice(1).toUpperCase() || "File",
    })
  }
  for (const folder of Object.values(folders)) folder.files.sort(byName)
  return Object.fromEntries(Object.entries(folders).sort(([a], [b]) => a.localeCompare(b)))
}

/** The folder map of the private vault at `privateRoot` (its committed files), with the restricted
 *  vaults overlaid on it (`restricted`, tools/acl/vaults.mjs). */
export const vaultFolders = (
  privateRoot,
  { excluded = new Set(), prefix = "resources", restricted = [] } = {},
) => folderMap(listVaultFiles(privateRoot, { excluded, restricted }), { prefix })
