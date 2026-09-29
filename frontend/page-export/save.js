// Hand the browser a file made on the page to save: {name, type, text} (text: a string or a Blob).
export function save({ name, type, text }) {
  const url = URL.createObjectURL(text instanceof Blob ? text : new Blob([text], { type }))
  const anchor = document.createElement("a")
  anchor.href = url
  anchor.download = name
  anchor.hidden = true
  document.body.append(anchor)
  anchor.click()
  anchor.remove()
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
}
