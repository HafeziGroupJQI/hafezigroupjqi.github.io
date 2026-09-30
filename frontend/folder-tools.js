// The tools of an automatic folder page (quartz/plugins/local/folder-index/), in its tools row
// (JqiFrame's [data-page-tools], whose data-folder is the folder's own path in the private vault).
// Such a page has no file of its own, so it has no Edit, History or Export. Each action is one
// entry of `folderActions`, so a new one is a new entry. Small and without dependencies: it is on
// every member page (member-tools.js).

import { h } from "./dashboard/dom.js"
import { uploadsUrl } from "./uploads/model.js"

/** What a folder page offers, from its tools row's data: `[{id, label, title, href}]`. */
export function folderActions(dataset) {
  const folder = dataset?.folder
  if (typeof folder !== "string" || !folder) return []
  return [
    {
      id: "upload",
      label: "Upload to this folder",
      title: `Add files to ${folder} in the private vault`,
      href: uploadsUrl("folder", folder),
    },
  ]
}

/** Put the folder's actions in its tools row, styled as a page's Edit button is. */
export function mountFolderTools(tools) {
  for (const action of folderActions(tools.dataset))
    tools.append(
      h("a", {
        class: "page-edit",
        "data-folder-action": action.id,
        href: action.href,
        title: action.title,
        text: action.label,
      }),
    )
}
