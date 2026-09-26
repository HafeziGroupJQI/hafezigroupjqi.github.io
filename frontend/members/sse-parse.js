// A small Server-Sent Events parser for fetch() streams (EventSource cannot send a bearer token).
// feed() takes decoded text in arbitrary chunks and calls onEvent(name, data) per complete event.

export function createSseParser(onEvent) {
  let buffer = ""
  let name = ""
  let data = []
  const dispatch = () => {
    if (data.length) onEvent(name || "message", data.join("\n"))
    name = ""
    data = []
  }
  return {
    feed(text) {
      buffer += text
      let index
      while ((index = buffer.search(/\r\n|\r|\n/)) >= 0) {
        const line = buffer.slice(0, index)
        buffer = buffer.slice(index + (buffer[index] === "\r" && buffer[index + 1] === "\n" ? 2 : 1))
        if (line === "") dispatch()
        else if (line.startsWith(":")) continue
        else {
          const colon = line.indexOf(":")
          const field = colon < 0 ? line : line.slice(0, colon)
          let value = colon < 0 ? "" : line.slice(colon + 1)
          if (value.startsWith(" ")) value = value.slice(1)
          if (field === "event") name = value
          else if (field === "data") data.push(value)
        }
      }
    },
  }
}
