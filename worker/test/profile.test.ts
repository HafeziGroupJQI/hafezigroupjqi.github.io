import { SELF, env } from "cloudflare:test"
import { beforeEach, describe, expect, it } from "vitest"
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
  // Storage is shared across tests, and profile changes count toward a daily limit.
  await env.DB.prepare("DELETE FROM audit_log WHERE action LIKE 'profile.%'").run()
})

const claim = (client: Awaited<ReturnType<typeof as>>, path: string) =>
  client.json("/api/profile/claim", { method: "POST", body: JSON.stringify({ path }) })

describe("member settings: the People page", () => {
  it("is for signed-in members only", async () => {
    expect((await SELF.fetch(`${ORIGIN}/api/profile`)).status).toBe(401)
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

  it("links a page by committing github: <login>, and only once", async () => {
    const ada = await as("ada")
    const linked = await claim(ada, "content/people/ada-lovelace.md")
    expect(linked).toEqual({
      status: 200,
      body: { path: "content/people/ada-lovelace.md", committed: true },
    })
    expect(vault.text("content/people/ada-lovelace.md")).toBe(
      PAGE.replace("tags:\n", "github: ada\ntags:\n"),
    )
    expect(vault.made.map((c) => [c.message, c.author.email])).toEqual([
      ["link people/ada-lovelace to the github login ada", "ada@users.noreply.github.com"],
    ])
    // The navbar has the page's name at once.
    expect((await ada.json("/api/session")).body.user.display_name).toBe("Ada Lovelace")
    const page = (await ada.json("/api/profile")).body.page
    expect(page).toMatchObject({
      slug: "ada-lovelace",
      url: "/people/ada-lovelace",
      role: "Graduate Research Assistant",
      photo: "/assets/people/ada-lovelace.png",
      fields: {
        title: "Ada Lovelace",
        email: null,
        building: "Atlantic Building",
        office: "2369",
        scope: null,
        profile: "https://hafezi.jqi.umd.edu/people/ada-lovelace",
      },
    })
    expect((await claim(ada, "content/people/alumni/grace-hopper.md")).status).toBe(409)
    expect((await claim(await as("eve"), "content/people/ada-lovelace.md")).status).toBe(409)
    expect((await auditRows("action = 'profile.claim'")).map((r) => r.target)).toEqual([
      "content/people/ada-lovelace.md",
    ])
  })

  it("won't link a page that names another GitHub login, or anything that isn't a People page", async () => {
    const eve = await as("eve")
    expect((await claim(eve, "content/people/charles-babbage.md")).status).toBe(409)
    expect((await claim(eve, "content/notes/x.md")).status).toBe(422)
    expect((await claim(eve, "content/people/index.md")).status).toBe(422)
    expect((await claim(eve, "content/people/nobody.md")).status).toBe(409)
    // The page's own login may link it, with no commit needed (compared case-insensitively).
    const charles = await as("CBabbage")
    expect(await claim(charles, "content/people/charles-babbage.md")).toMatchObject({
      status: 200,
      body: { committed: false },
    })
    expect(vault.made).toEqual([])
  })

  it("commits only the fields that changed, in place", async () => {
    const ada = await as("ada")
    await claim(ada, "content/people/ada-lovelace.md")
    const saved = await ada.json("/api/profile", {
      method: "PUT",
      body: JSON.stringify({
        title: "Ada King",
        email: " ada@umd.edu ",
        building: "Atlantic Building",
        office: "2207",
        scope: "",
        profile: "https://hafezi.jqi.umd.edu/people/ada-lovelace",
      }),
    })
    expect(saved.status).toBe(200)
    expect(saved.body.changed).toEqual(["title", "email", "office"])
    expect(vault.text("content/people/ada-lovelace.md")).toBe(
      PAGE.replace("title: Ada Lovelace", "title: Ada King")
        .replace("email: null", "email: ada@umd.edu")
        .replace('office: "2369"', 'office: "2207"')
        .replace("tags:\n", "github: ada\ntags:\n"),
    )
    expect(vault.made.at(-1)!.message).toBe(
      "update people/ada-lovelace from the members site settings",
    )
    expect((await ada.json("/api/session")).body.user.display_name).toBe("Ada King")
    // Saving the same values again commits nothing.
    const commits = vault.made.length
    const again = await ada.json("/api/profile", {
      method: "PUT",
      body: JSON.stringify({ title: "Ada King", office: "2207" }),
    })
    expect(again.body).toEqual({ changed: [], commit: null })
    expect(vault.made).toHaveLength(commits)
    const rows = await auditRows("action = 'profile.update'")
    expect(JSON.parse(rows[0].detail_json)).toEqual({ fields: ["title", "email", "office"] })
  })

  it("refuses bad values and edits before linking", async () => {
    const ada = await as("ada")
    const put = (body: object) =>
      ada.json("/api/profile", { method: "PUT", body: JSON.stringify(body) })
    expect((await put({ title: "Ada" })).status).toBe(409)
    await claim(ada, "content/people/ada-lovelace.md")
    expect((await put({ title: "  " })).status).toBe(422)
    expect((await put({ email: "not an address" })).status).toBe(422)
    expect((await put({ profile: "javascript:alert(1)" })).status).toBe(422)
    expect((await put({ office: "a\nb" })).status).toBe(422)
    expect((await put({ scope: "x".repeat(501) })).status).toBe(422)
    expect(vault.made).toHaveLength(1)
  })

  it("retries on top of a push that lands while saving", async () => {
    const ada = await as("ada")
    await claim(ada, "content/people/ada-lovelace.md")
    vault.beforeUpdate = () => vault.push("content/notes/y.md", "---\ntitle: y\n---\n")
    const patches = () => vault.calls.filter((call) => call.startsWith("PATCH")).length
    const before = patches()
    const saved = await ada.json("/api/profile", {
      method: "PUT",
      body: JSON.stringify({ office: "2207" }),
    })
    expect(saved.status).toBe(200)
    expect(vault.text("content/notes/y.md")).toContain("title: y")
    expect(vault.text("content/people/ada-lovelace.md")).toContain('office: "2207"')
    expect(patches() - before).toBe(2)
  })

  it("allows a limited number of vault commits a day", async () => {
    const ada = await as("ada")
    await claim(ada, "content/people/ada-lovelace.md")
    await auditRows("action = 'profile.claim'")
    for (let i = 0; i < 19; i++)
      await env.DB.prepare(
        "INSERT INTO audit_log (at, login, action, target) VALUES (?, 'ada', 'profile.update', 'x')",
      )
        .bind(Date.now())
        .run()
    const saved = await ada.json("/api/profile", {
      method: "PUT",
      body: JSON.stringify({ office: "1" }),
    })
    expect(saved.status).toBe(429)
  })

  it("stops a page someone relinked by hand from being edited", async () => {
    const ada = await as("ada")
    await claim(ada, "content/people/ada-lovelace.md")
    vault.push(
      "content/people/ada-lovelace.md",
      PAGE.replace("tags:\n", "github: mallory\ntags:\n"),
    )
    const saved = await ada.json("/api/profile", {
      method: "PUT",
      body: JSON.stringify({ office: "1" }),
    })
    expect(saved.status).toBe(409)
  })
})

describe("member settings: the photo", () => {
  it("commits a JPEG as the page's photo, drops the old one and shows it in the navbar", async () => {
    const ada = await as("ada")
    await claim(ada, "content/people/ada-lovelace.md")
    const notJpeg = await ada.fetch("/api/profile/photo", {
      method: "PUT",
      headers: { "content-type": "image/jpeg" },
      body: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
    })
    expect(notJpeg.status).toBe(422)
    const saved = await ada.fetch("/api/profile/photo", {
      method: "PUT",
      headers: { "content-type": "image/jpeg" },
      body: JPEG,
    })
    expect(saved.status).toBe(200)
    const { avatar } = (await saved.json()) as { avatar: string }
    expect(avatar).toMatch(/^\/api\/profile\/photo\/ada\?v=\d+$/)
    expect(vault.bytes("content/assets/people/ada-lovelace.jpg")).toEqual(JPEG)
    expect(vault.bytes("content/assets/people/ada-lovelace.png")).toBeUndefined()
    const page = vault.text("content/people/ada-lovelace.md")!
    expect(page).toContain("photo: assets/people/ada-lovelace.jpg\n")
    expect(page).toContain("\n![[assets/people/ada-lovelace.jpg]]\n\nNotes on the engine.")
    expect(page).not.toContain("ada-lovelace.png")
    expect(vault.made.at(-1)!.message).toBe(
      "update the photo on people/ada-lovelace from the members site settings",
    )
    expect((await ada.json("/api/session")).body.user.avatar).toBe(avatar)
    const served = await (await as("eve")).fetch(avatar)
    expect(served.headers.get("content-type")).toBe("image/jpeg")
    expect(new Uint8Array(await served.arrayBuffer())).toEqual(JPEG)
    expect((await ada.fetch("/api/profile/photo/nobody")).status).toBe(404)
  })

  it("takes only JPEGs up to 1 MB, and only after linking", async () => {
    const ada = await as("ada")
    const put = (body: BodyInit, type = "image/jpeg") =>
      ada.fetch("/api/profile/photo", { method: "PUT", headers: { "content-type": type }, body })
    expect((await put(JPEG)).status).toBe(409)
    await claim(ada, "content/people/ada-lovelace.md")
    expect((await put(JPEG, "image/png")).status).toBe(415)
    const big = new Uint8Array(1024 * 1024 + 1)
    big.set([0xff, 0xd8, 0xff])
    expect((await put(big)).status).toBe(413)
    expect(vault.made).toHaveLength(1)
  })
})
