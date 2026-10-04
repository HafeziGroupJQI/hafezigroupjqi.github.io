import { SELF, env } from "cloudflare:test"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { HttpError } from "../src/http"
import { PENDING_MAX, attachmentType, readFields, statusOf } from "../src/announcements"
import { type Client, ORIGIN, as, auditRows } from "./helpers"

const DAY = 86_400_000

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM announcement_dismissals").run()
  await env.DB.prepare("DELETE FROM announcement_files").run()
  await env.DB.prepare("DELETE FROM announcements").run()
  await env.DB.prepare("DELETE FROM admins WHERE login = 'ada'").run()
  const staged = await env.ARTIFACTS.list({ prefix: "announcements/" })
  if (staged.objects.length) await env.ARTIFACTS.delete(staged.objects.map((o) => o.key))
})

const owner = () => as("olivia", "owner")

async function post(client: Client, body: unknown) {
  return client.json("/api/announcements", { method: "POST", body: JSON.stringify(body) })
}

async function create(body: Record<string, unknown>) {
  const created = await post(await owner(), body)
  expect(created.status).toBe(201)
  return created.body
}

function upload(
  client: Client,
  id: string,
  name: string,
  type: string,
  content: string | Uint8Array,
) {
  const form = new FormData()
  form.append("file", new File([content], name, { type }))
  return SELF.fetch(`${ORIGIN}/api/announcements/${id}/files`, {
    method: "POST",
    headers: { authorization: client.headers.authorization, origin: client.headers.origin },
    body: form,
  })
}

const pending = async (client: Client) =>
  (await client.json("/api/announcements/pending")).body.announcements as any[]

describe("announcements: what members see", () => {
  it("shows a live announcement in the spotlight until the member dismisses it", async () => {
    const live = await create({
      title: "Lab cleanup",
      body_md: "Friday **3 pm**",
      publish_at: "now",
    })
    expect(live).toMatchObject({ title: "Lab cleanup", status: "live", files: [] })
    expect(live.author).toEqual({ login: "olivia", name: "olivia", page: null })
    const ada = await as("ada")
    expect((await pending(ada)).map((a) => a.id)).toEqual([live.id])
    const dismissed = await ada.json(`/api/announcements/${live.id}/dismiss`, { method: "POST" })
    expect(dismissed).toEqual({ status: 200, body: { dismissed: live.id } })
    // Idempotent, and kept for every session of the login, whatever its case.
    expect(
      (await ada.fetch(`/api/announcements/${live.id}/dismiss`, { method: "POST" })).status,
    ).toBe(200)
    expect(await pending(await as("Ada"))).toEqual([])
    // Others still see it; the archive still lists it, marked dismissed for ada.
    expect((await pending(await as("bob"))).map((a) => a.id)).toEqual([live.id])
    const archive = (await ada.json("/api/announcements")).body
    expect(archive.is_admin).toBe(false)
    expect(archive.announcements).toMatchObject([{ id: live.id, dismissed: true, status: "live" }])
    const [row] = await auditRows("action = 'announcement.dismiss' AND login = 'ada'")
    expect(row.target).toBe(live.id)
  })

  it("keeps drafts and scheduled ones from members until they go live", async () => {
    const draft = await create({ title: "Draft", body_md: "soon" })
    expect(draft.status).toBe("draft")
    expect(draft.publish_at).toBeNull()
    const later = await create({ title: "Later", publish_at: Date.now() + 60_000 })
    expect(later.status).toBe("scheduled")
    const ada = await as("ada")
    expect(await pending(ada)).toEqual([])
    expect((await ada.json("/api/announcements")).body.announcements).toEqual([])
    for (const a of [draft, later]) {
      expect((await ada.fetch(`/api/announcements/${a.id}`)).status).toBe(404)
      expect(
        (await ada.fetch(`/api/announcements/${a.id}/dismiss`, { method: "POST" })).status,
      ).toBe(404)
    }
    // The boundary: live from publish_at on.
    await env.DB.prepare("UPDATE announcements SET publish_at = ? WHERE id = ?")
      .bind(Date.now() - 1, later.id)
      .run()
    expect((await pending(ada)).map((a) => a.id)).toEqual([later.id])
    // Admins see all three, with their status, drafts first.
    const all = (await (await owner()).json("/api/announcements")).body
    expect(all.is_admin).toBe(true)
    expect(all.announcements.map((a: any) => [a.title, a.status])).toEqual([
      ["Draft", "draft"],
      ["Later", "live"],
    ])
  })

  it("shows the newest few of the last 30 days, newest first", async () => {
    const now = Date.now()
    const ids: string[] = []
    for (let i = 0; i < PENDING_MAX + 2; i++)
      ids.push((await create({ title: `n${i}`, publish_at: now - (i + 1) * 60_000 })).id)
    const old = await create({ title: "old", publish_at: now - 31 * DAY })
    const shown = await pending(await as("ada"))
    expect(shown.map((a) => a.id)).toEqual(ids.slice(0, PENDING_MAX))
    expect(shown.some((a) => a.id === old.id)).toBe(false)
    // The archive keeps the old one.
    const archive = (await (await as("ada")).json("/api/announcements")).body.announcements
    expect(archive.map((a: any) => a.title)).toContain("old")
  })

  it("names the author by their approved People page", async () => {
    await env.DB.prepare(
      "INSERT OR REPLACE INTO profiles (login, path, name, updated_at, status) VALUES ('olivia', 'content/people/olivia-o.md', 'Olivia O', 0, 'approved')",
    ).run()
    try {
      const live = await create({ title: "Hi", publish_at: "now" })
      expect(live.author).toEqual({ login: "olivia", name: "Olivia O", page: "/people/olivia-o" })
    } finally {
      await env.DB.prepare("DELETE FROM profiles WHERE login = 'olivia'").run()
    }
  })
})

describe("announcements: what admins do", () => {
  it("lets only admins create, change and delete them, from the site's own origins", async () => {
    const ada = await as("ada")
    expect((await post(ada, { title: "x" })).status).toBe(403)
    // A promoted admin may.
    await env.DB.prepare(
      "INSERT INTO admins (login, added_by, added_at) VALUES ('ada', 'olivia', 0)",
    ).run()
    const made = await post(ada, { title: "By ada", body_md: "hello" })
    expect(made.status).toBe(201)
    await env.DB.prepare("DELETE FROM admins WHERE login = 'ada'").run()
    const id = made.body.id
    expect((await ada.json(`/api/announcements/${id}`, { method: "PUT", body: "{}" })).status).toBe(
      404,
    )
    const o = await owner()
    const foreign = await o.fetch("/api/announcements", {
      method: "POST",
      headers: { origin: "https://evil.example" },
      body: JSON.stringify({ title: "x" }),
    })
    expect(foreign.status).toBe(403)
    const live = await create({ title: "Live", publish_at: "now" })
    expect(
      (await ada.fetch(`/api/announcements/${live.id}`, { method: "PUT", body: "{}" })).status,
    ).toBe(403)
    expect((await ada.fetch(`/api/announcements/${live.id}`, { method: "DELETE" })).status).toBe(
      403,
    )
    const [row] = await auditRows("action = 'announcement.create' AND login = 'ada'")
    expect(row.target).toBe(id)
  })

  it("changes only the fields sent, and schedules, publishes and unpublishes", async () => {
    const o = await owner()
    const draft = await create({ title: "T", body_md: "body" })
    const at = Date.now() + 3_600_000
    const scheduled = await o.json(`/api/announcements/${draft.id}`, {
      method: "PUT",
      body: JSON.stringify({ publish_at: at }),
    })
    expect(scheduled.body).toMatchObject({
      title: "T",
      body_md: "body",
      publish_at: at,
      status: "scheduled",
    })
    const live = await o.json(`/api/announcements/${draft.id}`, {
      method: "PUT",
      body: JSON.stringify({ publish_at: "now", title: "  New   title " }),
    })
    expect(live.body).toMatchObject({ title: "New title", status: "live" })
    expect(Math.abs(live.body.publish_at - Date.now())).toBeLessThan(10_000)
    const back = await o.json(`/api/announcements/${draft.id}`, {
      method: "PUT",
      body: JSON.stringify({ publish_at: null }),
    })
    expect(back.body.status).toBe("draft")
    const [row] = await auditRows("action = 'announcement.update' AND target = ?", draft.id)
    expect(JSON.parse(row.detail_json)).toMatchObject({ title: "T", publish_at: at })
  })

  it("refuses what it can't keep", async () => {
    const o = await owner()
    for (const body of [
      { title: "x".repeat(201) },
      { body_md: "é".repeat(25_001) },
      { title: 3 },
      { publish_at: "tomorrow" },
      { publish_at: 1.5 },
      { publish_at: 99_999_999_999_999 },
      { publish_at: "now" }, // no title
      { title: "x", color: "red" },
      [],
    ])
      expect((await post(o, body)).status, JSON.stringify(body).slice(0, 40)).toBe(422)
    expect((await o.fetch("/api/announcements", { method: "POST", body: "{" })).status).toBe(422)
    expect((await o.fetch("/api/announcements", { method: "PATCH" })).status).toBe(405)
    expect((await post(o, { title: "x", body_md: "a".repeat(50_000) })).status).toBe(201)
  })

  it("deletes an announcement with its files and dismissals", async () => {
    const o = await owner()
    const live = await create({ title: "With file", publish_at: "now" })
    const sent = await upload(
      o,
      live.id,
      "plot.png",
      "image/png",
      new Uint8Array([137, 80, 78, 71]),
    )
    expect(sent.status).toBe(201)
    const file = (await sent.json()) as any
    await (await as("ada")).fetch(`/api/announcements/${live.id}/dismiss`, { method: "POST" })
    expect((await o.fetch(`/api/announcements/${live.id}`, { method: "DELETE" })).status).toBe(200)
    expect((await o.fetch(`/api/announcements/${live.id}`)).status).toBe(404)
    expect((await o.fetch(file.url)).status).toBe(404)
    await vi.waitFor(async () =>
      expect((await env.ARTIFACTS.list({ prefix: `announcements/${live.id}/` })).objects).toEqual(
        [],
      ),
    )
    const counts = await env.DB.prepare(
      "SELECT (SELECT COUNT(*) FROM announcement_files) AS f, (SELECT COUNT(*) FROM announcement_dismissals) AS d",
    ).first()
    expect(counts).toEqual({ f: 0, d: 0 })
    await auditRows("action = 'announcement.delete' AND target = ?", live.id)
  })
})

describe("announcements: attachments", { timeout: 20_000 }, () => {
  it("serves a live announcement's files to members, a draft's to admins only", async () => {
    const o = await owner()
    const draft = await create({ title: "Draft", body_md: "" })
    const sent = await upload(o, draft.id, "minutes.pdf", "application/pdf", "%PDF-1.4 x")
    expect(sent.status).toBe(201)
    const file = (await sent.json()) as any
    expect(file).toMatchObject({ name: "minutes.pdf", type: "application/pdf", size: 10 })
    expect(file.url).toBe(`/api/announcements/files/${file.id}`)
    const ada = await as("ada")
    expect((await ada.fetch(file.url)).status).toBe(404)
    const mine = await o.fetch(file.url)
    expect(mine.status).toBe(200)
    expect(await mine.text()).toBe("%PDF-1.4 x")
    await o.fetch(`/api/announcements/${draft.id}`, {
      method: "PUT",
      body: JSON.stringify({ publish_at: "now" }),
    })
    const theirs = await ada.fetch(file.url)
    expect(theirs.status).toBe(200)
    expect(theirs.headers.get("content-type")).toBe("application/pdf")
    expect(theirs.headers.get("x-content-type-options")).toBe("nosniff")
    expect(theirs.headers.get("cache-control")).toBe("private, no-store")
    // The announcement lists it.
    expect((await pending(ada))[0].files).toEqual([file])
  })

  it("shows images and text as inert, downloads Office files, refuses anything else", async () => {
    const o = await owner()
    const live = await create({ title: "Files", publish_at: "now" })
    const png = (await (await upload(o, live.id, "x.png", "image/png", "png")).json()) as any
    const served = await o.fetch(png.url)
    expect(served.headers.get("content-type")).toBe("image/png")
    expect(served.headers.get("content-security-policy")).toBe("sandbox; default-src 'none'")
    expect(served.headers.get("content-disposition")).toBe('inline; filename="x.png"')
    // An SVG sent as text is text, never an image.
    const svg = (await (
      await upload(o, live.id, "fig.txt", "image/svg+xml", "<svg/>")
    ).json()) as any
    expect(svg.type).toBe("text/plain")
    expect((await o.fetch(svg.url)).headers.get("content-type")).toBe("text/plain; charset=utf-8")
    const docx = await upload(
      o,
      live.id,
      "minutes.docx",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "PK",
    )
    expect(docx.status).toBe(201)
    const doc = await o.fetch(((await docx.json()) as any).url)
    expect(doc.headers.get("content-type")).toBe("application/octet-stream")
    expect(doc.headers.get("content-disposition")).toBe('attachment; filename="minutes.docx"')
    for (const [name, type] of [
      ["x.svg", "image/svg+xml"],
      ["x.bin", "application/octet-stream"],
      ["run.exe", "application/x-msdownload"],
      ["x.zip", "application/zip"],
    ])
      expect((await upload(o, live.id, name, type, "x")).status, name).toBe(415)
  })

  it("lets only admins add and delete files", async () => {
    const live = await create({ title: "Files", publish_at: "now" })
    const ada = await as("ada")
    expect((await upload(ada, live.id, "x.png", "image/png", "png")).status).toBe(403)
    const o = await owner()
    const file = (await (await upload(o, live.id, "x.png", "image/png", "png")).json()) as any
    expect((await ada.fetch(file.url, { method: "DELETE" })).status).toBe(403)
    expect((await o.fetch(file.url, { method: "DELETE" })).status).toBe(200)
    expect((await o.fetch(file.url)).status).toBe(404)
    await vi.waitFor(async () =>
      expect((await env.ARTIFACTS.list({ prefix: `announcements/${live.id}/` })).objects).toEqual(
        [],
      ),
    )
    const big = new Uint8Array(25 * 1024 * 1024 + 1)
    expect((await upload(o, live.id, "big.png", "image/png", big)).status).toBe(413)
    expect((await upload(o, "missing", "x.png", "image/png", "png")).status).toBe(404)
    await auditRows("action = 'announcement.file.delete'")
  })
})

describe("announcement rules", () => {
  it("says whether one is a draft, scheduled or live", () => {
    expect(statusOf(null, 5)).toBe("draft")
    expect(statusOf(6, 5)).toBe("scheduled")
    expect(statusOf(5, 5)).toBe("live")
  })

  it("reads fields over the current ones", () => {
    const current = { title: "a", body_md: "b", publish_at: null }
    expect(readFields({}, current, 1)).toEqual(current)
    expect(readFields({ publish_at: "now" }, current, 7).publish_at).toBe(7)
    expect(() => readFields({ title: "", publish_at: 3 }, current, 1)).toThrow(HttpError)
  })

  it("takes images, PDFs, text and Office documents only", () => {
    expect(attachmentType("image/png", "a.png")).toBe("image/png")
    expect(attachmentType("", "a.pdf")).toBe("application/pdf")
    expect(attachmentType("text/x-python", "a.py")).toBe("text/x-python")
    expect(attachmentType("", "a.xlsx")).toBe("application/octet-stream")
    expect(attachmentType("application/vnd.ms-excel", "a.xls")).toBe("application/vnd.ms-excel")
    expect(attachmentType("text/html", "a.docx")).toBe("text/html")
    expect(attachmentType("image/svg+xml", "a.svg")).toBeNull()
    expect(attachmentType("application/x-msdownload", "a.docx")).toBeNull()
  })
})
