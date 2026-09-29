import assert from "node:assert/strict"
import test from "node:test"
import { GOOGLE_CLIENT_ID } from "./config.js"
import { docDocument, inlineImage, sourceMath, texText } from "./doc.js"
import {
  DRIVE_SCOPE,
  colabUrl,
  consentMessage,
  driveErrorMessage,
  driveType,
  popupMessage,
  resumeOffset,
  tokenValid,
  uploadStart,
} from "./drive.js"

test("the client ID is the site's Google OAuth client, a public value", () => {
  assert.match(GOOGLE_CLIENT_ID, /^[\w-]+\.apps\.googleusercontent\.com$/)
  // drive.file: only the files this site makes; Google needs no verification for it.
  assert.equal(DRIVE_SCOPE, "https://www.googleapis.com/auth/drive.file")
})

test("a token is used until a minute before it expires, then asked for again", () => {
  const now = 1_000_000
  assert.equal(tokenValid(null, now), false)
  assert.equal(tokenValid({ value: "t", expires: now + 3599_000 }, now), true)
  assert.equal(tokenValid({ value: "t", expires: now + 59_000 }, now), false)
})

test("a blocked or closed sign-in window, and declined consent, read plainly", () => {
  assert.match(popupMessage("popup_failed_to_open"), /blocked; allow pop-ups/)
  assert.match(popupMessage("popup_closed"), /closed/)
  assert.equal(popupMessage("unknown"), "Google sign-in did not finish")
  assert.equal(consentMessage("access_denied"), "Google Drive access was declined")
  assert.equal(consentMessage("invalid_client"), "Google sign-in failed (invalid_client)")
})

test("an upload opens a resumable session with the file's metadata, type and size", () => {
  const [url, init] = uploadStart("tok", {
    metadata: { name: "Git", mimeType: "application/vnd.google-apps.document" },
    type: "text/html",
    size: 1234,
  })
  assert.equal(
    url,
    "https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id%2Cname%2CmimeType%2CwebViewLink",
  )
  assert.equal(init.method, "POST")
  assert.equal(init.headers.authorization, "Bearer tok")
  assert.equal(init.headers["x-upload-content-type"], "text/html")
  assert.equal(init.headers["x-upload-content-length"], "1234")
  assert.deepEqual(JSON.parse(init.body), {
    name: "Git",
    mimeType: "application/vnd.google-apps.document",
  })
})

test("a broken-off upload resumes after the last byte Drive has", () => {
  assert.equal(resumeOffset("bytes=0-524287"), 524288)
  assert.equal(resumeOffset(null), 0)
})

test("Drive's errors read plainly", () => {
  const error = (reason, message = "") => ({ error: { message, errors: [{ reason }] } })
  assert.match(driveErrorMessage(401, error("authError")), /sign-in expired/)
  assert.equal(driveErrorMessage(403, error("storageQuotaExceeded")), "your Google Drive is full")
  assert.match(driveErrorMessage(403, error("userRateLimitExceeded")), /busy/)
  assert.match(driveErrorMessage(503, null), /unavailable/)
  assert.equal(
    driveErrorMessage(403, error("accessNotConfigured", "Google Drive API has not been used")),
    "Google Drive refused the file (403: Google Drive API has not been used)",
  )
})

test("files keep their type in Drive, and a notebook opens in Colab by its id", () => {
  assert.equal(driveType("git.md"), "text/markdown")
  assert.equal(driveType("01_ring.ipynb"), "application/x-ipynb+json")
  assert.equal(driveType("EIWL3-01.nb"), "application/vnd.wolfram.mathematica")
  assert.equal(colabUrl("1AbC-d_9"), "https://colab.research.google.com/drive/1AbC-d_9")
})

test("the Google Doc is the article under the page's title and address", () => {
  const html = docDocument({
    title: "Git & SSH",
    url: "https://hafezigroupjqi.github.io/resources/onboarding/git",
    body: "<p>Body</p>",
  })
  assert.match(
    html,
    /^<!doctype html>\n<html><head><meta charset="utf-8"><title>Git &amp; SSH<\/title>/,
  )
  assert.match(
    html,
    /<h1>Git &amp; SSH<\/h1>\n<p>From <a href="https:\/\/hafezigroupjqi.github.io\/resources\/onboarding\/git">/,
  )
  assert.match(html, /<p>Body<\/p>\n<\/body><\/html>$/)
  assert.equal(texText(" E = mc^2 ", true), "$$E = mc^2$$")
  assert.equal(texText("x_1", false), "$x_1$")
})

test("images Google can't fetch or can't import go in as data: URLs", () => {
  const page = "https://hafezigroupjqi.github.io/resources/onboarding/git"
  // A member page's images are members-only; the public site's Google fetches itself.
  assert.equal(inlineImage("/resources/assets/flow.png", { page, members: true }), true)
  assert.equal(inlineImage("/assets/people/a.jpg", { page, members: false }), false)
  assert.equal(inlineImage("https://img.shields.io/badge.png", { page, members: true }), false)
  // Google Docs imports no SVG: drawn to PNG, wherever it comes from.
  assert.equal(inlineImage("/assets/logo.svg", { page, members: false }), true)
  assert.equal(inlineImage("data:image/png;base64,AAAA", { page, members: true }), false)
})

test("equations come from the page's source, in order, outside code and comments", () => {
  const markdown = [
    "---",
    "title: $not math$",
    "---",
    "The field $E = mc^2$ costs \\$5, and",
    "",
    "$$",
    "H = \\frac{t - a}{1 - ta}",
    "$$",
    "",
    "```python",
    'print("$x$")',
    "```",
    "`$y$` %% $z$ %% <!-- $w$ --> and $$T = |H|^2$$ inline.",
  ].join("\n")
  assert.deepEqual(sourceMath(markdown), ["E = mc^2", "H = \\frac{t - a}{1 - ta}", "T = |H|^2"])
})
