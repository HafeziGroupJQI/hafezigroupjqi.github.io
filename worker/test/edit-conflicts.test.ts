import { env } from "cloudflare:test"
import { beforeEach, describe, expect, it } from "vitest"
import { as } from "./helpers"
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
