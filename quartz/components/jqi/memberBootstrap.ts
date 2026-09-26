// Inlined at the top of every page (JqiFrame). Signed-in members are served the member edition
// by the service worker at /sw.js (frontend/members/sw.js); a hard reload, or the first page after
// signing in in some browsers, bypasses it. If this browser holds a live session but no service
// worker controls the page, register it and reload once. The sessionStorage guard prevents a
// reload loop where service workers are unavailable.
export const memberBootstrap = `(function(){try{
var until=+localStorage.getItem("hafezi.signedInUntil");var sw=navigator.serviceWorker;
if(sw&&sw.controller){sessionStorage.removeItem("hafezi.swReload");return}
if(!until||until<Date.now()||!sw||sessionStorage.getItem("hafezi.swReload"))return;
sessionStorage.setItem("hafezi.swReload","1");document.documentElement.style.visibility="hidden";
sw.register("/sw.js",{scope:"/"}).then(function(){return sw.ready}).then(function(){location.reload()},function(){document.documentElement.style.visibility=""});
}catch(e){}})();`
