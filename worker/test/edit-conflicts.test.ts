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

describe("editing on top of another member's sent change", () => {
  it("goes in after theirs, with both changes, and never before it", async () => {
    const { ada, bob, first, second, due } = await overlapping()
    const both = edit("Third paragraph.", "Third, as Ada has it, and Bob too.")
    const stacked = await put(bob, second, { stack_on: first, text: both })
    expect(stacked.status).toBe(200)
    const row = await env.DB.prepare("SELECT after_draft FROM upload_drafts WHERE id = ?")
      .bind(second)
      .first<any>()
    expect(row.after_draft).toBe(first)
    expect(await auditRows("action = 'edit.stack'")).toHaveLength(1)
    // On top of Ada's text, Bob's send is clean.
    const sent = await send(bob, second)
    expect(sent.status).toBe(200)
    // Ada revises hers: Bob's waits for it, even when its own hour comes first.
    await env.DB.prepare("UPDATE upload_drafts SET due_at = ? WHERE id = ?")
      .bind(due - 3_600_000, second)
      .run()
    await put(ada, first, { text: ADA_LINE + "\nAda's afterthought.\n" })
    expect(await commitDue(env as any, vault.fetch, due)).toMatchObject({
      merged: [],
      waiting: [first, second],
    })
    expect(vault.text(PAGE)).toBe(TEXT)
    // Published again, Ada's goes in, then Bob's on top of it, in one run.
    const again = (await send(ada, first)).body.due_at
    expect(await commitDue(env as any, vault.fetch, again)).toMatchObject({
      merged: [first, second],
    })
    expect(vault.text(PAGE)).toBe(both + "\nAda's afterthought.\n")
  })

  it("holds the second when the first is taken back, and says why", async () => {
    const { ada, bob, first, second, due } = await overlapping()
    await put(bob, second, { stack_on: first, text: BOB_LINE })
    expect((await send(bob, second)).status).toBe(200)
    await ada.json(`/api/edit/drafts/${first}`, { method: "DELETE" })
    expect(await commitDue(env as any, vault.fetch, due)).toMatchObject({ conflicts: [second] })
    expect((await bob.json(`/api/edit/drafts/${second}`)).body).toMatchObject({
      status: "conflict",
      detail: { message: expect.stringContaining("taken back") },
    })
    expect((await conflicts()).map((row) => [row.draft_id, row.reason])).toEqual([
      [second, "base-gone"],
    ])
  })

  it("stacks only on a sent change to the same page by someone else", async () => {
    const { ada, bob, first, second } = await overlapping()
    const other = (await draft(ada, TEXT + "x\n", "x", "content/research/optics.md")).body.id
    const eve = await as("eve")
    const unsent = (await draft(eve, TEXT + "eve\n")).body.id
    const own = (await draft(await as("cy"), TEXT + "cy\n")).body.id
    for (const target of [other, unsent, own.replace(/./, "f"), second, "nope"])
      expect(
        (await put(bob, second, { stack_on: target, text: BOB_LINE })).status,
      ).toBeGreaterThanOrEqual(409)
    await ada.json(`/api/edit/drafts/${first}`, { method: "DELETE" })
    expect((await put(bob, second, { stack_on: first, text: BOB_LINE })).status).toBe(409)
    const row = await env.DB.prepare("SELECT after_draft FROM upload_drafts WHERE id = ?")
      .bind(second)
      .first<any>()
    expect(row.after_draft).toBeNull()
  })

  it("keeps a private stacked draft out of the hourly merge until the first is merged", async () => {
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
    const due = (await send(ada, first)).body.due_at
    const second = (await create(bob, base.replace("Third paragraph.", "Bob's third."))).body.id
    const both = base.replace("Third paragraph.", "Ada's third, and Bob's.")
    expect((await put(bob, second, { stack_on: first, text: both })).status).toBe(200)
    const sent = await send(bob, second)
    expect(sent.status).toBe(200)
    for (const branch of [`edits/ada/${first}`, `edits/bob/${second}`])
      privateVault.report(privateVault.refs.get(branch)!, "success")
    // Bob's is due first; it waits for Ada's all the same.
    await env.DB.prepare("UPDATE upload_drafts SET due_at = ? WHERE id = ?")
      .bind(due - 3_600_000, second)
      .run()
    expect((await mergeDue(env as any, privateVault.fetch, due - 3_600_000)).waiting).toEqual([
      second,
    ])
    const run = await mergeDue(env as any, privateVault.fetch, due)
    expect(run.merged).toEqual([first])
    expect((await mergeDue(env as any, privateVault.fetch, due)).merged).toEqual([second])
    expect(privateVault.text(path)).toBe(both)
  })
})

describe("settling a queued conflict", () => {
  async function queued() {
    const setup = await overlapping()
    const { conflict } = (await post(setup.bob, `/api/edit/drafts/${setup.second}/queue`)).body
    return { ...setup, conflict: conflict.id as string }
  }
  const resolve = (client: Client, id: string, body: unknown) =>
    post(client, `/api/edit/conflicts/${id}/resolve`, body)
  const unchanged = async (id: string) => {
    const [row] = await conflicts()
    expect(row).toMatchObject({ id, state: "open", resolved_by: null })
  }

  it("is never settled by the second editor, even an admin, nor by anyone else", async () => {
    const { bob, conflict } = await queued()
    // A1: the body names no one; who is first is the Worker's own row.
    expect(
      (await resolve(bob, conflict, { choice: "second", first_login: "bob", login: "ada" })).status,
    ).toBe(403)
    await env.DB.prepare(
      "INSERT INTO admins (login, added_by, added_at) VALUES ('bob', 'olivia', 0)",
    ).run()
    expect((await resolve(bob, conflict, { choice: "second" })).status).toBe(403)
    // A9: anyone else is told there is no such conflict, and sees none of its text.
    const eve = await as("eve")
    expect((await resolve(eve, conflict, { choice: "first" })).status).toBe(404)
    expect((await eve.json(`/api/edit/conflicts/${conflict}`)).status).toBe(404)
    await unchanged(conflict)
    expect(await statusOf((await conflicts())[0].draft_id)).toBe("conflict")
  })

  it("shows its parties and admins both changes and a proposed merge", async () => {
    const { ada, bob, conflict } = await queued()
    for (const client of [ada, bob, await as("olivia", "owner")]) {
      const seen = await client.json(`/api/edit/conflicts/${conflict}`)
      expect(seen).toMatchObject({
        status: 200,
        body: {
          base_text: TEXT,
          first_text: ADA_LINE,
          second_text: BOB_LINE,
          proposed: BOB_LINE,
          clean: false,
        },
      })
    }
    expect((await ada.json("/api/edit/conflicts?role=first")).body).toMatchObject({
      conflicts: [{ id: conflict, you_first: true, can_settle: true }],
      counts: { first: 1, mine: 0 },
    })
    expect((await bob.json("/api/edit/conflicts?role=mine")).body.counts).toEqual({
      mine: 1,
      first: 0,
    })
    expect((await bob.json("/api/edit/conflicts?role=all")).status).toBe(422)
    const owner = await as("olivia", "owner")
    expect((await owner.json("/api/edit/conflicts?role=all")).body.conflicts).toHaveLength(1)
  })

  it("lets the first editor take the second change: it goes in after theirs, under its author", async () => {
    const { ada, bob, first, second, due, conflict } = await queued()
    const settled = await resolve(ada, conflict, { choice: "second" })
    expect(settled).toMatchObject({
      status: 200,
      body: {
        conflict: { state: "resolved", resolution: "second" },
        draft: { id: second, status: "open", unsent: false },
      },
    })
    const row = await env.DB.prepare("SELECT * FROM upload_drafts WHERE id = ?")
      .bind(second)
      .first<any>()
    expect(row.after_draft).toBe(first)
    expect(row.due_at).toBeGreaterThanOrEqual(due)
    expect((await conflicts())[0]).toMatchObject({ state: "resolved", resolved_by: "ada" })
    const change = await env.DB.prepare("SELECT state, summary FROM changes WHERE draft_id = ?")
      .bind(second)
      .first<any>()
    expect(change).toMatchObject({
      state: "sent",
      summary: expect.stringContaining("(settled by ada)"),
    })
    expect(await auditRows("action = 'edit.conflict.resolve'")).toEqual([
      expect.objectContaining({
        login: "ada",
        detail_json: JSON.stringify({ conflict, choice: "second", first: "ada", second: "bob" }),
      }),
    ])
    // Ada's goes in on schedule, then Bob's (a full hour after it was settled, here the same
    // hour), whose lines win where both changed.
    const run = await commitDue(env as any, vault.fetch, Math.max(due, row.due_at))
    expect(run.merged).toEqual([first, second])
    expect(vault.text(PAGE)).toBe(BOB_LINE)
    expect(vault.commit(vault.commit(vault.head).parents[0]).author.email).toBe(
      "ada@users.noreply.github.com",
    )
    expect(vault.commit(vault.head)).toMatchObject({
      author: { email: "bob@users.noreply.github.com" },
      message: expect.stringContaining("settled by ada"),
    })
    expect(bob).toBeTruthy()
  })

  it("lets an admin keep the first change: the second goes back to its author as a draft", async () => {
    const { bob, second, conflict } = await queued()
    const owner = await as("olivia", "owner")
    expect((await resolve(owner, conflict, { choice: "first" })).body).toMatchObject({
      conflict: { state: "rejected" },
    })
    expect((await bob.json(`/api/edit/drafts/${second}`)).body).toMatchObject({
      status: "editing",
      text: BOB_LINE,
      detail: { message: expect.stringContaining("kept the first change") },
    })
    // Settled once: a second answer finds it taken (A11).
    expect((await resolve(owner, conflict, { choice: "second" })).status).toBe(409)
  })

  it("checks a merged text as any edit of the page, and leaves the conflict open if it fails", async () => {
    const { ada, conflict } = await queued()
    const merged = edit("Third paragraph.", "Third, merged.")
    // A10: HTML that runs can't come in through a settlement by a member.
    expect(
      (await resolve(ada, conflict, { choice: "merged", text: merged + "<script>x()</script>\n" }))
        .status,
    ).toBe(422)
    expect(
      (await resolve(ada, conflict, { choice: "merged", text: "no front matter" })).status,
    ).toBe(422)
    await unchanged(conflict)
    expect((await resolve(ada, conflict, { choice: "merged", text: merged })).status).toBe(200)
    expect((await conflicts())[0]).toMatchObject({ state: "resolved", resolution: "merged" })
  })

  it("settles against the first editor's newest sent text", async () => {
    const { ada, first, second, conflict } = await queued()
    const newer = ADA_LINE.replace("First paragraph.", "First, newer.")
    await put(ada, first, { text: newer })
    expect((await send(ada, first)).status).toBe(200)
    const seen = (await ada.json(`/api/edit/conflicts/${conflict}`)).body
    expect(seen.first_text).toBe(newer)
    expect(seen.proposed).toBe(BOB_LINE.replace("First paragraph.", "First, newer."))
    await resolve(ada, conflict, { choice: "second" })
    const base = await env.ARTIFACTS.get(`uploads/${second}/.base/${PAGE}`)
    expect(await base!.text()).toBe(newer)
  })

  it("sends a settled private change as a pull request again, after the first", async () => {
    const path = "notes/meeting.md"
    const base = privateVault.text(path)!
    const create = (client: Client, text: string) =>
      post(client, "/api/edit/drafts", {
        repo: "vault-private",
        path,
        base_sha: privateVault.sha(path),
        text,
        summary: "a change",
      })
    const ada = await as("ada")
    const bob = await as("bob")
    const first = (await create(ada, base.replace("Third paragraph.", "Ada's third."))).body.id
    expect((await send(ada, first)).status).toBe(200)
    const second = (await create(bob, base.replace("Third paragraph.", "Bob's third."))).body.id
    const { conflict } = (await post(bob, `/api/edit/drafts/${second}/queue`)).body
    const settled = await resolve(ada, conflict.id, { choice: "second" })
    expect(settled.body.draft).toMatchObject({ status: "open", pull: { number: 2 } })
    expect(privateVault.text(path, `edits/bob/${second}`)).toBe(
      base.replace("Third paragraph.", "Bob's third."),
    )
    expect(privateVault.pulls.get(2)!.title).toContain("settled by ada")
  })
})
