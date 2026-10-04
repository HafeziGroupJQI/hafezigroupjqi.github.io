import { env } from "cloudflare:test"
import { beforeEach, describe, expect, it } from "vitest"
import { HttpError } from "../src/http"
import { mergeDue } from "../src/uploads/merge"
import { mountsIn, oneVault, vaultOf, vaultOfFolder, vaultRepo } from "../src/vaults"
import { OPTICAL_ACL, as, setAcl } from "./helpers"
import { opticalVault, privateVault, privateVaults, upstreamBodies, upstreamCalls } from "./worker"

// Restricted vaults (worker/vaults.json): vault-optical-rl, its own repository, mounted at
// projects/optical-rl/ in the private vault. A path there goes to that repository, with the same
// tokens: uploads, page edits, the hourly merge, documents and history.

const NOTE = `---
title: Optical RL meeting
date: 2026-10-03
type: note
tags: [internal, notes]
---

PPO on the microring.
`
const PLAN = "projects/optical-rl/notes/plan.md"

// A member of the optical RL group (migration 0018), so these keep passing once access is enforced.
const member = () => as("anishgoyal1108")

beforeEach(async () => {
  privateVault.reset({ "notes/meeting.md": NOTE, "projects/other/a.md": NOTE })
  opticalVault.reset({ [PLAN]: NOTE, "projects/optical-rl/files/run.csv": "a\n1\n" })
  await env.DB.prepare("DELETE FROM upload_changes").run()
  await env.DB.prepare("DELETE FROM upload_drafts").run()
  await env.DB.prepare("DELETE FROM changes").run()
  await env.DB.prepare("DELETE FROM audit_log").run()
  upstreamCalls.splice(0)
})

describe("vaults", () => {
  it("finds a path's vault by its longest mount", () => {
    expect(vaultOf(PLAN).repo).toBe("vault-optical-rl")
    expect(vaultOf("projects/optical-rl-other/a.md").repo).toBe("vault-private")
    expect(vaultOf("notes/a.md").repo).toBe("vault-private")
    expect(vaultOfFolder("projects/optical-rl").repo).toBe("vault-optical-rl")
    expect(vaultOfFolder("projects").repo).toBe("vault-private")
    expect(vaultRepo(env as any, vaultOf(PLAN))).toBe("HafeziGroupJQI/vault-optical-rl")
    expect(vaultRepo(env as any, vaultOf("notes/a.md"))).toBe("HafeziGroupJQI/vault-private")
    expect(mountsIn("projects").map((m) => m.path)).toEqual(["projects/optical-rl"])
    expect(mountsIn("")).toEqual([])
    expect(oneVault([PLAN, "projects/optical-rl/b.md", null]).repo).toBe("vault-optical-rl")
    expect(() => oneVault([PLAN, "notes/a.md"])).toThrow(HttpError)
  })

  it("sends an upload under the mount to its own repository, and merges it there", async () => {
    const ada = await member()
    const id = (await ada.json("/api/uploads/drafts", { method: "POST", body: "{}" })).body.id
    const staged = await ada.json(
      `/api/uploads/drafts/${id}/file?path=projects/optical-rl/notes/new.md`,
      { method: "PUT", body: NOTE },
    )
    expect(staged.status).toBe(200)
    // One draft, one repository: a file of vault-private can't join it.
    const mixed = await ada.json(`/api/uploads/drafts/${id}/file?path=notes/other.md`, {
      method: "PUT",
      body: NOTE,
    })
    expect(mixed.status).toBe(422)
    const rename = await ada.json(`/api/uploads/drafts/${id}/changes`, {
      method: "POST",
      body: JSON.stringify({ action: "rename", from: "notes/meeting.md", to: "notes/m.md" }),
    })
    expect(rename.status).toBe(422)
    const sent = await ada.json(`/api/uploads/drafts/${id}/send`, { method: "POST" })
    expect(sent.status).toBe(200)
    expect(sent.body.pull.url).toBe("https://github.com/HafeziGroupJQI/vault-optical-rl/pull/1")
    expect(opticalVault.pulls.get(1)).toMatchObject({ state: "open" })
    expect(privateVault.pulls.size).toBe(0)
    expect(
      (await env.DB.prepare("SELECT repo, path, slug FROM changes WHERE draft_id = ?")
        .bind(id)
        .first()) as any,
    ).toEqual({
      repo: "vault-optical-rl",
      path: "projects/optical-rl/notes/new.md",
      slug: "resources/projects/optical-rl/notes/new",
    })

    opticalVault.report(opticalVault.refs.get(`uploads/anishgoyal1108/${id}`)!, "success")
    const result = await mergeDue(env as any, privateVaults, sent.body.due_at)
    expect(result.merged).toEqual([id])
    expect(opticalVault.text("projects/optical-rl/notes/new.md")).toBe(NOTE)
    expect(privateVault.text("projects/optical-rl/notes/new.md")).toBeUndefined()
    const listing = (await ada.json("/api/uploads")).body.drafts[0]
    expect(listing.merge.url).toMatch(/^https:\/\/github.com\/HafeziGroupJQI\/vault-optical-rl\//)
  })

  it("leaves a sent upload to an admin when its author has left the group by its hour", async () => {
    await setAcl({
      ...OPTICAL_ACL,
      groups: { "optical-rl": { logins: ["anishgoyal1108", "lidaxu-physics"] } },
    })
    const lida = await as("lidaxu-physics")
    const id = (await lida.json("/api/uploads/drafts", { method: "POST", body: "{}" })).body.id
    const path = "projects/optical-rl/notes/late.md"
    expect(
      (
        await lida.json(`/api/uploads/drafts/${id}/file?path=${path}`, {
          method: "PUT",
          body: NOTE,
        })
      ).status,
    ).toBe(200)
    const sent = await lida.json(`/api/uploads/drafts/${id}/send`, { method: "POST" })
    expect(sent.status).toBe(200)
    // Removed from the group before the hourly run.
    await setAcl({ ...OPTICAL_ACL, groups: { "optical-rl": { logins: ["anishgoyal1108"] } } })
    opticalVault.report(opticalVault.refs.get(`uploads/lidaxu-physics/${id}`)!, "success")
    const result = await mergeDue(env as any, privateVaults, sent.body.due_at)
    expect(result.merged).toEqual([])
    expect(result.review).toEqual([id])
    expect(opticalVault.text(path)).toBeUndefined()
    const row = (await env.DB.prepare("SELECT status FROM upload_drafts WHERE id = ?")
      .bind(id)
      .first()) as { status: string }
    expect(row.status).toBe("review")
    await setAcl()
  })

  it("lists a mount in its folder, and its own folders from its repository", async () => {
    const ada = await member()
    const projects = (await ada.json("/api/uploads/folder?path=projects")).body
    expect(projects.entries.map((e: any) => [e.name, e.type])).toEqual([
      ["optical-rl", "folder"],
      ["other", "folder"],
    ])
    const notes = (await ada.json("/api/uploads/folder?path=projects/optical-rl/notes")).body
    expect(notes).toMatchObject({ exists: true, entries: [{ name: "plan.md", type: "file" }] })
  })

  it("edits a page under the mount in its own repository", async () => {
    const ada = await member()
    const source = await ada.json(
      `/api/edit/source?${new URLSearchParams({ repo: "vault-private", path: PLAN })}`,
    )
    expect(source.status).toBe(200)
    expect(source.body).toMatchObject({
      repo_name: "HafeziGroupJQI/vault-optical-rl",
      main: { text: NOTE },
    })
    const draft = await ada.json("/api/edit/drafts", {
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
    const sent = await ada.json(`/api/edit/drafts/${draft.body.id}/send`, { method: "POST" })
    expect(sent.status).toBe(200)
    expect(sent.body.pull.url).toBe("https://github.com/HafeziGroupJQI/vault-optical-rl/pull/1")
    expect(opticalVault.text(PLAN, `edits/anishgoyal1108/${draft.body.id}`)).toBe(NOTE + "More.\n")
    expect(privateVault.refs.size).toBe(1)
  })

  it("reads a page's history from its own repository", async () => {
    const rev = "1234567890abcdef1234567890abcdef12345678"
    upstreamBodies[`plan.md?ref=${rev}`] = [200, NOTE]
    const ada = await member()
    for (const repo of ["vault-private", "vault-optical-rl"]) {
      const response = await ada.fetch(
        `/api/history/file?${new URLSearchParams({ repo, rev, path: PLAN })}`,
      )
      expect(response.status).toBe(200)
      expect(await response.text()).toBe(NOTE)
    }
    expect(upstreamCalls).toEqual([
      `https://api.github.com/repos/HafeziGroupJQI/vault-optical-rl/contents/projects/optical-rl/notes/plan.md?ref=${rev}`,
    ])
  })

  it("streams a document under the mount from its own repository", async () => {
    const ada = await member()
    const response = await ada.fetch("/api/site/resources/projects/optical-rl/files/run.pdf")
    expect(response.status).toBe(200)
    expect(await response.text()).toBe("%PDF-1.4 optical")
    expect(upstreamCalls).toEqual([
      "https://api.github.com/repos/HafeziGroupJQI/vault-optical-rl/git/blobs/0b71ca1000000000000000000000000000000001",
    ])
  })
})
