import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { render } from "preact-render-to-string"
import { h } from "preact"
import FolderIndex, {
  automaticPages,
  folderOf,
  folderRows,
  formatSize,
  modifiedDay,
} from "./index.js"
import { folderTitle } from "./names.js"

const page = (slug, frontmatter = {}, extra = {}) => [
  { type: "root", children: [] },
  {
    data: {
      slug,
      relativePath: slug + ".md",
      filePath: "/stage/content/" + slug + ".md",
      frontmatter: { title: slug.split("/").pop(), tags: [], ...frontmatter },
      ...extra,
    },
  },
]

const histories = {
  "vault-private:notes/group-meeting-2026-09-29/summary.md": {
    revisions: [{ date: "2026-09-29T23:40:00-04:00" }, { date: "2026-09-28T09:00:00-04:00" }],
  },
}

test("a folder's name reads as a title, and the dashes of a date stay", () => {
  assert.equal(folderTitle("group-meeting-2026-09-29"), "Group meeting 2026-09-29")
  assert.equal(folderTitle("lida_simulators-2026-09-29"), "Lida simulators 2026-09-29")
  assert.equal(folderTitle("Nonlinear code"), "Nonlinear code")
  assert.equal(folderTitle("rc26"), "Rc26")
  assert.equal(folderTitle("journal-club"), "Journal club")
})

test("quartz's folder pages keep their number and slugs and get readable titles", () => {
  const plugin = FolderIndex()
  const content = [
    page("resources/notes/index", { title: "Notes" }),
    page("resources/notes/group-meeting-2026-09-29/summary", { title: "Summary" }),
    page("resources/files/layout/rahul-gdsfactory/cells", { title: "Cells" }),
    page("people/index", { title: "People" }),
  ]
  const pages = plugin.generate({ content, cfg: { locale: "en-US" } })
  assert.deepEqual(
    pages.map((entry) => [entry.slug, entry.title]).sort(),
    [
      ["resources/files/index", "Files"],
      ["resources/files/layout/index", "Layout"],
      ["resources/files/layout/rahul-gdsfactory/index", "Rahul gdsfactory"],
      ["resources/index", "Resources"],
      ["resources/notes/group-meeting-2026-09-29/index", "Group meeting 2026-09-29"],
    ].sort(),
  )
  for (const entry of pages) {
    assert.equal(entry.data.frontmatter.title, entry.title)
    assert.equal(entry.data.frontmatter.folder_index, "auto")
    // No social image is drawn for an automatic page.
    assert.equal(entry.data.frontmatter.socialImage, "og-image.png")
  }
  // An index of its own keeps its title, and the wrapper is still quartz's folder page type.
  assert.equal(content[0][1].data.frontmatter.title, "Notes")
  assert.equal(plugin.name, "FolderPage")
  assert.equal(plugin.layout, "folder")
  assert.equal(plugin.match({ slug: "people/index" }), true)
  assert.equal(plugin.match({ slug: "people/ada" }), false)
  assert.deepEqual(automaticPages([]), [])
  // A tag's folder is left to Quartz as it was.
  const tag = { slug: "tags/role/index", title: "role", data: {} }
  assert.equal(automaticPages([tag])[0], tag)
})

test("a page's day is its newest revision's in the vault, and nothing without one", () => {
  const summary = {
    edit_repo: "vault-private",
    edit_path: "notes/group-meeting-2026-09-29/summary.md",
  }
  assert.equal(modifiedDay(summary, histories), "2026-09-29")
  assert.equal(modifiedDay({ ...summary, edit_path: "notes/other.md" }, histories), null)
  assert.equal(modifiedDay({ title: "Made by the build" }, histories), null)
  assert.equal(modifiedDay(summary, {}), null)
  assert.equal(folderOf("resources/notes/index"), "resources/notes")
})

const files = [
  { slug: "resources/notes/index", frontmatter: { title: "Notes" } },
  {
    slug: "resources/notes/zebra",
    frontmatter: { title: "zebra crossing", tags: ["internal", "planning"] },
  },
  {
    slug: "resources/notes/group-meeting-2026-09-29/index",
    frontmatter: { title: "Group meeting 2026-09-29", folder_index: "auto" },
  },
  {
    slug: "resources/notes/group-meeting-2026-09-29/summary",
    frontmatter: {
      title: "Summary",
      description: " What was decided. ",
      edit_repo: "vault-private",
      edit_path: "notes/group-meeting-2026-09-29/summary.md",
    },
  },
  { slug: "resources/notes/Apple", frontmatter: { title: "Apple" } },
  { slug: "resources/notes/chapter-10", frontmatter: { title: "Chapter 10" } },
  { slug: "resources/notes/chapter-2", frontmatter: { title: "Chapter 2" } },
  { slug: "resources/notes/hidden", unlisted: true, frontmatter: { title: "Hidden" } },
  { slug: "resources/notes/archive/index", frontmatter: { title: "Archive" } },
  { slug: "resources/notes/archive/old/deep", frontmatter: { title: "Deep" } },
  { slug: "resources/notes-other/page", frontmatter: { title: "Elsewhere" } },
]

test("a folder lists its subfolders first, then its own pages, each A to Z", () => {
  const rows = folderRows("resources/notes/index", files, histories)
  assert.deepEqual(
    rows.map((row) => [row.title, row.folder]),
    [
      ["Archive", true],
      ["Group meeting 2026-09-29", true],
      ["Apple", false],
      ["Chapter 2", false],
      ["Chapter 10", false],
      ["zebra crossing", false],
    ],
  )
  // Only a page has a day, and only from the vault's history: never the build's time.
  assert.ok(rows.every((row) => row.day === null))
  const [summary] = folderRows("resources/notes/group-meeting-2026-09-29/index", files, histories)
  assert.deepEqual(summary, {
    slug: "resources/notes/group-meeting-2026-09-29/summary",
    title: "Summary",
    folder: false,
    description: "What was decided.",
    day: "2026-09-29",
    tags: [],
    acl: null,
  })
})

test("an automatic page shows the listing; a page with its own index is quartz's, unchanged", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "folder-index-"))
  const saved = process.env.SITE_HISTORY
  try {
    process.env.SITE_HISTORY = path.join(directory, "history.json")
    fs.writeFileSync(process.env.SITE_HISTORY, JSON.stringify(histories))
    const Body = FolderIndex().body()
    const props = (slug, frontmatter, filePath) => ({
      fileData: { slug, frontmatter, filePath },
      allFiles: files,
      cfg: { locale: "en-US" },
      tree: { type: "root", children: [] },
      ctx: {},
    })
    const auto = render(
      h(
        Body,
        props("resources/notes/group-meeting-2026-09-29/index", {
          title: "Group meeting 2026-09-29",
          folder_index: "auto",
        }),
      ),
    )
    assert.match(auto, /^<div class="page-listing folder-listing">/)
    assert.match(auto, /<time datetime="2026-09-29">Sep 29, 2026<\/time>/)
    assert.match(
      auto,
      /<a href="\.\.\/\.\.\/\.\.\/resources\/notes\/group-meeting-2026-09-29\/summary" class="internal">/,
    )
    assert.match(auto, /<p class="folder-listing__description">What was decided\.<\/p>/)
    const notes = render(
      h(Body, props("resources/notes/index", { title: "Notes", folder_index: "auto" })),
    )
    assert.ok(notes.indexOf("Group meeting 2026-09-29") < notes.indexOf("Apple"))
    assert.match(notes, /<p class="meta">Folder<\/p>/)
    assert.match(notes, /class="internal tag-link" href="\.\.\/\.\.\/tags\/planning"/)
    assert.doesNotMatch(notes, /<time/)
    // Quartz's own rendering, with its listing (hidden by the site's styles) and none of ours.
    const own = render(h(Body, props("resources/notes/index", { title: "Notes" }, "/x/index.md")))
    assert.doesNotMatch(own, /folder-listing/)
    assert.match(own, /<div class="page-listing">/)
  } finally {
    if (saved === undefined) delete process.env.SITE_HISTORY
    else process.env.SITE_HISTORY = saved
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

const folders = {
  "resources/files": { name: "files", path: "files", files: [] },
  "resources/files/equipment": { name: "equipment", path: "files/equipment", files: [] },
  "resources/files/equipment/laser-2": {
    name: "Laser 2",
    path: "files/equipment/Laser 2",
    files: [
      {
        name: "Manual.pdf",
        href: "/resources/files/equipment/laser-2/manual.pdf",
        size: 31_600_000,
        type: "PDF",
      },
    ],
  },
  "resources/files/rc26/nonlinear-code": {
    name: "Nonlinear code",
    path: "files/rc26/Nonlinear code",
    files: [],
  },
  "resources/notes": { name: "notes", path: "notes", files: [] },
}

test("a folder that holds only documents gets a page too", () => {
  const quartz = [
    { slug: "resources/files/index", title: "files", data: {} },
    { slug: "resources/files/rc26/nonlinear-code/index", title: "nonlinear-code", data: {} },
  ]
  const pages = automaticPages(quartz, ["resources/notes", "resources"], folders)
  assert.deepEqual(
    pages.map((entry) => [entry.slug, entry.title, entry.data.frontmatter.folder_path]),
    [
      ["resources/files/index", "Files", "files"],
      // Quartz's page, with the folder's own path in the vault for its tools.
      ["resources/files/rc26/nonlinear-code/index", "Nonlinear code", "files/rc26/Nonlinear code"],
      ["resources/files/equipment/index", "Equipment", "files/equipment"],
      ["resources/files/equipment/laser-2/index", "Laser 2", "files/equipment/Laser 2"],
    ],
  )
  // A folder with an index of its own (notes) gets none, and neither does any without the map.
  assert.equal(automaticPages(quartz, [], {}).length, 2)
  assert.equal(automaticPages(quartz, [], {})[0].data.frontmatter.folder_path, undefined)
})

test("an automatic page lists the folder's documents as downloads, with type and size", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "folder-index-"))
  const saved = process.env.SITE_FOLDERS
  try {
    process.env.SITE_FOLDERS = path.join(directory, "folders.json")
    fs.writeFileSync(process.env.SITE_FOLDERS, JSON.stringify(folders))
    const Body = FolderIndex().body()
    const html = render(
      h(Body, {
        fileData: {
          slug: "resources/files/equipment/laser-2/index",
          frontmatter: { title: "Laser 2", folder_index: "auto" },
        },
        allFiles: [],
        cfg: { locale: "en-US" },
        tree: { type: "root", children: [] },
      }),
    )
    assert.match(html, /<h2 id="files">Files<\/h2>/)
    assert.match(
      html,
      /<p class="meta">PDF, 31\.6 MB<\/p><div class="desc"><a href="\/resources\/files\/equipment\/laser-2\/manual\.pdf" class="internal" data-no-popover="true">Manual\.pdf<\/a>/,
    )
    assert.doesNotMatch(html, /no pages yet/)
    // The generator reads the same map.
    const pages = FolderIndex().generate({ content: [], cfg: {} })
    assert.ok(pages.some((entry) => entry.slug === "resources/files/equipment/laser-2/index"))
  } finally {
    if (saved === undefined) delete process.env.SITE_FOLDERS
    else process.env.SITE_FOLDERS = saved
    fs.rmSync(directory, { recursive: true, force: true })
  }
  assert.equal(formatSize(999), "999 B")
  assert.equal(formatSize(2048), "2.0 kB")
  assert.equal(formatSize(31_600_000), "31.6 MB")
  assert.equal(formatSize(316_000_000), "316 MB")
  assert.equal(formatSize(1_500_000_000), "1.5 GB")
})

test("restricted pages, folders and files are listed under data-acl on other rules' pages", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "folder-index-"))
  const saved = process.env.SITE_FOLDERS
  try {
    process.env.SITE_FOLDERS = path.join(directory, "folders.json")
    fs.writeFileSync(
      process.env.SITE_FOLDERS,
      JSON.stringify({
        "resources/projects": { name: "projects", path: "projects", files: [] },
        "resources/projects/optical-rl": {
          name: "optical-rl",
          path: "projects/optical-rl",
          acl: "r1",
          files: [],
        },
        "resources/projects/optical-rl/files": {
          name: "files",
          path: "projects/optical-rl/files",
          acl: "r1",
          files: [{ name: "run.py", href: "/x/run.py", size: 9, type: "PY", acl: "r1" }],
        },
      }),
    )
    // A restricted folder's automatic page is its rule's, and unlisted.
    const [optical] = automaticPages([], [], {
      "resources/projects/optical-rl": {
        name: "optical-rl",
        path: "projects/optical-rl",
        acl: "r1",
      },
    })
    assert.equal(optical.data.unlisted, true)
    assert.equal(optical.data.frontmatter.acl, "r1")
    assert.equal(optical.data.frontmatter.unlisted, true)
    assert.equal(automaticPages([], [], folders)[0].data.unlisted, undefined)

    const all = [
      { slug: "resources/projects/index", frontmatter: { title: "Projects index" } },
      { slug: "resources/projects/topo", frontmatter: { title: "Topo log" } },
      {
        slug: "resources/projects/optical-rl/index",
        unlisted: true,
        frontmatter: { title: "Optical rl", folder_index: "auto", acl: "r1" },
      },
      {
        slug: "resources/projects/optical-rl/meeting",
        unlisted: true,
        frontmatter: { title: "Kerr microring meeting", acl: "r1" },
      },
      {
        slug: "resources/projects/optical-rl/files/index",
        unlisted: true,
        frontmatter: { title: "Files", folder_index: "auto", acl: "r1" },
      },
      { slug: "resources/projects/draft", unlisted: true, frontmatter: { title: "Draft" } },
    ]
    const rows = folderRows("resources/projects/index", all)
    assert.deepEqual(
      rows.map((row) => [row.title, row.acl]),
      [
        ["Optical rl", "r1"],
        ["Topo log", null],
      ],
    )
    const Body = FolderIndex().body()
    const props = (slug, frontmatter, filePath) => ({
      fileData: { slug, frontmatter, filePath },
      allFiles: all,
      cfg: { locale: "en-US" },
      tree: { type: "root", children: [] },
      ctx: {},
    })
    // The rule's own folder page lists its pages and files plainly.
    const own = render(
      h(
        Body,
        props("resources/projects/optical-rl/index", {
          title: "Optical rl",
          folder_index: "auto",
          acl: "r1",
        }),
      ),
    )
    assert.match(own, /Kerr microring meeting/)
    assert.doesNotMatch(own, /data-acl/)
    const files = render(
      h(
        Body,
        props("resources/projects/optical-rl/files/index", {
          title: "Files",
          folder_index: "auto",
          acl: "r1",
        }),
      ),
    )
    assert.match(files, /run\.py/)
    assert.doesNotMatch(files, /data-acl/)
    // Another folder's automatic page tags them.
    const auto = render(
      h(Body, props("resources/projects/index", { title: "Projects", folder_index: "auto" })),
    )
    assert.match(auto, /<li class="section-li" data-acl="r1">[^]*?Optical rl/)
    assert.doesNotMatch(auto, /Draft/)
    // A page with an index of its own: Quartz's listing without them, then theirs under data-acl.
    const index = render(
      h(Body, props("resources/projects/index", { title: "Projects index" }, "/x/index.md")),
    )
    const tagged = index.indexOf('data-acl="r1"')
    assert.ok(tagged > 0)
    assert.ok(index.indexOf("Topo log") < tagged)
    // Nothing before the tagged rows names the restricted folder.
    assert.ok(index.indexOf("ptical") > tagged)
    assert.match(index, /<p>1 item under this folder\.<\/p>/)
  } finally {
    if (saved === undefined) delete process.env.SITE_FOLDERS
    else process.env.SITE_FOLDERS = saved
    fs.rmSync(directory, { recursive: true, force: true })
  }
})
