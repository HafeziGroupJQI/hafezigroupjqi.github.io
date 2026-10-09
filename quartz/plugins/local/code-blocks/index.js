// Code blocks: the copy button and a member's choice to wrap long lines.
//
// The copy button replaces @quartz-community/syntax-highlighting's (its `clipboard` option is off in
// quartz.config.yaml), which failed in Safari: it read each block's text once, as the page loaded,
// with innerText. Safari gives an empty innerText for a block that is not being rendered, which is
// every block inside a closed <details> (a report's "Reproduce" blocks), so the button put nothing
// on the clipboard and said nothing. This one reads the block when the button is pressed, with
// textContent (the source exactly as written, whether the block is shown or not), copies it with a
// hidden textarea inside the click (accepted by every browser, Safari included) and then with the
// async Clipboard API, and if both are refused it selects the code and says to press ⌘C or Ctrl+C.
//
// Wrapping is in quartz/styles/custom.scss (the site's stylesheet, which the editor's preview also
// links): frontend/theme/ puts data-code-wrap="on" or "off" on <html> for a signed-in member
// (worker/src/prefs.ts `wrap`, on unless they turn it off in /settings). Without the attribute
// (signed out, the public site) code keeps the site's own sideways scrolling.
export const manifest = {
  name: "code-blocks",
  displayName: "Code blocks",
  description:
    "A copy button that works in every browser, and wrapping of long lines by preference",
  version: "1.0.0",
  category: "transformer",
}

const COPY_ICON =
  '<svg aria-hidden="true" height="16" viewBox="0 0 16 16" width="16"><path fill-rule="evenodd" d="M0 6.75C0 5.784.784 5 1.75 5h1.5a.75.75 0 010 1.5h-1.5a.25.25 0 00-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 00.25-.25v-1.5a.75.75 0 011.5 0v1.5A1.75 1.75 0 019.25 16h-7.5A1.75 1.75 0 010 14.25v-7.5z"></path><path fill-rule="evenodd" d="M5 1.75C5 .784 5.784 0 6.75 0h7.5C15.216 0 16 .784 16 1.75v7.5A1.75 1.75 0 0114.25 11h-7.5A1.75 1.75 0 015 9.25v-7.5zm1.75-.25a.25.25 0 00-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 00.25-.25v-7.5a.25.25 0 00-.25-.25h-7.5z"></path></svg>'
const DONE_ICON =
  '<svg aria-hidden="true" height="16" viewBox="0 0 16 16" width="16"><path fill-rule="evenodd" fill="rgb(63, 185, 80)" d="M13.78 4.22a.75.75 0 010 1.06l-7.25 7.25a.75.75 0 01-1.06 0L2.22 9.28a.75.75 0 011.06-1.06L6 10.94l6.72-6.72a.75.75 0 011.06 0z"></path></svg>'

/** The text a block's button copies: its data-clipboard source (a Mermaid diagram's) or its code as written. */
export function sourceOf(code) {
  const raw = code.getAttribute("data-clipboard")
  if (raw) {
    try {
      const parsed = JSON.parse(raw)
      if (typeof parsed === "string") return parsed
    } catch {
      /* not JSON: fall through to the text */
    }
  }
  return code.textContent || code.innerText || ""
}

// The script as it runs in the page: sourceOf is inlined from the function above.
export const script = `(function(){
var COPY=${JSON.stringify(COPY_ICON)},DONE=${JSON.stringify(DONE_ICON)};
var sourceOf=${sourceOf.toString()};
var mac=/Mac|iPhone|iPad/.test(navigator.platform||navigator.userAgent||"");
function viaTextarea(text){
  var area=document.createElement("textarea");
  area.value=text;area.setAttribute("readonly","");
  area.style.cssText="position:fixed;top:0;left:0;width:1px;height:1px;padding:0;border:0;opacity:0;";
  var selection=document.getSelection(),saved=selection&&selection.rangeCount?selection.getRangeAt(0):null;
  var focused=document.activeElement;
  document.body.appendChild(area);area.focus();area.select();
  try{area.setSelectionRange(0,text.length)}catch(e){}
  var ok=false;try{ok=document.execCommand("copy")}catch(e){ok=false}
  document.body.removeChild(area);
  if(focused&&focused.focus)try{focused.focus({preventScroll:true})}catch(e){}
  if(saved&&selection){selection.removeAllRanges();selection.addRange(saved)}
  return ok;
}
function selectCode(code){
  var range=document.createRange();range.selectNodeContents(code);
  var selection=document.getSelection();selection.removeAllRanges();selection.addRange(range);
}
function setState(button,state){
  button.dataset.state=state;
  if(state==="done"){button.innerHTML=DONE;button.setAttribute("aria-label","Copied");button.title="Copied"}
  else if(state==="manual"){button.innerHTML=COPY;var hint="Selected: press "+(mac?"\\u2318C":"Ctrl+C")+" to copy";button.setAttribute("aria-label",hint);button.title=hint}
  else{button.innerHTML=COPY;button.setAttribute("aria-label","Copy code");button.title="Copy code"}
}
function attach(){
  var blocks=document.getElementsByTagName("pre");
  for(var i=0;i<blocks.length;i++){
    var pre=blocks[i],code=pre.getElementsByTagName("code")[0];
    if(!code||pre.querySelector(":scope > .clipboard-button"))continue;
    (function(pre,code){
      var button=document.createElement("button");
      button.className="clipboard-button";button.type="button";setState(button,"idle");
      var timer=0;
      var onClick=function(){
        var text=sourceOf(code);
        clearTimeout(timer);
        var finish=function(state){setState(button,state);timer=setTimeout(function(){setState(button,"idle")},state==="manual"?6000:2000)};
        if(text&&viaTextarea(text)){finish("done");return}
        if(text&&navigator.clipboard&&navigator.clipboard.writeText){
          navigator.clipboard.writeText(text).then(function(){finish("done")},function(){selectCode(code);finish("manual")});
          return;
        }
        selectCode(code);finish("manual");
      };
      button.addEventListener("click",onClick);
      if(window.addCleanup)window.addCleanup(function(){button.removeEventListener("click",onClick);clearTimeout(timer)});
      pre.prepend(button);
    })(pre,code);
  }
}
document.addEventListener("nav",attach);document.addEventListener("render",attach);
})();`

export const css = `.clipboard-button {
  position: absolute;
  display: flex;
  right: 0;
  top: 0;
  z-index: 1;
  padding: 0.4rem;
  margin: 0.3rem;
  color: var(--gray);
  background-color: var(--light);
  border: 1px solid var(--lightgray);
  border-radius: 5px;
  opacity: 0;
  transition: opacity 0.2s;
  cursor: pointer;
}
.clipboard-button > svg {
  fill: var(--darkgray);
}
.clipboard-button:hover {
  border-color: var(--secondary);
}
pre:hover > .clipboard-button,
pre:focus-within > .clipboard-button,
.clipboard-button:focus-visible,
.clipboard-button[data-state="done"],
.clipboard-button[data-state="manual"] {
  opacity: 1;
}
.clipboard-button[data-state="manual"] {
  border-color: var(--secondary);
}
@media (hover: none) {
  pre > .clipboard-button {
    opacity: 1;
  }
}
@media print {
  .clipboard-button {
    display: none;
  }
}
`

export default () => ({
  name: "CodeBlocks",
  // Quartz loads a transformer only if it has one of these (quartz/plugins/loader/config-loader.ts
  // validateCategory); this one changes no page, it only adds its script and styles.
  htmlPlugins: () => [],
  externalResources() {
    return {
      js: [{ script, loadTime: "afterDOMReady", contentType: "inline" }],
      css: [{ content: css, inline: true }],
    }
  },
})
