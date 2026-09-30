// A page's PDF: printed by the build (tools/render-pdfs.mjs) at /pdf/<slug>.pdf, the file the
// Export menu's PDF download sends, and its Save to Google Drive › As PDF. It is fetched at most
// once per page view, so both send the same bytes. Pure but for fetch, so node:test covers it.

/** Where the build puts a page's PDF, from the page's Markdown source (JqiFrame's data-source). */
export function pdfPath(source) {
  return `/pdf/${source.replace(/^\/+/, "").replace(/\.md$/i, "")}.pdf`
}

/** The site has no PDF for the page: the build didn't print it (a new page, or a failed print). */
export class MissingPdf extends Error {
  constructor() {
    super("this page's PDF isn't built yet")
  }
}

/** The PDF at `url` as a Blob. MissingPdf where the site answers without one (404, or a page). */
export async function fetchPdf(url, fetcher = fetch) {
  let response
  try {
    response = await fetcher(url, { cache: "no-cache" })
  } catch {
    throw new Error(
      globalThis.navigator?.onLine === false ? "you are offline" : "the page's PDF did not load",
    )
  }
  if (response.status === 404) throw new MissingPdf()
  if (!response.ok) throw new Error(`the page's PDF did not load (${response.status})`)
  if (!/^application\/pdf\b/i.test(response.headers.get("content-type") ?? ""))
    throw new MissingPdf()
  return response.blob()
}

/**
 * The page's PDF, loaded once: load() gives the same Blob every time (after a failure it tries
 * again), and missing() says whether the site has answered that there is none (check() asks).
 */
export function pdfLoader(url, fetcher = fetch) {
  let file = null
  let missing = false
  return {
    load() {
      file ??= fetchPdf(url, fetcher).then(
        (blob) => {
          missing = false
          return blob
        },
        (error) => {
          file = null
          missing = error instanceof MissingPdf
          throw error
        },
      )
      return file
    },
    missing: () => missing,
    /** Ask whether the site has it, without the file (HEAD): sets missing(), answers !missing(). */
    async check() {
      try {
        const response = await fetcher(url, { method: "HEAD", cache: "no-cache" })
        const type = response.headers.get("content-type") ?? ""
        if (response.status === 404 || (response.ok && !/^application\/pdf\b/i.test(type)))
          missing = true
        else if (response.ok) missing = false
      } catch {
        // Unknown; load() will tell.
      }
      return !missing
    },
  }
}
