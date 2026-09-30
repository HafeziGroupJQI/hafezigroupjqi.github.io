import { env } from "cloudflare:test"
import { beforeEach, describe, expect, it } from "vitest"
import { commitDue } from "../src/edit/publish"
import { mergeDue } from "../src/uploads/merge"
import { as, auditRows } from "./helpers"
import { privateVault, vault } from "./worker"

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
  await env.DB.prepare("DELETE FROM admins").run()
  privateVault.reset({
    "notes/meeting.md": TEXT.replace(
      "type: research\ntags: [research]",
      "type: note\ntags: [internal, notes]",
    ),
  })
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

const conflicts = async () =>
  (await env.DB.prepare("SELECT * FROM edit_conflicts ORDER BY opened_at").all<any>()).results
const statusOf = async (id: string) =>
  (await env.DB.prepare("SELECT status FROM upload_drafts WHERE id = ?").bind(id).first<any>())!
    .status
const ADA_LINE = edit("Third paragraph.", "Third, as Ada has it.")
const BOB_LINE = edit("Third paragraph.", "Third, as Bob has it.")

/** Ada publishes a change of the third paragraph; Bob changes the same one. */
async function overlapping() {
  const ada = await as("ada")
  const bob = await as("bob")
  const first = (await draft(ada, ADA_LINE, "ada's third")).body.id
  const published = await send(ada, first)
  expect(published.status).toBe(200)
  const second = (await draft(bob, BOB_LINE, "bob's third")).body.id
  return { ada, bob, first, second, due: published.body.due_at as number }
}

describe("another member's sent change to the same page", () => {
  it("stops a send that touches the same lines, naming them and showing their change", async () => {
    const { bob, first, second, due } = await overlapping()
    const refused = await send(bob, second)
    expect(refused).toMatchObject({
      status: 409,
      body: {
        kind: "pending",
        with: { draft: first, login: "ada", author: "ada", due_at: due },
        base_text: TEXT,
        their_text: ADA_LINE,
        proposed: BOB_LINE,
      },
    })
    expect(refused.body.with.sent_at).toEqual(expect.any(Number))
    // Not queued: Bob chooses what happens.
    expect(await statusOf(second)).toBe("editing")
    expect(await conflicts()).toEqual([])
  })

  it("lets a change to other lines go in beside theirs, and says so", async () => {
    const { ada, bob, first, due } = await overlapping()
    const cy = await as("cy")
    const other = (await draft(cy, edit("Fifth paragraph.", "Fifth, by Cy."), "cy")).body.id
    const sent = await send(cy, other)
    expect(sent.status).toBe(200)
    expect(sent.body.beside).toEqual([expect.objectContaining({ draft: first, login: "ada" })])
    // Both go in with the run, Ada's first.
    expect(await commitDue(env as any, vault.fetch, due + 3_600_000)).toMatchObject({
      merged: [first, other],
    })
    expect(vault.text(PAGE)).toBe(edit("Fifth paragraph.", "Fifth, by Cy.", ADA_LINE))
    expect(ada && bob).toBeTruthy()
  })

  it("never lets an unsent draft hold a page", async () => {
    const ada = await as("ada")
    const bob = await as("bob")
    await draft(ada, ADA_LINE)
    const second = (await draft(bob, BOB_LINE)).body.id
    expect((await send(bob, second)).status).toBe(200)
    // Bob sees Ada's name only, not her draft or its text.
    const seen = (await bob.json(`/api/edit/source?repo=vault&path=${PAGE}`)).body.others
    expect(seen).toEqual([
      {
        login: "ada",
        kind: "edit",
        status: "editing",
        sent_at: null,
        due_at: null,
        author: null,
        draft: null,
      },
    ])
  })

  it("queues the second change for review: held, recorded, and left alone by the runs", async () => {
    const { bob, first, second, due } = await overlapping()
    const queued = await post(bob, `/api/edit/drafts/${second}/queue`)
    expect(queued.status).toBe(200)
    expect(queued.body).toMatchObject({
      draft: { id: second, status: "conflict" },
      conflict: {
        draft: second,
        login: "bob",
        first_draft: first,
        first_login: "ada",
        reason: "pending",
        state: "open",
        can_settle: false,
        can_withdraw: true,
      },
    })
    expect(await auditRows("action = 'edit.conflict.queue'")).toEqual([
      expect.objectContaining({ login: "bob", target: PAGE }),
    ])
    const { results } = await env.DB.prepare("SELECT state, author FROM changes WHERE draft_id = ?")
      .bind(second)
      .all()
    expect(results).toEqual([{ state: "conflict", author: "bob" }])
    // Ada's goes in on schedule; Bob's waits.
    expect(await commitDue(env as any, vault.fetch, due)).toMatchObject({ merged: [first] })
    expect(await commitDue(env as any, vault.fetch, due + 7_200_000)).toMatchObject({ merged: [] })
    expect(await statusOf(second)).toBe("conflict")
    expect(vault.text(PAGE)).toBe(ADA_LINE)
    // Held: Bob can't change or send it until he withdraws it.
    expect((await put(bob, second, { text: TEXT + "x\n" })).status).toBe(409)
    expect((await send(bob, second)).status).toBe(409)
    // Ada sees it on the page, to settle; Bob sees his own, waiting.
    const ada = await as("ada")
    const hers = (await ada.json(`/api/edit/source?repo=vault&path=${PAGE}`)).body
    expect(hers.to_settle).toEqual([expect.objectContaining({ draft: second, you_first: true })])
    const his = (await bob.json(`/api/edit/source?repo=vault&path=${PAGE}`)).body
    expect(his.conflict).toMatchObject({ draft: second, can_withdraw: true })
    expect(his.to_settle).toEqual([])
  })

  it("won't queue a change nothing conflicts with, nor more than five at once", async () => {
    const bob = await as("bob")
    const alone = (await draft(bob, BOB_LINE, "mine")).body.id
    expect(await post(bob, `/api/edit/drafts/${alone}/queue`)).toMatchObject({
      status: 409,
      body: { detail: expect.stringContaining("nothing conflicts") },
    })
    expect(await statusOf(alone)).toBe("editing")
    await bob.json(`/api/edit/drafts/${alone}`, { method: "DELETE" })
    // Five held already, on other pages.
    for (let i = 0; i < 5; i++) {
      const path = `content/research/topic-${i}.md`
      vault.push(path, TEXT)
      const id = (await draft(bob, TEXT + `${i}\n`, "mine", path)).body.id
      await env.DB.batch([
        env.DB.prepare("UPDATE upload_drafts SET status = 'conflict' WHERE id = ?").bind(id),
        env.DB.prepare(
          `INSERT INTO edit_conflicts (id, repo, path, draft_id, login, reason, opened_at, expires_at)
           VALUES (?, 'vault', ?, ?, 'bob', 'main', 0, 9e15)`,
        ).bind(`00000000000${i}`, path, id),
      ])
    }
    const { second } = await overlapping()
    expect((await post(bob, `/api/edit/drafts/${second}/queue`)).status).toBe(429)
    expect(await statusOf(second)).toBe("editing")
  })

  it("lets the second editor withdraw a held change, and discarding it withdraws it too", async () => {
    const { bob, second } = await overlapping()
    const { conflict } = (await post(bob, `/api/edit/drafts/${second}/queue`)).body
    const ada = await as("ada")
    // Only Bob withdraws it.
    expect((await post(ada, `/api/edit/conflicts/${conflict.id}/withdraw`)).status).toBe(403)
    const eve = await as("eve")
    expect((await post(eve, `/api/edit/conflicts/${conflict.id}/withdraw`)).status).toBe(404)
    const back = await post(bob, `/api/edit/conflicts/${conflict.id}/withdraw`)
    expect(back.body).toMatchObject({
      conflict: { state: "withdrawn" },
      draft: { status: "editing" },
    })
    expect((await post(bob, `/api/edit/conflicts/${conflict.id}/withdraw`)).status).toBe(409)
    expect((await bob.json(`/api/edit/drafts/${second}`)).body.text).toBe(BOB_LINE)
    // Queued again, then discarded.
    await post(bob, `/api/edit/drafts/${second}/queue`)
    await bob.json(`/api/edit/drafts/${second}`, { method: "DELETE" })
    expect((await conflicts()).map((row) => row.state)).toEqual(["withdrawn", "withdrawn"])
    expect(await auditRows("action = 'edit.conflict.withdraw'")).toHaveLength(1)
  })

  it("treats any other edit of a notebook as a conflict", async () => {
    const path = "notes/fit.ipynb"
    const notebook = (source: string) =>
      JSON.stringify(
        {
          cells: [{ cell_type: "markdown", metadata: {}, source }],
          metadata: {},
          nbformat: 4,
          nbformat_minor: 5,
        },
        null,
        1,
      ) + "\n"
    privateVault.push(path, notebook("a\nb\nc\nd\ne"))
    const ada = await as("ada")
    const bob = await as("bob")
    const create = (client: Client, text: string) =>
      post(client, "/api/edit/drafts", {
        repo: "vault-private",
        path,
        base_sha: privateVault.sha(path),
        text,
        summary: "cells",
      })
    const first = (await create(ada, notebook("A\nb\nc\nd\ne"))).body.id
    expect((await send(ada, first)).status).toBe(200)
    const second = (await create(bob, notebook("a\nb\nc\nd\nE"))).body.id
    expect(await send(bob, second)).toMatchObject({ status: 409, body: { kind: "pending" } })
  })

  it("reads a private page's first change from its branch, and holds a queued one with no pull request", async () => {
    const path = "notes/meeting.md"
    const base = privateVault.text(path)!
    const ada = await as("ada")
    const bob = await as("bob")
    const create = (client: Client, text: string) =>
      post(client, "/api/edit/drafts", {
        repo: "vault-private",
        path,
        base_sha: privateVault.sha(path),
        text,
        summary: "a change",
      })
    const first = (await create(ada, base.replace("Third paragraph.", "Ada's third."))).body.id
    const sentFirst = await send(ada, first)
    expect(sentFirst.body).toMatchObject({ pull: { number: 1 } })
    const second = (await create(bob, base.replace("Third paragraph.", "Bob's third."))).body.id
    expect(await send(bob, second)).toMatchObject({
      status: 409,
      body: { kind: "pending", their_text: base.replace("Third paragraph.", "Ada's third.") },
    })
    expect((await post(bob, `/api/edit/drafts/${second}/queue`)).status).toBe(200)
    expect(privateVault.pulls.size).toBe(1)
    privateVault.report(privateVault.refs.get(`edits/ada/${first}`)!, "success")
    const run = await mergeDue(env as any, privateVault.fetch, sentFirst.body.due_at)
    expect(run.merged).toEqual([first])
    expect(await statusOf(second)).toBe("conflict")
  })
})
