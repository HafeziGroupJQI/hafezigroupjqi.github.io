import assert from "node:assert/strict"
import test from "node:test"
import {
  avatarFor,
  centreSquare,
  changedFields,
  licenceSummary,
  pendingSummary,
  publishLabel,
  slugName,
} from "./model.js"

test("only changed fields are sent, and emptied ones become null", () => {
  const current = { title: "Ada Lovelace", email: null, office: "2369", scope: "Engines" }
  assert.deepEqual(
    changedFields(current, {
      title: " Ada Lovelace ",
      email: "ada@umd.edu",
      office: "2369",
      scope: "",
    }),
    { email: "ada@umd.edu", scope: null },
  )
  assert.deepEqual(changedFields(current, { ...current, email: "" }), {})
})

test("a People page's slug reads as a name", () => {
  assert.equal(slugName("ada-lovelace"), "Ada Lovelace")
  assert.equal(slugName("mohammad-hafezi"), "Mohammad Hafezi")
})

test("a photo is cropped to its centred square", () => {
  assert.deepEqual(centreSquare(400, 300), { sx: 50, sy: 0, size: 300 })
  assert.deepEqual(centreSquare(300, 401), { sx: 0, sy: 50, size: 300 })
})

test("the avatar is the uploaded photo, then the People page's, then GitHub's", () => {
  assert.equal(
    avatarFor({ login: "ada", avatar: "/api/profile/photo/ada?v=1" }),
    "/api/profile/photo/ada?v=1",
  )
  assert.equal(
    avatarFor({ login: "ada", page: { photo: "/assets/people/a.jpg" } }),
    "/assets/people/a.jpg",
  )
  assert.equal(avatarFor({ login: "ada" }), "https://avatars.githubusercontent.com/ada?s=128")
})

test("the licence line says what state the member's Wolfram licence is in", () => {
  assert.match(licenceSummary({ state: "none" }), /^Not activated yet/)
  assert.match(
    licenceSummary({ state: "active", wolfram_id: "ada@umd.edu" }),
    /^Active for ada@umd.edu\./,
  )
  assert.match(licenceSummary({ state: "offline" }), /offline/)
})

test("saved changes say when they go in, and what they are", () => {
  const due = Date.UTC(2026, 8, 28, 23, 0)
  assert.match(
    publishLabel(due, due - 83 * 60_000, "en-US"),
    /^at \d{1,2}:00 (AM|PM), in 1 h 23 min$/,
  )
  assert.match(publishLabel(due, due - 5 * 60_000, "en-US"), /, in 5 min$/)
  assert.match(publishLabel(due, due + 60_000, "en-US"), /, in 0 min$/)
  assert.equal(pendingSummary({ fields: ["title"], photo: true }), "name and photo")
  assert.equal(
    pendingSummary({ fields: ["email", "office", "scope"], photo: false }),
    "email, office and ask me about",
  )
  assert.equal(pendingSummary({ fields: [], photo: false, link: true }), "")
})
