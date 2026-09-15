import { PageFrame, PageFrameProps } from "./types"
import JqiHeaderConstructor from "../jqi/Header"
import JqiFooterConstructor from "../jqi/Footer"
import { navScript } from "../jqi/navScript"
import SectionNav from "../jqi/SectionNav"
import { FullSlug, resolveRelative } from "../../util/path"

const JqiHeader = JqiHeaderConstructor()
const JqiFooter = JqiFooterConstructor()

/** The public Hafezi layout is shared by every page and both authentication editions. */
export const JqiFrame: PageFrame = {
  name: "jqi",
  render({ componentData, header, pageBody: Content, afterBody, footer }: PageFrameProps) {
    const home = componentData.fileData.frontmatter?.site_home === true
    const person = componentData.fileData.frontmatter?.type === "person"
    const internal = process.env.SITE_MODE === "internal"
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
                    <a href={resolveRelative(componentData.fileData.slug!, "index" as FullSlug)}>
                      Home
                    </a>
                    <span aria-hidden="true">›</span>
                    <span>{componentData.fileData.frontmatter?.title}</span>
                  </nav>
                  <h1>{componentData.fileData.frontmatter?.title}</h1>
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
