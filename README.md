# Hafezi Group website

Source of the group site published at <https://hafezigroupjqi.github.io/>
(a mock of the group's public site plus onboarding, equipment, and notes). It is
[Quartz 5](https://quartz.jzhao.xyz/) wearing the theme of hafezi.jqi.umd.edu, and it
builds from the content in [HafeziGroupJQI/vault](https://github.com/HafeziGroupJQI/vault):
there is no content in this repository.

## How it fits together

```
vault (markdown, .qmd, images)  --push-->  vault CI validates, dispatches "vault-updated"
                                                 |
website CI: checkout vault/content -> quarto render .qmd -> quartz build -> GitHub Pages
```

- `quartz/components/frames/JqiFrame.tsx` provides public and handbook layouts using
  the live site's header and footer. Public pages have section navigation; handbook
  pages retain the explorer, graph, backlinks, and tags.
- `quartz/components/jqi/` holds the header, footer, nav list, and the small nav script.
- `quartz/styles/_jqi-theme.scss` is the live site's stylesheet (refresh with `npm run sync-theme`);
  `quartz/styles/custom.scss` holds everything on top of it.
- `quartz/static/theme/` holds the fonts and logos.
- `quartz.config.yaml` enables the plugins: explorer (sidebar nav), search, graph, backlinks,
  table of contents, tags, folder and tag pages, Bases (filterable tables), LaTeX, callouts.
- `tools/render-qmd.mjs` renders `.qmd` files with Quarto before the build; `tools/clean-qmd.mjs`
  removes the generated twins afterwards.
- `tools/prepare-site.mjs` creates a disposable website copy of the vault. The homepage
  uses the group introduction, research, publications, and news. `/people/` contains
  role-grouped photo cards and `/people/directory/` contains the contact table.
  The onboarding welcome lives at `/onboarding/welcome`; old `/welcome` and
  `/people/Directory` links have aliases. The source vault is not modified.

## Local development

```sh
npm ci
ln -sfn ../vault/content content   # the vault checked out next to this repo
npm run build                      # render .qmd, build to public/, clean up
npm run serve                      # dev server at http://localhost:8080
```

Alternatively, point `CONTENT_DIR` at a checkout inside this repository:

```sh
git clone https://github.com/HafeziGroupJQI/vault.git vault-src
CONTENT_DIR=vault-src/content npm run build
CONTENT_DIR=vault-src/content npm run serve
```

Use `npm run build` / `npm run serve`, not a direct `quartz build`: these commands
prepare the public pages and render Quarto in a temporary copy before running Quartz.
The preview serves a snapshot of the vault; restart it after editing vault content.
Both deployment workflows use this same build entry point.

Run `npm run test:site` for routing, card generation, and source-preservation checks.
After a successful build, `npm run compare:site` compares the live site's primary
pages and each imported record against the generated HTML. It writes missing headings,
paragraphs, navigation labels, and fetch errors to `.cache/parity-report.json` and
exits unsuccessfully when differences remain. This checks content, not visual parity.
Screenshots at desktop and mobile widths are still required to verify layout,
hover previews, menus, and database interactions.

`.qmd` rendering needs Quarto and a Python with the packages in the vault's
`requirements.txt` (`pip install -r ../vault/requirements.txt`).
