import path from "node:path"

const readOption = (args, name) => {
  const index = args.indexOf(name)
  if (index < 0) return undefined
  if (!args[index + 1] || args[index + 1].startsWith("--")) throw new Error(`${name} requires a value`)
  return args[index + 1]
}

export function parseBuildOptions(args, environment = process.env) {
  const mode = readOption(args, "--mode") ?? environment.SITE_MODE ?? "public"
  if (!new Set(["public", "internal"]).has(mode)) throw new Error(`unknown site mode: ${mode}`)
  const content = readOption(args, "--content") ?? environment.CONTENT_DIR ?? (mode === "internal" ? "../vault-private" : "content")
  const output = readOption(args, "--output") ?? "public"
  const baseUrl = readOption(args, "--base-url")
  let quartzBaseUrl
  if (baseUrl) {
    const url = new URL(baseUrl)
    if (url.protocol !== "https:" && url.hostname !== "localhost" && url.hostname !== "127.0.0.1")
      throw new Error("--base-url must use HTTPS outside localhost")
    quartzBaseUrl = `${url.host}${url.pathname}`.replace(/\/$/, "")
  }
  const consumed = new Set(["--mode", "--content", "--output", "--base-url"])
  const quartzArgs = []
  for (let index = 0; index < args.length; index++) {
    if (consumed.has(args[index])) {
      index++
      continue
    }
    quartzArgs.push(args[index])
  }
  quartzArgs.push("--output", output)
  return {
    mode,
    content,
    output: path.resolve(output),
    quartzArgs,
    quartzBaseUrl,
    config: mode === "internal" ? "quartz.internal.config.yaml" : "quartz.config.yaml",
  }
}
