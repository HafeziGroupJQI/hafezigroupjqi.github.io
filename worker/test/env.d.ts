// Bindings the tests see; production code uses the Env interface in src/env.ts directly.
interface TestEnv {
  ASSETS: Fetcher
  DB: D1Database
  TEST_MIGRATIONS: D1Migration[]
}
declare namespace Cloudflare {
  interface Env extends TestEnv {}
}
