// "Save to Google Drive" in the Export menu (drive.js) signs in with this OAuth client: a Web
// application client in the lab's Google Cloud project, whose one authorized JavaScript origin is
// https://hafezigroupjqi.github.io (both editions of the site are served there), with the Google
// Drive API enabled and the drive.file scope on its consent screen. A client ID is public by design
// (Google shows it in the sign-in window); there is no secret. Empty: the menu has no Drive items.
export const GOOGLE_CLIENT_ID = ""
