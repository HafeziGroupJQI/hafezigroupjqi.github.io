import { env } from "cloudflare:test"
import { beforeEach, describe, expect, it } from "vitest"
import { as, setAcl } from "./helpers"
import { opticalVault, privateVault } from "./worker"

// Uploads and restricted folders: a member outside the group neither sees the folder nor its
// files in the folder picker, and can't add, replace, move or delete anything there; a member who
// loses access no longer sees, nor sends, their own draft of it.

const NOTE = `---
title: Optical RL plan
type: note
tags: [internal]
---

PPO on the microring.
`
const PLAN = "projects/optical-rl/notes/plan.md"

beforeEach(async () => {
  await setAcl()
  privateVault.reset({ "notes/meeting.md": NOTE, "projects/other/a.md": NOTE })
  opticalVault.reset({ [PLAN]: NOTE })
  for (const table of ["upload_changes", "upload_drafts", "audit_log"])
    await env.DB.prepare(`DELETE FROM ${table}`).run()
})

const folder = async (login: string, path: string) =>
  (await (await as(login)).json(`/api/uploads/folder?path=${path}`)).body

describe("uploads and restricted folders", () => {
  it("hide the folder and everything in it from a member outside the group", async () => {
    expect((await folder("outsider", "projects")).entries.map((e: any) => e.name)).toEqual([
      "other",
    ])
    expect(await folder("outsider", "projects/optical-rl/notes")).toEqual({
      path: "projects/optical-rl/notes",
      exists: false,
      entries: [],
    })
    expect((await folder("mjalalim3", "projects")).entries.map((e: any) => e.name)).toEqual([
      "optical-rl",
      "other",
    ])
    expect((await folder("mjalalim3", "projects/optical-rl/notes")).entries).toHaveLength(1)
  })

  it("refuse every change there from a member outside the group, as if it weren't there", async () => {
    const outsider = await as("outsider")
    const id = (await outsider.json("/api/uploads/drafts", { method: "POST", body: "{}" })).body.id
    const calls = opticalVault.calls.length
    const add = await outsider.json(
      `/api/uploads/drafts/${id}/file?path=projects/optical-rl/notes/new.md`,
      { method: "PUT", body: NOTE },
    )
    expect(add).toEqual({ status: 404, body: { detail: "not found" } })
    const replace = await outsider.json(
      `/api/uploads/drafts/${id}/file?path=${PLAN}&mode=replace`,
      {
        method: "PUT",
        body: NOTE,
      },
    )
    expect(replace.status).toBe(404)
    for (const body of [
      { action: "delete", path: PLAN },
      { action: "rename", from: PLAN, to: "projects/optical-rl/notes/moved.md" },
      { action: "rename", from: "notes/meeting.md", to: "projects/optical-rl/notes/m.md" },
    ]) {
      const change = await outsider.json(`/api/uploads/drafts/${id}/changes`, {
        method: "POST",
        body: JSON.stringify(body),
      })
      expect(change.status, JSON.stringify(body)).toBe(404)
    }
    expect(opticalVault.calls.length).toBe(calls)
  })

  it("keep a draft from a member who left the group: not listed, read or sent", async () => {
    const lida = await as("lidaxu-physics")
    const id = (await lida.json("/api/uploads/drafts", { method: "POST", body: "{}" })).body.id
    const staged = await lida.json(
      `/api/uploads/drafts/${id}/file?path=projects/optical-rl/notes/new.md`,
      { method: "PUT", body: NOTE },
    )
    expect(staged.status).toBe(200)
    expect((await lida.json("/api/uploads")).body.drafts).toHaveLength(1)
    await setAcl({
      groups: { "optical-rl": { logins: ["anishgoyal1108"] } },
      rules: [{ id: "r1", pattern: "projects/optical-rl/", allow: ["group:optical-rl"] }],
    })
    expect((await lida.json("/api/uploads")).body.drafts).toEqual([])
    expect((await lida.json(`/api/uploads/drafts/${id}`)).status).toBe(404)
    expect(
      (await lida.fetch(`/api/uploads/drafts/${id}/file?path=projects/optical-rl/notes/new.md`))
        .status,
    ).toBe(404)
    expect((await lida.json(`/api/uploads/drafts/${id}/send`, { method: "POST" })).status).toBe(404)
    expect(opticalVault.pulls.size).toBe(0)
    // An admin still sees every draft.
    const admin = await as("boss", "owner")
    expect((await admin.json(`/api/uploads/drafts/${id}`)).status).toBe(200)
  })
})
