import { PageFrame, PageFrameProps } from "./types"
import JqiHeaderConstructor from "../jqi/Header"
import JqiFooterConstructor from "../jqi/Footer"
import { navScript } from "../jqi/navScript"
import SectionNav from "../jqi/SectionNav"
import { publicNav, resourceNav } from "../jqi/nav"
import { FullSlug, resolveRelative } from "../../util/path"

const JqiHeader = JqiHeaderConstructor()
const JqiFooter = JqiFooterConstructor()

// Labels for ancestor sections that have no index page of their own or whose index
// title reads badly as a crumb ("Code index").
const sectionLabels: Record<string, string> = Object.fromEntries([
  ...publicNav.map((item) => [item.slug!, item.label]),
  ...resourceNav.map((item) => [item.href!.replace(/^\/|\/$/g, ""), item.label]),
  ["resources", "Resources"],
  ["tags", "Tags"],
  ["onboarding", "Onboarding"],
  ["places", "Places"],
  ["equipment", "Lab equipment"],
  ["materials", "Photonic materials"],
  ["lab", "Lab notes"],
])

const humanize = (segment: string) =>
  segment.replace(/[-_]+/g, " ").replace(/^\w/, (letter) => letter.toUpperCase())

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
    const label = sectionLabels[prefix] ?? (title && title !== segment ? title : humanize(segment))
    return { target, label }
  })
}

/** The public Hafezi layout is shared by every page and both authentication editions. */
export const JqiFrame: PageFrame = {
  name: "jqi",
  render({ componentData, header, pageBody: Content, afterBody, footer }: PageFrameProps) {
    const slug = componentData.fileData.slug!
    const frontmatter = componentData.fileData.frontmatter
    const home = frontmatter?.site_home === true
    const person = frontmatter?.type === "person"
    const internal = process.env.SITE_MODE === "internal"
    const crumbs = breadcrumbs(slug, componentData.allFiles)
    // Private resources carry topic tags; public pages keep the live site's untagged look.
    const tags =
      internal && slug.startsWith("resources/")
        ? ((frontmatter?.tags ?? []) as string[]).filter((tag) => tag !== "internal")
        : []
    return (
      <div
        class={`base-layout site-public${home ? " site-home" : ""}${person ? " site-person" : ""}${internal ? " site-internal" : ""}`}
      >
        <a href="#main-content" class="skip-nav-link">
          Skip to main content
        </a>
        <JqiHeader {...componentData}>
          {header.map((HeaderComponent) => (
            <HeaderComponent {...componentData} />
          ))}
        </JqiHeader>
        <main id="main-content">
          <div class="page-content">
            <div class="page-content__sidebar">
              <SectionNav {...componentData} />
            </div>
            <div class="page-content__main">
              <div class="page-content__header popover-hint">
                <>
                  <nav class="public-breadcrumbs" aria-label="Breadcrumb">
                    <a href={resolveRelative(slug, "index" as FullSlug)}>Home</a>
                    {crumbs.map((crumb) => (
                      <>
                        <span aria-hidden="true">›</span>
                        <a href={resolveRelative(slug, crumb.target)}>{crumb.label}</a>
                      </>
                    ))}
                    <span aria-hidden="true">›</span>
                    <span>{frontmatter?.title}</span>
                  </nav>
                  <h1>{frontmatter?.title}</h1>
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
            <aside class="page-content__aside" />
          </div>
        </main>
        <JqiFooter {...componentData} />
        {footer.map((FooterComponent) => (
          <FooterComponent {...componentData} />
        ))}
        {internal && <script type="module" src="/static/member-tools.js" data-spa-preserve />}
        <script dangerouslySetInnerHTML={{ __html: navScript }} />
      </div>
    )
  },
}
