# Member site Worker

One Cloudflare Worker serves everything members see: the built member edition of the site
as static assets, GitHub sign-in restricted to the lab team, the group calendar on a D1
database, and the private documents streamed from `vault-private` on GitHub. The public
site stays on GitHub Pages and only links here.

## Routes

| Route                                                   | Purpose                                                                                                                                                                                                               |
| ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/health`                                       | liveness, no login                                                                                                                                                                                                    |
| `GET /auth/login?next=`                                 | GitHub OAuth (`read:org`); `AUTH_MODE=dev` signs in a local owner instead                                                                                                                                             |
| `GET /auth/callback`                                    | exchanges the code, checks org ownership or `lab-members` membership, sets the session cookie                                                                                                                         |
| `GET /auth/logout`                                      | clears the session and returns to the public site                                                                                                                                                                     |
| `GET /api/session`                                      | `{ user, csrf }`                                                                                                                                                                                                      |
| `GET /api/calendar/events?start&end`                    | occurrences in an aware range of at most 370 days                                                                                                                                                                     |
| `GET/POST/PUT/DELETE /api/calendar/events[/:id]`        | series and single-occurrence edits with optimistic `version` (409 on conflict); writes need `Origin` equal to the site and `X-CSRF-Token`                                                                             |
| `POST /api/agent/enroll`                                | an agent exchanges a one-time enrollment token for its device key (the only agent call without a device key)                                                                                                          |
| `POST /api/agent/{instruments,readings,logs,heartbeat}` | device-key ingest: replace-set the instrument declaration, the reading/log firehose (routed through the DeviceHub DO), and per-instrument status                                                                      |
| `GET /api/agent/command-channel`                        | the agent's persistent WebSocket to its DeviceHub (hibernated): commands out, results back                                                                                                                            |
| `POST /api/agent/experiments`                           | device-key twin of `POST /api/devices/:code/experiments`: the desktop GUI (`HafeziAgent gui`) on the lab PC submits a `Setup.json` for _its own_ device — same generation, validation and `experiment.start` dispatch |
| `GET/POST /api/devices`, `DELETE /api/devices/:code`    | list devices; owner-only create (returns a one-time enrollment token) and revoke                                                                                                                                      |
| `GET /api/devices/:code[/instruments[/:local_id]]`      | device detail, its instruments with latest readings, and one instrument's ports/capabilities/history                                                                                                                  |
| _liveness fields_                                       | `GET /api/devices` rows and `GET /api/devices/:code` carry `liveness` (`online` ≤ 45 s · `stale` ≤ 300 s · `offline` · `pending` = never enrolled/seen) and `last_seen_age_ms`, from the **server-stamped** heartbeat; the list adds `instruments_online`. Instrument rows add `effective_status` (`offline` unless the device is `online`) — `instrument_status` never expires, so views must use it |
| `GET /api/devices/:code/stream`                         | Server-Sent Events: the DeviceHub's live reading/log fan-out (member session cookie authenticates it)                                                                                                                 |
| `GET/POST /api/devices/:code/commands`                  | the command audit log; enqueue a `poll`/`reconfigure`/`experiment.stop` command (mutation headers required)                                                                                                           |
| `GET/POST /api/devices/:code/experiments`               | list experiments; `POST` a `Setup.json` spec → cloud-generate `Runexp.py` → dispatch `experiment.start` (mutation headers)                                                                                            |
| `POST /api/devices/:code/experiments/:id/stop`          | stop a running experiment                                                                                                                                                                                             |
| `GET /api/experiments/:id[/datasets]`                   | one experiment (spec, generated script, status) and its dataset artifacts                                                                                                                                             |
| `GET /api/catalog`                                      | instrument families (ports, capabilities) for the builder                                                                                                                                                             |
| everything else                                         | requires a session (anonymous page requests are redirected to the login, other requests get 401); served from the static assets, or streamed from GitHub when the path is a private document                          |

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

| Secret                                     | Value                                                                           |
| ------------------------------------------ | ------------------------------------------------------------------------------- |
| `SESSION_SECRET`                           | 32 or more random characters; signs the session cookie                          |
| `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` | the GitHub OAuth app whose callback is `https://<worker-host>/auth/callback`    |
| `GITHUB_DOCS_TOKEN`                        | fine-grained PAT with contents:read on `vault-private`                          |
| `ANTHROPIC_API_KEY`                        | cloud experiment generation; unset falls back to the offline template generator |
| `ANTHROPIC_MODEL`                          | optional generation model override (defaults to a current, capable model)       |

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

## Instruments (multi-device)

Each lab PC runs a **HafeziAgent** (`~/src/agent`, C#) that is the only thing that touches
instruments. It dials out over HTTPS (no inbound ports, no tunnel), enrolls once with a one-time
token to get a per-device key, declares its instruments, streams readings/logs up, and holds one
persistent WebSocket for commands. The Worker is the relay and the site; it stores and forwards,
and never controls anything.

- **Three auth tiers.** Member (GitHub session + CSRF) governs the browser; device (a per-device
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
