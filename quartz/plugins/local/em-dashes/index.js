import { visit } from "unist-util-visit"

// `---` in running text is an em dash in Pandoc, LaTeX and SmartyPants' old-school mode, which is
// how documents written for a PDF (and Quarto output) spell it. The site's SmartyPants
// (@quartz-community/github-flavored-markdown) turns `--` into an em dash but leaves `---` as three
// hyphens, so this does the rest: in text only, never in code, and not inside a name like
// `simulations---Lumerical`. It runs before the table of contents so headings read the same there.
export const manifest = {
  name: "em-dashes",
  displayName: "Em dashes",
  description: "Renders --- in text as an em dash",
  version: "1.0.0",
  category: "transformer",
}

const dash = /(?<!-)(?:(?<!\w)---|---(?!\w))(?!-)/g

export function remarkEmDashes() {
  return (tree) => {
    visit(tree, "text", (node) => {
      if (node.value.includes("---")) node.value = node.value.replace(dash, "—")
    })
  }
}

export default () => ({
  name: "EmDashes",
  markdownPlugins: () => [remarkEmDashes],
})
