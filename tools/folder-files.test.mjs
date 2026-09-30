import assert from "node:assert/strict"
import test from "node:test"
import { folderMap, folderSlug } from "./folder-files.mjs"

test("a vault folder's slug is the one its pages and documents are served under", () => {
  assert.equal(
    folderSlug("notes/group-meeting-2026-09-29"),
    "resources/notes/group-meeting-2026-09-29",
  )
  assert.equal(folderSlug("files/rc26/Nonlinear code"), "resources/files/rc26/nonlinear-code")
  assert.equal(folderSlug("files/v1.2 drafts"), "resources/files/v1.2-drafts")
})

test("each folder lists its documents with sizes; images and notebooks are left out", () => {
  const folders = folderMap([
    { path: "README.pdf", size: 1 },
    { path: "notes/group-meeting-2026-09-29/summary.md", size: 900 },
    { path: "notes/group-meeting-2026-09-29/2606.23960v3.pdf", size: 31_600_000 },
    { path: "notes/group-meeting-2026-09-29/figure.png", size: 5000 },
    { path: "files/rc26/Nonlinear code/sweep 10.py", size: 2048 },
    { path: "files/rc26/Nonlinear code/sweep 2.py", size: 10 },
    { path: "files/rc26/Nonlinear code/run.ipynb", size: 70000 },
    { path: "files/rc26/Nonlinear code/guide.nb", size: 70000 },
    { path: "files/rc26/Nonlinear code/report.qmd", size: 700 },
    { path: "files/equipment/laser/manuals/Manual", size: 12 },
    { path: "assets/people/ada.jpg", size: 4000 },
  ])
  assert.deepEqual(Object.keys(folders), [
    "resources/files",
    "resources/files/equipment",
    "resources/files/equipment/laser",
    "resources/files/equipment/laser/manuals",
    "resources/files/rc26",
    "resources/files/rc26/nonlinear-code",
    "resources/notes",
    "resources/notes/group-meeting-2026-09-29",
  ])
  assert.deepEqual(folders["resources/notes/group-meeting-2026-09-29"], {
    name: "group-meeting-2026-09-29",
    path: "notes/group-meeting-2026-09-29",
    files: [
      {
        name: "2606.23960v3.pdf",
        href: "/resources/notes/group-meeting-2026-09-29/2606.23960v3.pdf",
        size: 31_600_000,
        type: "PDF",
      },
    ],
  })
  // The key is the folder's slug; its name and its path in the vault keep their spelling.
  const code = folders["resources/files/rc26/nonlinear-code"]
  assert.equal(code.name, "Nonlinear code")
  assert.equal(code.path, "files/rc26/Nonlinear code")
  assert.deepEqual(
    code.files.map((file) => [file.name, file.href]),
    [
      ["sweep 2.py", "/resources/files/rc26/nonlinear-code/sweep-2.py"],
      ["sweep 10.py", "/resources/files/rc26/nonlinear-code/sweep-10.py"],
    ],
  )
  // A folder that only holds folders is there so its children can be reached.
  assert.deepEqual(folders["resources/files/equipment"].files, [])
  assert.deepEqual(folders["resources/files/equipment/laser/manuals"].files, [
    {
      name: "Manual",
      href: "/resources/files/equipment/laser/manuals/manual",
      size: 12,
      type: "File",
    },
  ])
})
