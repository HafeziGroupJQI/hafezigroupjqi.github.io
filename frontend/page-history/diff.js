// The difference between two versions of a page's file, for its History (frontend/page-history/),
// as GitHub and MediaWiki show one: line by line or side by side, with the words changed within a
// line marked. jsdiff (BSD-3-Clause) makes the patch and diff2html (MIT) draws it. diff2html escapes
// every line it draws, so HTML or a script in a revision shows as text and never runs (pinned by
// diff.test.mjs); the file name it would draw is a fixed word, never a path, and hidden. Loaded
// only once a comparison is asked for.
import { createTwoFilesPatch } from "diff"
import { html } from "diff2html"

/** Give up on a comparison after this long: the files are too different to show line by line. */
const TIMEOUT_MS = 4000

/**
 * The comparison's HTML, or null when the two versions are the same. Throws when they are too
 * different to compare in the browser.
 */
export function diffHtml(before, after, { sideBySide = false, dark = false } = {}) {
  const patch = createTwoFilesPatch("page", "page", before, after, "", "", {
    context: 3,
    timeout: TIMEOUT_MS,
  })
  if (patch === undefined) throw new Error("these versions are too different to compare here")
  if (!/^@@/m.test(patch)) return null
  return html(patch, {
    drawFileList: false,
    matching: "lines",
    diffStyle: "word",
    outputFormat: sideBySide ? "side-by-side" : "line-by-line",
    colorScheme: dark ? "dark" : "light",
  })
}
