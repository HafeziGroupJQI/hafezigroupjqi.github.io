import { createHandler } from "./app"
// Written by `npm run build:members` in the website root (tools/docs-manifest.mjs).
import manifest from "../generated/docs-manifest.json"

export default createHandler(manifest)
