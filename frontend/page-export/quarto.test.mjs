import assert from "node:assert/strict"
import test from "node:test"
import {
  convertBody,
  frontEntries,
  markdownToQmd,
  qmdFrontMatter,
  siteUrl,
  splitFrontMatter,
} from "./quarto.js"

const site = {
  slug: "resources/onboarding/git",
  origin: "https://hafezigroupjqi.github.io",
  allSlugs: [
    "index",
    "people/index",
    "people/mohammad-hafezi",
    "resources/onboarding/git",
    "resources/onboarding/ssh-keys",
    "resources/code/index",
    "resources/onboarding/figures/git-flow.png",
  ],
}
const url = (path) => site.origin + path

test("links resolve as Quartz resolves them (shortest path), to full URLs", () => {
  assert.equal(siteUrl("ssh-keys", site), url("/resources/onboarding/ssh-keys"))
  assert.equal(siteUrl("mohammad-hafezi", site), url("/people/mohammad-hafezi"))
  assert.equal(siteUrl("/resources/code/", site), url("/resources/code/"))
  assert.equal(siteUrl("../../people/", site), url("/people/"))
  assert.equal(siteUrl("ssh-keys#Add a key", site), url("/resources/onboarding/ssh-keys#add-a-key"))
  for (const kept of ["https://git-scm.com/book", "mailto:lab@umd.edu", "#top", ""])
    assert.equal(siteUrl(kept, site), kept)
})

test("front matter becomes Quarto's: the title, what Quarto reads, and tags as categories", () => {
  const front =
    'title: "Git: a tutorial"\ntype: page\nsite_public: true\ndate: 2026-09-28\nauthors:\n  - Ada\n  - Grace\ntags:\n  - internal\n  - onboarding\n  - tool/git\naliases:\n  - resources/git'
  assert.deepEqual(
    frontEntries(front).map((entry) => entry.key),
    ["title", "type", "site_public", "date", "authors", "tags", "aliases"],
  )
  assert.equal(
    qmdFrontMatter(front, "Git, the tutorial"),
    '---\ntitle: "Git, the tutorial"\ndate: 2026-09-28\nauthors:\n  - Ada\n  - Grace\ncategories:\n  - onboarding\n  - tool/git\n---',
  )
  // Without the page's title, the source's own; tags that were only "internal" are dropped.
  assert.equal(qmdFrontMatter("title: Notes\ntags:\n  - internal", ""), "---\ntitle: Notes\n---")
  assert.equal(qmdFrontMatter("tags: []", "A"), '---\ntitle: "A"\n---')
  assert.deepEqual(splitFrontMatter("# No front matter\n"), {
    front: null,
    body: "# No front matter\n",
  })
})

test("wikilinks and embeds become Markdown links and images with full URLs", () => {
  assert.equal(
    convertBody(
      "See [[ssh-keys]], [[ssh-keys#Add a key|adding a key]] and [[people/mohammad-hafezi]].",
      site,
    ),
    `See [ssh-keys](${url("/resources/onboarding/ssh-keys")}), [adding a key](${url("/resources/onboarding/ssh-keys#add-a-key")}) and [mohammad-hafezi](${url("/people/mohammad-hafezi")}).`,
  )
  assert.equal(
    convertBody("![[figures/git-flow.png|The flow|400]]\n![[git-flow.png|300x200]]", site),
    `![The flow](${url("/resources/onboarding/figures/git-flow.png")}){width="400px"}\n` +
      `![](${url("/resources/onboarding/figures/git-flow.png")}){width="300px" height="200px"}`,
  )
  // An embedded note is linked, not pulled in; a table cell's escaped pipe still separates.
  assert.equal(
    convertBody("![[ssh-keys]]", site),
    `[ssh-keys](${url("/resources/onboarding/ssh-keys")})`,
  )
  assert.equal(
    convertBody("| [[ssh-keys\\|keys]] |", site),
    `| [keys](${url("/resources/onboarding/ssh-keys")}) |`,
  )
})

test("Markdown and HTML links on the page get full URLs; code keeps its text", () => {
  assert.equal(
    convertBody(
      '[Code](/resources/code/) and <a href="../../people/">people</a>, ![fig](figures/git-flow.png "Flow")',
      site,
    ),
    `[Code](${url("/resources/code/")}) and <a href="${url("/people/")}">people</a>, ![fig](${url("/resources/onboarding/figures/git-flow.png")} "Flow")`,
  )
  const code = "`[[ssh-keys]]` and\n\n```md\n[[ssh-keys]] ==x== %%y%%\n```\n"
  assert.equal(convertBody(code, site), code)
})

test("highlights become marks and comments go", () => {
  assert.equal(
    convertBody(
      "A ==key point== here.%% a note to self\nacross lines %% Done; a == b stays.",
      site,
    ),
    "A [key point]{.mark} here. Done; a == b stays.",
  )
})

test("callouts become Quarto callout blocks, nested and folded ones too", () => {
  const markdown = [
    "> [!warning] Don't push to main",
    "> Open a pull request; see [[ssh-keys]].",
    ">",
    "> > [!example]-",
    "> > `git switch -c fix`",
    "",
    "> A plain quote stays.",
  ].join("\n")
  assert.equal(
    convertBody(markdown, site),
    [
      '::: {.callout-warning title="Don\'t push to main"}',
      `Open a pull request; see [ssh-keys](${url("/resources/onboarding/ssh-keys")}).`,
      "",
      '::: {.callout-note title="Example" collapse="true"}',
      "`git switch -c fix`",
      ":::",
      ":::",
      "",
      "> A plain quote stays.",
    ].join("\n"),
  )
  assert.equal(
    convertBody('> [!danger] "Quoted" [[ssh-keys|keys]]\n> Body', site),
    '::: {.callout-caution title="\\"Quoted\\" keys"}\nBody\n:::',
  )
})

test("a page's source as a .qmd: Quarto front matter over the converted body", () => {
  const source =
    "---\ntitle: Git\ntype: page\ntags:\n  - onboarding\n---\n\n# Git\n\n> [!tip]\n> Use [[ssh-keys]].\n"
  assert.equal(
    // The content index and the page's own links name some pages twice.
    markdownToQmd(source, {
      ...site,
      allSlugs: [...site.allSlugs, ...site.allSlugs],
      title: "Git tutorial",
    }),
    `---\ntitle: "Git tutorial"\ncategories:\n  - onboarding\n---\n\n# Git\n\n::: {.callout-tip}\nUse [ssh-keys](${url("/resources/onboarding/ssh-keys")}).\n:::\n`,
  )
})
