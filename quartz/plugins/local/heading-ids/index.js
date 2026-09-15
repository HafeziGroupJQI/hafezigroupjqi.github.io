import rehypeSlug from "rehype-slug"

// Stable heading ids for in-page links (#section, [[note#heading]]) without the
// chain-link anchor that @quartz-community/github-flavored-markdown appends to every
// heading when its linkHeadings option is on.
export const manifest = {
  name: "heading-ids",
  displayName: "Heading ids",
  description: "Adds ids to headings without autolink anchors",
  version: "1.0.0",
  category: "transformer",
}

export default () => ({
  name: "HeadingIds",
  htmlPlugins: () => [rehypeSlug],
})
