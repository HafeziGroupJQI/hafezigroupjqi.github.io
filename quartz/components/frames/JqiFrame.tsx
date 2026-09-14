import { PageFrame, PageFrameProps } from "./types"
import JqiHeaderConstructor from "../jqi/Header"
import JqiFooterConstructor from "../jqi/Footer"
import { navScript } from "../jqi/navScript"
import SectionNav from "../jqi/SectionNav"
import { FullSlug, resolveRelative } from "../../util/path"

const JqiHeader = JqiHeaderConstructor()
const JqiFooter = JqiFooterConstructor()

/**
 * Page frame that reproduces the DOM of hafezi.jqi.umd.edu so the vendored
 * stylesheet applies unchanged:
 *
 *   .base-layout
 *     header.site-header            (logo, main nav, search = `header` slot)
 *     main#main-content
 *       .page-content
 *         .page-content__sidebar    (`left` slot: explorer)
 *         .page-content__main
 *           .page-content__header   (`beforeBody` slot: breadcrumbs, title, meta, tags)
 *           .page-content__body > .text-content  (page body, then `afterBody`)
 *         .page-content__aside      (`right` slot: graph, backlinks, toc)
 *     footer.site-footer            (JQI footer; `footer` slot components follow it)
 */
export const JqiFrame: PageFrame = {
  name: "jqi",
  render({ componentData, header, beforeBody, pageBody: Content, afterBody, left, right, footer }: PageFrameProps) {
    const publicPage = componentData.fileData.frontmatter?.site_public === true
    const home = componentData.fileData.frontmatter?.site_home === true
    const person = componentData.fileData.frontmatter?.type === "person"
    const internal = process.env.SITE_MODE === "internal"
    return (
      <div class={`base-layout${publicPage ? " site-public" : " site-handbook"}${home ? " site-home" : ""}${person ? " site-person" : ""}${internal ? " site-internal" : ""}`}>
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
              {publicPage ? <SectionNav {...componentData} /> : left.map((BodyComponent) => (
                <BodyComponent {...componentData} />
              ))}
            </div>
            <div class="page-content__main">
              <div class="page-content__header popover-hint">
                {publicPage ? <>
                  <nav class="public-breadcrumbs" aria-label="Breadcrumb"><a href={resolveRelative(componentData.fileData.slug!, "index" as FullSlug)}>Home</a><span aria-hidden="true">›</span><span>{componentData.fileData.frontmatter?.title}</span></nav>
                  <h1>{componentData.fileData.frontmatter?.title}</h1>
                </> : beforeBody.map((BodyComponent) => (
                  <BodyComponent {...componentData} />
                ))}
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
              {!publicPage && right.map((BodyComponent) => (
                <BodyComponent {...componentData} />
              ))}
            </aside>
          </div>
        </main>
        <JqiFooter {...componentData} />
        {footer.map((FooterComponent) => (
          <FooterComponent {...componentData} />
        ))}
        <script dangerouslySetInnerHTML={{ __html: navScript }} />
      </div>
    )
  },
}
