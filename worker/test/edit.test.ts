import { SELF, env } from "cloudflare:test"
import { beforeEach, describe, expect, it } from "vitest"
import { HttpError } from "../src/http"
import { cleanSummary, editTitle, editablePath, editText } from "../src/edit/rules"
import { mergeDue } from "../src/uploads/merge"
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
const QMD = `---
title: Bend optimization
type: note
tags: [internal, code]
---

\`\`\`{python}
1 + 1
\`\`\`
`
const NOTEBOOK = '{\n "cells": [],\n "metadata": {},\n "nbformat": 4,\n "nbformat_minor": 5\n}\n'

type Client = Awaited<ReturnType<typeof as>>

beforeEach(async () => {
  repo.reset({
    "README.md": "# vault-private\n",
    "tools/validate.mjs": "\n",
    "notes/meeting.md": NOTE,
    "code/bend.qmd": QMD,
    "code/fit.ipynb": NOTEBOOK,
    "code/guide/intro.nb": "(* Content-type: application/vnd.wolfram.mathematica *)\n",
    "notes/scan.pdf": "%PDF-1.4",
  })
  await env.DB.prepare("DELETE FROM edit_conflicts").run()
  await env.DB.prepare("DELETE FROM upload_changes").run()
  await env.DB.prepare("DELETE FROM upload_drafts").run()
  // A member's name on their commits is their People page's, when they have one.
  await env.DB.prepare("DELETE FROM profiles").run()
  await env.DB.prepare(
    "DELETE FROM audit_log WHERE action LIKE 'edit.%' OR action LIKE 'uploads.%'",
  ).run()
  const staged = await env.ARTIFACTS.list({ prefix: "uploads/" })
  if (staged.objects.length) await env.ARTIFACTS.delete(staged.objects.map((o) => o.key))
})

const source = (client: Client, path: string, name = "vault-private") =>
  client.json(`/api/edit/source?${new URLSearchParams({ repo: name, path })}`)

const create = (client: Client, body: object) =>
  client.json("/api/edit/drafts", {
    method: "POST",
    body: JSON.stringify({ repo: "vault-private", ...body }),
  })

const save = (client: Client, id: string, body: object) =>
  client.json(`/api/edit/drafts/${id}`, { method: "PUT", body: JSON.stringify(body) })

const send = (client: Client, id: string) =>
  client.json(`/api/edit/drafts/${id}/send`, { method: "POST" })

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

describe("edit: what the editor opens", () => {
  it("opens a private page's own file: .md, .qmd and .ipynb, never a rendered copy", () => {
    expect(editablePath("vault-private", "notes/meeting.md")).toEqual({
      path: "notes/meeting.md",
      kind: "md",
    })
    expect(editablePath("vault-private", "code/bend.qmd").kind).toBe("qmd")
    expect(editablePath("vault-private", "code/fit.ipynb").kind).toBe("ipynb")
    for (const path of [
      "code/guide/intro.nb",
      "notes/scan.pdf",
      "notes/sketch.excalidraw.md",
      "tools/validate.mjs",
      ".github/workflows/validate.yml",
      "notes/../tools/x.md",
      "README.md",
    ])
      expect(
        refusal(() => editablePath("vault-private", path)),
        path,
      ).toBeGreaterThan(400)
    expect(refusal(() => editablePath("vault-private", "code/guide/intro.nb"))).toBe(422)
  })

  it("takes well-formed text and a one-line summary", () => {
    expect(editText("a\n")).toBe("a\n")
    expect(refusal(() => editText("\ud800 lone"))).toBe(422)
    expect(refusal(() => editText("nul \u0000"))).toBe(422)
    expect(refusal(() => editText(3))).toBe(422)
    expect(refusal(() => editText("x".repeat(2 * 1024 * 1024 + 1)))).toBe(413)
    expect(cleanSummary("  fix\n the  date ")).toBe("fix the date")
    expect(cleanSummary(undefined)).toBe("")
    expect(refusal(() => cleanSummary("x".repeat(121)))).toBe(422)
  })

  it("titles an edit in lowercase with its summary, short enough for the merge's words", () => {
    expect(editTitle("notes/Meeting.md", "Ada  Lovelace", "Fix the @olivia `date` [x](y)")).toBe(
      "edit notes/meeting.md by ada lovelace: fix the olivia date x(y)",
    )
    expect(editTitle("notes/a.md", "Ada", "")).toBe("edit notes/a.md by ada")
    const long = editTitle(`notes/${"x".repeat(60)}.md`, "Ada", "y".repeat(120))
    expect(long.length).toBeLessThanOrEqual(110)
    expect(`${long} from the members site editor`.length).toBeLessThan(150)
  })
})

describe("edit: drafts of a private page", () => {
  it("is for signed-in members only", async () => {
    expect(
      (await SELF.fetch(`${ORIGIN}/api/edit/source?repo=vault-private&path=notes/meeting.md`))
        .status,
    ).toBe(401)
    expect((await SELF.fetch(`${ORIGIN}/api/edit/drafts`, { method: "POST" })).status).toBe(401)
  })

  it("loads a file exactly as it is on main, with its blob", async () => {
    const ada = await as("ada")
    const page = await source(ada, "notes/meeting.md")
    expect(page.status).toBe(200)
    expect(page.body).toMatchObject({
      repo: "vault-private",
      repo_name: "HafeziGroupJQI/vault-private",
      path: "notes/meeting.md",
      kind: "md",
      main: { sha: repo.sha("notes/meeting.md"), text: NOTE },
      can_edit: true,
      draft: null,
      others: [],
      review: null,
      github_url: "https://github.com/HafeziGroupJQI/vault-private/blob/main/notes/meeting.md",
    })
    // A Quarto page's source runs when the site builds: an admin merges its edits.
    expect((await source(ada, "code/bend.qmd")).body).toMatchObject({
      kind: "qmd",
      main: { text: QMD },
      review: "its code cells run when the site builds",
    })
    expect((await source(ada, "code/fit.ipynb")).body.main.text).toBe(NOTEBOOK)
    expect((await source(ada, "notes/gone.md")).status).toBe(404)
    expect((await source(ada, "code/guide/intro.nb")).status).toBe(422)
    expect((await source(ada, "content/people/index.md", "vault")).status).toBe(422)
    expect((await source(ada, "notes/meeting.md", "elsewhere")).status).toBe(422)
  })

  it("saves a draft on the blob it was loaded from, and gives it back byte for byte", async () => {
    const ada = await as("ada")
    const base = repo.sha("notes/meeting.md")
    const text = NOTE + "More minutes, ünïcödé and all.\r\n"
    const created = await create(ada, { path: "notes/meeting.md", base_sha: base, text })
    expect(created.status).toBe(201)
    expect(created.body).toMatchObject({
      kind: "edit",
      repo: "vault-private",
      path: "notes/meeting.md",
      status: "editing",
      base_sha: base,
      problems: [],
      unsent: true,
    })
    const id = created.body.id
    // One draft per page: opening the page again gives it back, with its text and base.
    expect((await create(ada, { path: "notes/meeting.md", base_sha: base, text })).body).toEqual({
      detail: "you already have a draft of this page",
      draft: id,
    })
    const again = await source(ada, "notes/meeting.md")
    expect(again.body.draft).toMatchObject({ id, base_sha: base, text })
    expect(again.body.main.text).toBe(NOTE)

    // A draft may be saved with problems (it is the member's own); they are said, not refused.
    const broken = await save(ada, id, { text: "no front matter\n", summary: "fix the date" })
    expect(broken.body).toMatchObject({
      summary: "fix the date",
      problems: [expect.stringContaining("front matter")],
    })
    expect((await ada.json(`/api/edit/drafts/${id}`)).body.text).toBe("no front matter\n")

    // Others see that someone is editing the page, but not the draft.
    const eve = await as("eve")
    expect((await source(eve, "notes/meeting.md")).body).toMatchObject({
      draft: null,
      others: [expect.objectContaining({ login: "ada", status: "editing" })],
    })
    expect((await eve.json(`/api/edit/drafts/${id}`)).status).toBe(404)
    expect((await save(eve, id, { text: NOTE })).status).toBe(404)
    // An admin may look.
    expect((await (await as("olivia", "owner")).json(`/api/edit/drafts/${id}`)).status).toBe(200)

    const rows = await auditRows("action LIKE 'edit.%'")
    expect(rows.map((r) => [r.action, r.login, r.target])).toEqual([
      ["edit.create", "ada", "notes/meeting.md"],
      ["edit.save", "ada", "notes/meeting.md"],
    ])
  })

  it("sends a draft as a pull request of the member's own commit, merged by rebase in its hour", async () => {
    const ada = await as("ada")
    const main = repo.head
    const text = NOTE.replace("Minutes.", "Minutes, corrected.")
    const id = (
      await create(ada, {
        path: "notes/meeting.md",
        base_sha: repo.sha("notes/meeting.md"),
        text,
      })
    ).body.id
    expect((await send(ada, id)).body.detail).toMatch(/say in a line/)
    await save(ada, id, { summary: "Correct the @olivia minutes" })
    const sent = await send(ada, id)
    expect(sent.status).toBe(200)
    expect(sent.body).toMatchObject({
      status: "open",
      unsent: false,
      pull: { number: 1, url: "https://github.com/HafeziGroupJQI/vault-private/pull/1" },
    })
    const branch = `edits/ada/${id}`
    const commit = repo.commit(repo.refs.get(branch)!)
    expect(commit).toMatchObject({
      parents: [main],
      message:
        "edit notes/meeting.md by ada: correct the olivia minutes from the members site editor",
      author: { name: "ada", email: "ada@users.noreply.github.com" },
    })
    expect(repo.text("notes/meeting.md", branch)).toBe(text)
    const pull = repo.pulls.get(1)!
    expect(pull.title).toBe("edit notes/meeting.md by ada: correct the olivia minutes")
    expect(pull.body).toContain("edited in the members site's editor by ada (ada)")
    expect(pull.body).toContain("their summary:\n\n```text\nCorrect the @olivia minutes\n```")
    expect(await auditRows("action = 'edit.send'")).toEqual([
      expect.objectContaining({ login: "ada", target: "notes/meeting.md" }),
    ])

    repo.report(repo.refs.get(branch)!, "success")
    expect(await mergeDue(env as any, repo.fetch, sent.body.due_at)).toMatchObject({
      merged: [id],
    })
    expect(repo.text("notes/meeting.md")).toBe(text)
    expect(repo.commit(repo.head).author).toMatchObject({ email: "ada@users.noreply.github.com" })
    expect((await ada.json(`/api/edit/drafts/${id}`)).body).toMatchObject({
      status: "merged",
      text: null,
    })
    expect(await auditRows("action = 'edit.merge'")).toEqual([
      expect.objectContaining({ login: "ada", target: id }),
    ])
  })

  it("refuses to send over someone else's change, and shows it; the member takes it in", async () => {
    const ada = await as("ada")
    const base = repo.sha("notes/meeting.md")
    const id = (
      await create(ada, {
        path: "notes/meeting.md",
        base_sha: base,
        text: NOTE + "Mine.\n",
        summary: "add my line",
      })
    ).body.id
    repo.push("notes/meeting.md", NOTE + "Theirs.\n")
    const refused = await send(ada, id)
    expect(refused).toMatchObject({
      status: 409,
      body: {
        detail: expect.stringContaining("changed on main"),
        incoming: { sha: repo.sha("notes/meeting.md"), text: NOTE + "Theirs.\n" },
      },
    })
    expect(repo.pulls.size).toBe(0)
    expect([...repo.refs.keys()]).toEqual(["main"])
    // Only main's version can become the draft's new base, and a save refused in part keeps
    // nothing of it.
    expect((await save(ada, id, { base_sha: base, text: "lost\n" })).status).toBe(409)
    expect((await ada.json(`/api/edit/drafts/${id}`)).body.text).toBe(NOTE + "Mine.\n")
    const rebased = await save(ada, id, {
      base_sha: repo.sha("notes/meeting.md"),
      text: NOTE + "Theirs.\nMine.\n",
    })
    expect(rebased.body.base_sha).toBe(repo.sha("notes/meeting.md"))
    expect((await send(ada, id)).status).toBe(200)
    expect(repo.text("notes/meeting.md", `edits/ada/${id}`)).toBe(NOTE + "Theirs.\nMine.\n")
  })

  it("won't send what the vault's check refuses, and leaves what runs to an admin", async () => {
    const ada = await as("ada")
    const id = (
      await create(ada, {
        path: "notes/meeting.md",
        base_sha: repo.sha("notes/meeting.md"),
        text: "---\ntitle: x\n---\n",
        summary: "break it",
      })
    ).body.id
    expect(await send(ada, id)).toMatchObject({
      status: 422,
      body: { detail: expect.stringContaining("no type") },
    })
    await save(ada, id, { text: NOTE })
    expect(await send(ada, id)).toMatchObject({
      status: 422,
      body: { detail: "nothing changed: the page is the same as on main" },
    })
    const qmd = (
      await create(ada, {
        path: "code/bend.qmd",
        base_sha: repo.sha("code/bend.qmd"),
        text: QMD.replace("1 + 1", "2 + 2"),
        summary: "sum more",
      })
    ).body
    expect(qmd.review).toEqual(["code/bend.qmd: its code cells run when the site builds"])
    expect((await send(ada, qmd.id)).status).toBe(200)
    const body = repo.pulls.get(1)!.body
    expect(body).toContain("an admin merges this by hand")
    expect(body).toContain(
      "after merging, refresh `_freeze/code/bend` (run `quarto render code/bend.qmd` in vault-private and commit `_freeze`)",
    )
  })

  it("discards a draft: its pull request closes and its text goes", async () => {
    const ada = await as("ada")
    const id = (
      await create(ada, {
        path: "notes/meeting.md",
        base_sha: repo.sha("notes/meeting.md"),
        text: NOTE + "x\n",
        summary: "x",
      })
    ).body.id
    await send(ada, id)
    const gone = await ada.json(`/api/edit/drafts/${id}`, { method: "DELETE" })
    expect(gone.body).toMatchObject({ status: "discarded" })
    expect(repo.pulls.get(1)!.state).toBe("closed")
    expect(repo.refs.has(`edits/ada/${id}`)).toBe(false)
    expect((await env.ARTIFACTS.list({ prefix: `uploads/${id}/` })).objects).toEqual([])
    expect(await auditRows("action = 'edit.discard'")).toHaveLength(1)
    // The page can be edited afresh.
    expect((await source(ada, "notes/meeting.md")).body.draft).toBeNull()
  })

  it("keeps edits and uploads apart: Uploads lists an edit but doesn't change it", async () => {
    const ada = await as("ada")
    const id = (
      await create(ada, {
        path: "notes/meeting.md",
        base_sha: repo.sha("notes/meeting.md"),
        text: NOTE,
      })
    ).body.id
    const listed = await ada.json("/api/uploads")
    expect(listed.body.drafts).toEqual([
      expect.objectContaining({ id, kind: "edit", path: "notes/meeting.md" }),
    ])
    const staged = await ada.json(
      `/api/uploads/drafts/${id}/file?${new URLSearchParams({ path: "notes/x.md", mode: "add" })}`,
      { method: "PUT", headers: { "content-type": "application/octet-stream" }, body: NOTE },
    )
    expect(staged).toMatchObject({
      status: 409,
      body: { detail: expect.stringContaining("editor") },
    })
    expect((await ada.json(`/api/uploads/drafts/${id}/send`, { method: "POST" })).status).toBe(409)
    // An edit doesn't count against the member's open uploads, nor an upload against their edits.
    for (let i = 0; i < 5; i++)
      expect((await ada.json("/api/uploads/drafts", { method: "POST", body: "{}" })).status).toBe(
        201,
      )
  })
})
