export interface NavItem {
  label: string
  slug?: string
  href?: string
  children?: NavItem[]
  /** Identifies a dropdown so the header can attach live status to it. */
  menu?: "resources" | "tools"
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
  ...["Journal Club", "Notes", "Projects", "Code", "Drive", "Equipment"].map((label) => ({
    label,
    href: `/resources/${label.toLowerCase().replace(/ /g, "-")}/`,
  })),
  { label: "Topics", href: "/resources/topics/" },
]

export const calendarNav: NavItem = { label: "Calendar", href: "/calendar" }

export function navigation(mode = process.env.SITE_MODE): NavItem[] {
  return mode === "internal"
    ? [
        ...publicNav,
        { label: "Resources", menu: "resources", children: [...resourceNav, calendarNav] },
        {
          label: "Tools",
          menu: "tools",
          children: [{ label: "Instruments", href: "/instruments" }],
        },
        { label: "Sign out", href: "/auth/logout" },
      ]
    : [
        ...publicNav,
        { label: "Sign in with GitHub", href: `${process.env.SITE_LOGIN_ORIGIN ?? ""}/auth/login` },
      ]
}

export const footerNav = publicNav
