// Site navigation, shared by the header and footer. Slugs are content paths
// (folder pages or index pages) resolved relative to the current page so the
// site works under any base path (GitHub Pages subpath or a custom domain).
export interface NavItem {
  label: string
  slug: string
}

export const mainNav: NavItem[] = [
  { label: "Research", slug: "research" },
  { label: "People", slug: "people" },
  { label: "Positions", slug: "positions" },
  { label: "News", slug: "news" },
  { label: "Publications", slug: "publications" },
  { label: "Lab Facilities", slug: "lab-facilities" },
  { label: "Theses", slug: "theses" },
  { label: "Onboarding", slug: "onboarding" },
]

export const footerNav: NavItem[] = mainNav.slice(0, 7)

export const mainSite = "https://hafezi.jqi.umd.edu"
