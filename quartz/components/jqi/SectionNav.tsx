import { QuartzComponentProps } from "../types"
import { FullSlug, resolveRelative } from "../../util/path"
import { publicNav, resourceNav } from "./nav"

export default function SectionNav({ fileData, allFiles }: QuartzComponentProps) {
  const slug = fileData.slug!
  const section = slug.split("/")[0]
  const children = allFiles
    .filter(
      (f) =>
        f.slug?.startsWith(section + "/") &&
        f.slug !== section + "/index" &&
        (section === "research" ? f.frontmatter?.type === "research" : false),
    )
    .sort((a, b) => String(a.frontmatter?.title).localeCompare(String(b.frontmatter?.title)))
  const link = (target: string, label: string) => (
    <a
      href={resolveRelative(slug, target as FullSlug)}
      aria-current={slug === target || slug === target + "/index" ? "page" : undefined}
    >
      {label}
    </a>
  )
  return (
    <nav class="section-nav" aria-label="Section navigation">
      <ul>
        {publicNav.map((item) => (
          <li key={item.slug}>
            {link(item.slug!, item.label)}
            {item.slug === section && children.length > 0 && (
              <ul>
                {children.map((f) => (
                  <li key={f.slug}>{link(f.slug!, String(f.frontmatter?.title))}</li>
                ))}
              </ul>
            )}
            {item.slug === "people" && section === "people" && (
              <ul>
                <li>{link("people/directory/index", "Contact directory")}</li>
                <li>{link("people/alumni/index", "Alumni")}</li>
              </ul>
            )}
          </li>
        ))}
      </ul>
      <div class="handbook-links">
        <h2>Group resources</h2>
        {process.env.SITE_MODE === "internal" && (
          <ul>
            {resourceNav.map((item) => (
              <li>
                <a href={item.href}>{item.label}</a>
              </li>
            ))}
          </ul>
        )}
        <ul>
          <li>{link("onboarding/index", "Onboarding")}</li>
          <li>{link("places/index", "Places")}</li>
          <li>{link("equipment/index", "Lab equipment")}</li>
          <li>{link("materials/index", "Photonic materials")}</li>
          <li>{link("lab/index", "Lab notes")}</li>
        </ul>
      </div>
    </nav>
  )
}
