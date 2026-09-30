import assert from "node:assert/strict"
import test from "node:test"
import {
  LAUNCHERS,
  createNdjsonParser,
  describeStatus,
  formatMemory,
  keepProfile,
  kernelFor,
  launchMessage,
  launchPlan,
  launchRef,
  launchUrl,
  ownProfiles,
  pendingStatus,
  forkUrl,
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

test("a running lab gets the same launch as a message, and a file to open by its path", () => {
  const ref = launchRef(3, Date.UTC(2026, 8, 29))
  assert.match(ref, /^[A-Za-z0-9._-]{1,64}$/)
  assert.notEqual(launchRef(4, Date.UTC(2026, 8, 29)), ref)
  assert.deepEqual(launchMessage("ipython", "gds", "", ref), {
    type: "hafezi-launch",
    ref,
    id: "ipython",
    view: "console",
    kernel: "hafezi-gds",
  })
  const url = new URL(launchUrl(ROOT, "quarto", "user-rings"))
  const quarto = launchMessage("quarto", "user-rings", "", ref)
  assert.deepEqual(
    [quarto.id, quarto.view, quarto.kernel],
    ["hafezi-launch", "hafezi-view", "kernel"].map((key) => url.searchParams.get(key)),
  )
  assert.equal(quarto.kernel, "hafezi-user-rings")
  assert.equal(launchMessage("wolfram", "gds", "", ref).kernel, "wolfram")
  assert.deepEqual(launchMessage("notebook", "base", "forks/published/a b.qmd", ref), {
    type: "hafezi-open",
    ref,
    path: "forks/published/a b.qmd",
  })
  assert.deepEqual(launchMessage(null, "base", "x.ipynb", ref), {
    type: "hafezi-open",
    ref,
    path: "x.ipynb",
  })
  assert.equal(launchMessage("nope", "base", "", ref), null)
})

test("only a lab that said it is ready, on a running server, is asked by message", () => {
  assert.equal(launchPlan({ labReady: true, running: true }), "message")
  assert.equal(launchPlan({ labReady: false, running: true }), "navigate")
  assert.equal(launchPlan({ labReady: true, running: false }), "navigate")
  assert.equal(launchPlan({}), "navigate")
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
  // A pending server is starting, unless the host says it is stopping.
  const pending = (extra) =>
    describeStatus({ host: { online: true }, server: { server: "pending", ...extra } })
  assert.deepEqual(pending({ pending: "stop" }), { label: "server stopping", tone: "pending" })
  assert.deepEqual(pending({ pending: "spawn" }), { label: "server starting", tone: "pending" })
  assert.deepEqual(pending({}), { label: "server starting", tone: "pending" })
})

test("the pill says starting or stopping from the click, before the host's status does", () => {
  const stopped = { host: { online: true }, server: { server: "stopped" }, lab: ROOT }
  assert.deepEqual(describeStatus(pendingStatus(stopped, "spawn")), {
    label: "server starting",
    tone: "pending",
  })
  const running = { host: { online: true }, server: { server: "running" } }
  assert.deepEqual(describeStatus(pendingStatus(running, "stop")), {
    label: "server stopping",
    tone: "pending",
  })
  assert.equal(pendingStatus(stopped, "spawn").lab, ROOT)
  // Without a status, or with the host offline, the pill still says offline.
  assert.equal(describeStatus(pendingStatus(null, "spawn")).tone, "offline")
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
  // A notebook page's Open in Scratchpad links there.
  const url = new URL(forkUrl("code/jumpstart/01 ring & bus.ipynb"), "https://site.test")
  assert.equal(url.pathname, "/scratchpad")
  assert.equal(requestedFork(url.search), "code/jumpstart/01 ring & bus.ipynb")
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

test("a member's own profile launches its own kernel, and only well-formed ones are listed", () => {
  const ipython = LAUNCHERS.find((l) => l.id === "ipython")
  assert.equal(kernelFor(ipython, "user-ring_fits"), "hafezi-user-ring_fits")
  assert.equal(kernelFor(ipython, "user-../x"), "hafezi-base")
  assert.deepEqual(
    ownProfiles({
      profiles: [
        { id: "gds", name: "gds", title: "GDS layout", builtin: true },
        { id: "user-zeta", name: "zeta", title: "Zeta fits", builtin: false },
        { id: "user-alpha", name: "alpha", title: "", builtin: false },
        { id: "user-Bad", name: "Bad", title: "Bad", builtin: false },
      ],
    }),
    [
      ["user-alpha", "alpha"],
      ["user-zeta", "Zeta fits"],
    ],
  )
  assert.deepEqual(ownProfiles(null), [])
})

test("a deleted own profile falls back to General, with a note; listed ones stay selected", () => {
  const own = [["user-zeta", "Zeta fits"]]
  assert.deepEqual(keepProfile("user-zeta", own, "Zeta fits"), { profile: "user-zeta", note: "" })
  assert.deepEqual(keepProfile("gds", own), { profile: "gds", note: "" })
  const gone = keepProfile("user-qatest", own, "qatest")
  assert.equal(gone.profile, "base")
  assert.match(gone.note, /“qatest” no longer exists, so General is selected/)
  // Nothing to explain for a value that was never a profile.
  assert.deepEqual(keepProfile("", own), { profile: "base", note: "" })
})
