// "Save to Google Drive" in the Export menu (drive.js) signs in with this OAuth client: the Web
// application client of the Google Cloud project hafezi-group-website (app "Hafezi Group", in
// production), whose authorized JavaScript origins are https://hafezigroupjqi.github.io (both
// editions of the site are served there) and http://localhost:8080 (tools/serve-pages.mjs), with
// the Google Drive API enabled and the drive.file scope on its consent screen. A client ID is
// public by design (Google shows it in the sign-in window); there is no secret. Empty: the menu has
// no Drive items.
export const GOOGLE_CLIENT_ID =
  "827668248395-2m92en0alqppj7rbhpef1au13tj6dsq6.apps.googleusercontent.com"
