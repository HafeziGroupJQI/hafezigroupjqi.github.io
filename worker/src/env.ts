export interface Env {
  ASSETS: Fetcher
  DB: D1Database
  AUTH_MODE: "github" | "dev"
  SESSION_SECRET: string
  GITHUB_CLIENT_ID?: string
  GITHUB_CLIENT_SECRET?: string
  GITHUB_ORG: string
  GITHUB_TEAM: string
  GITHUB_DOCS_TOKEN?: string
  DOCS_REPO: string
  PUBLIC_SITE_URL: string
  /** Instrument service origin (Cloudflare Tunnel public hostname). Empty = not configured. */
  C2_URL?: string
  /** Shared with C2_GATEWAY_SECRET on the instrument service. */
  C2_GATEWAY_SECRET?: string
  /** Cloudflare Access service token for the tunnel in front of C2. */
  CF_ACCESS_CLIENT_ID?: string
  CF_ACCESS_CLIENT_SECRET?: string
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
