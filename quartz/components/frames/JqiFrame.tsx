import { PageFrame, PageFrameProps } from "./types"
import JqiHeaderConstructor from "../jqi/Header"
import JqiFooterConstructor from "../jqi/Footer"
import { navScript } from "../jqi/navScript"
import { memberBootstrap } from "../jqi/memberBootstrap"
import { themeBootstrap } from "../jqi/themeBootstrap"
import SectionNav from "../jqi/SectionNav"
import { publicNav, resourceNav } from "../jqi/nav"
import { FullSlug, resolveRelative } from "../../util/path"
import { PrintMeta } from "./printMeta"
import { automaticFolder, editAttributes, folderAttributes } from "./pageTools"
import { folderTitle } from "../../plugins/local/folder-index/names"

const JqiHeader = JqiHeaderConstructor()
const JqiFooter = JqiFooterConstructor()

// Labels for ancestor sections that have no index page of their own or whose index
// title reads badly as a crumb ("Code index").
const sectionLabels: Record<string, string> = Object.fromEntries([
  ...publicNav.map((item) => [item.slug!, item.label]),
  ...resourceNav.map((item) => [item.href!.replace(/^\/|\/$/g, ""), item.label]),
  ["resources", "Resources"],
  ["tags", "Tags"],
  ["places", "Places"],
  ["equipment", "Lab equipment"],
  ["materials", "Photonic materials"],
])

const handbookSections = new Set(["equipment", "setups", "materials", "places"])

/** Every ancestor of the page, so nested content reads as part of its section. */
function breadcrumbs(slug: FullSlug, allFiles: PageFrameProps["componentData"]["allFiles"]) {
  const parts = slug.split("/")
  if (parts[parts.length - 1] === "index") parts.pop()
  return parts.slice(0, -1).map((segment, index) => {
    const prefix = parts.slice(0, index + 1).join("/")
    const page = allFiles.find((file) => file.slug === `${prefix}/index` || file.slug === prefix)
    // Tag pages live at tags/<tag>; every other section has a folder or index page.
    const target = (page?.slug ??
      (prefix.startsWith("tags/") ? prefix : `${prefix}/index`)) as FullSlug
    // Folder and tag pages are titled by their raw path segment; present those readably.
    const title = page?.frontmatter?.title as string | undefined
    const label =
      sectionLabels[prefix] ?? (title && title !== segment ? title : folderTitle(segment))
    return { target, label }
  })
}

/** The public Hafezi layout is shared by every page and both authentication editions. */
export const JqiFrame: PageFrame = {
  name: "jqi",
  render({ componentData, header, pageBody: Content, afterBody, right, footer }: PageFrameProps) {
    const slug = componentData.fileData.slug!
    const frontmatter = componentData.fileData.frontmatter
    const home = frontmatter?.site_home === true
    const person = frontmatter?.type === "person"
    // The members' devices dashboard is a full-bleed app: no sidebar, no breadcrumbs or second
    // <h1>, no prose wrapper. It renders its own chrome (frontend/dashboard/).
    const dashboard = frontmatter?.layout === "dashboard"
    const internal = process.env.SITE_MODE === "internal"
    const crumbs = breadcrumbs(slug, componentData.allFiles)
    // Tag pages list every page that carries the tag (the listing public pages otherwise hide).
    const tagPage = slug === "tags" || slug.startsWith("tags/")
    // Handbook, tag and member pages get the graph, backlinks, and table of contents column;
    // pages mirrored from hafezi.jqi.umd.edu keep the live site's two-column look.
    const handbook =
      tagPage ||
      handbookSections.has(slug.split("/")[0]) ||
      (internal && slug.startsWith("resources/"))
    // Private resources carry topic tags; public pages keep the live site's untagged look.
    const tags =
      internal && slug.startsWith("resources/")
        ? ((frontmatter?.tags ?? []) as string[]).filter((tag) => tag !== "internal")
        : []
    // A private page's own file in the vault (tools/prepare-unified.mjs), for its Replace and Move
    // tools (frontend/member-tools.js).
    const vaultSource =
      internal && slug.startsWith("resources/") && typeof frontmatter?.vault_source === "string"
        ? frontmatter.vault_source
        : undefined
    // A page made from a Markdown file has its source beside it (quartz/plugins/local/page-source/)
    // and an Export menu under its title (frontend/page-export/); folder and tag pages have neither,
    // and the dashboards have no title to put it under.
    const source =
      !dashboard &&
      !automaticFolder(frontmatter) &&
      componentData.fileData.filePath?.endsWith(".md")
        ? `/${slug}.md`
        : undefined
    // An automatic folder page (quartz/plugins/local/folder-index/) has no source: its tools row
    // names its folder of the private vault instead (frontend/folder-tools.js), members only.
    const folderTools = folderAttributes(slug, frontmatter, internal)
    return (
      <div
        class={`base-layout site-public${home ? " site-home" : ""}${person ? " site-person" : ""}${internal ? " site-internal" : ""}${handbook ? " site-handbook" : ""}${tagPage ? " site-tag" : ""}${dashboard ? " site-dashboard" : ""}`}
      >
        {/* A signed-in member's own theme (frontend/theme/), before the page paints: members only. */}
        {internal && <script dangerouslySetInnerHTML={{ __html: themeBootstrap }} />}
        <script dangerouslySetInnerHTML={{ __html: memberBootstrap }} />
        <a href="#main-content" class="skip-nav-link">
          Skip to main content
        </a>
        <JqiHeader {...componentData}>
          {header.map((HeaderComponent) => (
            <HeaderComponent {...componentData} />
          ))}
        </JqiHeader>
        {/* "center": Quartz plugin scripts (e.g. the Mermaid renderer) look for their content in .center. */}
        <main id="main-content" class="center">
          {dashboard ? (
            <div class="page-content">
              <div class="page-content__main">
                <Content {...componentData} />
              </div>
            </div>
          ) : (
            <div class="page-content">
              <div class="page-content__sidebar">
                <SectionNav {...componentData} />
              </div>
              <div class="page-content__main">
                <div class="page-content__header popover-hint" data-vault-source={vaultSource}>
                  <>
                    <nav class="public-breadcrumbs" aria-label="Breadcrumb">
                      {/* Each crumb keeps the "›" after it, so a wrapped line never starts with one. */}
                      {[{ target: "index" as FullSlug, label: "Home" }, ...crumbs].map((crumb) => (
                        <span class="public-breadcrumbs__crumb">
                          <a href={resolveRelative(slug, crumb.target)}>{crumb.label}</a>
                          <span aria-hidden="true">›</span>
                        </span>
                      ))}
                      <span>{frontmatter?.title}</span>
                    </nav>
                    <h1>{frontmatter?.title}</h1>
                    <PrintMeta
                      slug={slug}
                      title={String(frontmatter?.title ?? "")}
                      trail={crumbs.map((crumb) => crumb.label)}
                      baseUrl={componentData.cfg.baseUrl}
                      members={internal && slug.startsWith("resources/")}
                      frontmatter={frontmatter}
                    />
                    {tags.length > 0 && (
                      <ul class="tags" aria-label="Topics">
                        {tags.map((tag) => (
                          <li>
                            <a
                              class="internal tag-link"
                              href={resolveRelative(slug, `tags/${tag}` as FullSlug)}
                            >
                              {tag}
                            </a>
                          </li>
                        ))}
                      </ul>
                    )}
                    {source && (
                      <div
                        class="page-tools"
                        data-page-tools
                        data-source={source}
                        {...editAttributes(slug, frontmatter)}
                      />
                    )}
                    {!source && folderTools["data-folder"] && (
                      <div class="page-tools" data-page-tools {...folderTools} />
                    )}
                  </>
                </div>
                <div class="page-content__body">
                  <div class="text-content page-body">
                    <Content {...componentData} />
                  </div>
                  <div class="page-content__after">
                    {afterBody.map((BodyComponent) => (
                      <BodyComponent {...componentData} />
                    ))}
                  </div>
                </div>
              </div>
              <aside class="page-content__aside">
                {handbook && right.map((RightComponent) => <RightComponent {...componentData} />)}
              </aside>
            </div>
          )}
        </main>
        <JqiFooter {...componentData} />
        {footer.map((FooterComponent) => (
          <FooterComponent {...componentData} />
        ))}
        {internal && <script type="module" src="/static/member-tools.js" data-spa-preserve />}
        {source && <script type="module" src="/static/page-export.js" data-spa-preserve />}
        {/* The page's History (frontend/page-history/), where its tools name a history file. */}
        {source && editAttributes(slug, frontmatter)["data-history"] && (
          <script type="module" src="/static/page-history.js" data-spa-preserve />
        )}
        <script dangerouslySetInnerHTML={{ __html: navScript }} />
      </div>
    )
  },
}
