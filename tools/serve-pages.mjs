// A local stand-in for GitHub Pages: serves a built public site the way Pages does — `/x` from
// x.html, `/dir` redirects to `/dir/`, `/dir/` from dir/index.html, and anything missing gets
// 404.html with status 404. Used by tools/verify-members.sh.
// Usage: node tools/serve-pages.mjs <dir> [port]
import fs from "node:fs"
import http from "node:http"
import path from "node:path"

const root = path.resolve(process.argv[2] ?? "public")
const port = Number(process.argv[3] ?? 8080)
const types = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".xml": "application/xml",
  ".txt": "text/plain; charset=utf-8",
}

const isFile = (p) => fs.existsSync(p) && fs.statSync(p).isFile()
const isDir = (p) => fs.existsSync(p) && fs.statSync(p).isDirectory()

function send(res, file, status = 200) {
  res.writeHead(status, { "content-type": types[path.extname(file)] ?? "application/octet-stream" })
  fs.createReadStream(file).pipe(res)
}

http
  .createServer((req, res) => {
    const url = new URL(req.url, `http://localhost:${port}`)
    const rel = decodeURIComponent(url.pathname)
    const target = path.join(root, rel)
    if (!target.startsWith(root)) return send(res, path.join(root, "404.html"), 404)
    if (isFile(target)) return send(res, target)
    if (isDir(target)) {
      if (!rel.endsWith("/")) {
        res.writeHead(301, { location: rel + "/" + url.search })
        return res.end()
      }
      if (isFile(path.join(target, "index.html"))) return send(res, path.join(target, "index.html"))
    }
    if (isFile(target + ".html")) return send(res, target + ".html")
    send(res, path.join(root, "404.html"), 404)
  })
  .listen(port, () => console.log(`pages: ${root} on http://localhost:${port}`))
