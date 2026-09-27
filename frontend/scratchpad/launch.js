// Pure pieces of the Scratchpad page: the launcher vocabulary, the lab URLs it opens, and the
// NDJSON reader for the start-server progress stream. No DOM, so node:test covers them.

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

export const labRoot = (login) => `/jupyter/user/${encodeURIComponent(login.toLowerCase())}/`

export function kernelFor(launcher, profile = "base") {
  if (launcher.kernel !== "profile") return launcher.kernel
  return `hafezi-${PROFILES.some(([id]) => id === profile) ? profile : "base"}`
}

/**
 * The lab URL for a launcher. JupyterLab has no URL command for "new console", so the request rides
 * in the query (hafezi-launch, hafezi-view, kernel) for the hafezi lab extension to act on; without
 * it the lab simply opens. `path` opens an existing file through JupyterLab's own tree URL.
 */
export function launchUrl(login, launcherId, profile = "base", path = "") {
  const root = labRoot(login)
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
  if (server === "pending") return { label: "server starting", tone: "pending" }
  if (server === "stopped") return { label: "host online · server stopped", tone: "stale" }
  return { label: "host online", tone: "stale" }
}

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

/** "1.2 GiB of 4 GiB" for a server's memory (bytes; the limit may be unknown). */
export function formatMemory(bytes, max = null) {
  if (typeof bytes !== "number") return "—"
  const unit = (n) =>
    n >= 2 ** 30 ? `${(n / 2 ** 30).toFixed(1)} GiB` : `${Math.round(n / 2 ** 20)} MiB`
  return typeof max === "number" ? `${unit(bytes)} of ${unit(max)}` : unit(bytes)
}
