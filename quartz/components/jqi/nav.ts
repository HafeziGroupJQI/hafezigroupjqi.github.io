// Site navigation, shared by the header and footer. Slugs are content paths
// (folder pages or index pages) resolved relative to the current page so the
// site works under any base path (GitHub Pages subpath or a custom domain).
export interface NavItem {
  label: string
  slug?: string
  href?: string
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

const defaultInternalNav: NavItem[] = [
  { label: "Vault", href: "/" },
  { label: "Journal Club", slug: "journal-club" },
  { label: "Notes", slug: "notes" },
  { label: "Projects", slug: "projects" },
  { label: "Code", slug: "code" },
  { label: "Drive", slug: "drive" },
  { label: "Instruments", href: "/instruments" },
  { label: "Sign Out", href: "/auth/logout" },
]

export function configuredInternalUrl(value = process.env.INTERNAL_SITE_URL): string | undefined {
  if (!value) return undefined
  try {
    const url = new URL(value)
    if (url.protocol !== "https:" && url.hostname !== "localhost" && url.hostname !== "127.0.0.1") return undefined
    return url.toString().replace(/\/$/, "")
  } catch {
    return undefined
  }
}

export function configuredC2Url(value = process.env.INTERNAL_C2_URL): string | undefined {
  if (!value) return undefined
  try {
    const url = new URL(value)
    if (url.protocol !== "https:" && url.hostname !== "localhost" && url.hostname !== "127.0.0.1") return undefined
    return url.toString().replace(/\/$/, "")
  } catch {
    return undefined
  }
}

export function internalNavigation(value = process.env.INTERNAL_C2_URL): NavItem[] {
  const c2Url = configuredC2Url(value)
  return defaultInternalNav.map((item) =>
    item.label === "Instruments" && c2Url ? { ...item, href: c2Url } : item,
  )
}

export const internalNav: NavItem[] = internalNavigation()

export function navigation(mode = process.env.SITE_MODE): NavItem[] {
  if (mode === "internal") return internalNavigation()
  const internalUrl = configuredInternalUrl()
  return internalUrl ? [...publicNav, { label: "Internal", href: internalUrl }] : publicNav
}

export const footerNav: NavItem[] = publicNav

export const mainSite = process.env.PUBLIC_SITE_URL ?? "https://hafezigroupjqi.github.io"
