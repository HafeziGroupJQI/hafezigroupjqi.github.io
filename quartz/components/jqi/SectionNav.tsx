import { QuartzComponentProps } from "../types"
import { FullSlug, resolveRelative } from "../../util/path"
import { type NavItem, navigation, publicNav } from "./nav"

// Group resources the navbar doesn't list, kept under Resources here.
const extraResources: NavItem[] = [
  { label: "Places", slug: "places/index" },
  { label: "Lab equipment", slug: "equipment/index" },
  { label: "Photonic materials", slug: "materials/index" },
]

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
  // The navbar's member menus (Resources, Tools), in the member build only.
  const members = navigation().filter((item) => item.member && item.children)
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
      {members.length > 0 && (
        // The navbar's member menus, laid out like Research and its pages. Rendered only in the
        // member build and hidden until signed in (the session script reveals [data-member] and,
        // for admins, [data-admin-only]). The public build has none.
        <ul class="section-nav__members" data-member="" hidden>
          {members.map((menu) => (
            <li>
              {menu.menu === "resources" ? (
                link("resources/index", menu.label)
              ) : (
                <span class="section-nav__label">{menu.label}</span>
              )}
              <ul>
                {[
                  ...(menu.children ?? []),
                  ...(menu.menu === "resources" ? extraResources : []),
                ].map((child) => (
                  <li
                    data-admin-only={child.admin ? "" : undefined}
                    hidden={child.admin ? true : undefined}
                  >
                    {child.href ? (
                      <a href={child.href}>{child.label}</a>
                    ) : (
                      link(child.slug!, child.label)
                    )}
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      )}
    </nav>
  )
}
