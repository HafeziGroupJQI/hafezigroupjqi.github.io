export interface NavItem {
  label: string
  slug?: string
  href?: string
  children?: NavItem[]
  /** Identifies a dropdown so the header can attach live status to it. */
  menu?: "resources"
  /** Member-only entry: hidden until the visitor is signed in (toggled client-side). */
  member?: boolean
  /** Admin-only entry: hidden unless the live session reports is_admin (toggled client-side). */
  admin?: boolean
  /** Auth control: "in" shows only when logged out, "out" shows only when logged in. */
  auth?: "in" | "out"
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
  ...["Onboarding", "Journal Club", "Notes", "Projects", "Code", "Library", "Equipment"].map(
    (label) => ({
      label,
      href: `/resources/${label.toLowerCase().replace(/ /g, "-")}/`,
    }),
  ),
  { label: "Wolfram Language guide", href: "/resources/code/wolfram-guide/" },
  { label: "Topics", href: "/resources/topics/" },
]

export const calendarNav: NavItem = { label: "Calendar", href: "/calendar" }

export function navigation(mode = process.env.SITE_MODE): NavItem[] {
  // The internal edition is one unified site: public entries for everyone, member entries and the
  // Sign out control revealed only once signed in, and a Sign in control shown only when logged
  // out. The header marks each so the client can toggle them from the live session.
  return mode === "internal"
    ? [
        ...publicNav,
        {
          label: "Resources",
          menu: "resources",
          member: true,
          children: [...resourceNav, calendarNav],
        },
        {
          label: "Tools",
          member: true,
          children: [
            { label: "Hafezi GPT", href: "/gpt" },
            { label: "Scratchpad", href: "/scratchpad" },
            // The devices dashboard: its experiments and experiment builder are tabs of the page.
            { label: "Command Center", href: "/devices" },
            { label: "Admin", href: "/admin", admin: true },
          ],
        },
        { label: "Sign in with GitHub", href: "/auth/login", auth: "in" },
        { label: "Sign out", href: "/auth/logout", auth: "out" },
      ]
    : [
        ...publicNav,
        // Same-origin: /auth/login is a static page of this site that signs in through the
        // members API (frontend/members/pages.js); members never leave hafezigroupjqi.github.io.
        { label: "Sign in with GitHub", href: "/auth/login" },
      ]
}

export const footerNav = publicNav
