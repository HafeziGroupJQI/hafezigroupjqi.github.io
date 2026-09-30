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
  /** The public vault ("owner/name"), whose People pages members edit from /settings. */
  VAULT_REPO?: string
  /** A token that may write VAULT_REPO's contents (fine-grained: that repo, Contents read/write). */
  GITHUB_VAULT_TOKEN?: string
  /** A token on DOCS_REPO (vault-private) alone for members' uploads (src/uploads/): fine-grained,
   *  Contents and Pull requests read/write, Commit statuses read. Unset, uploads are off. */
  GITHUB_VAULT_PRIVATE_TOKEN?: string
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
  /** The single ComputeRelay DO (src/compute/relay.ts) the compute host's tunnel dials into. */
  COMPUTE_RELAY: DurableObjectNamespace
  /** HMAC secret shared with the compute host for the per-request assertion. Unset: compute is off. */
  COMPUTE_ASSERTION_SECRET?: string
  /** Lowercase hex SHA-256 of the compute host's bearer key. */
  COMPUTE_HOST_KEY_HASH?: string
  /** Optional coarse rate limit for Wolfram runs; the relay enforces the real per-login budget. */
  COMPUTE_LIMIT?: RateLimit
  /** Optional rate limit for the lab's ghost-text completions (src/gpt/lab-agent.ts). */
  COMPLETE_LIMIT?: RateLimit
  /** "true" lets owners open any member's server (every such request is logged), and admins read
   *  members' live sessions and code history in /admin (every read is audited). */
  COMPUTE_OWNER_ACCESS?: string
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
