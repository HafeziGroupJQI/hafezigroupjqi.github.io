# Member site Worker

One Cloudflare Worker serves everything members see: the built member edition of the site
as static assets, GitHub sign-in restricted to the lab team, the group calendar on a D1
database, and the private documents streamed from `vault-private` on GitHub. The public
site stays on GitHub Pages and only links here.

## Routes

| Route | Purpose |
|---|---|
| `GET /api/health` | liveness, no login |
| `GET /auth/login?next=` | GitHub OAuth (`read:org`); `AUTH_MODE=dev` signs in a local owner instead |
| `GET /auth/callback` | exchanges the code, checks org ownership or `lab-members` membership, sets the session cookie |
| `GET /auth/logout` | clears the session and returns to the public site |
| `GET /api/session` | `{ user, csrf }` |
| `GET /api/calendar/events?start&end` | occurrences in an aware range of at most 370 days |
| `GET/POST/PUT/DELETE /api/calendar/events[/:id]` | series and single-occurrence edits with optimistic `version` (409 on conflict); writes need `Origin` equal to the site and `X-CSRF-Token` |
| everything else | requires a session (anonymous page requests are redirected to the login, other requests get 401); served from the static assets, or streamed from GitHub when the path is a private document |

Every response is marked `private` and `noindex`.

## Documents

`npm run build:members` (in the website root) writes the member edition to
`.cache/private-site` without any PDFs, Office files, audio or scripts, and records each of
them in `worker/generated/docs-manifest.json` as `site path → { sha, size, contentType }`,
where `sha` is the git blob in `vault-private` (`tools/docs-manifest.mjs`). On a request for
one of those paths the Worker fetches the blob through the GitHub API with
`GITHUB_DOCS_TOKEN`, streams it, and caches it at the edge under the sha, so a changed
document simply gets a new key. Documents that are not committed in `vault-private` fail
the build on purpose: the Worker could never fetch them.

## Configuration

`wrangler.jsonc` holds the public settings (`GITHUB_ORG`, `GITHUB_TEAM`, `DOCS_REPO`,
`PUBLIC_SITE_URL`, `AUTH_MODE=github`) and the D1 binding. Secrets, set with
`wrangler secret put`:

| Secret | Value |
|---|---|
| `SESSION_SECRET` | 32 or more random characters; signs the session cookie |
| `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` | the GitHub OAuth app whose callback is `https://<worker-host>/auth/callback` |
| `GITHUB_DOCS_TOKEN` | fine-grained PAT with contents:read on `vault-private` |

## Local development

```sh
npm run build:members            # website root; needs ../vault-private checked out
cd worker
cp .dev.vars.example .dev.vars   # AUTH_MODE=dev; add GITHUB_DOCS_TOKEN to open documents
npm ci
npm run migrate:local
npm run dev                      # http://localhost:8787
npm test                         # vitest inside the Workers runtime
npm run check                    # tsc
```

## Deployment

The private repo `HafeziGroupJQI/members-site` runs `ci/members-site-deploy.yml` on
`repository_dispatch` from the website, vault, and vault-private repos, on a daily
schedule, and by hand. It checks out the three repos, builds the member edition, runs the
tests, applies D1 migrations, and runs `wrangler deploy`, which uploads the static assets
and the Worker together. Calendar data lives in D1 and survives deploys.

First-time setup: `wrangler d1 create hafezi-members` (paste the id into `wrangler.jsonc`),
`wrangler deploy` once from a laptop to learn the `workers.dev` host, then create the OAuth
app and the secrets above.
