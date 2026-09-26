// Bindings the tests see; production code uses the Env interface in src/env.ts directly.
interface TestEnv {
  ASSETS: Fetcher
  DB: D1Database
  DEVICE_HUB: DurableObjectNamespace
  ARTIFACTS: R2Bucket
  TEST_MIGRATIONS: D1Migration[]
}
declare namespace Cloudflare {
  interface Env extends TestEnv {}
}
