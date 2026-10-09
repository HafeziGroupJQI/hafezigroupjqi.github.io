// Inlined at the top of every page of the members edition only (JqiFrame), before anything paints:
// a signed-in member's theme, from the copy frontend/theme/ keeps in localStorage, so a page never
// flashes the light site first, and their choice of wrapping long lines in code blocks (applied
// whatever the theme, the site's own look included). It does nothing for a member who kept the site's own look, nothing
// signed out (an expired session's leftover copy included), and nothing on the public edition,
// which does not carry it. Keep it in step with frontend/theme/cache.js (resolve and applyTheme).
export const THEME_KEY = "hafezi.theme"

export const themeBootstrap = `(function(){try{
var s=localStorage,d=document.documentElement;
if(!(+s.getItem("hafezi.signedInUntil")>Date.now()))return;
var c=JSON.parse(s.getItem("${THEME_KEY}")||"null");if(!c||typeof c!=="object")return;
if(c.prefs&&typeof c.prefs==="object")d.setAttribute("data-code-wrap",c.wrap===false?"off":"on");
var t=c.mode==="dark"||c.mode==="system"&&matchMedia("(prefers-color-scheme: dark)").matches?c.dark:c.light;
if(!t||!t.vars||typeof t.vars!=="object")return;
d.setAttribute("saved-theme",t.polarity==="dark"?"dark":"light");d.setAttribute("data-palette",t.id);
d.setAttribute("data-figures",c.figures===false?"keep":"match");
for(var k in t.vars)if(/^--[\\w-]+$/.test(k))d.style.setProperty(k,String(t.vars[k]));
}catch(e){}})();`
