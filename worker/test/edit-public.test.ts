import { env } from "cloudflare:test"
import { beforeEach, describe, expect, it } from "vitest"
import { pageProblems, readPage, vaultProblems } from "../src/edit/public"
import { EDITS_PER_RUN, commitDue } from "../src/edit/publish"
import { schemaProblems } from "../src/edit/schema"
import { dueAt } from "../src/profile/routes"
import { as, auditRows } from "./helpers"
import { vault } from "./worker"

// The public vault's People page schema, as its schema/person.schema.json has it.
const PERSON_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "person.schema.json",
  title: "Person record frontmatter",
  type: "object",
  required: ["title", "type", "role", "group", "tags"],
  properties: {
    title: { type: "string", minLength: 1 },
    type: { const: "person" },
    role: { type: "string" },
    group: { enum: ["Graduate Students", "Staff", "Alumni"] },
    email: { type: ["string", "null"] },
    scope: { type: ["string", "null"] },
    places: {
      type: "array",
      items: { type: "string", pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$" },
      uniqueItems: true,
    },
    github: { type: "string", pattern: "^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$" },
    tags: { type: "array", items: { type: "string" }, contains: { const: "people" } },
  },
  additionalProperties: true,
}
const EQUIPMENT_SCHEMA = {
  type: "object",
  required: ["title", "type", "id", "tags"],
  properties: {
    id: { type: "string", pattern: "^[a-z0-9][a-z0-9-]*$" },
    setups: {
      type: "array",
      items: { type: "string", pattern: "^\\[\\[setups/[a-z0-9-]+\\]\\]$" },
    },
    tags: { type: "array", items: { type: "string" }, contains: { const: "equipment" } },
  },
}

const ADA = `---
title: Ada Lovelace
type: person
role: Graduate Research Assistant
group: Graduate Students
places:
  - atlantic-2369
scope: engines
github: ada
tags:
  - people
---

![[assets/people/ada.jpg]]

Works on [[research/engines|engines]] with [[eve-other]].
`
const EVE = ADA.replace(/Ada Lovelace/g, "Eve Other").replace("github: ada", "github: eve")
const LASER = `---
title: Laser
type: equipment
id: laser
setups:
  - "[[setups/bench]]"
tags: [equipment]
---

A laser.
`
const RESEARCH = "---\ntitle: Engines\ntype: research\ntags: [research]\n---\n\nAbout engines.\n"
const PLACES = `places:
  - id: atlantic-2369
    name: Office 2369
    occupants: [ada-lovelace, eve-other]
  - id: atlantic-2400
    name: Lab 2400
    occupants: []
`

type Client = Awaited<ReturnType<typeof as>>

beforeEach(async () => {
  vault.reset({
    "content/index.md": "---\ntitle: Hafezi Group\n---\n\nWelcome.\n",
    "content/privacy.md": "---\ntitle: Privacy\n---\n\nDrive.\n",
    "content/people/index.md": "---\ntitle: People\n---\n",
    "content/people/ada-lovelace.md": ADA,
    "content/people/eve-other.md": EVE,
    "content/research/engines.md": RESEARCH,
    "content/equipment/laser.md": LASER,
    "content/setups/bench.md": "---\ntitle: Bench\ntype: setup\nid: bench\ntags: [setup]\n---\n",
    "content/places/places.yml": PLACES,
    "content/assets/people/ada.jpg": new Uint8Array([0xff, 0xd8, 0xff]),
    "schema/person.schema.json": JSON.stringify(PERSON_SCHEMA),
    "schema/equipment.schema.json": JSON.stringify(EQUIPMENT_SCHEMA),
  })
  await env.DB.prepare("DELETE FROM edit_conflicts").run()
  await env.DB.prepare("DELETE FROM upload_changes").run()
  await env.DB.prepare("DELETE FROM upload_drafts").run()
  await env.DB.prepare("DELETE FROM profiles").run()
  await env.DB.prepare("DELETE FROM audit_log WHERE action LIKE 'edit.%'").run()
  const staged = await env.ARTIFACTS.list({ prefix: "uploads/" })
  if (staged.objects.length) await env.ARTIFACTS.delete(staged.objects.map((o) => o.key))
  // Ada's link to her People page, approved; Eve's is Eve's.
  for (const [login, path, name] of [
    ["ada", "content/people/ada-lovelace.md", "Ada Lovelace"],
    ["eve", "content/people/eve-other.md", "Eve Other"],
  ])
    await env.DB.prepare(
      `INSERT INTO profiles (login, path, name, status, claimed_at, updated_at)
       VALUES (?, ?, ?, 'approved', 0, 0)`,
    )
      .bind(login, path, name)
      .run()
})

const source = (client: Client, path: string) =>
  client.json(`/api/edit/source?${new URLSearchParams({ repo: "vault", path })}`)

async function draft(client: Client, path: string, text: string, summary = "an edit") {
  const created = await client.json("/api/edit/drafts", {
    method: "POST",
    body: JSON.stringify({ repo: "vault", path, base_sha: vault.sha(path), text, summary }),
  })
  return created
}

const publish = (client: Client, id: string) =>
  client.json(`/api/edit/drafts/${id}/send`, { method: "POST" })

describe("public pages: who may edit which", () => {
  it("lets any member edit most pages, a People page only its own member or an admin", async () => {
    const ada = await as("ada")
    expect((await source(ada, "content/people/ada-lovelace.md")).body).toMatchObject({
      repo: "vault",
      repo_name: "HafeziGroupJQI/vault",
      main: { text: ADA },
      can_edit: true,
      review: null,
    })
    expect((await source(ada, "content/research/engines.md")).body.can_edit).toBe(true)
    expect((await source(ada, "content/people/eve-other.md")).body).toMatchObject({
      can_edit: false,
      why: "Only Eve Other or an admin can edit this People page.",
    })
    await env.DB.prepare("DELETE FROM profiles WHERE login = 'eve'").run()
    expect((await source(ada, "content/people/eve-other.md")).body.why).toMatch(
      /^Only the person on this page/,
    )
    for (const path of ["content/index.md", "content/privacy.md"])
      expect((await source(ada, path)).body).toMatchObject({
        can_edit: false,
        why: "Only an admin can edit this page.",
      })
    const owner = await as("olivia", "owner")
    for (const path of ["content/index.md", "content/people/eve-other.md"])
      expect((await source(owner, path)).body.can_edit).toBe(true)
    // Pages the site makes whole, files that aren't pages, and paths out of content/.
    for (const path of [
      "content/people/index.md",
      "content/places/places.yml",
      "content/assets/people/ada.jpg",
      "content/../schema/person.schema.json",
      "schema/person.schema.json",
      "content/.hidden.md",
    ])
      expect((await source(ada, path)).status, path).toBe(422)
    // Refused before a draft exists, and again on every save and send.
    expect((await draft(ada, "content/people/eve-other.md", EVE + "x\n")).status).toBe(403)
    expect((await draft(ada, "content/index.md", "---\ntitle: Mine\n---\n")).status).toBe(403)
  })
})

describe("public pages: publishing", () => {
  it("queues an edit for the hour after, then commits it to main as the member's own commit", async () => {
    const ada = await as("ada")
    const main = vault.head
    const text = ADA.replace("scope: engines", "scope: analytical engines")
    const id = (await draft(ada, "content/people/ada-lovelace.md", text, "Say what I work on")).body
      .id
    const before = Date.now()
    const queued = await publish(ada, id)
    expect(queued.status).toBe(200)
    expect(queued.body).toMatchObject({ status: "open", unsent: false, pull: null })
    expect([dueAt(before), dueAt(Date.now())]).toContain(queued.body.due_at)
    // Nothing public happens before its hour: no branch, no pull request, main as it was.
    expect(vault.head).toBe(main)
    expect([...vault.refs.keys()]).toEqual(["main"])
    expect(vault.pulls.size).toBe(0)
    // Members see it in the site's recent changes (src/changes.ts) from now, as hers and waiting.
    const recent = async () =>
      (
        await env.DB.prepare(
          "SELECT path, slug, kind, state, repo, author, summary, commit_sha FROM changes WHERE draft_id = ?",
        )
          .bind(id)
          .all()
      ).results
    expect(await recent()).toEqual([
      {
        path: "content/people/ada-lovelace.md",
        slug: "people/ada-lovelace",
        kind: "edit",
        state: "sent",
        repo: "vault",
        author: "Ada Lovelace",
        summary: "edit content/people/ada-lovelace.md by ada lovelace: say what i work on",
        commit_sha: null,
      },
    ])

    const due = queued.body.due_at as number
    const calls = vault.calls.length
    expect(await commitDue(env as any, vault.fetch, due - 3_600_000)).toMatchObject({ merged: [] })
    expect(vault.calls.length).toBe(calls)
    expect(await commitDue(env as any, vault.fetch, due)).toMatchObject({ merged: [id] })
    expect(vault.text("content/people/ada-lovelace.md")).toBe(text)
    // Under the name the site shows for her (her People page's), and her GitHub no-reply address.
    expect(vault.commit(vault.head)).toMatchObject({
      parents: [main],
      message:
        "edit content/people/ada-lovelace.md by ada lovelace: say what i work on from the members site editor",
      author: { name: "Ada Lovelace", email: "ada@users.noreply.github.com" },
    })
    expect((await ada.json(`/api/edit/drafts/${id}`)).body).toMatchObject({
      status: "merged",
      merge: { url: `https://github.com/HafeziGroupJQI/vault/commit/${vault.head}` },
    })
    expect((await env.ARTIFACTS.list({ prefix: `uploads/${id}/` })).objects).toEqual([])
    expect(await auditRows("action = 'edit.merge'")).toEqual([
      expect.objectContaining({ login: "ada", target: id }),
    ])
    expect(await recent()).toMatchObject([{ state: "merged", commit_sha: vault.head }])
    // Settled: the next hour leaves it alone.
    expect(await commitDue(env as any, vault.fetch, due + 3_600_000)).toMatchObject({ merged: [] })
  })

  it("commits every due edit in one run, each its member's, and moves main once", async () => {
    const ada = await as("ada")
    const bob = await as("bob")
    const main = vault.head
    const one = (await draft(ada, "content/people/ada-lovelace.md", ADA + "More.\n")).body.id
    const two = (await draft(bob, "content/research/engines.md", RESEARCH + "And more.\n")).body.id
    const due = (await publish(ada, one)).body.due_at
    await publish(bob, two)
    const calls = vault.calls.length
    expect(await commitDue(env as any, vault.fetch, due)).toMatchObject({ merged: [one, two] })
    const second = vault.commit(vault.head)
    const first = vault.commit(second.parents[0])
    expect(first).toMatchObject({
      parents: [main],
      author: { email: "ada@users.noreply.github.com" },
    })
    expect(second.author).toMatchObject({ name: "bob", email: "bob@users.noreply.github.com" })
    expect(vault.calls.slice(calls).filter((call) => call.startsWith("PATCH"))).toEqual([
      "PATCH /git/refs/heads/main",
    ])
  })

  it("never lets a second due edit of one page overwrite the first in the same run", async () => {
    const ada = await as("ada")
    const bob = await as("bob")
    const path = "content/research/engines.md"
    // Both loaded the same version and both published before either went in.
    const one = (await draft(ada, path, RESEARCH + "Ada's line.\n")).body.id
    const two = (await draft(bob, path, RESEARCH + "Bob's line.\n")).body.id
    const due = (await publish(ada, one)).body.due_at
    // Sent before sends were checked against each other (rows from before, say): Ada's draft
    // stood aside while Bob's was published.
    const aside = (status: string) =>
      env.DB.prepare("UPDATE upload_drafts SET status = ? WHERE id = ?").bind(status, one).run()
    await aside("editing")
    expect((await publish(bob, two)).status).toBe(200)
    await aside("open")
    const run = await commitDue(env as any, vault.fetch, due)
    expect(run).toMatchObject({ merged: [one], conflicts: [two] })
    // Ada's change is on the page; Bob's is a conflict with his text kept, and he is told.
    expect(vault.text(path)).toBe(RESEARCH + "Ada's line.\n")
    expect(vault.made.length).toBe(1)
    expect((await bob.json(`/api/edit/drafts/${two}`)).body).toMatchObject({
      status: "conflict",
      text: RESEARCH + "Bob's line.\n",
    })
    expect(await auditRows("action = 'edit.conflict'")).toEqual([
      expect.objectContaining({ login: "bob", target: two }),
    ])
    // The conflict names Ada, whose change went in first: she or an admin may settle it.
    const { results } = await env.DB.prepare(
      "SELECT draft_id, login, first_draft_id, first_login, reason, state FROM edit_conflicts",
    ).all()
    expect(results).toEqual([
      {
        draft_id: two,
        login: "bob",
        first_draft_id: one,
        first_login: "ada",
        reason: "main",
        state: "open",
      },
    ])
    // The next run leaves Ada's change alone too.
    await commitDue(env as any, vault.fetch, due + 3_600_000)
    expect(vault.text(path)).toBe(RESEARCH + "Ada's line.\n")
  })

  it("puts two due edits of one page together when they change different lines", async () => {
    const ada = await as("ada")
    const bob = await as("bob")
    const path = "content/research/engines.md"
    const body = RESEARCH + "\nOne.\n\nTwo.\n\nThree.\n\nFour.\n\nFive.\n"
    vault.push(path, body)
    const one = (await draft(ada, path, body.replace("One.", "One, by Ada."))).body.id
    const two = (await draft(bob, path, body.replace("Five.", "Five, by Bob."))).body.id
    const due = (await publish(ada, one)).body.due_at
    await publish(bob, two)
    const calls = vault.calls.length
    expect(await commitDue(env as any, vault.fetch, due)).toMatchObject({ merged: [one, two] })
    expect(vault.text(path)).toBe(
      body.replace("One.", "One, by Ada.").replace("Five.", "Five, by Bob."),
    )
    // Two commits, Ada's and then Bob's, and the audit log says Bob's was merged onto hers.
    const second = vault.commit(vault.head)
    expect(second.author.email).toBe("bob@users.noreply.github.com")
    expect(vault.commit(second.parents[0]).author.email).toBe("ada@users.noreply.github.com")
    const merges = await auditRows("action = 'edit.merge'")
    expect(merges.map((row) => JSON.parse(row.detail_json))).toEqual([
      { path, commit: second.parents[0] },
      { path, commit: vault.head, auto_merged: true, onto: one },
    ])
    // One more GitHub request than two edits of different pages: the second one's base.
    expect(vault.calls.length - calls).toBeLessThanOrEqual(4 + 3 * 2 + 1)
  })

  it("merges an edit with a change that reached main after it was published", async () => {
    const admin = await as("owner", "owner")
    const path = "content/people/ada-lovelace.md"
    // An admin's edit of the body, published; then Ada's Settings change lands at :00.
    const id = (await draft(admin, path, ADA + "A line from an admin.\n")).body.id
    const due = (await publish(admin, id)).body.due_at
    vault.push(path, ADA.replace("scope: engines", "scope: difference engines"))
    expect(await commitDue(env as any, vault.fetch, due)).toMatchObject({ merged: [id] })
    expect(vault.text(path)).toBe(
      ADA.replace("scope: engines", "scope: difference engines") + "A line from an admin.\n",
    )
  })

  it("holds a merge the vault's check would refuse as a conflict", async () => {
    const ada = await as("ada")
    const path = "content/research/engines.md"
    const id = (
      await draft(ada, path, RESEARCH.replace("title: Engines\n", "title: Engines\nscope: a\n"))
    ).body.id
    const due = (await publish(ada, id)).body.due_at
    vault.push(path, RESEARCH.replace("type: research\n", "type: research\nscope: b\n"))
    const main = vault.head
    expect(await commitDue(env as any, vault.fetch, due)).toMatchObject({ conflicts: [id] })
    expect(vault.head).toBe(main)
  })

  it("stays within a Free invocation's subrequests: a few edits per run, the rest an hour later", async () => {
    const people = ["ada", "bob", "cy", "dee", "eli"]
    const ids: string[] = []
    let due = 0
    for (const [i, login] of people.entries()) {
      const path = `content/research/topic-${i}.md`
      vault.push(path, RESEARCH)
      const client = await as(login)
      const id = (await draft(client, path, RESEARCH + `${login}\n`)).body.id
      due = (await publish(client, id)).body.due_at
      ids.push(id)
    }
    const calls = vault.calls.length
    const run = await commitDue(env as any, vault.fetch, due)
    expect(run.merged).toEqual(ids.slice(0, EDITS_PER_RUN))
    // GitHub: main's tip and tree, each edit's base, tree and commit, and main moved once. With
    // each edit's R2 and D1 calls (about five), well under 50.
    const github = vault.calls.length - calls
    expect(github).toBeLessThanOrEqual(4 + 3 * EDITS_PER_RUN)
    expect(github + 1 + 5 * EDITS_PER_RUN).toBeLessThan(50)
    expect((await commitDue(env as any, vault.fetch, due + 3_600_000)).merged).toEqual([ids[4]])
  })

  it("commits the text its member published, not one saved while the run goes", async () => {
    const ada = await as("ada")
    const path = "content/research/engines.md"
    const id = (await draft(ada, path, RESEARCH + "Published.\n")).body.id
    const due = (await publish(ada, id)).body.due_at
    // A save that lands while the run is going: its text is there before its D1 row says so.
    await env.ARTIFACTS.put(`uploads/${id}/${path}`, RESEARCH + "Half typed")
    expect(await commitDue(env as any, vault.fetch, due)).toMatchObject({ merged: [id] })
    expect(vault.text(path)).toBe(RESEARCH + "Published.\n")
    expect((await env.ARTIFACTS.list({ prefix: `uploads/${id}/` })).objects).toEqual([])
  })

  it("refuses to publish over someone else's change, and shows it", async () => {
    const ada = await as("ada")
    const id = (await draft(ada, "content/research/engines.md", RESEARCH + "Mine.\n")).body.id
    vault.push("content/research/engines.md", RESEARCH + "Theirs.\n")
    expect(await publish(ada, id)).toMatchObject({
      status: 409,
      body: {
        detail: expect.stringContaining("changed on main"),
        incoming: { sha: vault.sha("content/research/engines.md"), text: RESEARCH + "Theirs.\n" },
      },
    })
    expect((await ada.json(`/api/edit/drafts/${id}`)).body.status).toBe("editing")
  })

  it("leaves main alone when the page changed there after it was published: a conflict", async () => {
    const ada = await as("ada")
    const id = (await draft(ada, "content/research/engines.md", RESEARCH + "Mine.\n")).body.id
    const due = (await publish(ada, id)).body.due_at
    // A People page edit from /settings, say, lands first.
    vault.push("content/research/engines.md", RESEARCH + "Theirs.\n")
    const main = vault.head
    expect(await commitDue(env as any, vault.fetch, due)).toMatchObject({ conflicts: [id] })
    expect(vault.head).toBe(main)
    expect((await ada.json(`/api/edit/drafts/${id}`)).body).toMatchObject({
      status: "conflict",
      detail: { message: expect.stringContaining("changed on main") },
    })
    expect(await auditRows("action = 'edit.conflict'")).toHaveLength(1)
    const { results } = await env.DB.prepare("SELECT state FROM changes WHERE draft_id = ?")
      .bind(id)
      .all()
    expect(results).toEqual([{ state: "conflict" }])
  })

  it("waits for a draft changed after it was published, and for main that moved meanwhile", async () => {
    const ada = await as("ada")
    const id = (await draft(ada, "content/research/engines.md", RESEARCH + "Mine.\n")).body.id
    const due = (await publish(ada, id)).body.due_at
    await ada.json(`/api/edit/drafts/${id}`, {
      method: "PUT",
      body: JSON.stringify({ text: RESEARCH + "Mine, better.\n" }),
    })
    const main = vault.head
    expect(await commitDue(env as any, vault.fetch, due)).toMatchObject({ waiting: [id] })
    expect(vault.head).toBe(main)
    const republished = await publish(ada, id)
    // Someone pushes to main while the run commits: the edit waits for the next hour.
    vault.beforeUpdate = () => vault.push("content/index.md", "---\ntitle: Moved\n---\n")
    expect(await commitDue(env as any, vault.fetch, republished.body.due_at)).toMatchObject({
      waiting: [id],
    })
    expect((await ada.json(`/api/edit/drafts/${id}`)).body.status).toBe("open")
    expect(await commitDue(env as any, vault.fetch, republished.body.due_at)).toMatchObject({
      merged: [id],
    })
    expect(vault.text("content/research/engines.md")).toBe(RESEARCH + "Mine, better.\n")
    expect(vault.text("content/index.md")).toBe("---\ntitle: Moved\n---\n")
  })
})

describe("public pages: what the vault's check would refuse", () => {
  const refused = async (client: Client, path: string, text: string) => {
    const mine = (await source(client, path)).body.draft
    const id = mine ? mine.id : (await draft(client, path, text)).body.id
    if (mine)
      await client.json(`/api/edit/drafts/${id}`, { method: "PUT", body: JSON.stringify({ text }) })
    const answer = await publish(client, id)
    expect(answer.status, text).toBe(422)
    return answer.body.detail as string
  }

  it("refuses at publish what the vault's check refuses, naming each problem", async () => {
    const ada = await as("ada")
    const page = "content/research/engines.md"
    expect(await refused(ada, page, "No front matter.\n")).toContain("no front matter")
    expect(await refused(ada, page, "---\ntitle: [x\n---\n")).toContain("isn't valid YAML")
    expect(await refused(ada, page, "---\ntype: research\n---\n")).toContain("no title")
    expect(await refused(ada, page, "---\ntitle: x\ntags: [internal]\n---\n")).toContain(
      "can't be tagged internal",
    )
    expect(await refused(ada, page, "---\ntitle: x\ntags: [Bad Tag]\n---\n")).toContain(
      "invalid tag Bad Tag",
    )
    expect(await refused(ada, page, "---\ntitle: x\ndraft: true\n---\n")).toContain("draft")
    expect(await refused(ada, page, RESEARCH + "See [[research/nowhere]].\n")).toContain(
      "[[research/nowhere]] doesn't lead to a page",
    )
    expect(await refused(ada, page, RESEARCH + "![plot](plots/none.png)\n")).toContain(
      "missing image plots/none.png",
    )
    expect(await refused(ada, page, RESEARCH + "<script>alert(1)</script>\n")).toContain(
      "can only be added by an admin",
    )
  }, 20_000)

  it("refuses a record that breaks its schema, its places or the records it names", async () => {
    const ada = await as("ada")
    const person = "content/people/ada-lovelace.md"
    // The record's schema, as an admin (who may change a person's group) edits it.
    const owner = await as("olivia", "owner")
    expect(await refused(owner, person, ADA.replace("group: Graduate Students\n", ""))).toContain(
      "must have required property 'group'",
    )
    expect(
      await refused(owner, person, ADA.replace("group: Graduate Students", "group: Wizards")),
    ).toContain("/group must be equal to one of the allowed values")
    expect(
      await refused(ada, person, ADA.replace("group: Graduate Students", "group: Staff")),
    ).toContain("only an admin can change a person's group")
    expect(await refused(ada, person, ADA.replace("role: Graduate", "role: Chief"))).toContain(
      "only an admin can change a person's role",
    )
    expect(await refused(ada, person, ADA.replace("github: ada", "github: mallory"))).toContain(
      "only an admin can change a person's github",
    )
    expect(
      await refused(ada, person, ADA.replace("  - atlantic-2369", "  - atlantic-2400")),
    ).toContain("places/places.yml doesn't list this person in atlantic-2400")
    expect(
      await refused(
        ada,
        "content/equipment/laser.md",
        LASER.replace("setups/bench", "setups/gone"),
      ),
    ).toContain("unknown setup gone")
    expect(
      await refused(ada, "content/equipment/laser.md", LASER.replace("id: laser", "id: lamp")),
    ).toContain("changing a record's id")
  }, 20_000)

  it("lets an admin change what only an admin may, and what a page had stays", async () => {
    const owner = await as("olivia", "owner")
    const withHtml = RESEARCH + '<iframe src="https://example.com/video"></iframe>\n'
    const id = (await draft(owner, "content/research/engines.md", withHtml)).body.id
    expect((await publish(owner, id)).status).toBe(200)
    const due = (await owner.json(`/api/edit/drafts/${id}`)).body.due_at
    await commitDue(env as any, vault.fetch, due)
    // A member's later edit keeps the admin's iframe, adding none of its own.
    const ada = await as("ada")
    const later = (await draft(ada, "content/research/engines.md", withHtml + "Typo fixed.\n")).body
      .id
    expect((await publish(ada, later)).status).toBe(200)
    // (Taken back, so the next edit of the same lines doesn't wait for it.)
    await ada.json(`/api/edit/drafts/${later}`, { method: "DELETE" })
    // Links the page already had are its own business; an edit is judged by what it adds.
    vault.push("content/research/engines.md", RESEARCH + "[[research/legacy-title]]\n")
    const kept = RESEARCH + "[[research/legacy-title]]\nMore.\n"
    const third = (await draft(await as("bob"), "content/research/engines.md", kept)).body.id
    expect((await publish(await as("bob"), third)).status).toBe(200)
  })

  it("reads front matter as the vault's check and the site's build read it", () => {
    expect(readPage("---\r\ntitle: x\r\n---\r\n").problems[0]).toContain("no front matter")
    expect(readPage("---\ntitle: a\ntitle: b\n---\n").problems[0]).toContain("isn't valid YAML")
    expect(readPage("---\n- a\n---\n").problems[0]).toContain("keys and values")
    expect(pageProblems("---\ntitle: x\ntags: people\n---\n", null, false)).toEqual([
      "tags must be a list",
    ])
    expect(
      pageProblems(RESEARCH + "<script>x</script>", RESEARCH + "<script>x</script>", false),
    ).toEqual([])
  })

  it("checks a record against its schema as the vault's check does", async () => {
    expect(schemaProblems(PERSON_SCHEMA, readPage(ADA).fm)).toEqual([])
    const problems = schemaProblems(PERSON_SCHEMA, {
      title: "",
      type: "robot",
      role: 3,
      group: "Staff",
      places: ["a", "a", "Bad"],
      github: "-x",
      tags: ["x"],
    })
    expect(problems).toEqual([
      "/title must NOT have fewer than 1 characters",
      "/type must be equal to constant",
      "/role must be string",
      '/places/2 must match pattern "^[a-z0-9]+(?:-[a-z0-9]+)*$"',
      "/places must NOT have duplicate items (items ## 0 and 1 are identical)",
      '/github must match pattern "^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$"',
      "/tags must contain at least 1 valid item(s)",
    ])
    expect(schemaProblems({ type: "integer", minimum: 1990, maximum: 2100 }, 2200)).toEqual([
      "/ must be <= 2100",
    ])
    expect(schemaProblems({ type: "integer" }, 2024.5)).toEqual(["/ must be integer"])
    expect(schemaProblems({ oneOf: [] }, 1)[0]).toContain("uses oneOf, which the site can't check")
    // A YAML date is not a string, as Ajv sees js-yaml's Date.
    expect(schemaProblems({ type: ["string", "null"] }, new Date())).toEqual([
      "/ must be string,null",
    ])
  })

  it("checks what an edit adds against the vault at main", async () => {
    const files = new Map(
      ["content/people/ada-lovelace.md", "content/research/engines.md", "content/assets/a.png"].map(
        (path) => [path, { path, type: "blob" as const, sha: "x" }],
      ),
    )
    const view = { files, data: async () => null }
    const page = "content/research/engines.md"
    expect(
      await vaultProblems(
        page,
        RESEARCH + "[[ada-lovelace]] ![a](../assets/a.png)\n",
        RESEARCH,
        view,
      ),
    ).toEqual([])
    expect(await vaultProblems(page, RESEARCH + "![a](../../x.png)\n", RESEARCH, view)).toEqual([
      "missing image ../../x.png",
    ])
    expect(await vaultProblems(page, RESEARCH + "[[tags/anything]]\n", RESEARCH, view)).toEqual([])
  })
})
