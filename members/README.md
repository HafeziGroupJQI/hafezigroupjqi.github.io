# Hafezi website gateway

One origin serves the public website and authenticated edition using the same Quartz layout.
GitHub members of `HafeziGroupJQI/lab-members` and org owners can access resources, calendar,
and instruments. Anonymous visitors see the public edition and a GitHub sign-in link.

## Local setup

From the website repository root, with Node 22+, Python 3.12+, Quarto and both vaults checked out:

```sh
cp members/.env.example members/.env
chmod 600 members/.env
python3.12 -m venv members/.venv
members/.venv/bin/pip install -e './members[dev]'
npm ci
npm run setup:browser
npm run build:unified
members/.venv/bin/hafezi-members
```

Set `MEMBERS_AUTH=dev` for local testing. Dev mode starts anonymous; clicking Sign in creates a
local member session. This mode is restricted to a localhost base URL. For GitHub, set the OAuth
client ID, secret and a random session secret (32+ characters), with the callback
`MEMBERS_BASE_URL/auth/callback`. Never use development authentication on a public host.

`build:unified` loads `members/.env` and builds both editions; `build:public` and
`build:members` rebuild one edition after a small change (about one and two minutes). The
gateway serves the output directories directly, so a rebuild shows up without a restart. `build:internal` is a compatibility
alias for this unified build. `build` still builds a public-only static preview. Both editions
use `quartz.config.yaml`; the authenticated build disables feeds/sitemaps and includes private PDFs.
Build processes stage copies of the source vaults without modifying them.

## Settings and routes

- `MEMBERS_BASE_URL`: canonical website origin, HTTPS outside localhost.
- `MEMBERS_PUBLIC_SITE_PATH`: public build directory (default `public`).
- `MEMBERS_SITE_PATH`: authenticated build directory (default `.cache/private-site`). It contains
  public content plus private content under `/resources/`; never publish this directory to Pages.
- `VAULT_PUBLIC_DIR`: public vault **content** directory (default `content`).
- `VAULT_PRIVATE_DIR`: private vault root (default `../vault-private`).
- `MEMBERS_CALENDAR_DB`: persistent SQLite path (default `members/data/calendar.sqlite`).
- `/calendar` and `/api/calendar/events`: authenticated calendar and CRUD API. Range queries
  require offset-aware `start`/`end`, up to 370 days. Events store local times with an IANA timezone.
  PUT/DELETE use an event version to reject stale writes; `occurrence` identifies an original local
  start when editing/deleting one instance. Changing a series schedule resets exceptions.
- `/api/session`: current identity and CSRF token. Mutations require the matching `Origin` and
  `X-CSRF-Token` headers. All members can edit events. Month-end recurrence skips months without
  that date; nonexistent DST occurrences are skipped. The UI displays Eastern time.
- `/instruments` and `/api/c2/*`: instrument UI and authenticated gateway.

The calendar is seeded once with Group Meeting (Wednesdays noon–1pm beginning September 16, 2026)
and Laser Safety Training (September 17, 2026, 9–10am), America/New_York. Deleting or editing those
records persists across restarts. Runtime SQLite is the source of truth, superseding the earlier
roadmap's build-time YAML calendar. Back up the database while the gateway is stopped, or use
SQLite's online backup API. Builds must never replace it.

## Connecting C2 later

Leave `MEMBERS_C2_URL` empty until configured. The website will show “Not configured”. To connect:

1. Set `C2_AUTH=gateway` on C2 and `MEMBERS_C2_URL` on the website.
2. Set the same random 32+ character value for `C2_GATEWAY_SECRET` and
   `MEMBERS_C2_GATEWAY_SECRET`. Keep it distinct from the website session secret.
3. Bind C2 to localhost or an authenticated private network, with HTTPS for remote connections.

The website signs identity assertions valid for 30 seconds and bound to an API path and method.
C2 validates them. No browser C2 credentials or second OAuth flow are needed. Existing standalone
C2 GitHub authentication remains available for separate deployments.

## Production

Prepare a host with the prerequisites above. Build both editions outside the served release, then
switch a release symlink atomically and restart the gateway. Keep the SQLite database and secrets
at persistent absolute paths across releases. `deploy/hafezi-website.service` assumes a `hafezi`
user and `/srv/hafezi/website`; adjust those paths for the host. Configure Caddy with
`deploy/Caddyfile`, the production hostname in `MEMBERS_SITE_ADDRESS`, and the same HTTPS origin in
`MEMBERS_BASE_URL`. Register that origin's GitHub callback and update DNS to the gateway host.

The GitHub Pages workflow remains a public-only preview. Set repository variable
`SITE_LOGIN_ORIGIN` to the gateway's HTTPS origin so its login button works. It never checks out
or uploads private content. Canonical production traffic should use the gateway hostname.

Check `/api/health`, public homepage, GitHub login, a private resource, calendar, and the C2 offline
state before cutting over. Monitor gateway process failures and HTTP 5xx responses. Roll back by
switching to the previous complete build and restarting; preserve calendar data.

## Verification

```sh
members/.venv/bin/pytest members/tests
members/.venv/bin/ruff check members/src members/tests
npm test
npm run test:site
npm run build:unified
```
