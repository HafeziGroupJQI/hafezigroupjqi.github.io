import assert from "node:assert/strict"
import test from "node:test"
import { Description } from "@quartz-community/description"
import AclText, { describe, hasRestricted, openText } from "./index.js"

const text = (value) => ({ type: "text", value })
const element = (tagName, properties, children) => ({
  type: "element",
  tagName,
  properties,
  children,
})

const run = async (plugin, tree, frontmatter = {}) => {
  const file = { data: { frontmatter } }
  for (const make of plugin.htmlPlugins()) await make()(tree, file)
  return file.data
}

test("a page without restricted elements keeps the description plugin's text", async () => {
  const tree = {
    type: "root",
    children: [
      element("p", {}, [text("A first sentence about https://example.org/x. Then more.")]),
    ],
  }
  const quartz = await run(Description(), tree)
  assert.equal(hasRestricted(tree), false)
  assert.deepEqual(await run(AclText(), tree), { frontmatter: {} })
  // The same text and description as Quartz's, when made from the same words.
  assert.deepEqual(describe(openText(tree)), { text: quartz.text, description: quartz.description })
  const described = await run(Description(), tree, { description: "Mine: https://a.org/b" })
  assert.deepEqual(describe(openText(tree), "Mine: https://a.org/b"), {
    text: described.text,
    description: described.description,
  })
})

test("a restricted element's words leave the page's text and description", async () => {
  const tree = {
    type: "root",
    children: [
      element("p", {}, [text("Laser manuals & datasheets.")]),
      element("ul", { dataAcl: "r1" }, [element("li", {}, [text("Kerr microring meeting")])]),
      element("p", {}, [
        text("More "),
        element("span", { dataAcl: "r1" }, [text("secret")]),
        text("text."),
      ]),
    ],
  }
  const file = { data: { frontmatter: {}, text: "stale", description: "stale" } }
  for (const make of AclText().htmlPlugins()) await make()(tree, file)
  assert.equal(file.data.text, "Laser manuals &amp; datasheets.More text.")
  assert.doesNotMatch(file.data.description, /Kerr|secret/)
})
