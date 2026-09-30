// What a page's tools row (JqiFrame's [data-page-tools]) says about the page's own file in its
// vault, which the build records in the page's front matter (tools/prepare-site.mjs,
// tools/prepare-unified.mjs, tools/notebooks/): Edit opens that file (frontend/member-tools.js,
// /edit), never the page the site made from it, and History lists its revisions from the
// <slug>.history.json the build writes beside the page. Pages the site makes whole have none.

const ATTRIBUTES = [
  ["edit_repo", "data-edit-repo"],
  ["edit_sha", "data-edit-sha"],
  ["edit_mode", "data-edit-mode"],
  ["edit_note", "data-edit-note"],
] as const

export function editAttributes(
  slug: string,
  frontmatter: Record<string, unknown> | undefined,
): Record<string, string> {
  const text = (key: string) =>
    typeof frontmatter?.[key] === "string" && frontmatter[key] ? (frontmatter[key] as string) : null
  const path = text("edit_path")
  if (!path) return {}
  const attributes: Record<string, string> = {
    "data-edit-path": path,
    "data-history": `/${slug}.history.json`,
  }
  for (const [key, attribute] of ATTRIBUTES) {
    const value = text(key)
    if (value) attributes[attribute] = value
  }
  return attributes
}
