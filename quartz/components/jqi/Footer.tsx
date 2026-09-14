import { QuartzComponent, QuartzComponentConstructor, QuartzComponentProps } from "../types"
import { FullSlug, joinSegments, pathToRoot, resolveRelative } from "../../util/path"
import { configuredC2Url, footerNav, mainSite } from "./nav"

// Reproduces the hafezi.jqi.umd.edu footer: partner logos, footer nav,
// contact block, social links, legal strip.
const JqiFooter: QuartzComponent = ({ fileData }: QuartzComponentProps) => {
  const slug = fileData.slug!
  const root = pathToRoot(slug)
  const logo = (file: string) => joinSegments(root, `static/theme/${file}`)
  const year = new Date().getFullYear()
  if (process.env.SITE_MODE === "internal") {
    const c2Url = configuredC2Url() ?? "/instruments"
    return (
      <footer class="site-footer site-footer--internal">
        <div class="site-footer__legal">
          <span class="site-footer__copyright">Hafezi Members Vault</span>
          <nav class="site-footer__legal-nav" aria-label="Member links">
            <ul>
              <li><a href={mainSite}>Public website</a></li>
              <li><a href={c2Url}>Instruments</a></li>
              <li><a href="/auth/logout">Sign out</a></li>
            </ul>
          </nav>
        </div>
      </footer>
    )
  }
  return (
    <footer class="site-footer">
      <div class="site-footer__main">
        <div class="site-footer__logos">
          <ul class="site-footer__logos-list">
            <li class="site-footer__logos-item">
              <a class="responsive-img" style="padding-top:20.11661807580175%" href="https://jqi.umd.edu/" target="_blank" rel="noopener">
                <img src={logo("jqi-logo-white.svg")} alt="UMD Joint Quantum Institute logo" loading="lazy" />
              </a>
            </li>
            <li class="site-footer__logos-item">
              <a class="responsive-img" style="padding-top:27.960339943342778%" href="https://www.umd.edu/" target="_blank" rel="noopener">
                <img src={logo("umd-logo-white.svg")} alt="University of Maryland logo" loading="lazy" />
              </a>
            </li>
            <li class="site-footer__logos-item">
              <a class="responsive-img" style="padding-top:13.095238095238097%" href="https://www.nist.gov/" target="_blank" rel="noopener">
                <img src={logo("nist-logo-white.svg")} alt="National Institute of Standards and Technology logo" loading="lazy" />
              </a>
            </li>
          </ul>
        </div>
        <nav class="site-footer__nav" aria-label="Footer">
          <ul>
            {footerNav.map((item) => (
              <li>
                <a href={resolveRelative(slug, item.slug as FullSlug)}>{item.label}</a>
              </li>
            ))}
          </ul>
        </nav>
        <div class="site-footer__contact">
          <h2 class="site-footer__contact-title">Contact Us</h2>
          <div class="site-footer__contact-address">
            <p>
              Room 2207 Atlantic Bldg.<br />University of Maryland<br />College Park, MD 20742
            </p>
          </div>
          <div class="site-footer__contact-phone-email">
            <p>
              <span>Phone: </span><a href="tel:+13013141908">(301) 314-1908</a>
              <br />
              <span>Fax: </span><a href="tel:+13013140207">(301) 314-0207</a>
              <br />
              <a href="mailto:jqi-info@umd.edu">jqi-info@umd.edu</a>
            </p>
          </div>
        </div>
        <nav class="site-footer__social" aria-label="Social">
          <ul>
            <li>
              <a href="https://twitter.com/JQInews">
                <span class="sr-only">Twitter</span>
                <svg class="icon icon-twitter" aria-hidden="true" width="20" height="20" viewBox="0 0 16 16">
                  <path d="M12.2,1.5h2.2L9.6,7l5.7,7.5h-4.4L7.3,10l-4,4.5H1.1l5.2-5.9L0.8,1.5h4.5l3.1,4.2L12.2,1.5z M11.4,13.2h1.2L4.7,2.8H3.4 L11.4,13.2z" />
                </svg>
              </a>
            </li>
            <li>
              <a href="https://www.facebook.com/JQInews">
                <span class="sr-only">Facebook</span>
                <svg class="icon icon-facebook" aria-hidden="true" width="11" height="22" viewBox="0 0 11 22">
                  <path d="M9.951 4.283c.144.028.301 0 .43-.086a.523.523 0 0 0 .23-.373l.386-2.793a.559.559 0 0 0-.401-.601A11.75 11.75 0 0 0 7.374 0C3.952 0 2.291 1.633 2.291 5.013v1.475H.544c-.3 0-.544.244-.544.545v2.864c0 .315.243.559.544.559h1.747v11c0 .3.243.544.544.544h3.58c.286 0 .53-.243.53-.544v-11h2.892c.286 0 .515-.23.544-.516l.2-2.864a.549.549 0 0 0-.143-.416.511.511 0 0 0-.386-.172H6.945v-1.26c0-.945.1-1.175 1.073-1.175.559 0 1.318.1 1.933.23Z" fill-rule="evenodd" />
                </svg>
              </a>
            </li>
            <li>
              <a href="https://www.youtube.com/user/JQInews">
                <span class="sr-only">Youtube</span>
                <svg class="icon icon-youtube" aria-hidden="true" width="22" height="15" viewBox="0 0 22 15">
                  <path d="M21.68 3.475c-.116-.775-.422-1.543-.758-2.261-.309-.66-.915-1.027-1.693-1.07-.665-.036-1.33-.131-1.995-.133C13.1-.002 8.968-.005 4.835.01c-.753.003-1.508.083-2.257.166-.667.073-1.16.426-1.506.996-.4.657-.64 1.366-.75 2.114-.389 2.634-.447 5.276-.057 7.91.119.803.394 1.602.719 2.353a1.928 1.928 0 0 0 1.59 1.174c.574.068 1.152.117 1.73.131 2.267.055 4.535.093 7.213.145 2.097-.058 4.602-.119 7.107-.204.758-.026 1.514-.106 2.051-.753.432-.52.7-1.113.839-1.757.628-2.926.607-5.872.166-8.811ZM8.842 11.332v-7.79l6.167 3.906-6.167 3.884Z" fill-rule="evenodd" />
                </svg>
              </a>
            </li>
          </ul>
        </nav>
      </div>
      <div class="site-footer__legal">
        <span class="site-footer__copyright">© {year} Joint Quantum Institute</span>
        <nav class="site-footer__legal-nav" aria-label="Legal">
          <ul>
            <li><a href="https://www.umd.edu/privacy-notice">Privacy Policy</a></li>
            <li><a href="https://www.umd.edu/web-accessibility">Web Accessibility</a></li>
          </ul>
        </nav>
      </div>
    </footer>
  )
}

export default (() => JqiFooter) satisfies QuartzComponentConstructor
