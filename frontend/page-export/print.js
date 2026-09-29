// Printing a page (Ctrl+P, or Save as PDF in its Export menu): the print stylesheet (the end of
// quartz/styles/custom.scss) prints the article alone. Before it prints, each of the article's links
// gets its full address in data-print-href, which the stylesheet prints after the link, and folded
// sections are opened, then closed again after.

/**
 * The address a link prints after it: its full URL (an email link's address), or null where that
 * would say nothing the text doesn't (an anchor on the page, a tag, a link that reads as its own
 * address) or isn't a place (javascript:, a download made on the page). Pure, for node:test.
 */
export function printHref({ href, text, tag = false }, page) {
  let url
  try {
    url = new URL(href, page)
  } catch {
    return null
  }
  if (tag || !["http:", "https:", "mailto:"].includes(url.protocol)) return null
  const here = new URL(page)
  if (url.hash && url.origin === here.origin && url.pathname === here.pathname) return null
  const shown = url.protocol === "mailto:" ? decodeURIComponent(url.pathname) : url.href
  const bare = (value) => value.trim().replace(/\/$/, "")
  if ([shown, url.href].some((value) => bare(value) === bare(text))) return null
  return shown
}

export function preparePrint(article) {
  let opened = []
  addEventListener("beforeprint", () => {
    for (const link of article.querySelectorAll("a[href]")) {
      const href = printHref(
        { href: link.href, text: link.textContent, tag: link.classList.contains("tag-link") },
        location.href,
      )
      if (href) link.dataset.printHref = href
      else delete link.dataset.printHref
    }
    opened = [...article.querySelectorAll("details:not([open])")]
    for (const details of opened) details.open = true
  })
  addEventListener("afterprint", () => {
    for (const details of opened) details.open = false
    opened = []
  })
}
