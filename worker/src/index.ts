import { createHandler } from "./app"
// Written by `npm run build:members` in the website root (tools/docs-manifest.mjs).
import manifest from "../generated/docs-manifest.json"

// The Durable Object class must be exported from the entry module for Wrangler to bind it.
export { DeviceHub } from "./devices/hub"

export default createHandler(manifest)
