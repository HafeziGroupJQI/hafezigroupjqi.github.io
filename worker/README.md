# Members API Worker

The members API behind **https://hafezigroupjqi.github.io**. Members never visit this Worker:
the site is the only thing they see. After a member signs in, the site's service worker
(`frontend/members/sw.js`, emitted as `/sw.js` by the public build) answers every request.
It serves the **member edition** of each page (the static assets of this Worker, built by
`npm run build:members`) from `GET /api/site/<path>`, and forwards same-origin `/api/*` calls
here, adding a bearer token. The dashboard's live stream calls the Worker directly with
`fetch()`.

Sign-in is GitHub OAuth, restricted to the lab team. GitHub returns to the static page
`/auth/callback` on github.io, which trades the code here for an 8-hour bearer token. The Worker
also holds the group calendar on D1, and streams the private documents from `vault-private` on
GitHub. Lab PCs call `/api/agent/*` with device keys. Any non-API URL on the Worker redirects
to the same path on github.io.

```
member @ github.io ─ /sw.js ─ bearer ─► /api/site/* (member edition) · /api/* (calendar, devices, session)
/auth/login (github.io) ─► POST /api/auth/start ─► GitHub ─► /auth/callback (github.io) ─► POST /api/auth/exchange
lab PC ─ device key ─► /api/agent/*
```

## Routes

| Route                                                   | Purpose                                                                                                                                                                                                                                                                                                                                                                                               |
| ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/health`                                       | liveness, no login                                                                                                                                                                                                                                                                                                                                                                                    |
| `POST /api/auth/start {next}`                           | returns GitHub's authorize URL with `redirect_uri` = `PUBLIC_SITE_URL/auth/callback` and a signed 10-minute state bound to a nonce; `AUTH_MODE=dev` returns `{dev:true, state, nonce}` instead                                                                                                                                                                                                        |
| `POST /api/auth/exchange {code, state, nonce}`          | verifies the state and nonce, trades the code, checks org ownership or `lab-members` membership, returns `{token, exp, user, next}` (8 h bearer token)                                                                                                                                                                                                                                                |
| `GET /api/session`                                      | `{ user }` for the bearer token (`{ user: null }` without one)                                                                                                                                                                                                                                                                                                                                        |
| `GET /api/site/<path>`                                  | the member edition of a github.io path: pages and assets from the static assets, private documents streamed from GitHub (Range supported); a trailing-slash/`.html` redirect comes back as `204` + `x-canonical-path`                                                                                                                                                                                 |
| `GET /api/calendar/events?start&end`                    | occurrences in an aware range of at most 370 days                                                                                                                                                                                                                                                                                                                                                     |
| `GET/POST/PUT/DELETE /api/calendar/events[/:id]`        | series and single-occurrence edits with optimistic `version` (409 on conflict); writes from a browser must come from an allowed origin                                                                                                                                                                                                                                                                |
| `POST /api/agent/enroll`                                | an agent exchanges a one-time enrollment token for its device key (the only agent call without a device key)                                                                                                                                                                                                                                                                                          |
| `POST /api/agent/{instruments,readings,logs,heartbeat}` | device-key ingest: replace-set the instrument declaration, the reading/log firehose (routed through the DeviceHub DO), and per-instrument status                                                                                                                                                                                                                                                      |
| `GET /api/agent/command-channel`                        | the agent's persistent WebSocket to its DeviceHub (hibernated): commands out, results back                                                                                                                                                                                                                                                                                                            |
| `POST /api/agent/experiments`                           | device-key twin of `POST /api/devices/:code/experiments`: the desktop GUI (`HafeziAgent gui`) on the lab PC submits a `Setup.json` for _its own_ device — same generation, validation and `experiment.start` dispatch                                                                                                                                                                                 |
| `GET/POST /api/devices`, `DELETE /api/devices/:code`    | list devices; any member may create (returns a one-time enrollment token) and revoke; both are audited                                                                                                                                                                                                                                                                                                |
| `GET /api/devices/:code[/instruments[/:local_id]]`      | device detail, its instruments with latest readings, and one instrument's ports/capabilities/history                                                                                                                                                                                                                                                                                                  |
| _liveness fields_                                       | `GET /api/devices` rows and `GET /api/devices/:code` carry `liveness` (`online` ≤ 45 s · `stale` ≤ 300 s · `offline` · `pending` = never enrolled/seen) and `last_seen_age_ms`, from the **server-stamped** heartbeat; the list adds `instruments_online`. Instrument rows add `effective_status` (`offline` unless the device is `online`) — `instrument_status` never expires, so views must use it |
| `GET /api/devices/:code/stream`                         | Server-Sent Events: the DeviceHub's live reading/log fan-out (bearer token; the dashboard reads it with `fetch()`)                                                                                                                                                                                                                                                                                    |
| `GET/POST /api/devices/:code/commands`                  | the command audit log; enqueue a `poll`/`reconfigure`/`experiment.stop` command (mutation headers required)                                                                                                                                                                                                                                                                                           |
| `GET/POST /api/devices/:code/experiments`               | list experiments; `POST` a `Setup.json` spec → cloud-generate `Runexp.py` → dispatch `experiment.start` (mutation headers)                                                                                                                                                                                                                                                                            |
| `POST /api/devices/:code/experiments/:id/stop`          | stop a running experiment                                                                                                                                                                                                                                                                                                                                                                             |
| `GET /api/experiments/:id[/datasets]`                   | one experiment (spec, generated script, status) and its dataset artifacts                                                                                                                                                                                                                                                                                                                             |
| `GET /api/catalog`                                      | instrument families (ports, capabilities) for the builder                                                                                                                                                                                                                                                                                                                                             |
| `POST /api/auth/logout`                                 | ends every session the member began before now, on every device: its bearers and the lab tickets issued from them are refused from then on (D1 `logouts`; the compute relay keeps a copy and closes the member's open lab sockets), and records the sign-out                                                                                                                                          |
| `/api/admin/*`                                          | group admins only (org owners + the `admins` table): `audit` (paged, filtered), `audit.csv`, `admins` (promote/demote), `usage`, `budgets/:login`, `profile-claims` (members' claims of People pages, approved or turned down here), `compute/*` (members' code). See [Audit log](#audit-log-and-admins)                                                                                              |
| `/api/gpt/*`                                            | Hafezi GPT: projects, skills, uploads, chats, sharing, and `POST /api/gpt/conversations/:id/messages` (Server-Sent Events). See [Hafezi GPT](#hafezi-gpt)                                                                                                                                                                                                                                             |
| `GET /api/changes?login&repo&path&kind&state&before`    | the site's activity (D1 `changes`, like MediaWiki's recent changes): each change to a file of either vault, newest first, 50 a page (`next` is the next page's `before`), filtered to a member's contributions (`login`), a vault, one file (`path`) or comma lists of kinds and states. Each members deploy imports both vaults' commits; the Worker adds what members do on the site as they do it  |
| any other `/api/*`                                      | requires the bearer token (401 without it)                                                                                                                                                                                                                                                                                                                                                            |
| anything outside `/api/`                                | `302` to the same path on `PUBLIC_SITE_URL`                                                                                                                                                                                                                                                                                                                                                           |

Every response is marked `private` and `noindex`. Browser access is limited by CORS to
`PUBLIC_SITE_URL` plus any `ALLOWED_ORIGINS` (comma-separated; e.g. `http://localhost:8080` for
local development). There are no cookies. Bearer tokens are never sent automatically, so there
is nothing for CSRF to exploit. Rotating `SESSION_SECRET` signs everyone out.

## Documents

`npm run build:members` (in the website root) writes the member edition to
`.cache/private-site` without any PDFs, Office files, audio or scripts, and records each of
them in `worker/generated/docs-manifest.json` as `site path → { sha, size, contentType }`,
where `sha` is the git blob in `vault-private` (`tools/docs-manifest.mjs`). On a request for
one of those paths the Worker fetches the blob through the GitHub API with
`GITHUB_DOCS_TOKEN`, streams it, and caches it at the edge under the sha, so a changed
document simply gets a new key. Documents that are not committed in `vault-private` fail
the build on purpose: the Worker could never fetch them.

## Audit log and admins

Every sign-in (`auth.login`, and `auth.denied` for accounts the org rule turns away), sign-out,
private-document view (`doc.view`) and write is recorded in the D1 `audit_log` with the login,
role, time, target, status, IP and user agent (`src/audit.ts`). Routes record specific events
(`device.create`, `gpt.share`, `gpt.message` with model and token counts, `admin.promote` …);
any other write gets a generic `api.<METHOD>` row. Chat prompts and answers are never logged.
A daily cron (`triggers.crons`) prunes rows older than 365 days.

Group admins are the GitHub org owners plus anyone in the `admins` table; admins add and remove
each other at `/admin`. The check reads D1 on every request, so changes apply immediately.
`/api/session` reports `is_admin`, which reveals Tools → Admin in the header.

Admins also read members' code at `/admin` → Code (`/api/admin/compute/*`): a member's live
sessions, kernels and terminals, their IPython and terminal history, and their Scratchpad file
history with each commit's diff. The Worker gives the compute host an assertion naming that one
member (`admin_read`), the host serves only read-only ops for it, and both sides need owner
access on (`COMPUTE_OWNER_ACCESS`). Unlike Hafezi GPT conversations, every read is recorded
(`admin.compute.sessions`, `.ipython`, `.bash`, `.files`).

## Hafezi GPT

A Claude-backed assistant for members, at `/gpt` and as "Ask Hafezi GPT" (Ctrl/⌘+J) on every
member page (`frontend/gpt/`, `src/gpt/`). It knows the whole member edition of the site:

- **Search and read tools** over the Quartz `contentIndex.json` (public + private pages, BM25 in
  the isolate) and the docs manifest (private PDFs/text, snapshotted to R2 `gpt/blobs/<sha>`).
  Results come back as `search_result` / `document` blocks, so answers cite site pages.
- **Projects**: instructions plus topics (tags such as `project/tfln`, which load every tagged
  page) and pinned pages and text files, placed in the system prompt behind a 1-hour cache
  breakpoint (up to ~150k tokens; the rest is read on demand). Private or group.
- **@-mentions** of pages and documents, **uploads** (PDF, images, text/code; R2 `gpt/<login>/`),
  and the page a modal chat started on, as cited `document` blocks in the member's message.
- **Skills**: `SKILL.md`s in `vault-private/gpt/skills/` (baked into
  `generated/gpt-skills.json` by `tools/gpt-manifest.mjs`) plus member-written ones in D1; the
  model loads them with `use_skill`, or a member forces one with `/name`.
- **History and sharing**: chats are private to their owner until shared with a login or the
  whole lab (`*`); readers get a read-only transcript and can fork it into their own chat.
- **Models and budgets**: Sonnet 5 by default, Opus 5.5 per chat; usage and cost per member per
  month in `gpt_usage`, capped by `gpt_budgets` (admins set them at `/admin`), and per day, model
  and source (the site chat, the lab's coding agent, its ghost text) in `gpt_usage_daily`.

History is append-only and replayed exactly (thinking and compaction blocks included), with
binaries stored as R2 references rather than base64. Long chats use server-side compaction.
Without `ANTHROPIC_API_KEY` the chat answers offline, listing the context it would have sent.
Through a claude-bridge (any `ANTHROPIC_BASE_URL` but Anthropic's) it runs the same tools, by
emulation, and sends images and PDFs, but no betas: no compaction or citations.

## Configuration

`wrangler.jsonc` holds the public settings (`GITHUB_ORG`, `GITHUB_TEAM`, `DOCS_REPO`,
`PUBLIC_SITE_URL`, `AUTH_MODE=github`) and the D1 binding. Secrets, set with
`wrangler secret put`:

| Secret                                     | Value                                                                                   |
| ------------------------------------------ | --------------------------------------------------------------------------------------- |
| `SESSION_SECRET`                           | 32 or more random characters; signs the bearer tokens and login states                  |
| `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` | the GitHub OAuth app whose callback is `https://hafezigroupjqi.github.io/auth/callback` |
| `GITHUB_DOCS_TOKEN`                        | fine-grained PAT with contents:read on `vault-private`                                  |
| `ANTHROPIC_API_KEY`                        | cloud experiment generation; unset falls back to the offline template generator         |
| `ANTHROPIC_MODEL`                          | optional generation model override (defaults to a current, capable model)               |

## Local development

`npm run build:members` needs more than a checkout of `../vault-private`: Quarto (the
version pinned in `ci/members-site-deploy.yml`), the Jupyter kernels the vault's notes
declare (`py314`, `py312`; see the vault-private README, and set `QUARTO_PYTHON` to a
Python with `jupyter_core`, `nbformat` and `nbclient`), and the headless Chromium that
renders Excalidraw drawings (`npm run setup:browser` in the website root; on Arch the
browser's system libraries are `nss nspr at-spi2-core alsa-lib libxdamage libxrandr`,
on Debian/Ubuntu use `npm run setup:browser -- --with-deps`). `npm run check` fails with
a missing `generated/docs-manifest.json` until that build has run once.

```sh
npm run build:members            # website root; needs ../vault-private checked out
cd worker
cp .dev.vars.example .dev.vars   # AUTH_MODE=dev; add GITHUB_DOCS_TOKEN to open documents
npm ci
npm run migrate:local
npm run dev                      # the API on http://localhost:8787
npm test                         # vitest inside the Workers runtime
npm run check                    # tsc
```

The API has no pages of its own. To use the site locally, build both editions pointing at the
local API, and serve the public one the way GitHub Pages does:

```sh
MEMBERS_API_ORIGIN=http://localhost:8787 npm run build:unified   # website root
node tools/serve-pages.mjs public 8080                          # then open http://localhost:8080
```

`tools/verify-members.sh --build` does all of this, simulates a lab PC, and signs in with a
headless browser to walk the member pages. `ALLOWED_ORIGINS=http://localhost:8080` in
`.dev.vars` lets the local site call the local API.

## Deployment

The private repo `HafeziGroupJQI/members-site` runs `ci/members-site-deploy.yml` on
`repository_dispatch` from the website, vault, and vault-private repos, on a daily
schedule, and by hand. It checks out the three repos, builds the member edition, runs the
tests, applies D1 migrations, and runs `wrangler deploy`, which uploads the static assets
and the Worker together. Calendar data lives in D1 and survives deploys.

First-time setup: `wrangler d1 create hafezi-members` (paste the id into `wrangler.jsonc`),
`wrangler deploy` once from a laptop to learn the `workers.dev` host, then create the OAuth
app and the secrets above.

## Instruments (multi-device)

Each lab PC runs a **HafeziAgent** (`~/src/agent`, C#) that is the only thing that touches
instruments. It dials out over HTTPS (no inbound ports, no tunnel), enrolls once with a one-time
token to get a per-device key, declares its instruments, streams readings/logs up, and holds one
persistent WebSocket for commands. The Worker is the relay and the site; it stores and forwards,
and never controls anything.

- **Three auth tiers.** Member (GitHub sign-in → bearer token) governs the browser; device (a per-device
  key, stored only as a SHA-256 hash) authenticates agent ingest; enrollment (a one-time,
  short-TTL token an owner issues) bootstraps a device's key once.
- **`DeviceHub` Durable Object**, one per device code-name, is the live plane: the reading/log
  firehose fans out to member SSE subscribers in real time and never touches D1 on the hot path;
  an `alarm()` coalesces the buffered points into bounded D1 writes (`reading_latest` upserts +
  capped `reading_history`/`logs`). The command queue and the agent WebSocket live here too.
- **Cloud experiment generation.** The Experiment Builder posts a `Setup.json` spec; the Worker
  assembles the device-scoped instrument context from the `catalog` table, calls the Claude
  Messages API (or the offline template when `ANTHROPIC_API_KEY` is unset) to write a
  hardware-safe `Runexp.py`, statically validates it, stores it, and dispatches an
  `experiment.start` command carrying the spec + script. The agent runs it, `py_compile`s first,
  and streams points/logs back for the live plot; artifacts land in the `ARTIFACTS` R2 bucket.
- **Python bridge.** Real instrument reads work through `python -m c2.agentdriver` in
  `command-and-control` (subprocess line protocol), reusing the existing drivers and emitting
  byte-identical bus records. `keithley_2450` and `zurich_mfli` are the seeded real drivers; a
  device-scoped MCP server (`c2.mcp_server`) grounds the generator and a member working in Claude.

The old single-lab-PC C2 quick-tunnel proxy has been retired.
