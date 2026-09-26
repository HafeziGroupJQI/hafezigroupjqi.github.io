export interface Env {
  ASSETS: Fetcher
  DB: D1Database
  /** One instance per device code-name; live command queue + reading/log fan-out. */
  DEVICE_HUB: DurableObjectNamespace
  /** Experiment result artifacts (CSV, plot PNGs). */
  ARTIFACTS: R2Bucket
  AUTH_MODE: "github" | "dev"
  SESSION_SECRET: string
  GITHUB_CLIENT_ID?: string
  GITHUB_CLIENT_SECRET?: string
  GITHUB_ORG: string
  GITHUB_TEAM: string
  GITHUB_DOCS_TOKEN?: string
  DOCS_REPO: string
  /** The github.io site: the only browser origin (besides ALLOWED_ORIGINS), the OAuth callback
   *  host, and where non-API requests to the Worker are redirected. */
  PUBLIC_SITE_URL: string
  /** Extra comma-separated browser origins allowed by CORS (local development, e.g. http://localhost:8080). */
  ALLOWED_ORIGINS?: string
  /** Cloud experiment generation. When set, the Worker calls the Claude Messages API to write the
   *  control script; unset, it falls back to a deterministic offline template (used in tests). */
  ANTHROPIC_API_KEY?: string
  /** Optional model override for generation; defaults to a current, capable model. */
  ANTHROPIC_MODEL?: string
  /** Messages API origin. Defaults to https://api.anthropic.com. Point it at a local claude-bridge
   *  (`~/src/claude-bridge`) under `wrangler dev` to generate on a Claude subscription with no key. */
  ANTHROPIC_BASE_URL?: string
}

export interface DocumentEntry {
  sha: string
  size: number
  contentType: string
}

export interface DocsManifest {
  generatedAt?: string
  repo?: string
  documents: Record<string, DocumentEntry>
}
