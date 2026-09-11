import { PageFrame, PageFrameProps } from "./types"
import JqiHeaderConstructor from "../jqi/Header"
import JqiFooterConstructor from "../jqi/Footer"
import { navScript } from "../jqi/navScript"

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
    return (
      <div class="base-layout">
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
              {left.map((BodyComponent) => (
                <BodyComponent {...componentData} />
              ))}
            </div>
            <div class="page-content__main">
              <div class="page-content__header popover-hint">
                {beforeBody.map((BodyComponent) => (
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
              {right.map((BodyComponent) => (
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
