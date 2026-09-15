import { QuartzComponent, QuartzComponentConstructor, QuartzComponentProps } from "../types"
import { FullSlug, joinSegments, pathToRoot, resolveRelative } from "../../util/path"
import { navigation, NavItem } from "./nav"

const searchIcon = (
  <svg class="icon icon-search" aria-hidden="true" height="22" width="22" viewBox="0 0 23 23">
    <g fill-rule="nonzero">
      <path d="M8.75.5a8.25 8.25 0 1 0 0 16.5 8.25 8.25 0 0 0 0-16.5Zm0 3a5.25 5.25 0 1 1 0 10.5 5.25 5.25 0 0 1 0-10.5Z" />
      <path d="m12.129 14.25 2.121-2.121 8.421 8.421-2.121 2.121z" />
    </g>
  </svg>
)

// Reproduces the hafezi.jqi.umd.edu site header: logo, main nav, search.
// Components placed in the `header` layout slot (the search box) render into
// the search area on the right.
const JqiHeader: QuartzComponent = ({ fileData, children }: QuartzComponentProps) => {
  const slug = fileData.slug!
  const root = pathToRoot(slug)
  const current = (target: string) => slug === target || slug.startsWith(target + "/")
  const href = (item: NavItem) => item.href ?? resolveRelative(slug, item.slug! as FullSlug)
  return (
    <header class="site-header">
      <div class="site-header__inner">
        <div class="site-header__logo">
          <a href={resolveRelative(slug, "index" as FullSlug)}>
            <img
              src={joinSegments(root, "static/theme/logo_hafezi.svg")}
              alt="Joint Quantum Institute Research - Hafezi Group"
              width="350"
              height="60"
            />
          </a>
        </div>
        <div class="site-header__mobile-controls">
          <button
            class="site-header__search site-header__search-mobile"
            type="button"
            data-jqi-search
          >
            <span class="sr-only">Search</span>
            {searchIcon}
          </button>
          <button
            class="site-header__nav-toggle"
            aria-expanded="false"
            type="button"
            data-jqi-nav-toggle
          >
            <span class="sr-only">Show Main Menu</span>
            <span class="site-header__hamburger-icon" aria-hidden="true">
              <span class="site-header__hamburger-icon-bar"></span>
              <span class="site-header__hamburger-icon-bar"></span>
              <span class="site-header__hamburger-icon-bar"></span>
              <span class="site-header__hamburger-icon-bar"></span>
            </span>
          </button>
        </div>
        <nav class="site-header__nav" aria-label="Main" aria-hidden="false">
          <ul>
            {navigation().map((item) => (
              <li>
                {item.children ? (
                  <details class="member-menu" data-menu={item.menu}>
                    <summary>{item.label}</summary>
                    <div class="member-menu__panel">
                      <ul>
                        {item.children.map((child) => (
                          <li>
                            <a href={href(child)}>{child.label}</a>
                          </li>
                        ))}
                      </ul>
                      {item.menu === "resources" && (
                        <div class="lab-menu-status">
                          <p data-upcoming-events>Loading upcoming events…</p>
                        </div>
                      )}
                      {item.menu === "tools" && (
                        <div class="lab-menu-status">
                          <p data-instrument-status>Checking instruments…</p>
                        </div>
                      )}
                    </div>
                  </details>
                ) : (
                  <a
                    href={href(item)}
                    aria-current={item.slug && current(item.slug) ? "page" : undefined}
                  >
                    {item.label}
                  </a>
                )}
              </li>
            ))}
          </ul>
        </nav>
        <div class="site-header__search-slot hidden 1000:block">{children}</div>
      </div>
    </header>
  )
}

export default (() => JqiHeader) satisfies QuartzComponentConstructor
