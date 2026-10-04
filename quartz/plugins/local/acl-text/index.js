import { escapeHTML } from "@quartz-community/utils"

// A page's text and description without what it holds of restricted pages of other rules: the
// elements the members build tags data-acl (tools/acl/lists.mjs), which the Worker shows only to
// the members a rule lets in. Quartz's description plugin (@quartz-community/description 0.1, MIT)
// reads the whole page into its text (the search index's) and its description (the page's meta
// description and social image), so this runs right after it and, on a page with such elements,
// makes both again the same way from the page without them. Other pages are left as they are.
export const manifest = {
  name: "acl-text",
  displayName: "Restricted text",
  description: "Keeps restricted pages' words out of other pages' search text and description",
  version: "1.0.0",
  category: "transformer",
}

const DESCRIPTION_LENGTH = 150
const MAX_DESCRIPTION_LENGTH = 300
const urlRegex =
  /(https?:\/\/)?(?<domain>([\da-z.-]+)\.([a-z.]{2,6})(:\d+)?)(?<path>[/\w.-]*)(\?[/\w.=&;-]*)?/g

const restricted = (node) => node.type === "element" && node.properties?.dataAcl !== undefined

/** Whether a tree has an element tagged data-acl. */
export const hasRestricted = (node) => restricted(node) || (node.children ?? []).some(hasRestricted)

/** A tree's text (hast-util-to-string's), without its data-acl elements. */
export function openText(node) {
  if (restricted(node)) return ""
  if (node.type === "text") return node.value
  return "children" in node ? node.children.map(openText).join("") : ""
}

/** The page's text and description as the description plugin makes them, from `text`. */
export function describe(text, frontmatterDescription) {
  const escaped = escapeHTML(text).replace(urlRegex, "$<domain>$<path>")
  if (frontmatterDescription)
    return {
      text: escaped,
      description: frontmatterDescription.replace(urlRegex, "$<domain>$<path>"),
    }
  const sentences = escaped.replace(/\s+/g, " ").split(/\.\s/)
  let description = ""
  for (let index = 0; index < sentences.length; index++) {
    const sentence = sentences[index]
    if (!sentence) break
    const current = sentence.endsWith(".") ? sentence : sentence + "."
    const length = description.length + current.length + (description ? 1 : 0)
    if (length > DESCRIPTION_LENGTH && index > 0) break
    description += (description ? " " : "") + current
  }
  return {
    text: escaped,
    description:
      description.length > MAX_DESCRIPTION_LENGTH
        ? description.slice(0, MAX_DESCRIPTION_LENGTH) + "..."
        : description,
  }
}

export default () => ({
  name: "AclText",
  htmlPlugins() {
    return [
      () => (tree, file) => {
        if (!hasRestricted(tree)) return
        Object.assign(file.data, describe(openText(tree), file.data.frontmatter?.description))
      },
    ]
  },
})
