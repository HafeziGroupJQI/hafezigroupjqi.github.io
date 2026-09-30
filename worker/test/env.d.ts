// Bindings the tests see; production code uses the Env interface in src/env.ts directly.
interface TestEnv {
  ASSETS: Fetcher
  DB: D1Database
  DEVICE_HUB: DurableObjectNamespace
  COMPUTE_RELAY: DurableObjectNamespace
  SESSION_SECRET: string
  ARTIFACTS: R2Bucket
  TEST_MIGRATIONS: D1Migration[]
}
declare namespace Cloudflare {
  interface Env extends TestEnv {}
}
// Text fixtures imported as strings (Vite's ?raw), e.g. the deploy's import SQL.
declare module "*?raw" {
  const text: string
  export default text
}
