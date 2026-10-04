import { env } from "cloudflare:test"
import { beforeEach, describe, expect, it } from "vitest"
import { as, setAcl } from "./helpers"
import { opticalVault, privateVault } from "./worker"

// The page editor and restricted pages: a private page a member may not read isn't in the vault
// for them (its source, a version from its history, a new draft), their own draft of it can't be
// read, saved or sent once they lose access, and a conflict over it is neither listed nor shown.

const NOTE = `---
title: Optical RL plan
type: note
tags: [internal]
---

PPO on the microring.
`
const PLAN = "projects/optical-rl/notes/plan.md"
const query = (params: Record<string, string>) => new URLSearchParams(params).toString()

beforeEach(async () => {
  await setAcl()
  privateVault.reset({ "notes/meeting.md": NOTE })
  opticalVault.reset({ [PLAN]: NOTE })
  for (const table of ["edit_conflicts", "upload_changes", "upload_drafts", "audit_log"])
    await env.DB.prepare(`DELETE FROM ${table}`).run()
})

const draftOf = async (login: string) => {
  const client = await as(login)
  const source = await client.json(
    `/api/edit/source?${query({ repo: "vault-private", path: PLAN })}`,
  )
  expect(source.status).toBe(200)
  const draft = await client.json("/api/edit/drafts", {
    method: "POST",
    body: JSON.stringify({
      repo: "vault-private",
      path: PLAN,
      text: NOTE + "More.\n",
      base_sha: source.body.main.sha,
      summary: "add a line",
    }),
  })
  expect(draft.status).toBe(201)
  return draft.body.id as string
}

describe("editing restricted pages", () => {
  it("doesn't find them for a member outside the group, and asks GitHub nothing", async () => {
    const outsider = await as("outsider")
    const calls = opticalVault.calls.length
    const source = await outsider.json(
      `/api/edit/source?${query({ repo: "vault-private", path: PLAN })}`,
    )
    expect(source).toEqual({ status: 404, body: { detail: `${PLAN} isn't in the vault` } })
    const revert = await outsider.json(
      `/api/edit/revert?${query({ repo: "vault-private", path: PLAN, rev: "c".repeat(40), mode: "restore" })}`,
    )
    expect(revert.status).toBe(404)
    const made = await outsider.json("/api/edit/drafts", {
      method: "POST",
      body: JSON.stringify({
        repo: "vault-private",
        path: PLAN,
        text: NOTE,
        base_sha: "abcdef12",
        summary: "x",
      }),
    })
    expect(made.status).toBe(404)
    expect(opticalVault.calls.length).toBe(calls)
    // Unrestricted pages open as ever.
    const meeting = await outsider.json(
      `/api/edit/source?${query({ repo: "vault-private", path: "notes/meeting.md" })}`,
    )
    expect(meeting.status).toBe(200)
  })

  it("lets the group and admins edit them", async () => {
    await draftOf("anishgoyal1108")
    const admin = await as("boss", "owner")
    const source = await admin.json(
      `/api/edit/source?${query({ repo: "vault-private", path: PLAN })}`,
    )
    expect(source.body.main.text).toBe(NOTE)
  })

  it("keeps a member's own draft from them once they leave the group", async () => {
    const id = await draftOf("lidaxu-physics")
    await setAcl({
      groups: { "optical-rl": { logins: ["anishgoyal1108"] } },
      rules: [{ id: "r1", pattern: "projects/optical-rl/", allow: ["group:optical-rl"] }],
    })
    const lida = await as("lidaxu-physics")
    expect((await lida.json(`/api/edit/drafts/${id}`)).status).toBe(404)
    const saved = await lida.json(`/api/edit/drafts/${id}`, {
      method: "PUT",
      body: JSON.stringify({ text: NOTE + "Even more.\n" }),
    })
    expect(saved.status).toBe(404)
    expect((await lida.json(`/api/edit/drafts/${id}/send`, { method: "POST" })).status).toBe(404)
    // Taking it back still works: nothing of the page shows.
    expect((await lida.json(`/api/edit/drafts/${id}`, { method: "DELETE" })).status).toBe(200)
  })

  it("neither lists nor shows a conflict over a page the member may not read", async () => {
    const id = await draftOf("anishgoyal1108")
    await env.DB.prepare(
      `INSERT INTO edit_conflicts (id, repo, path, draft_id, login, first_login, first_author,
         reason, opened_at, expires_at)
       VALUES ('c1', 'vault-private', ?, ?, 'anishgoyal1108', 'outsider', 'Outsider', 'pending', 0, 9e15)`,
    )
      .bind(PLAN, id)
      .run()
    const outsider = await as("outsider")
    const listed = await outsider.json("/api/edit/conflicts?role=first")
    expect(listed.body).toEqual({ conflicts: [], counts: { mine: 0, first: 0 } })
    expect((await outsider.json("/api/edit/conflicts/c1")).status).toBe(404)
    const resolve = await outsider.json("/api/edit/conflicts/c1/resolve", {
      method: "POST",
      body: JSON.stringify({ choice: "first" }),
    })
    expect(resolve.status).toBe(404)
    const anish = await as("anishgoyal1108")
    const mine = await anish.json("/api/edit/conflicts?role=mine")
    expect(mine.body.counts.mine).toBe(1)
    expect(mine.body.conflicts[0].path).toBe(PLAN)
  })
})
