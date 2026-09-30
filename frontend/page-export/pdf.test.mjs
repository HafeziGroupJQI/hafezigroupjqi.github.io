import assert from "node:assert/strict"
import test from "node:test"
import { MissingPdf, fetchPdf, pdfLoader, pdfPath } from "./pdf.js"

const pdfResponse = (body = "%PDF-1.7") =>
  new Response(body, { headers: { "content-type": "application/pdf" } })

test("a page's PDF is where the build prints it: /pdf/ and the page's path", () => {
  assert.equal(pdfPath("/people/index.md"), "/pdf/people/index.pdf")
  assert.equal(pdfPath("/setups/setup-1-main.md"), "/pdf/setups/setup-1-main.pdf")
  assert.equal(pdfPath("/index.md"), "/pdf/index.pdf")
  assert.equal(pdfPath("/people/tomás-lee.md"), "/pdf/people/tomás-lee.pdf")
})

test("a missing PDF is told apart from one that failed to load", async () => {
  const answer = (response) => () => Promise.resolve(response)
  const blob = await fetchPdf("/pdf/x.pdf", answer(pdfResponse()))
  assert.equal(await blob.text(), "%PDF-1.7")
  assert.equal(blob.type, "application/pdf")
  await assert.rejects(
    fetchPdf("/pdf/x.pdf", answer(new Response("", { status: 404 }))),
    MissingPdf,
  )
  // A site that answers a missing file with a page instead of a 404.
  await assert.rejects(
    fetchPdf(
      "/pdf/x.pdf",
      answer(new Response("<!doctype html>", { headers: { "content-type": "text/html" } })),
    ),
    MissingPdf,
  )
  await assert.rejects(
    fetchPdf("/pdf/x.pdf", answer(new Response("", { status: 503 }))),
    /the page's PDF did not load \(503\)/,
  )
  await assert.rejects(
    fetchPdf("/pdf/x.pdf", () => Promise.reject(new TypeError("Failed to fetch"))),
    /did not load|offline/,
  )
})

test("the download and the save to Drive get the same file from one fetch", async () => {
  let fetches = 0
  const pdf = pdfLoader("/pdf/people/index.pdf", async (url, init) => {
    fetches++
    assert.equal(url, "/pdf/people/index.pdf")
    assert.equal(init.cache, "no-cache")
    return pdfResponse()
  })
  const [download, drive] = await Promise.all([pdf.load(), pdf.load()])
  assert.equal(download, drive)
  assert.equal(await pdf.load(), download)
  assert.equal(fetches, 1)
  assert.equal(pdf.missing(), false)
})

test("a failed fetch is tried again; a missing PDF is remembered as missing", async () => {
  let answers = [new Response("", { status: 404 }), pdfResponse()]
  const pdf = pdfLoader("/pdf/x.pdf", async () => answers.shift())
  await assert.rejects(pdf.load(), MissingPdf)
  assert.equal(pdf.missing(), true)
  assert.equal(await (await pdf.load()).text(), "%PDF-1.7")
  assert.equal(pdf.missing(), false)
})

test("the menu asks whether the page has a PDF without fetching it", async () => {
  const requests = []
  const answering = (response) => async (url, init) => {
    requests.push(init.method ?? "GET")
    return response
  }
  const missing = pdfLoader("/pdf/x.pdf", answering(new Response(null, { status: 404 })))
  assert.equal(await missing.check(), false)
  assert.equal(missing.missing(), true)
  const present = pdfLoader(
    "/pdf/x.pdf",
    answering(new Response(null, { headers: { "content-type": "application/pdf" } })),
  )
  assert.equal(await present.check(), true)
  assert.equal(present.missing(), false)
  // Offline or a server error: unknown, so it isn't called missing.
  const failing = pdfLoader("/pdf/x.pdf", () => Promise.reject(new TypeError("offline")))
  assert.equal(await failing.check(), true)
  assert.deepEqual(requests, ["HEAD", "HEAD"])
})
