// What the build writes into pages about other pages, when some of them are restricted (an access
// rule's, tools/acl/snapshot.mjs): lists of pages (a folder's list_pages, the drawings index, an
// equipment record's "Documents (members)") and embeds (`![[page]]`, `![](image)`). An item or embed
// of another rule than the page it is in goes inside an element with data-acl="<rule>", which the
// Worker keeps only for the members that rule lets in; the leak scan (tools/acl-leak-scan.mjs)
// allows a restricted page's words only there.

const escapeHtml = (text) =>
  String(text).replace(
    /[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c],
  )

/**
 * A Markdown list of `items` (`{href, title, acl}`, href a root-relative site path) in a page of
 * rule `pageAcl` (null: every member's): each item of that rule or none as `markdown(item)`, then
 * each other rule's items as an HTML list under its data-acl.
 */
export function aclList(items, pageAcl, markdown) {
  const open = items.filter((item) => !item.acl || item.acl === pageAcl)
  const byRule = new Map()
  for (const item of items)
    if (item.acl && item.acl !== pageAcl)
      byRule.set(item.acl, [...(byRule.get(item.acl) ?? []), item])
  const blocks = []
  if (open.length) blocks.push(open.map(markdown).join("\n"))
  for (const [acl, list] of byRule)
    blocks.push(
      `<ul data-acl="${escapeHtml(acl)}">\n` +
        list
          .map(
            (item) =>
              `<li><a class="internal" href="${escapeHtml(item.href)}">${escapeHtml(item.title)}</a></li>`,
          )
          .join("\n") +
        "\n</ul>",
    )
  return blocks.join("\n\n")
}

const EMBED = /!\[\[([^\]|#^]+)[^\]]*\]\]|!\[[^\]]*\]\(\s*<?([^)\s>]+)>?[^)]*\)/g

/**
 * A page's Markdown with every embed of a restricted page or file of another rule than `pageAcl`
 * wrapped in data-acl: an embed alone on its line in a <div> (a transcluded page is a block), any
 * other in a <span>. `aclOf(target)` is the rule of an embed's target, or null. Code is left alone.
 */
export function wrapEmbeds(text, pageAcl, aclOf) {
  let fence = null
  return text
    .split("\n")
    .map((line) => {
      const marker = /^\s*(`{3,}|~{3,})/.exec(line)?.[1]
      if (fence) {
        if (marker && marker[0] === fence[0] && marker.length >= fence.length) fence = null
        return line
      }
      if (marker) {
        fence = marker
        return line
      }
      const other = (target) => {
        const acl = aclOf(target)
        return acl && acl !== pageAcl ? acl : null
      }
      const embeds = [...line.matchAll(EMBED)]
      if (!embeds.some((match) => other(match[1] ?? match[2]))) return line
      const [only] = embeds
      if (embeds.length === 1 && line.trim() === only[0] && !/^ {4}|^\t/.test(line))
        return `<div data-acl="${escapeHtml(other(only[1] ?? only[2]))}">\n\n${line.trim()}\n\n</div>`
      return line.replace(EMBED, (embed, page, file) => {
        const acl = other(page ?? file)
        return acl ? `<span data-acl="${escapeHtml(acl)}">${embed}</span>` : embed
      })
    })
    .join("\n")
}
