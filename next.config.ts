import path from "node:path"
import { fileURLToPath } from "node:url"
import type { NextConfig } from "next"

// Pin the workspace root to THIS project (the parent dir also has a lockfile,
// which Next would otherwise infer as the root).
const projectRoot = path.dirname(fileURLToPath(import.meta.url))

const nextConfig: NextConfig = {
  // The app is often opened as http://127.0.0.1:5001 (e.g. the Fyers app's
  // redirect URI) — allow it for dev HMR, which otherwise treats anything
  // other than localhost as cross-origin and blocks it.
  allowedDevOrigins: ["127.0.0.1"],
  // Native modules used by the server-side data layer (DuckDB Parquet store +
  // Prisma better-sqlite3 adapter) must not be bundled — keep them external so
  // they're require()'d from node_modules at runtime. Turbopack honors this.
  serverExternalPackages: ["@prisma/client", ".prisma/client", "better-sqlite3", "fyers-api-v3"],
  turbopack: {
    root: projectRoot,
  },
}

export default nextConfig
