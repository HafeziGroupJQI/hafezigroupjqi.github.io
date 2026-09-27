// Tiny DOM helpers: h() builds elements without innerHTML, patchList() updates a keyed list in
// place so a 1 s tick or a reading touches only the nodes that changed.

export function h(tag, attrs = {}, ...children) {
  const node = document.createElement(tag)
  for (const [name, value] of Object.entries(attrs ?? {})) {
    if (value == null || value === false) continue
    if (name === "text") node.textContent = value
    else if (name === "class") node.className = value
    else if (name.startsWith("on") && typeof value === "function")
      node.addEventListener(name.slice(2).toLowerCase(), value)
    else node.setAttribute(name, value === true ? "" : String(value))
  }
  for (const child of children.flat()) {
    if (child == null || child === false) continue
    node.append(child instanceof Node ? child : document.createTextNode(String(child)))
  }
  return node
}

/**
 * The children h() would keep: drops null/false so `cond ? h(...) : null` can go straight into
 * replaceChildren()/append(), which would otherwise insert the text "null".
 */
export const present = (...children) =>
  children.flat().filter((child) => child != null && child !== false)

/** Set text only when it differs (avoids layout churn on the 1 s tick). */
export function setText(node, text) {
  if (node && node.textContent !== text) node.textContent = text
}

export function setClass(node, className) {
  if (node && node.className !== className) node.className = className
}

/**
 * Reconcile `parent`'s children with `items`: each child carries data-key=key(item); missing ones
 * are created, stale ones removed, survivors updated in place and re-ordered only when needed.
 */
export function patchList(parent, items, key, create, update) {
  const existing = new Map()
  for (const child of [...parent.children]) {
    if (child.dataset.key != null) existing.set(child.dataset.key, child)
    else child.remove()
  }
  let cursor = parent.firstElementChild
  for (const item of items) {
    const k = String(key(item))
    let node = existing.get(k)
    if (node) {
      existing.delete(k)
      update?.(node, item)
    } else {
      node = create(item)
      node.dataset.key = k
      update?.(node, item)
    }
    if (node !== cursor) parent.insertBefore(node, cursor)
    else cursor = cursor.nextElementSibling
  }
  for (const node of existing.values()) node.remove()
}

export const pill = (status, extra = "") =>
  h("span", { class: `status status-${status}${extra ? " " + extra : ""}`, text: status })

export const prefersReducedMotion = () =>
  typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches
