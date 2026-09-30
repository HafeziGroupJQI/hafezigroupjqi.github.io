import assert from "node:assert/strict"
import test from "node:test"
import { GOOGLE_CLIENT_ID } from "./config.js"
import {
  DOC_MAX,
  cellMax,
  docDocument,
  docImageFormat,
  docImageSize,
  docKeepsImage,
  docPixels,
  sourceMath,
  texText,
} from "./doc.js"
import {
  DRIVE_SCOPE,
  colabUrl,
  consentMessage,
  driveErrorMessage,
  driveType,
  pdfForDrive,
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
  assert.equal(driveType("Setup 1.PDF"), "application/pdf")
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

test("a picture in the Google Doc keeps its size on the page, fitted to a Letter or A4 page", () => {
  // Wider than the page on screen (the hero figure): the page's width, in its own proportions.
  assert.deepEqual(
    docImageSize({ natural: { width: 1360, height: 800 }, shown: { width: 767, height: 451 } }),
    { width: 600, height: 353 },
  )
  // Smaller on the page than it is (a person's photo): the page's size.
  assert.deepEqual(
    docImageSize({ natural: { width: 1920, height: 1920 }, shown: { width: 180, height: 180 } }),
    { width: 180, height: 180 },
  )
  // Not laid out on the page (in a closed section): its own size, fitted.
  assert.deepEqual(docImageSize({ natural: { width: 1622, height: 518 } }), {
    width: 600,
    height: 192,
  })
  // Taller than a page: fitted by height, at most 800 px (8.3 in).
  assert.deepEqual(docImageSize({ natural: { width: 400, height: 2400 } }), {
    width: 133,
    height: 800,
  })
  // Drawn squashed on the page: the Doc keeps the picture's own proportions.
  assert.deepEqual(
    docImageSize({ natural: { width: 24, height: 48 }, shown: { width: 12, height: 18 } }),
    { width: 12, height: 24 },
  )
  // A drawing with no size of its own takes the page's; with neither, a default.
  assert.deepEqual(docImageSize({ natural: null, shown: { width: 1253, height: 336 } }), {
    width: 600,
    height: 161,
  })
  assert.deepEqual(docImageSize({ natural: { width: 0, height: 0 } }), { width: 300, height: 150 })
  for (const natural of [
    { width: 1961, height: 712 },
    { width: 751, height: 366 },
    { width: 5000, height: 7000 },
  ]) {
    const { width, height } = docImageSize({ natural })
    assert.ok(width <= DOC_MAX.width && height <= DOC_MAX.height)
    assert.ok(Math.abs(height - (width * natural.height) / natural.width) <= 1)
  }
  // In a table: its column's share of the page.
  assert.deepEqual(cellMax(2), { width: 288, height: 800 })
  assert.deepEqual(docImageSize({ natural: { width: 2400, height: 300 }, max: cellMax(2) }), {
    width: 288,
    height: 36,
  })
})

test("pictures go at twice their size in the Doc, as PNG or JPEG, under 25 megapixels", () => {
  assert.deepEqual(
    docPixels({ natural: { width: 1920, height: 1920 }, size: { width: 180, height: 180 } }),
    {
      width: 360,
      height: 360,
    },
  )
  // Never more pixels than the picture has; a drawing (no natural size) gets twice.
  assert.deepEqual(
    docPixels({ natural: { width: 400, height: 300 }, size: { width: 300, height: 225 } }),
    {
      width: 400,
      height: 300,
    },
  )
  assert.deepEqual(docPixels({ natural: null, size: { width: 600, height: 161 } }), {
    width: 1200,
    height: 322,
  })
  const huge = docPixels({ natural: null, size: { width: 20000, height: 20000 } })
  assert.ok(huge.width * huge.height <= 25_000_000)
  assert.equal(docImageFormat("image/jpeg"), "image/jpeg")
  assert.equal(docImageFormat("image/webp"), "image/png")
  assert.equal(docImageFormat("image/avif"), "image/png")
  assert.equal(docImageFormat("image/gif"), "image/png")
  // A PNG, JPEG or GIF that needs no fewer pixels goes as it is (a GIF keeps its frames).
  const small = { natural: { width: 300, height: 200 }, pixels: { width: 600, height: 400 } }
  assert.equal(docKeepsImage({ type: "image/gif", ...small }), true)
  assert.equal(docKeepsImage({ type: "image/png", ...small }), true)
  assert.equal(docKeepsImage({ type: "image/webp", ...small }), false)
  assert.equal(
    docKeepsImage({
      type: "image/jpeg",
      natural: { width: 1920, height: 1920 },
      pixels: { width: 360, height: 360 },
    }),
    false,
  )
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

test("the PDF saved to Drive is the downloaded file itself, named after the page", () => {
  const blob = new Blob(["%PDF-1.7"], { type: "application/pdf" })
  const file = pdfForDrive("Setup 1: main bench", blob)
  assert.deepEqual(file.metadata, { name: "Setup 1: main bench.pdf", mimeType: "application/pdf" })
  assert.equal(file.type, "application/pdf")
  // The same object as the download's (pdf.js loads it once): the same bytes in Drive.
  assert.equal(file.body, blob)
})
