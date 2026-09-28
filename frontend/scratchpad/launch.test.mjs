import assert from "node:assert/strict"
import test from "node:test"
import {
  LAUNCHERS,
  createNdjsonParser,
  describeStatus,
  formatMemory,
  kernelFor,
  launchUrl,
  requestedFork,
  requestedPath,
} from "./launch.js"

// The member's lab base, as /api/compute/status gives it: on the lab origin, keyed by a ticket.
const ROOT = "https://lab.test/lab/t.k/jupyter/user/alice/"

test("launchers open the member's own lab with the requested kernel", () => {
  const url = new URL(launchUrl(ROOT, "ipython", "gds"))
  assert.equal(url.origin, "https://lab.test")
  assert.equal(url.pathname, "/lab/t.k/jupyter/user/alice/lab")
  assert.equal(url.searchParams.get("hafezi-launch"), "ipython")
  assert.equal(url.searchParams.get("hafezi-view"), "console")
  assert.equal(url.searchParams.get("kernel"), "hafezi-gds")
  const wolfram = new URL(launchUrl(ROOT, "wolfram", "gds"))
  assert.equal(wolfram.searchParams.get("kernel"), "wolfram")
  // A native Wolfram notebook (.nb), not a Jupyter one.
  assert.equal(wolfram.searchParams.get("hafezi-view"), "nb")
  assert.equal(launchUrl(ROOT, "nope"), `${ROOT}lab`)
  assert.equal(
    launchUrl(ROOT, "notebook", "base", "proj/a b.ipynb"),
    `${ROOT}lab/tree/proj/a%20b.ipynb`,
  )
})

test("profiles only apply to IPython kernels and fall back to base", () => {
  const python = LAUNCHERS.find((item) => item.id === "python")
  const notebook = LAUNCHERS.find((item) => item.id === "notebook")
  assert.equal(kernelFor(python, "gds"), "python-plain")
  assert.equal(kernelFor(notebook, "meep"), "hafezi-meep")
  assert.equal(kernelFor(notebook, "../../etc"), "hafezi-base")
})

test("the progress stream parses across chunk boundaries", () => {
  const lines = []
  const parser = createNdjsonParser((line) => lines.push(line))
  parser.feed('{"progress":{"message":"spawn')
  parser.feed('ing","percent":40}}\n\n{"done":true,')
  parser.feed('"ok":true}')
  parser.end()
  assert.deepEqual(lines, [
    { progress: { message: "spawning", percent: 40 } },
    { done: true, ok: true },
  ])
})

test("status pill wording", () => {
  assert.equal(describeStatus({ host: { online: false } }).tone, "offline")
  assert.equal(
    describeStatus({ host: { online: true }, server: { server: "running" } }).tone,
    "online",
  )
  assert.match(
    describeStatus({ host: { online: true }, server: { server: "stopped" } }).label,
    /stopped/,
  )
})

test("?open= names a file in the member's storage; absolute or parent paths are ignored", () => {
  assert.equal(
    requestedPath("?open=forks%2Fpublished%2FEIWL3-01.nb"),
    "forks/published/EIWL3-01.nb",
  )
  assert.equal(requestedPath("?open=%2Fetc%2Fpasswd"), null)
  assert.equal(requestedPath("?open=a%2F..%2F..%2Fx"), null)
  assert.equal(requestedPath(""), null)
  assert.equal(
    launchUrl(ROOT, null, "base", "forks/published/My notes.nb"),
    `${ROOT}lab/tree/forks/published/My%20notes.nb`,
  )
})

test("?fork= names a vault notebook to copy in; unsafe paths are ignored", () => {
  assert.equal(
    requestedFork("?fork=code/wolfram-guide/EIWL3-01.nb"),
    "code/wolfram-guide/EIWL3-01.nb",
  )
  assert.equal(requestedFork("?fork=%2Fetc%2Fpasswd"), null)
  assert.equal(requestedFork("?fork=a/../../x"), null)
  assert.equal(requestedFork("?open=x.nb"), null)
})

test("server memory reads in MiB or GiB, with the limit when known", () => {
  assert.equal(formatMemory(512 * 2 ** 20), "512 MiB")
  assert.equal(formatMemory(1.5 * 2 ** 30, 4 * 2 ** 30), "1.5 GiB of 4.0 GiB")
  assert.equal(formatMemory(null), "—")
})

test("the ENEE graduate courses profile has its own kernel", () => {
  const ipython = LAUNCHERS.find((item) => item.id === "ipython")
  assert.equal(kernelFor(ipython, "courses"), "hafezi-courses")
  assert.equal(kernelFor(ipython, "base"), "hafezi-base")
})
