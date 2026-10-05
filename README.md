# Hafezi Group website

Public website and authenticated lab resources, built from Markdown vaults with one shared Hafezi layout.

Everything lives at **https://hafezigroupjqi.github.io**. Two editions come out of one build:

- **Public edition** (`npm run build:public`): the GitHub Pages site everyone sees. It also
  carries the members entry points: the `/auth/login`, `/auth/callback` and `/auth/logout`
  pages, and the service worker `/sw.js`.
- **Member edition** (`npm run build:members`): the same site plus `/resources`, the calendar and
  the `/devices` dashboard. It is deployed only as the static assets of the members API (the
  Cloudflare Worker in [`worker/`](worker/README.md)), never to Pages.

When a lab member signs in with GitHub, the service worker serves them the member edition of
every page at the same github.io URLs. It fetches each page from the Worker in the background
with a bearer token, so members never visit the Worker. Signed out, the service worker stays
out of the way.

## Rebuild triggers

```
website push ─────────────► hafezigroupjqi.github.io: deploy.yml ─► GitHub Pages
compute host (hafezi-dispatch, every 2 min) watches main of the website, vault,
vault-private and each restricted vault, and the Worker's access rules version:
  vault moved ─────────────► hafezigroupjqi.github.io: deploy.yml (workflow_dispatch)
  any of them moved ───────► members-site: deploy.yml (workflow_dispatch) ─► build:members ─► wrangler deploy
plus each workflow's daily schedule and manual runs
```

The dispatcher's token (Actions only, on the two site repositories) lives on the compute host,
never in a repository members can push to; the members-site workflow itself is kept in
`worker/ci/members-site-deploy.yml`.

## How it fits together

- All content is sourced directly from the vault repository (this includes markdown, Quarto markdown, and any other assets, such as images.)
- Do not edit this repository unless you're making any changes to the following files:
  - `quartz/components/frames/JqiFrame.tsx` provides public and handbook layouts using the live site's header and footer
  - `quartz/components/jqi/` holds the header, footer, nav list, and the small nav script
  - `quartz/styles/_jqi-theme.scss` is the live site's stylesheet (refresh with `npm run sync-theme`). `quartz/styles/custom.scss` holds everything on top of it
  - `quartz/static/theme/` holds fonts and logos
  - `quartz.config.yaml` enables the plugins: explorer (sidebar nav), search, graph, backlinks, table of contents, tags, folder and tag pages, Bases (filterable tables), LaTeX, callouts
  - `tools/render-qmd.mjs` renders `.qmd` files with Quarto before the build; `tools/clean-qmd.mjs` removes the generated twins afterwards.
  - `tools/prepare-site.mjs` creates a disposable website copy of the vault.
- Other important notes:
  - The homepage reuses the group introduction, research, publications, and news from the original website
  - `/people/` contains role-grouped photo cards and `/people/directory/` contains the contact table.
  - Onboarding and the lab walkthrough are member-only, in `vault-private` (served at `/resources/onboarding/`). The sidebar's Group resources block exists only in the member edition and stays hidden until sign-in. Old `/people/Directory` links have aliases. The source vault is not modified.
  - Tags that name a note (`people/<slug>`, `project/<name>`, `library/<collection>`, …) get a tag page that links to it (`tools/tag-pages.mjs`), so the note lists the tag page among its backlinks.
