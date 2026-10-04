import assert from "node:assert/strict"
import test from "node:test"
import {
  attachmentMarkdown,
  composerActions,
  fromLocalInput,
  saveBody,
  saveProblem,
  seenIds,
  sizeLabel,
  spotlightAllowed,
  statusOf,
  statusText,
  stepLabel,
  toLocalInput,
  tooBig,
} from "./model.js"

const UTC = { locale: "en-US", timeZone: "UTC" }

test("says where an announcement stands", () => {
  const at = Date.UTC(2026, 9, 4, 15, 30)
  assert.equal(statusText({ publish_at: null }), "Draft")
  assert.equal(statusText({ publish_at: at }, at - 1, UTC), "Scheduled for Oct 4, 2026, 3:30 PM")
  assert.equal(statusText({ publish_at: at }, at, UTC), "Live since Oct 4, 2026, 3:30 PM")
  assert.equal(statusOf({ publish_at: null }), "draft")
  assert.equal(statusOf({ publish_at: 10 }, 9), "scheduled")
  assert.equal(statusOf({ publish_at: 10 }, 10), "live")
  assert.equal(stepLabel(0, 3), "1 of 3")
})

test("writes an attachment into the text: images in place, other files as links", () => {
  const url = "/api/announcements/files/af_1"
  assert.equal(
    attachmentMarkdown({ name: "plot.png", type: "image/png", url }),
    `![plot.png](${url})`,
  )
  assert.equal(
    attachmentMarkdown({ name: "minutes [v2].pdf", type: "application/pdf", url }),
    `[minutes \\[v2\\].pdf](${url})`,
  )
  assert.equal(
    attachmentMarkdown({ name: "a", type: "text/plain", url: "/x (1)" }),
    "[a](/x%20%281%29)",
  )
  assert.equal(sizeLabel(512), "512 B")
  assert.equal(sizeLabel(1536), "1.5 KB")
  assert.equal(sizeLabel(3 * 1024 * 1024), "3 MB")
  assert.match(tooBig({ name: "big.mp4", size: 26 * 1024 * 1024 }), /over 25 MB/)
  assert.equal(tooBig({ name: "ok.png", size: 10 }), null)
})

test("reads and writes a schedule in the browser's time zone", () => {
  const at = new Date(2026, 9, 4, 9, 5).getTime()
  assert.equal(toLocalInput(at), "2026-10-04T09:05")
  assert.equal(fromLocalInput("2026-10-04T09:05"), at)
  assert.equal(fromLocalInput(toLocalInput(at)), at)
  assert.equal(fromLocalInput(""), null)
  assert.equal(fromLocalInput("2026-02-30T10:00"), null)
  assert.equal(fromLocalInput("tomorrow"), null)
})

test("offers the saves that fit where an announcement stands", () => {
  const actions = (status) => composerActions(status).map((a) => a.action)
  assert.deepEqual(actions(undefined), ["now", "schedule", "draft"])
  assert.deepEqual(actions("draft"), ["now", "schedule", "draft"])
  assert.deepEqual(actions("scheduled"), ["keep", "now", "schedule", "draft"])
  assert.deepEqual(actions("live"), ["keep", "schedule", "draft"])
  const fields = { title: "T", body_md: "b" }
  assert.deepEqual(saveBody(fields, "now"), { ...fields, publish_at: "now" })
  assert.deepEqual(saveBody(fields, "draft"), { ...fields, publish_at: null })
  assert.deepEqual(saveBody(fields, "schedule", 123), { ...fields, publish_at: 123 })
  assert.deepEqual(saveBody(fields, "keep"), fields)
})

test("says why a save can't go yet", () => {
  const now = 1000
  assert.equal(saveProblem({ title: "", body_md: "" }, "draft", null, now), null)
  assert.match(saveProblem({ title: " ", body_md: "" }, "now", null, now), /title/)
  assert.match(saveProblem({ title: "x".repeat(201), body_md: "" }, "draft", null, now), /too long/)
  assert.match(
    saveProblem({ title: "t", body_md: "é".repeat(25_001) }, "draft", null, now),
    /50 kB/,
  )
  assert.match(saveProblem({ title: "t", body_md: "" }, "schedule", null, now), /when/)
  assert.match(saveProblem({ title: "t", body_md: "" }, "schedule", 999, now), /future/)
  assert.equal(saveProblem({ title: "t", body_md: "" }, "schedule", 2000, now), null)
})

test("opens the spotlight only on a page of its own, and dismisses what was seen", () => {
  assert.equal(spotlightAllowed(), true)
  assert.equal(spotlightAllowed({ framed: true }), false)
  assert.equal(spotlightAllowed({ labOpen: true }), false)
  const list = [{ id: "a" }, { id: "b" }, { id: "c" }]
  assert.deepEqual(seenIds(list, new Set([0, 2])), ["a", "c"])
  assert.deepEqual(seenIds(list, new Set()), [])
})
