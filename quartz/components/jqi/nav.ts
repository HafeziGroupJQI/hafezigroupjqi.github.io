export interface NavItem {
  label: string
  slug?: string
  href?: string
  children?: NavItem[]
}

export const publicNav: NavItem[] = [
  { label: "Research", slug: "research" },
  { label: "People", slug: "people" },
  { label: "Positions", slug: "positions" },
  { label: "News", slug: "news" },
  { label: "Publications", slug: "publications" },
  { label: "Lab Facilities", slug: "lab-facilities" },
  { label: "Theses", slug: "theses" },
]

export const resourceNav: NavItem[] = [
  { label: "All resources", href: "/resources/" },
  ...["Journal Club", "Notes", "Projects", "Code", "Drive"].map((label) => ({
    label,
    href: `/resources/${label.toLowerCase().replace(/ /g, "-")}/`,
  })),
  { label: "Topics", href: "/resources/topics/" },
]

export function navigation(mode = process.env.SITE_MODE): NavItem[] {
  return mode === "internal"
    ? [
        ...publicNav,
        { label: "Resources", children: resourceNav },
        {
          label: "Lab tools",
          children: [
            { label: "Calendar", href: "/calendar" },
            { label: "Add event", href: "/calendar#add-event" },
            { label: "Instruments", href: "/instruments" },
            { label: "Sign out", href: "/auth/logout" },
          ],
        },
      ]
    : [
        ...publicNav,
        { label: "Sign in with GitHub", href: `${process.env.SITE_LOGIN_ORIGIN ?? ""}/auth/login` },
      ]
}

export const footerNav = publicNav
