// A ranked table (the leaderboard's members and pages): column headings, then a row of cells for
// each, a cell being text or {text, href, title}. The second cell names the row, as its header.
// Scrolls sideways on a narrow screen rather than squeezing its numbers.

import { h } from "../dashboard/dom.js"

const content = (cell) => {
  const { text, href, title } = typeof cell === "string" ? { text: cell } : cell
  return { node: href ? h("a", { href, text, title }) : text, title: href ? null : title }
}

export function rankTable(columns, rows) {
  return h(
    "div",
    { class: "recent-scores" },
    h(
      "table",
      {},
      h(
        "thead",
        {},
        h(
          "tr",
          {},
          columns.map((text) => h("th", { scope: "col", text })),
        ),
      ),
      h(
        "tbody",
        {},
        rows.map((cells) =>
          h(
            "tr",
            {},
            cells.map((cell, index) => {
              const { node, title } = content(cell)
              return h(index === 1 ? "th" : "td", index === 1 ? { scope: "row" } : { title }, node)
            }),
          ),
        ),
      ),
    ),
  )
}
