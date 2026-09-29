import { SELF, env } from "cloudflare:test"
import { beforeEach, describe, expect, it } from "vitest"
import { publishDue } from "../src/profile/publish"
import { WINDOW_MS, dueAt } from "../src/profile/routes"
import { ORIGIN, as, auditRows } from "./helpers"
import { vault } from "./worker"

const PAGE = `---
title: Ada Lovelace
type: person
role: Graduate Research Assistant
group: Graduate Students
building: Atlantic Building
office: "2369"
email: null
scope: null
profile: https://hafezi.jqi.umd.edu/people/ada-lovelace
photo: assets/people/ada-lovelace.png
research_areas: []
projects:
  - Analytical engines
tags:
  - people
  - role/grad
---

![[assets/people/ada-lovelace.png]]

Notes on the engine.
`

const OTHER = PAGE.replace(/Ada Lovelace/g, "Charles Babbage")
  .replace(/ada-lovelace/g, "charles-babbage")
  .replace("tags:\n", "github: cbabbage\ntags:\n")

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 0xff, 0xd9])

beforeEach(async () => {
  vault.reset({
    "content/people/index.md": "---\ntitle: People\n---\n",
    "content/people/ada-lovelace.md": PAGE,
    "content/people/charles-babbage.md": OTHER,
    "content/people/alumni/grace-hopper.md": PAGE.replace(/Ada Lovelace/g, "Grace Hopper"),
    "content/assets/people/ada-lovelace.png": new Uint8Array([0x89, 0x50]),
    "content/notes/x.md": "---\ntitle: x\n---\n",
  })
  await env.DB.prepare("DELETE FROM profiles").run()
  await env.DB.prepare("DELETE FROM profile_pending").run()
  for (const login of ["ada", "eve", "cbabbage"])
    for (const which of ["photo", "pending"])
      await env.ARTIFACTS.delete(`profiles/${login}/${which}.jpg`)
  // Storage is shared across tests, and profile changes count toward a daily limit.
  await env.DB.prepare(
    "DELETE FROM audit_log WHERE action LIKE 'profile.%' OR action LIKE 'admin.profile.%'",
  ).run()
})

const claim = (client: Awaited<ReturnType<typeof as>>, path: string) =>
  client.json("/api/profile/claim", { method: "POST", body: JSON.stringify({ path }) })

const decide = async (login: string, decision: "approve" | "reject") =>
  (await as("olivia", "owner")).json(`/api/admin/profile-claims/${login}/${decision}`, {
    method: "POST",
  })

/** Claim a page and have an admin approve it: the member is linked. */
async function link(client: Awaited<ReturnType<typeof as>>, path: string) {
  const claimed = await claim(client, path)
  expect(claimed.status).toBe(200)
  if (claimed.body.status === "pending") {
    const login = (await client.json("/api/session")).body.user.login
    expect((await decide(login, "approve")).status).toBe(200)
  }
}

/** The hourly publish, as the cron runs it, at a given time (default: two hours from now). */
const publish = (at = Date.now() + 2 * WINDOW_MS) => publishDue(env as any, vault.fetch, at)

const save = (client: Awaited<ReturnType<typeof as>>, body: object) =>
  client.json("/api/profile", { method: "PUT", body: JSON.stringify(body) })

describe("member settings: the People page", () => {
  it("is for signed-in members only", async () => {
    expect((await SELF.fetch(`${ORIGIN}/api/profile`)).status).toBe(401)
  })

  it("publishes an edit at the end of the hour after it was saved, and not before", () => {
    const at = Date.UTC(2026, 8, 28, 10, 20)
    expect(dueAt(at)).toBe(Date.UTC(2026, 8, 28, 12, 0))
    expect(dueAt(Date.UTC(2026, 8, 28, 10, 0))).toBe(Date.UTC(2026, 8, 28, 12, 0))
    expect(dueAt(Date.UTC(2026, 8, 28, 10, 59, 59))).toBe(Date.UTC(2026, 8, 28, 12, 0))
  })

  it("lists the People pages nobody has linked, alumni included", async () => {
    const ada = await as("ada")
    const profile = await ada.json("/api/profile")
    expect(profile.status).toBe(200)
    expect(profile.body).toMatchObject({ login: "ada", display_name: "ada", vault_ready: true })
    expect(profile.body.page).toBeNull()
    expect(profile.body.claimable).toEqual([
      { path: "content/people/ada-lovelace.md", slug: "ada-lovelace", alumni: false },
      { path: "content/people/alumni/grace-hopper.md", slug: "grace-hopper", alumni: true },
      { path: "content/people/charles-babbage.md", slug: "charles-babbage", alumni: false },
    ])
  })

  it("links a page once an admin approves, and writes github: <login> into it with the next hourly commit", async () => {
    const ada = await as("ada")
    const claimed = await claim(ada, "content/people/ada-lovelace.md")
    expect(claimed.body).toMatchObject({ status: "pending", pending: null })
    // Waiting for an admin, nothing changes: not the name, not the page, nothing queued.
    expect((await ada.json("/api/session")).body.user.display_name).toBe("ada")
    const waiting = (await ada.json("/api/profile")).body
    expect(waiting).toMatchObject({ page: null, pending: null, display_name: "ada" })
    expect(waiting.claim).toMatchObject({
      path: "content/people/ada-lovelace.md",
      slug: "ada-lovelace",
    })
    expect((await save(ada, { title: "Ada" })).status).toBe(409)
    const photo = { method: "PUT", headers: { "content-type": "image/jpeg" }, body: JPEG }
    expect((await ada.fetch("/api/profile/photo", photo)).status).toBe(409)
    expect((await claim(await as("eve"), "content/people/ada-lovelace.md")).status).toBe(409)
    expect((await claim(ada, "content/people/alumni/grace-hopper.md")).status).toBe(409)
    expect(await publish()).toEqual({ commit: null, published: [], dropped: [] })

    // Only an admin decides; they see who claimed which page, and when.
    const eve = await as("eve")
    expect((await eve.fetch("/api/admin/profile-claims")).status).toBe(403)
    expect(
      (await eve.fetch("/api/admin/profile-claims/ada/approve", { method: "POST" })).status,
    ).toBe(403)
    const owner = await as("olivia", "owner")
    const listed = await owner.json("/api/admin/profile-claims")
    expect(listed.body.claims).toEqual([
      expect.objectContaining({ login: "ada", path: "content/people/ada-lovelace.md" }),
    ])
    const approved = await decide("ada", "approve")
    expect(approved.body).toMatchObject({ status: "approved", pending: { link: true } })
    expect((await decide("ada", "approve")).status).toBe(404)
    expect((await owner.json("/api/admin/profile-claims")).body.claims).toEqual([])

    expect(vault.made).toEqual([]) // nothing committed yet
    expect((await ada.json("/api/session")).body.user.display_name).toBe("Ada Lovelace")
    const page = (await ada.json("/api/profile")).body.page
    expect(page).toMatchObject({ slug: "ada-lovelace", url: "/people/ada-lovelace" })
    expect((await claim(ada, "content/people/alumni/grace-hopper.md")).status).toBe(409)
    expect((await claim(await as("eve"), "content/people/ada-lovelace.md")).status).toBe(409)
    const rows = await auditRows("action LIKE 'admin.profile.%'")
    expect(rows.map((r) => [r.action, r.login, r.target])).toEqual([
      ["admin.profile.approve", "olivia", "ada"],
    ])

    expect(await publish(Date.now())).toEqual({ commit: null, published: [], dropped: [] })
    const done = await publish()
    expect(done.published).toEqual(["ada"])
    expect(vault.text("content/people/ada-lovelace.md")).toBe(
      PAGE.replace("tags:\n", "github: ada\ntags:\n"),
    )
    expect(vault.made.map((c) => [c.message, c.author.email])).toEqual([
      ["update people/ada-lovelace from the members site settings", "ada@users.noreply.github.com"],
    ])
    expect((await ada.json("/api/profile")).body.pending).toBeNull()
  })

  it("frees a page again when an admin turns the claim down", async () => {
    const eve = await as("eve")
    expect((await claim(eve, "content/people/ada-lovelace.md")).body.status).toBe("pending")
    const claimable = async () =>
      ((await eve.json("/api/profile")).body.claimable as any[]).map((p) => p.slug)
    expect(await claimable()).not.toContain("ada-lovelace")
    expect((await decide("eve", "reject")).body).toMatchObject({ status: "rejected" })
    expect((await eve.json("/api/profile")).body).toMatchObject({ claim: null, page: null })
    expect(await claimable()).toContain("ada-lovelace")
    expect((await decide("eve", "reject")).status).toBe(404)
    // The page's real owner can claim it now.
    expect((await claim(await as("ada"), "content/people/ada-lovelace.md")).status).toBe(200)
    const rows = await auditRows("action = 'admin.profile.reject'")
    expect(rows.map((r) => [r.login, r.target])).toEqual([["olivia", "eve"]])
    expect(await publish()).toEqual({ commit: null, published: [], dropped: [] })
  })

  it("won't link a page that names another GitHub login, or anything that isn't a People page", async () => {
    const eve = await as("eve")
    expect((await claim(eve, "content/people/charles-babbage.md")).status).toBe(409)
    expect((await claim(eve, "content/notes/x.md")).status).toBe(422)
    expect((await claim(eve, "content/people/index.md")).status).toBe(422)
    expect((await claim(eve, "content/people/nobody.md")).status).toBe(409)
    // The page's own login may link it at once; it names them already, so nothing is queued.
    const charles = await as("CBabbage")
    expect(await claim(charles, "content/people/charles-babbage.md")).toMatchObject({
      status: 200,
      body: { status: "approved", pending: null },
    })
    expect((await charles.json("/api/session")).body.user.display_name).toBe("Charles Babbage")
  })

  it("queues a saved edit, revisable until the hour after next, then commits only what changed", async () => {
    const ada = await as("ada")
    await link(ada, "content/people/ada-lovelace.md")
    const before = Date.now()
    const saved = await save(ada, {
      title: "Ada King",
      email: " ada@umd.edu ",
      building: "Atlantic Building",
      office: "2207",
      scope: "",
      profile: "https://hafezi.jqi.umd.edu/people/ada-lovelace",
    })
    expect(saved.status).toBe(200)
    expect(saved.body.pending.fields).toEqual(["title", "email", "office"])
    const wait = saved.body.pending.due_at - before
    expect(wait).toBeGreaterThanOrEqual(WINDOW_MS)
    expect(wait).toBeLessThanOrEqual(2 * WINDOW_MS)
    expect(vault.made).toEqual([])
    // The navbar and the form show the saved edit at once.
    expect((await ada.json("/api/session")).body.user.display_name).toBe("Ada King")
    const form = (await ada.json("/api/profile")).body.page
    expect(form.fields).toMatchObject({ title: "Ada King", email: "ada@umd.edu", office: "2207" })
    expect(form.published).toMatchObject({ title: "Ada Lovelace", office: "2369" })

    // Revised before it goes in: the office goes back to what the page says, so it isn't pending.
    const revised = await save(ada, { office: "2369", scope: "Engines" })
    expect(revised.body.pending.fields).toEqual(["title", "email", "scope"])

    await publish()
    expect(vault.text("content/people/ada-lovelace.md")).toBe(
      PAGE.replace("title: Ada Lovelace", "title: Ada King")
        .replace("email: null", "email: ada@umd.edu")
        .replace("scope: null", "scope: Engines")
        .replace("tags:\n", "github: ada\ntags:\n"),
    )
    expect(vault.made).toHaveLength(1) // the link and the edit, in one commit
    const rows = await auditRows("action = 'profile.publish'")
    expect(JSON.parse(rows.at(-1).detail_json)).toMatchObject({
      fields: ["title", "email", "scope"],
      link: true,
      photo: false,
    })
    expect((await ada.json("/api/profile")).body.pending).toBeNull()
  })

  it("commits every member's due edit in one commit, under the site's name", async () => {
    const ada = await as("ada")
    const grace = await as("grace")
    await link(ada, "content/people/ada-lovelace.md")
    await link(grace, "content/people/alumni/grace-hopper.md")
    await save(ada, { office: "1" })
    await save(grace, { office: "2" })
    const done = await publish()
    expect(done.published.sort()).toEqual(["ada", "grace"])
    expect(vault.made.map((c) => [c.message, c.author.name])).toEqual([
      [
        "update 2 people pages from the members site settings: ada-lovelace, grace-hopper",
        "hafezi members site",
      ],
    ])
  })

  it("discards a saved edit on request, keeping the link", async () => {
    const ada = await as("ada")
    await link(ada, "content/people/ada-lovelace.md")
    await save(ada, { title: "Ada King" })
    const discarded = await ada.json("/api/profile/pending", { method: "DELETE" })
    expect(discarded.body.pending).toMatchObject({ fields: [], link: true })
    expect((await ada.json("/api/session")).body.user.display_name).toBe("Ada Lovelace")
    await publish()
    expect(vault.text("content/people/ada-lovelace.md")).toContain("title: Ada Lovelace\n")
  })

  it("refuses bad values and edits before linking", async () => {
    const ada = await as("ada")
    const put = (body: object) => save(ada, body)
    expect((await put({ title: "Ada" })).status).toBe(409)
    await link(ada, "content/people/ada-lovelace.md")
    expect((await put({ title: "  " })).status).toBe(422)
    expect((await put({ email: "not an address" })).status).toBe(422)
    expect((await put({ profile: "javascript:alert(1)" })).status).toBe(422)
    expect((await put({ office: "a\nb" })).status).toBe(422)
    expect((await put({ scope: "x".repeat(501) })).status).toBe(422)
  })

  it("publishes on top of a push that lands meanwhile", async () => {
    const ada = await as("ada")
    await link(ada, "content/people/ada-lovelace.md")
    await save(ada, { office: "2207" })
    vault.beforeUpdate = () => vault.push("content/notes/y.md", "---\ntitle: y\n---\n")
    await publish()
    expect(vault.text("content/notes/y.md")).toContain("title: y")
    expect(vault.text("content/people/ada-lovelace.md")).toContain('office: "2207"')
  })

  it("keeps an edit for the next hour when GitHub won't take the commit", async () => {
    const ada = await as("ada")
    await link(ada, "content/people/ada-lovelace.md")
    await save(ada, { office: "2207" })
    // Someone pushes every time: the retry loses too, and the edit waits.
    vault.beforeUpdate = () => {
      vault.push("content/notes/y.md", "a")
      vault.beforeUpdate = () => vault.push("content/notes/y.md", "b")
    }
    await expect(publish()).rejects.toThrow()
    expect((await ada.json("/api/profile")).body.pending).toMatchObject({ fields: ["office"] })
    await publish()
    expect(vault.text("content/people/ada-lovelace.md")).toContain('office: "2207"')
  })

  it("drops an edit to a page someone relinked by hand", async () => {
    const ada = await as("ada")
    await link(ada, "content/people/ada-lovelace.md")
    await save(ada, { office: "1" })
    vault.push(
      "content/people/ada-lovelace.md",
      PAGE.replace("tags:\n", "github: mallory\ntags:\n"),
    )
    const done = await publish()
    expect(done).toMatchObject({ commit: null, dropped: ["ada"] })
    expect(vault.text("content/people/ada-lovelace.md")).toContain("github: mallory")
  })

  it("allows a limited number of saves a day", async () => {
    const ada = await as("ada")
    await link(ada, "content/people/ada-lovelace.md")
    await auditRows("action = 'profile.claim'")
    for (let i = 0; i < 59; i++)
      await env.DB.prepare(
        "INSERT INTO audit_log (at, login, action, target) VALUES (?, 'ada', 'profile.save', 'x')",
      )
        .bind(Date.now())
        .run()
    expect((await save(ada, { office: "1" })).status).toBe(429)
  })
})

describe("member settings: the photo", () => {
  const putPhoto = (client: Awaited<ReturnType<typeof as>>, body: BodyInit, type = "image/jpeg") =>
    client.fetch("/api/profile/photo", { method: "PUT", headers: { "content-type": type }, body })

  it("queues a saved photo, shows it in the navbar at once, and commits it with the hour", async () => {
    const ada = await as("ada")
    await link(ada, "content/people/ada-lovelace.md")
    const saved = await putPhoto(ada, JPEG)
    expect(saved.status).toBe(200)
    const { avatar, pending } = (await saved.json()) as any
    expect(pending).toMatchObject({ photo: true })
    expect(vault.made).toEqual([])
    expect((await ada.json("/api/session")).body.user.avatar).toBe(avatar)
    const served = await (await as("eve")).fetch(avatar)
    expect(new Uint8Array(await served.arrayBuffer())).toEqual(JPEG)
    // Whatever the bytes are, they are shown as a JPEG and nothing in them runs.
    expect(served.headers.get("content-type")).toBe("image/jpeg")
    expect(served.headers.get("x-content-type-options")).toBe("nosniff")
    expect(served.headers.get("content-security-policy")).toBe("sandbox; default-src 'none'")

    await publish()
    expect(vault.bytes("content/assets/people/ada-lovelace.jpg")).toEqual(JPEG)
    expect(vault.bytes("content/assets/people/ada-lovelace.png")).toBeUndefined()
    const page = vault.text("content/people/ada-lovelace.md")!
    expect(page).toContain("photo: assets/people/ada-lovelace.jpg\n")
    expect(page).toContain("\n![[assets/people/ada-lovelace.jpg]]\n\nNotes on the engine.")
    expect(page).not.toContain("ada-lovelace.png")
    // Published: the same photo, now from the published copy.
    expect(await env.ARTIFACTS.get("profiles/ada/pending.jpg")).toBeNull()
    expect((await ada.json("/api/session")).body.user.avatar).toBe(avatar)
    expect(new Uint8Array(await (await ada.fetch(avatar)).arrayBuffer())).toEqual(JPEG)
  })

  it("forgets a discarded photo", async () => {
    const ada = await as("ada")
    await link(ada, "content/people/ada-lovelace.md")
    await putPhoto(ada, JPEG)
    await ada.fetch("/api/profile/pending", { method: "DELETE" })
    expect(await env.ARTIFACTS.get("profiles/ada/pending.jpg")).toBeNull()
    expect((await ada.json("/api/session")).body.user.avatar).toBe(
      "/assets/people/ada-lovelace.png",
    )
    expect((await ada.fetch("/api/profile/photo/ada")).status).toBe(404)
  })

  it("takes only JPEGs up to 1 MB, and only after linking", async () => {
    const ada = await as("ada")
    expect((await putPhoto(ada, JPEG)).status).toBe(409)
    await link(ada, "content/people/ada-lovelace.md")
    expect((await putPhoto(ada, JPEG, "image/png")).status).toBe(415)
    expect((await putPhoto(ada, new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).status).toBe(422)
    const big = new Uint8Array(1024 * 1024 + 1)
    big.set([0xff, 0xd8, 0xff])
    expect((await putPhoto(ada, big)).status).toBe(413)
  })
})
