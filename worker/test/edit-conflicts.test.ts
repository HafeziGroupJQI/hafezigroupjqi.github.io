import { env } from "cloudflare:test"
import { beforeEach, describe, expect, it } from "vitest"
import { as, auditRows } from "./helpers"
import { vault } from "./worker"

// Conflicts between members' edits of one page (src/edit/conflicts.ts), on the public vault.

const PAGE = "content/research/engines.md"
const TEXT = `---
title: Engines
type: research
tags: [research]
---

First paragraph.

Second paragraph.

Third paragraph.

Fourth paragraph.

Fifth paragraph.
`

type Client = Awaited<ReturnType<typeof as>>

beforeEach(async () => {
  vault.reset({
    "content/index.md": "---\ntitle: Hafezi Group\n---\n\nWelcome.\n",
    [PAGE]: TEXT,
    "content/research/optics.md": TEXT.replace("Engines", "Optics"),
  })
  await env.DB.prepare("DELETE FROM edit_conflicts").run()
  await env.DB.prepare("DELETE FROM upload_changes").run()
  await env.DB.prepare("DELETE FROM upload_drafts").run()
  await env.DB.prepare("DELETE FROM changes").run()
  await env.DB.prepare("DELETE FROM audit_log WHERE action LIKE 'edit.%'").run()
  const staged = await env.ARTIFACTS.list({ prefix: "uploads/" })
  if (staged.objects.length) await env.ARTIFACTS.delete(staged.objects.map((o) => o.key))
})

const post = (client: Client, path: string, body: unknown = {}) =>
  client.json(path, { method: "POST", body: JSON.stringify(body) })
const put = (client: Client, id: string, body: unknown) =>
  client.json(`/api/edit/drafts/${id}`, { method: "PUT", body: JSON.stringify(body) })

const draft = (client: Client, text: string, summary = "an edit", path = PAGE) =>
  post(client, "/api/edit/drafts", {
    repo: "vault",
    path,
    base_sha: vault.sha(path),
    text,
    summary,
  })

const send = (client: Client, id: string) => post(client, `/api/edit/drafts/${id}/send`)
const edit = (from: string, to: string, text = TEXT) => text.replace(from, to)

describe("a page that changed on main since the member loaded it", () => {
  it("merges changes to other lines, and sends once the member has looked it over", async () => {
    const bob = await as("bob")
    const base = vault.sha(PAGE)
    const mine = edit("Fifth paragraph.", "Fifth, by Bob.")
    const id = (await draft(bob, mine)).body.id
    vault.push(PAGE, edit("First paragraph.", "First, by someone."))
    const refused = await send(bob, id)
    const merged = edit("First paragraph.", "First, by someone.", mine)
    expect(refused).toMatchObject({
      status: 409,
      body: {
        kind: "rebase",
        incoming: { sha: vault.sha(PAGE), text: vault.text(PAGE) },
        merged_text: merged,
      },
    })
    expect((await bob.json(`/api/edit/drafts/${id}`)).body).toMatchObject({
      status: "editing",
      base_sha: base,
    })
    const saved = await put(bob, id, { base_sha: vault.sha(PAGE), text: merged })
    expect(saved.body.base_sha).toBe(vault.sha(PAGE))
    expect((await send(bob, id)).status).toBe(200)
    expect(await auditRows("action = 'edit.rebase'")).toEqual([
      expect.objectContaining({
        login: "bob",
        detail_json: JSON.stringify({ draft: id, from: base, to: vault.sha(PAGE), clean: true }),
      }),
    ])
  })

  it("gives back main's version and a merge that keeps the member's lines where both changed", async () => {
    const bob = await as("bob")
    const mine = edit("Third paragraph.", "Third, by Bob.")
    const id = (await draft(bob, mine)).body.id
    const theirs = edit("Third paragraph.", "Third, by someone.").replace("First", "1st")
    vault.push(PAGE, theirs)
    const refused = await send(bob, id)
    expect(refused).toMatchObject({
      status: 409,
      body: {
        kind: "main",
        detail: expect.stringContaining("changed on main"),
        incoming: { text: theirs },
        base_text: TEXT,
        proposed: mine.replace("First", "1st"),
      },
    })
  })

  it("records a base moved to main with someone else's lines dropped (a replayed stale base)", async () => {
    const bob = await as("bob")
    const base = vault.sha(PAGE)
    const mine = edit("Fifth paragraph.", "Fifth, by Bob.")
    const id = (await draft(bob, mine)).body.id
    vault.push(PAGE, edit("First paragraph.", "First, by someone."))
    // Bob claims main's version as his base without taking its change in.
    expect((await put(bob, id, { base_sha: vault.sha(PAGE) })).status).toBe(200)
    expect(await auditRows("action = 'edit.rebase'")).toEqual([
      expect.objectContaining({
        detail_json: JSON.stringify({ draft: id, from: base, to: vault.sha(PAGE), clean: false }),
      }),
    ])
  })

  it("treats a merge the page's checks refuse as a conflict, not a merge", async () => {
    const bob = await as("bob")
    // Each adds the same front matter key on a different line: fine apart, invalid together.
    const mine = TEXT.replace("title: Engines\n", "title: Engines\nscope: mine\n")
    const id = (await draft(bob, mine)).body.id
    vault.push(PAGE, TEXT.replace("tags: [research]\n", "tags: [research]\nscope: theirs\n"))
    const refused = await send(bob, id)
    expect(refused).toMatchObject({ status: 409, body: { kind: "main" } })
    expect(refused.body.merged_text).toBeUndefined()
  })

  it("says a page gone from main was moved or deleted", async () => {
    const bob = await as("bob")
    const id = (await draft(bob, TEXT + "More.\n")).body.id
    vault.push(PAGE, null)
    expect(await send(bob, id)).toMatchObject({
      status: 409,
      body: { kind: "moved", incoming: null, detail: expect.stringContaining("moved or deleted") },
    })
  })

  it("refuses a draft whose base is no version of any file", async () => {
    const bob = await as("bob")
    const made = await post(bob, "/api/edit/drafts", {
      repo: "vault",
      path: PAGE,
      base_sha: "0123456789abcdef0123456789abcdef01234567",
      text: TEXT + "More.\n",
    })
    expect(made.status).toBe(409)
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM upload_drafts").first<any>())!.n).toBe(
      0,
    )
  })
})

describe("one member, two devices", () => {
  it("refuses a save made over an older version, and keeps the newer text", async () => {
    const ada = await as("ada")
    const created = (await draft(ada, TEXT + "One.\n")).body
    expect(created.version).toBe(0)
    // The first device saves; the second still holds version 0.
    const first = await put(ada, created.id, { text: TEXT + "Two.\n", version: 0 })
    expect(first.body.version).toBe(1)
    const stale = await put(ada, created.id, { text: TEXT + "Stale.\n", version: 0 })
    expect(stale.status).toBe(409)
    expect(stale.body).toMatchObject({ kind: "stale", text: TEXT + "Two.\n", version: 1 })
    expect((await ada.json(`/api/edit/drafts/${created.id}`)).body.text).toBe(TEXT + "Two.\n")
    // Keeping the stale device's text is a choice: a save that names the newer version.
    const kept = await put(ada, created.id, { text: TEXT + "Stale.\n", version: 1 })
    expect(kept.status).toBe(200)
    expect(kept.body.version).toBe(2)
  })

  it("makes one draft of two first saves at once", async () => {
    const ada = await as("ada")
    const answers = await Promise.all([draft(ada, TEXT + "One.\n"), draft(ada, TEXT + "Two.\n")])
    expect(answers.map((answer) => answer.status).sort()).toEqual([201, 409])
    const { results } = await env.DB.prepare(
      "SELECT id FROM upload_drafts WHERE login = 'ada' AND status = 'editing'",
    ).all()
    expect(results.length).toBe(1)
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM upload_changes").first<any>())!.n).toBe(
      1,
    )
    // The one that lost left no text behind.
    const staged = await env.ARTIFACTS.list({ prefix: "uploads/" })
    expect(staged.objects.map((o) => o.key)).toEqual([`uploads/${results[0].id}/${PAGE}`])
  })
})
