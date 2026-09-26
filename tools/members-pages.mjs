import fs from "node:fs"
import path from "node:path"

// The sign-in pages of the public site. They are plain static files (no Quartz page) so they stay
// tiny and never depend on the member edition: /auth/login starts GitHub sign-in through the
// members API, GitHub returns to /auth/callback, and /auth/logout forgets the session.
// GitHub Pages serves /auth/login from auth/login.html.
export const AUTH_PAGES = {
  login: { title: "Signing in", run: "login" },
  callback: { title: "Signing in", run: "callback" },
  logout: { title: "Signing out", run: "logout" },
}

export function authPage(title, run, stylesheet) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<meta name="referrer" content="no-referrer">
<title>${title} · Hafezi Group</title>
${stylesheet ? `<link rel="stylesheet" href="/${stylesheet}">` : ""}
<style>
  body { margin: 0; font-family: Roboto, system-ui, sans-serif; color: #222; background: #fff; }
  main { max-width: 560px; margin: 18vh auto; padding: 0 24px; }
  img { width: 280px; height: auto; }
  p { font-size: 1.05rem; color: #454545; }
  a { color: #e21833; }
</style>
</head>
<body>
<main>
  <a href="/"><img src="/static/theme/logo_hafezi.svg" alt="Hafezi Group"></a>
  <p data-status role="status">${title}…</p>
  <p><a href="/">Back to the group site</a></p>
</main>
<script type="module">import { ${run} } from "/static/members-auth.js"; ${run}()</script>
</body>
</html>
`
}

export function writeAuthPages(output) {
  const stylesheet = fs.readdirSync(output).find((name) => /^index-[0-9a-f]+\.css$/.test(name))
  fs.mkdirSync(path.join(output, "auth"), { recursive: true })
  for (const [name, { title, run }] of Object.entries(AUTH_PAGES))
    fs.writeFileSync(path.join(output, "auth", `${name}.html`), authPage(title, run, stylesheet))
}
