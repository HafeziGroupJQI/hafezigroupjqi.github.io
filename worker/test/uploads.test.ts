import { SELF, env } from "cloudflare:test"
import { beforeEach, describe, expect, it } from "vitest"
import { HttpError } from "../src/http"
import { dueAt } from "../src/profile/routes"
import { mergeTitle, plainName, summary, uploadTitle } from "../src/uploads/drafts"
import { PrivateVault } from "../src/uploads/github"
import { mergeDue } from "../src/uploads/merge"
import {
  FILE_MAX,
  activeHtml,
  checkContent,
  codeCells,
  pageProblems,
  vaultFolder,
  vaultPath,
} from "../src/uploads/rules"
import { ORIGIN, as, auditRows } from "./helpers"
import { privateVault as repo } from "./worker"

const NOTE = `---
title: Lab meeting
date: 2026-09-29
type: note
tags: [internal, notes]
---

Minutes.
`

const encoder = new TextEncoder()
/** A PDF whose length isn't a multiple of 3, so its base64 needs padding across stream chunks. */
const PDF = (() => {
  const bytes = new Uint8Array(200_003)
  bytes.set(encoder.encode("%PDF-1.4\n"))
  for (let i = 9; i < bytes.length; i++) bytes[i] = (i * 7) % 256
  return bytes
})()

type Client = Awaited<ReturnType<typeof as>>

beforeEach(async () => {
  repo.reset({
    "README.md": "# vault-private\n",
    ".github/workflows/validate.yml": "on: pull_request\n",
    "tools/validate.mjs": "\n",
    "notes/meeting.md": NOTE,
    "notes/old.pdf": "%PDF-1.4 old",
    "files/data.csv": "a,b\n1,2\n",
    "files/more.csv": "c\n3\n",
    "code/wolfram-guide/intro.nb": "(* Content-type: application/vnd.wolfram.mathematica *)\n",
  })
  await env.DB.prepare("DELETE FROM upload_changes").run()
  await env.DB.prepare("DELETE FROM upload_drafts").run()
  await env.DB.prepare(
    "DELETE FROM audit_log WHERE action LIKE 'uploads.%' OR action LIKE 'admin.uploads.%'",
  ).run()
  const staged = await env.ARTIFACTS.list({ prefix: "uploads/" })
  if (staged.objects.length) await env.ARTIFACTS.delete(staged.objects.map((o) => o.key))
})

const create = async (client: Client, note = "") =>
  client.json("/api/uploads/drafts", { method: "POST", body: JSON.stringify({ note }) })

const stage = (client: Client, id: string, path: string, body: BodyInit, mode = "add") =>
  client.json(`/api/uploads/drafts/${id}/file?${new URLSearchParams({ path, mode })}`, {
    method: "PUT",
    headers: { "content-type": "application/octet-stream" },
    body,
  })

const change = (client: Client, id: string, body: object) =>
  client.json(`/api/uploads/drafts/${id}/changes`, { method: "POST", body: JSON.stringify(body) })

const send = (client: Client, id: string) =>
  client.json(`/api/uploads/drafts/${id}/send`, { method: "POST" })

/** The status a rule refuses a value with (0: accepted). */
function refusal(check: () => unknown): number {
  try {
    check()
    return 0
  } catch (error) {
    if (error instanceof HttpError) return error.status
    throw error
  }
}

describe("uploads: what may be uploaded", () => {
  it("takes paths under the vault's content folders only", () => {
    expect(vaultPath("notes/a.md")).toBe("notes/a.md")
    expect(vaultPath("files/equipment/Attocube/manual.pdf")).toBe(
      "files/equipment/Attocube/manual.pdf",
    )
    expect(vaultPath("notes/cafe\u0301.md")).toBe("notes/caf\u00e9.md")
    for (const path of [
      ".github/workflows/validate.yml",
      "tools/validate.mjs",
      "templates/note.md",
      "gpt/skills/x/SKILL.md",
      "_freeze/code/x.json",
      "README.md",
      "notes.md",
      "notes/../tools/validate.mjs",
      "notes/./a.md",
      "/notes/a.md",
      "notes//a.md",
      "notes/a.md/",
      "notes/.hidden.md",
      "notes/.obsidian/a.json",
      "notes/sub/tools/a.py",
      "notes/sub/node_modules/a.py",
      "notes/README.md",
      "notes/ a.md",
      "notes/a:b.md",
      "notes/a#b.md",
      "notes/a\u0000.md",
      "notes\\a.md",
      "",
    ])
      expect(
        refusal(() => vaultPath(path)),
        path,
      ).toBe(422)
    for (const path of [
      "notes/page.html",
      "notes/figure.svg",
      "notes/data.xml",
      "notes/run",
      "notes/a.js",
    ])
      expect(
        refusal(() => vaultPath(path)),
        path,
      ).toBe(415)
    expect(vaultFolder("")).toBe("")
    expect(vaultFolder("files/equipment")).toBe("files/equipment")
    expect(refusal(() => vaultFolder("tools"))).toBe(422)
    expect(refusal(() => vaultFolder("notes/.git"))).toBe(422)
  })

  it("checks pages the way the vault's validator does", () => {
    expect(pageProblems(NOTE)).toEqual([])
    expect(pageProblems("# no front matter\n")).toEqual([
      expect.stringContaining("no front matter"),
    ])
    expect(pageProblems("---\ntitle: x\n---\nbody\n")).toEqual([
      "no type",
      "its first tag must be internal",
    ])
    expect(pageProblems("---\ntitle: x\ntype: note\ntags:\n  - internal\n  - a\n---\n")).toEqual([])
    expect(pageProblems("---\ntitle: x\ntype: note\ntags:\n- notes\n- internal\n---\n")).toEqual([
      "its first tag must be internal",
    ])
    expect(pageProblems('---\ntitle: ""\ntype: note\ntags: [internal]\n---\n')).toEqual([
      "no title",
    ])
    const page = "---\ntitle: x\ntype: note\ntags: [internal]\n---\n"
    expect(pageProblems(page + "![plot](https://example.com/p.png)\n")).toEqual([
      "remote images must be stored in the vault: https://example.com/p.png",
    ])
    expect(pageProblems(page + '<img src="//example.com/p.png">\n')).toHaveLength(1)
    expect(pageProblems(page + "![](/assets/p.png)\n")).toEqual([
      "site-absolute embeds are not supported: /assets/p.png",
    ])
    // Code isn't checked, links aren't embeds.
    expect(
      pageProblems(page + "```\n![x](https://e.com/a.png)\n```\n[site](https://e.com)\n"),
    ).toEqual([])
  })

  it("checks that a file is what its name says", () => {
    const bytes = (text: string) => encoder.encode(text)
    expect(refusal(() => checkContent("notes/a.md", bytes(NOTE)))).toBe(0)
    expect(refusal(() => checkContent("notes/a.md", bytes("\ufeff" + NOTE)))).toBe(422)
    expect(refusal(() => checkContent("notes/a.md", new Uint8Array([0xff, 0xfe, 0x00])))).toBe(422)
    expect(refusal(() => checkContent("notes/a.pdf", new Uint8Array()))).toBe(422)
    expect(refusal(() => checkContent("notes/a.pdf", bytes("<html>")))).toBe(422)
    expect(refusal(() => checkContent("notes/a.pdf", PDF))).toBe(0)
    expect(refusal(() => checkContent("code/a.ipynb", bytes('{"cells": [], "nbformat": 4}')))).toBe(
      0,
    )
    expect(refusal(() => checkContent("code/a.ipynb", bytes('{"cells": [], "nbformat": 3}')))).toBe(
      422,
    )
    expect(refusal(() => checkContent("code/a.ipynb", bytes("{not json")))).toBe(422)
    expect(
      refusal(() =>
        checkContent("code/a.nb", bytes("(* Content-type: application/vnd.wolfram.mathematica *)")),
      ),
    ).toBe(0)
    expect(refusal(() => checkContent("code/a.nb", bytes('Run["rm"]')))).toBe(422)
    expect(refusal(() => checkContent("assets/a.png", bytes("<svg onload=alert(1)>")))).toBe(422)
    expect(
      refusal(() =>
        checkContent("assets/a.png", new Uint8Array([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10])),
      ),
    ).toBe(0)
    expect(refusal(() => checkContent("files/a.docx", bytes("PK\x03\x04rest")))).toBe(0)
    expect(refusal(() => checkContent("files/a.csv", bytes("a,b\n")))).toBe(0)
  })

  it("leaves to an admin what would run at build time or in members' browsers", () => {
    const page = "---\ntitle: x\ntype: note\ntags: [internal]\n---\n"
    const review = (path: string, text: string) => checkContent(path, encoder.encode(text))
    expect(
      review("notes/a.md", page + "Plain *text*, <details><summary>more</summary></details>\n"),
    ).toBeNull()
    expect(
      review("notes/a.md", page + "```html\n<script>alert(1)</script>\n```\n`<iframe>`\n"),
    ).toBeNull()
    for (const html of [
      "<script>fetch('/api/session')</script>",
      "<SCRIPT src=x></SCRIPT>",
      '<img src="a.png" onerror="alert(1)">',
      "<iframe src=//evil.example></iframe>",
      "[click](javascript:alert(1))",
      "<style>body{display:none}</style>",
      "<svg><circle/></svg>",
    ]) {
      expect(activeHtml(html), html).toBe(true)
      expect(review("notes/a.md", page + html + "\n"), html).toBe(
        "it has HTML that runs in the browser",
      )
    }
    expect(codeCells("```{python}\nimport os\n```\n")).toBe(true)
    expect(codeCells("Inline `{python} 1 + 1` and `r 2`.\n")).toBe(true)
    expect(codeCells("```python\nshown, not run\n```\n")).toBe(false)
    expect(review("notes/a.qmd", page + "```{python}\nimport os\n```\n")).toBe(
      "its code cells run when the site builds",
    )
    expect(review("notes/a.qmd", page + "```python\nprint(1)\n```\n")).toBeNull()
    const notebook = (cells: object[]) => JSON.stringify({ nbformat: 4, nbformat_minor: 5, cells })
    const plot = {
      cell_type: "code",
      source: "plot()",
      outputs: [{ data: { "image/png": "iVBOR" } }],
    }
    expect(review("code/a.ipynb", notebook([plot]))).toBeNull()
    for (const cell of [
      {
        cell_type: "code",
        source: "",
        outputs: [{ data: { "text/html": ["<script>x</script>"] } }],
      },
      { cell_type: "code", source: "", outputs: [{ data: { "application/javascript": "x" } }] },
      { cell_type: "markdown", source: ["<img src=x onerror=alert(1)>"] },
    ])
      expect(review("code/a.ipynb", notebook([plot, cell]))).toBe(
        "its outputs or text have HTML or JavaScript that runs in the browser",
      )
    expect(review("code/a.nb", "(* Content-type: application/vnd.wolfram.mathematica *)")).toBe(
      "Wolfram notebooks are evaluated in part when the site renders them",
    )
  })
})

describe("uploads: drafts", () => {
  it("is for signed-in members only", async () => {
    expect((await SELF.fetch(`${ORIGIN}/api/uploads`)).status).toBe(401)
    expect((await SELF.fetch(`${ORIGIN}/api/uploads/drafts`, { method: "POST" })).status).toBe(401)
  })

  it("lists the vault's content folders, and a folder's files", async () => {
    const ada = await as("ada")
    const home = await ada.json("/api/uploads")
    expect(home.body).toMatchObject({ ready: true, drafts: [], limits: { file: FILE_MAX } })
    const top = await ada.json("/api/uploads/folder")
    expect(top.body.entries.map((e: any) => [e.name, e.type])).toEqual([
      ["code", "folder"],
      ["files", "folder"],
      ["notes", "folder"],
    ])
    const notes = await ada.json("/api/uploads/folder?path=notes")
    expect(notes.body).toMatchObject({ path: "notes", exists: true })
    expect(notes.body.entries).toEqual([
      expect.objectContaining({ name: "meeting.md", path: "notes/meeting.md", changeable: true }),
      expect.objectContaining({ name: "old.pdf", type: "file", size: 12 }),
    ])
    expect((await ada.json("/api/uploads/folder?path=notes/new")).body).toMatchObject({
      exists: false,
      entries: [],
    })
    expect((await ada.json("/api/uploads/folder?path=tools")).status).toBe(422)
    expect((await ada.json("/api/uploads/folder?path=.github")).status).toBe(422)
  })

  it("stages new files and new versions, refusing what the vault would", async () => {
    const ada = await as("ada")
    const created = await create(ada, "minutes and a scan")
    expect(created.status).toBe(201)
    expect(created.body).toMatchObject({
      status: "editing",
      note: "minutes and a scan",
      changes: [],
    })
    const id = created.body.id

    const added = await stage(ada, id, "notes/2026/minutes.md", NOTE)
    expect(added.status).toBe(200)
    expect(added.body.changes).toEqual([
      expect.objectContaining({ path: "notes/2026/minutes.md", action: "add", size: NOTE.length }),
    ])
    expect(added.body.unsent).toBe(true)
    const bad = await stage(ada, id, "notes/bad.md", "# no front matter\n")
    expect(bad).toMatchObject({
      status: 422,
      body: { detail: expect.stringContaining("front matter") },
    })
    expect((await stage(ada, id, ".github/workflows/validate.yml", "on: push")).status).toBe(422)
    expect((await stage(ada, id, "notes/../tools/validate.mjs", "x")).status).toBe(422)
    expect((await stage(ada, id, "notes/page.html", "<script>")).status).toBe(415)
    // An existing file is replaced only on purpose, and a missing one can't be.
    expect((await stage(ada, id, "notes/meeting.md", NOTE)).status).toBe(409)
    expect((await stage(ada, id, "notes/Meeting.md", NOTE)).status).toBe(409)
    expect((await stage(ada, id, "notes/gone.pdf", PDF, "replace")).status).toBe(404)
    const replaced = await stage(ada, id, "notes/meeting.md", NOTE + "More.\n", "replace")
    expect(replaced.body.changes[1]).toMatchObject({ path: "notes/meeting.md", action: "replace" })
    const big = await stage(ada, id, "files/big.csv", new Uint8Array(FILE_MAX + 1))
    expect(big.status).toBe(413)
    expect((await stage(ada, id, "notes/scan.pdf", PDF)).status).toBe(200)

    // Staged files come back as they will be committed, and never run as the site.
    const page = await ada.fetch(`/api/uploads/drafts/${id}/file?path=notes/2026/minutes.md`)
    expect(page.headers.get("content-type")).toBe("text/plain; charset=utf-8")
    expect(page.headers.get("content-security-policy")).toBe("sandbox; default-src 'none'")
    expect(page.headers.get("x-content-type-options")).toBe("nosniff")
    expect(await page.text()).toBe(NOTE)
    const pdf = await ada.fetch(`/api/uploads/drafts/${id}/file?path=notes/scan.pdf`)
    expect(pdf.headers.get("content-type")).toBe("application/pdf")
    expect(new Uint8Array(await pdf.arrayBuffer())).toEqual(PDF)

    // Another member can't see or touch it; an admin can look.
    const eve = await as("eve")
    expect((await eve.json(`/api/uploads/drafts/${id}`)).status).toBe(404)
    expect((await eve.fetch(`/api/uploads/drafts/${id}/file?path=notes/scan.pdf`)).status).toBe(404)
    expect((await stage(eve, id, "notes/x.pdf", PDF)).status).toBe(404)
    expect((await (await as("olivia", "owner")).json(`/api/uploads/drafts/${id}`)).status).toBe(200)

    const rows = await auditRows("action LIKE 'uploads.%'")
    expect(rows.map((r) => [r.action, r.login, r.target])).toEqual([
      ["uploads.create", "ada", id],
      ["uploads.stage", "ada", "notes/2026/minutes.md"],
      ["uploads.stage", "ada", "notes/meeting.md"],
      ["uploads.stage", "ada", "notes/scan.pdf"],
    ])

    // What runs is staged too, but marked for an admin to merge.
    const code = "---\ntitle: Fit\ntype: note\ntags: [internal]\n---\n\n```{python}\n1 + 1\n```\n"
    const marked = await stage(ada, id, "code/fit.qmd", code)
    expect(marked.body.changes.at(-1)).toMatchObject({
      path: "code/fit.qmd",
      review: "its code cells run when the site builds",
    })
    expect(marked.body.review).toEqual(["code/fit.qmd: its code cells run when the site builds"])
  })

  it("renames, moves and deletes files on main, one change per file", async () => {
    const ada = await as("ada")
    const id = (await create(ada)).body.id
    const moved = await change(ada, id, {
      action: "rename",
      from: "notes/old.pdf",
      to: "files/scans/old.pdf",
    })
    expect(moved.body.changes).toEqual([
      expect.objectContaining({
        path: "files/scans/old.pdf",
        action: "rename",
        from: "notes/old.pdf",
      }),
    ])
    expect(
      (await change(ada, id, { action: "rename", from: "files/data.csv", to: "files/data.md" }))
        .status,
    ).toBe(422)
    expect(
      (await change(ada, id, { action: "rename", from: "files/data.csv", to: "files/more.csv" }))
        .status,
    ).toBe(409)
    expect(
      (await change(ada, id, { action: "rename", from: "files/gone.csv", to: "files/new.csv" }))
        .status,
    ).toBe(404)
    expect(
      (await change(ada, id, { action: "rename", from: "files/data.csv", to: "tools/data.csv" }))
        .status,
    ).toBe(422)
    // A file already part of the draft can't also be changed some other way.
    expect((await stage(ada, id, "notes/old.pdf", PDF, "replace")).status).toBe(409)
    expect((await change(ada, id, { action: "delete", path: "notes/old.pdf" })).status).toBe(409)
    const deleted = await change(ada, id, { action: "delete", path: "files/data.csv" })
    expect(deleted.body.changes.map((c: any) => [c.action, c.path])).toEqual([
      ["rename", "files/scans/old.pdf"],
      ["delete", "files/data.csv"],
    ])
    expect((await change(ada, id, { action: "delete", path: "README.md" })).status).toBe(422)
    const out = await ada.json(
      `/api/uploads/drafts/${id}/changes?path=${encodeURIComponent("files/data.csv")}`,
      { method: "DELETE" },
    )
    expect(out.body.changes.map((c: any) => c.path)).toEqual(["files/scans/old.pdf"])
  })

  it("sends a draft as a branch with one commit on main's tip and a draft pull request", async () => {
    const ada = await as("ada")
    const id = (await create(ada, "@olivia the scans")).body.id
    await stage(ada, id, "notes/scan.pdf", PDF)
    await stage(ada, id, "notes/meeting.md", NOTE + "More.\n", "replace")
    await change(ada, id, { action: "rename", from: "notes/old.pdf", to: "files/old.pdf" })
    await change(ada, id, { action: "delete", path: "files/data.csv" })
    const main = repo.head
    const before = Date.now()
    const sent = await send(ada, id)
    expect(sent.status).toBe(200)
    expect(sent.body).toMatchObject({
      status: "open",
      unsent: false,
      pull: { number: 1, url: "https://github.com/HafeziGroupJQI/vault-private/pull/1" },
    })
    expect([dueAt(before), dueAt(Date.now())]).toContain(sent.body.due_at)

    // main is untouched; the branch holds one commit on it with every change.
    expect(repo.head).toBe(main)
    const branch = `uploads/ada/${id}`
    const commit = repo.commit(repo.refs.get(branch)!)
    expect(commit.parents).toEqual([main])
    expect(commit.author).toMatchObject({ name: "ada", email: "ada@users.noreply.github.com" })
    expect(commit.message).toBe(
      "add 1 file, replace 1 file, rename 1 file and delete 1 file in files and notes by ada from the members site uploads",
    )
    expect(repo.bytes("notes/scan.pdf", branch)).toEqual(PDF)
    expect(repo.text("notes/meeting.md", branch)).toBe(NOTE + "More.\n")
    expect(repo.text("files/old.pdf", branch)).toBe("%PDF-1.4 old")
    expect(repo.text("notes/old.pdf", branch)).toBeUndefined()
    expect(repo.text("files/data.csv", branch)).toBeUndefined()

    const pull = repo.pulls.get(1)!
    expect(pull).toMatchObject({
      head: branch,
      base: "main",
      draft: true,
      title:
        "add 1 file, replace 1 file, rename 1 file and delete 1 file in files and notes by ada",
    })
    for (const line of [
      "- add `notes/scan.pdf` (195 kb)",
      "- replace `notes/meeting.md`",
      "- rename `notes/old.pdf` to `files/old.pdf`",
      "- delete `files/data.csv`",
      "```text\n@olivia the scans\n```",
    ])
      expect(pull.body).toContain(line)
    // Lowercase, but for the paths and the member's own note.
    const prose = pull.body.replace(/```text\n[\s\S]*?```/g, "").replace(/`[^`]*`/g, "")
    expect(prose).toBe(prose.toLowerCase())
    const rows = await auditRows("action = 'uploads.send'")
    expect(rows).toEqual([expect.objectContaining({ login: "ada", target: id })])
  })

  it("revises a sent draft on main's new tip, and refuses a change main made meanwhile", async () => {
    const ada = await as("ada")
    const id = (await create(ada)).body.id
    await stage(ada, id, "notes/meeting.md", NOTE + "More.\n", "replace")
    await send(ada, id)
    const first = repo.refs.get(`uploads/ada/${id}`)!
    const staged = await stage(ada, id, "notes/scan.pdf", PDF)
    expect(staged.body).toMatchObject({ status: "open", unsent: true })
    repo.push("files/other.csv", "x\n")
    const revised = await send(ada, id)
    expect(revised.body).toMatchObject({ status: "open", unsent: false, pull: { number: 1 } })
    const second = repo.commit(repo.refs.get(`uploads/ada/${id}`)!)
    expect(second.sha).not.toBe(first)
    expect(second.parents).toEqual([repo.head])
    expect(repo.text("notes/meeting.md", `uploads/ada/${id}`)).toBe(NOTE + "More.\n")
    expect(repo.bytes("notes/scan.pdf", `uploads/ada/${id}`)).toEqual(PDF)
    expect(repo.pulls.size).toBe(1)
    expect(`${repo.pulls.get(1)!.title} from the members site uploads`).toBe(second.message)

    repo.push("notes/meeting.md", NOTE + "Someone else's line.\n")
    const conflict = await send(ada, id)
    expect(conflict).toMatchObject({
      status: 409,
      body: { detail: expect.stringContaining("notes/meeting.md changed on main") },
    })
    expect(repo.refs.get(`uploads/ada/${id}`)).toBe(second.sha)
  })

  it("discards a draft: its pull request closes, and its branch and staged files go", async () => {
    const ada = await as("ada")
    const id = (await create(ada)).body.id
    await stage(ada, id, "notes/scan.pdf", PDF)
    await send(ada, id)
    const gone = await ada.json(`/api/uploads/drafts/${id}`, { method: "DELETE" })
    expect(gone.body).toMatchObject({
      status: "discarded",
      detail: { message: "discarded by its author" },
    })
    expect(repo.pulls.get(1)!.state).toBe("closed")
    expect(repo.refs.has(`uploads/ada/${id}`)).toBe(false)
    expect((await env.ARTIFACTS.list({ prefix: `uploads/${id}/` })).objects).toEqual([])
    expect((await stage(ada, id, "notes/x.pdf", PDF)).status).toBe(409)
    expect((await send(ada, id)).status).toBe(409)
    const unsent = (await create(ada)).body.id
    expect(
      (await ada.json(`/api/uploads/drafts/${unsent}`, { method: "DELETE" })).body.status,
    ).toBe("discarded")
    expect(await auditRows("action = 'uploads.discard'")).toHaveLength(2)
  })

  it("limits open drafts and sends per member", async () => {
    const ada = await as("ada")
    for (let i = 0; i < 5; i++) expect((await create(ada)).status).toBe(201)
    expect((await create(ada)).status).toBe(409)
    const id = (await ada.json("/api/uploads")).body.drafts[0].id
    await stage(ada, id, "notes/scan.pdf", PDF)
    for (let i = 0; i < 40; i++)
      await env.DB.prepare(
        "INSERT INTO audit_log (at, login, action) VALUES (?, 'ada', 'uploads.send')",
      )
        .bind(Date.now())
        .run()
    expect((await send(ada, id)).status).toBe(429)
    expect((await send(await as("eve"), id)).status).toBe(404)
  })

  it("streams a file's base64 to GitHub across chunk boundaries", async () => {
    const bytes = PDF.subarray(0, 1000)
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        let at = 0
        for (const n of [1, 2, 3, 4, 5, 7, 100, 878]) {
          controller.enqueue(bytes.slice(at, at + n))
          at += n
        }
        controller.close()
      },
    })
    const sha = await new PrivateVault(env as any, repo.fetch).streamBlob(stream, bytes.length)
    expect(repo.blobs.get(sha)).toEqual(bytes)
  })

  it("names a draft's commit in lowercase, short enough for the merge's words", () => {
    const one = [{ action: "add" as const, path: "notes/Scan.pdf", from_path: null }]
    expect(summary(one)).toBe("add notes/Scan.pdf")
    expect(uploadTitle(one, "Ada  Lovelace")).toBe("add notes/scan.pdf by ada lovelace")
    expect(plainName("@octocat [x](y) `z`", "ada")).toBe("octocat x(y) z")
    expect(plainName("@", "ada")).toBe("ada")
    const long = [
      {
        action: "rename" as const,
        path: `files/${"x".repeat(90)}.pdf`,
        from_path: `notes/${"y".repeat(90)}.pdf`,
      },
    ]
    expect(uploadTitle(long, "Ada")).toBe("rename 1 file in files by ada")
    const many = Array.from({ length: 30 }, (_, i) => ({
      action: "add" as const,
      path: `${"f".repeat(60)}${i}/a.md`,
      from_path: null,
    }))
    const title = uploadTitle(many, "A".repeat(80))
    expect(title.length).toBeLessThanOrEqual(110)
    expect(mergeTitle(title).length).toBeLessThan(150)
  })
})

describe("uploads: admins", () => {
  it("see every member's open drafts, and can discard one", async () => {
    const ada = await as("ada")
    const id = (await create(ada, "scans")).body.id
    await stage(ada, id, "notes/scan.pdf", PDF)
    await send(ada, id)
    const other = (await create(await as("eve"))).body.id
    expect((await (await as("eve")).json("/api/admin/uploads")).status).toBe(403)
    const owner = await as("olivia", "owner")
    const listed = await owner.json("/api/admin/uploads")
    expect(listed.body.drafts.map((d: any) => [d.login, d.id, d.status])).toEqual([
      ["ada", id, "open"],
      ["eve", other, "editing"],
    ])
    expect(listed.body.drafts[0].pull.url).toBe(
      "https://github.com/HafeziGroupJQI/vault-private/pull/1",
    )
    expect((await owner.json(`/api/admin/uploads/${id}/discard`, { method: "POST" })).body).toEqual(
      {
        id,
        status: "discarded",
      },
    )
    expect(repo.pulls.get(1)!.state).toBe("closed")
    expect(repo.refs.has(`uploads/ada/${id}`)).toBe(false)
    expect((await ada.json(`/api/uploads/drafts/${id}`)).body).toMatchObject({
      status: "discarded",
      detail: { message: "discarded by olivia" },
    })
    expect((await owner.json(`/api/admin/uploads/${id}/discard`, { method: "POST" })).status).toBe(
      409,
    )
    expect(await auditRows("action = 'admin.uploads.discard'")).toEqual([
      expect.objectContaining({ login: "olivia", target: id }),
    ])
  })
})

describe("uploads: the hourly merge", () => {
  /** The hourly run, as the cron makes it, at a given time. */
  const merge = (at: number) => mergeDue(env as any, repo.fetch, at)

  /** A member's draft, sent: its id, due time and the commit it sent. */
  async function sent(client: Client, files: Record<string, BodyInit>) {
    const id = (await create(client)).body.id
    for (const [path, body] of Object.entries(files)) await stage(client, id, path, body)
    const draft = (await send(client, id)).body
    return { id, due: draft.due_at as number, head: repo.refs.get(`uploads/ada/${id}`)! }
  }

  it("merges a draft at the end of the hour after it was sent, once its check is green", async () => {
    const ada = await as("ada")
    const main = repo.head
    const { id, due, head } = await sent(ada, { "notes/scan.pdf": PDF })
    // Not due: nothing happens, not even a look at GitHub.
    const calls = repo.calls.length
    expect(await merge(due - 3 * 600_000)).toMatchObject({ merged: [], waiting: [] })
    expect(repo.calls.length).toBe(calls)

    // Due, but the check hasn't reported (or is running): it waits for the next hour.
    expect((await merge(due)).waiting).toEqual([id])
    repo.report(head, "pending")
    expect((await merge(due)).waiting).toEqual([id])
    const waiting = (await ada.json(`/api/uploads/drafts/${id}`)).body
    expect(waiting).toMatchObject({
      status: "open",
      detail: { message: "waiting for the validate check" },
      check: { state: "pending", url: `https://github.com/runs/${head}` },
    })
    expect(repo.head).toBe(main)

    repo.report(head, "success")
    // Someone else's push meanwhile: the member's commit is rebased onto it.
    repo.push("files/other.csv", "x\n")
    const moved = repo.head
    expect(await merge(due)).toMatchObject({ merged: [id] })
    const pull = repo.pulls.get(1)!
    expect(pull).toMatchObject({ draft: false, merged: true, merge_method: "rebase" })
    // Rebased, not squashed: main gets the member's own commit, their name, address and message,
    // so the vault's history (and the site's history of the page) credits them.
    expect(repo.commit(repo.head)).toMatchObject({
      parents: [moved],
      message: "add notes/scan.pdf by ada from the members site uploads",
      author: { name: "ada", email: "ada@users.noreply.github.com" },
    })
    expect(repo.commit(moved).parents).toEqual([main])
    expect(repo.bytes("notes/scan.pdf")).toEqual(PDF)
    expect(repo.refs.has(`uploads/ada/${id}`)).toBe(false)
    expect((await env.ARTIFACTS.list({ prefix: `uploads/${id}/` })).objects).toEqual([])
    const merged = (await ada.json(`/api/uploads/drafts/${id}`)).body
    expect(merged).toMatchObject({
      status: "merged",
      merge: { url: `https://github.com/HafeziGroupJQI/vault-private/commit/${repo.head}` },
    })
    expect(await auditRows("action = 'uploads.merge'")).toEqual([
      expect.objectContaining({ login: "ada", target: id }),
    ])
    // Settled: the next hour leaves it alone.
    expect(await merge(due + 3_600_000)).toMatchObject({ merged: [], waiting: [] })
  })

  it("leaves a draft whose check failed open for its author to fix", async () => {
    const ada = await as("ada")
    const main = repo.head
    const { id, due, head } = await sent(ada, { "notes/scan.pdf": PDF })
    repo.report(head, "failure")
    expect(await merge(due)).toMatchObject({ failed: [id], merged: [] })
    expect(repo.head).toBe(main)
    expect(repo.pulls.get(1)).toMatchObject({ state: "open", merged: false })
    expect((await ada.json(`/api/uploads/drafts/${id}`)).body).toMatchObject({
      status: "failed",
      detail: {
        message: "the validate check failed: failure",
        url: `https://github.com/runs/${head}`,
      },
    })
    expect(await auditRows("action = 'uploads.failed'")).toHaveLength(1)

    // A revision is checked again, and merges in its own hour.
    await stage(ada, id, "notes/minutes.md", NOTE)
    const revised = (await send(ada, id)).body
    expect(revised).toMatchObject({ status: "open", detail: null })
    repo.report(repo.refs.get(`uploads/ada/${id}`)!, "success")
    expect(await merge(revised.due_at)).toMatchObject({ merged: [id] })
    expect(repo.text("notes/minutes.md")).toBe(NOTE)
  })

  it("shows a conflict, and waits while its author changes a sent draft", async () => {
    const ada = await as("ada")
    const { id, due, head } = await sent(ada, { "notes/scan.pdf": PDF })
    repo.report(head, "success")
    await stage(ada, id, "notes/minutes.md", NOTE)
    expect(await merge(due)).toMatchObject({ waiting: [id], merged: [] })
    await ada.json(`/api/uploads/drafts/${id}/changes?path=notes/minutes.md`, { method: "DELETE" })
    const again = (await send(ada, id)).body
    repo.report(repo.refs.get(`uploads/ada/${id}`)!, "success")
    repo.pulls.get(1)!.mergeable = false
    expect(await merge(again.due_at)).toMatchObject({ conflicts: [id], merged: [] })
    expect((await ada.json(`/api/uploads/drafts/${id}`)).body).toMatchObject({
      status: "conflict",
      detail: { url: "https://github.com/HafeziGroupJQI/vault-private/pull/1" },
    })
  })

  it("never merges what runs: an admin does, on GitHub, and the draft follows", async () => {
    const ada = await as("ada")
    const code = "---\ntitle: Fit\ntype: note\ntags: [internal]\n---\n\n```{python}\n1 + 1\n```\n"
    const { id, due, head } = await sent(ada, { "code/fit.qmd": code })
    expect(repo.pulls.get(1)!.body).toContain("an admin merges this by hand")
    repo.report(head, "success")
    expect(await merge(due)).toMatchObject({ review: [id], merged: [] })
    expect(repo.pulls.get(1)).toMatchObject({ draft: false, merged: false, state: "open" })
    expect(repo.text("code/fit.qmd")).toBeUndefined()
    expect((await ada.json(`/api/uploads/drafts/${id}`)).body.status).toBe("review")
    expect(await merge(due + 3_600_000)).toMatchObject({ review: [id] })

    Object.assign(repo.pulls.get(1)!, {
      merged: true,
      state: "closed",
      merge_commit_sha: "c-admin",
    })
    expect(await merge(due + 7_200_000)).toMatchObject({ merged: [id] })
    expect((await ada.json(`/api/uploads/drafts/${id}`)).body).toMatchObject({
      status: "merged",
      merge: { sha: "c-admin" },
    })
  })

  it("leaves a branch someone changed on GitHub to an admin", async () => {
    const ada = await as("ada")
    const { id, due, head } = await sent(ada, { "notes/scan.pdf": PDF })
    const branch = `uploads/ada/${id}`
    // Someone else's commit on the branch, checked green.
    const other = await repo.fetch(
      "https://api.github.com/repos/HafeziGroupJQI/vault-private/git/commits",
      {
        method: "POST",
        headers: { authorization: "Bearer test-vault-private-token" },
        body: JSON.stringify({
          message: "tweak",
          tree: repo.commit(head).tree,
          parents: [head],
          author: {},
        }),
      },
    )
    repo.refs.set(branch, ((await other.json()) as { sha: string }).sha)
    repo.report(repo.refs.get(branch)!, "success")
    expect(await merge(due)).toMatchObject({ review: [id], merged: [] })
    expect(repo.pulls.get(1)).toMatchObject({ merged: false })
    expect((await ada.json(`/api/uploads/drafts/${id}`)).body).toMatchObject({
      status: "review",
      detail: { message: "its branch was changed on GitHub, so an admin merges it" },
    })
  })

  it("drops a draft whose pull request was closed on GitHub", async () => {
    const ada = await as("ada")
    const { id, due } = await sent(ada, { "notes/scan.pdf": PDF })
    repo.pulls.get(1)!.state = "closed"
    expect(await merge(due)).toMatchObject({ closed: [id] })
    expect(repo.refs.has(`uploads/ada/${id}`)).toBe(false)
    expect((await ada.json(`/api/uploads/drafts/${id}`)).body).toMatchObject({
      status: "discarded",
      detail: { message: "closed on GitHub" },
    })
  })
})
