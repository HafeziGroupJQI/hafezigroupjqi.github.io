// Pure pieces of the Scratchpad page: the launcher vocabulary, the lab URLs it opens and the
// messages it sends a lab already running in its frame, and the NDJSON reader for the
// start-server progress stream. No DOM, so node:test covers them.

/** IPython profiles (compute/hafezi_profiles); each has a kernelspec named hafezi-<profile>. */
export const PROFILES = [
  // The default: NumPy, SciPy, SymPy and matplotlib (the course helpers stay callable in every
  // IPython profile, but nothing course-specific is set up).
  ["base", "General (NumPy · SciPy · SymPy)"],
  // enee680() enee690() phys612() enee789p() combs(), loaded at kernel start.
  ["courses", "ENEE graduate courses"],
  ["lumerical", "Lumerical"],
  ["fdtd", "FDTD"],
  ["gds", "GDS layout"],
  ["topological", "Topological"],
  ["dispersion", "Dispersion"],
  ["g2", "g2 / photon counting"],
  ["reservoir", "Reservoir computing"],
  ["meep", "Meep"],
]

// The launcher. `view` is what JupyterLab opens: a console or a new document. The profile applies
// to IPython kernels; the plain Python and Wolfram kernels ignore it.
export const LAUNCHERS = [
  { id: "ipython", label: "IPython REPL", view: "console", kernel: "profile" },
  { id: "python", label: "Python REPL", view: "console", kernel: "python-plain" },
  { id: "console", label: "Jupyter console", view: "console", kernel: "profile" },
  { id: "notebook", label: "Notebook", view: "notebook", kernel: "profile" },
  { id: "quarto", label: "Quarto doc", view: "qmd", kernel: "profile" },
  { id: "wolfram", label: "Wolfram notebook", view: "nb", kernel: "wolfram" },
]

// A member's own profile (compute: ~/profiles/<name>.py, made from a notebook) has the id
// user-<name> and the kernel hafezi-user-<name>.
export const USER_PROFILE = /^user-[a-z0-9][a-z0-9_-]{0,39}$/

export function kernelFor(launcher, profile = "base") {
  if (launcher.kernel !== "profile") return launcher.kernel
  if (USER_PROFILE.test(profile)) return `hafezi-${profile}`
  return `hafezi-${PROFILES.some(([id]) => id === profile) ? profile : "base"}`
}

/** The member's own profiles from /api/compute/profiles, as [id, label] by label. */
export function ownProfiles(listing) {
  return (listing?.profiles ?? [])
    .filter((p) => !p.builtin && typeof p.id === "string" && USER_PROFILE.test(p.id))
    .map((p) => [p.id, String(p.title || p.name)])
    .sort((a, b) => a[1].localeCompare(b[1]))
}

/**
 * The profile to keep selected once the member's own profiles are read again (`own`, from
 * ownProfiles): a built-in or a still-listed own profile stays. One deleted from ~/profiles since
 * would ask for a kernel that no longer exists, so General takes its place, with a note saying so.
 */
export function keepProfile(chosen, own, label = chosen) {
  if (PROFILES.some(([id]) => id === chosen) || own.some(([id]) => id === chosen))
    return { profile: chosen, note: "" }
  const gone = USER_PROFILE.test(chosen)
  return {
    profile: "base",
    note: gone ? `Your profile “${label}” no longer exists, so General is selected.` : "",
  }
}

/**
 * The lab URL for a launcher. `root` is the member's lab base from /api/compute/status (on the lab
 * origin, ending in /jupyter/user/<login>/). JupyterLab has no URL command for "new console", so the
 * request rides in the query (hafezi-launch, hafezi-view, kernel) for the hafezi lab extension to act
 * on; without it the lab simply opens. `path` opens an existing file through JupyterLab's tree URL.
 */
export function launchUrl(root, launcherId, profile = "base", path = "") {
  if (path) return `${root}lab/tree/${path.split("/").map(encodeURIComponent).join("/")}`
  const launcher = LAUNCHERS.find((item) => item.id === launcherId)
  if (!launcher) return `${root}lab`
  const query = new URLSearchParams({
    "hafezi-launch": launcher.id,
    "hafezi-view": launcher.view,
    kernel: kernelFor(launcher, profile),
  })
  return `${root}lab?${query}`
}

// A lab already running in the page's frame opens a launcher or a file when asked by message,
// with no reload (compute's labextensions/src/launch.ts). It says {type: "hafezi-lab:ready",
// launch: 1} once it has loaded, and {type: "hafezi-launch:ack", ref} as soon as it takes a
// request; one it doesn't take (not ready, not a lab, a bad request) gets no answer.

/** A request's ref, which the lab's ack echoes: the nth of this page, at `now`. */
export const launchRef = (n, now = Date.now()) => `l${now.toString(36)}-${n.toString(36)}`

/**
 * What launchUrl asks for, as a message for the running lab: {type: "hafezi-open", ref, path} for
 * a file, else {type: "hafezi-launch", ref, id, view, kernel}. null for an unknown launcher.
 */
export function launchMessage(launcherId, profile = "base", path = "", ref = launchRef(0)) {
  if (path) return { type: "hafezi-open", ref, path }
  const launcher = LAUNCHERS.find((item) => item.id === launcherId)
  if (!launcher) return null
  return {
    type: "hafezi-launch",
    ref,
    id: launcher.id,
    view: launcher.view,
    kernel: kernelFor(launcher, profile),
  }
}

/**
 * How to open a launcher or a file: "message" when the lab in the frame said it was ready since it
 * last loaded and the server is running, else "navigate" (load the lab at launchUrl). A message
 * the lab doesn't ack in time falls back to navigating too.
 */
export const launchPlan = ({ labReady, running }) => (labReady && running ? "message" : "navigate")

/** Feed text chunks; `onLine` gets each complete JSON line (blank and malformed lines skipped). */
export function createNdjsonParser(onLine) {
  let buffer = ""
  const flush = (line) => {
    if (!line.trim()) return
    try {
      onLine(JSON.parse(line))
    } catch {}
  }
  return {
    feed(chunk) {
      buffer += chunk
      const lines = buffer.split("\n")
      buffer = lines.pop()
      for (const line of lines) flush(line)
    },
    end() {
      flush(buffer)
      buffer = ""
    },
  }
}

/** What the header pill says for a /api/compute/status answer. */
export function describeStatus(status) {
  if (!status?.host?.online) return { label: "compute host offline", tone: "offline" }
  const server = status.server?.server
  if (server === "running") return { label: "server running", tone: "online" }
  // The host says which way a pending server is going (pending: "spawn" or "stop"), when it can.
  if (server === "pending")
    return status.server.pending === "stop"
      ? { label: "server stopping", tone: "pending" }
      : { label: "server starting", tone: "pending" }
  if (server === "stopped") return { label: "host online · server stopped", tone: "stale" }
  return { label: "host online", tone: "stale" }
}

/**
 * The status while this page starts ("spawn") or stops ("stop") the member's server: the last
 * answer still says stopped or running, so the pill shows describeStatus() of this from the click
 * until the status is read again.
 */
export const pendingStatus = (status, pending) => ({
  ...status,
  server: { ...status?.server, server: "pending", pending },
})

// ?open=<path in the member's storage> (a notebook just copied from a site page, say) opens that
// file in the lab once the server runs. Absolute and parent paths are ignored.
export function requestedPath(search) {
  const path = new URLSearchParams(search).get("open")
  return path && !path.startsWith("/") && !path.split("/").includes("..") ? path : null
}

// ?fork=<path in the private vault> ("Open notebook in Scratchpad" on a notebook page): the page
// starts the member's server first, since the host only knows members who have started one, then
// copies the notebook in and opens it. Absolute and parent paths are ignored.
export function requestedFork(search) {
  const path = new URLSearchParams(search).get("fork")
  return path && !path.startsWith("/") && !path.split("/").includes("..") ? path : null
}

/** The Scratchpad page that forks <path in the private vault> and opens it (requestedFork). */
export const forkUrl = (path) => `/scratchpad?fork=${encodeURIComponent(path)}`

/** "1.2 GiB of 4 GiB" for a server's memory (bytes; the limit may be unknown). */
export function formatMemory(bytes, max = null) {
  if (typeof bytes !== "number") return "—"
  const unit = (n) =>
    n >= 2 ** 30 ? `${(n / 2 ** 30).toFixed(1)} GiB` : `${Math.round(n / 2 ** 20)} MiB`
  return typeof max === "number" ? `${unit(bytes)} of ${unit(max)}` : unit(bytes)
}
