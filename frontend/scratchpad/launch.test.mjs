import assert from "node:assert/strict"
import test from "node:test"
import {
  LAUNCHERS,
  createNdjsonParser,
  describeStatus,
  kernelFor,
  labRoot,
  launchUrl,
  requestedFork,
  requestedPath,
} from "./launch.js"

test("launchers open the member's own lab with the requested kernel", () => {
  assert.equal(labRoot("Alice"), "/jupyter/user/alice/")
  const url = new URL(launchUrl("alice", "ipython", "gds"), "https://site.test")
  assert.equal(url.pathname, "/jupyter/user/alice/lab")
  assert.equal(url.searchParams.get("hafezi-launch"), "ipython")
  assert.equal(url.searchParams.get("hafezi-view"), "console")
  assert.equal(url.searchParams.get("kernel"), "hafezi-gds")
  const wolfram = new URL(launchUrl("alice", "wolfram", "gds"), "https://site.test")
  assert.equal(wolfram.searchParams.get("kernel"), "wolfram")
  assert.equal(launchUrl("alice", "nope"), "/jupyter/user/alice/lab")
  assert.equal(
    launchUrl("alice", "notebook", "base", "proj/a b.ipynb"),
    "/jupyter/user/alice/lab/tree/proj/a%20b.ipynb",
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
    launchUrl("Alice", null, "base", "forks/published/My notes.nb"),
    "/jupyter/user/alice/lab/tree/forks/published/My%20notes.nb",
  )
})

test("?fork= names a vault notebook to copy in; unsafe paths are ignored", () => {
  assert.equal(requestedFork("?fork=wolfram-guide/EIWL3-01.nb"), "wolfram-guide/EIWL3-01.nb")
  assert.equal(requestedFork("?fork=%2Fetc%2Fpasswd"), null)
  assert.equal(requestedFork("?fork=a/../../x"), null)
  assert.equal(requestedFork("?open=x.nb"), null)
})
