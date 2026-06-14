import path from "node:path"
import { fileURLToPath } from "node:url"
import type { NextConfig } from "next"

// Pin the workspace root to THIS project (the parent dir also has a lockfile,
// which Next would otherwise infer as the root).
const projectRoot = path.dirname(fileURLToPath(import.meta.url))

const nextConfig: NextConfig = {
  // Native modules used by the server-side data layer (DuckDB Parquet store +
  // Prisma better-sqlite3 adapter) must not be bundled — keep them external so
  // they're require()'d from node_modules at runtime. Turbopack honors this.
  serverExternalPackages: ["@duckdb/node-api", "@prisma/client", ".prisma/client", "better-sqlite3"],
  turbopack: {
    root: projectRoot,
  },
}

export default nextConfig
