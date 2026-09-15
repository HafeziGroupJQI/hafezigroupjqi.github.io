# Hafezi Group website

Public website and authenticated lab resources, built from Markdown vaults with one shared Hafezi layout.

Two editions come out of one build: `npm run build:public` is the GitHub Pages site and
`npm run build:members` is the member edition, served by the Cloudflare Worker in
[`worker/`](worker/README.md) together with GitHub sign-in, the group calendar, and the
private documents streamed from `vault-private`.

## Rebuild triggers

```
vault push ───────(validate)──┬─► hafezigroupjqi.github.io: deploy.yml ─► GitHub Pages
                              │        └─ dispatch website-updated ─┐
vault-private push (validate) ┼──────────────────────────────────────┼─► members-site: deploy.yml
website push ─────────────────┘  (vault-updated, vault-private-updated, website-updated,
                                  daily schedule, manual) ─► build:members ─► wrangler deploy
```

Each dispatch uses the `MEMBERS_DISPATCH_TOKEN` secret (contents: write on `members-site`);
the members-site workflow itself is kept in `worker/ci/members-site-deploy.yml`.

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
  - The onboarding welcome lives at `/onboarding/welcome`; old `/welcome` and `/people/Directory` links have aliases. The source vault is not modified.
