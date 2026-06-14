import path from 'node:path';
import { defineConfig } from 'prisma/config';

const isVercel = process.env.VERCEL === '1';

// Default: SQLite in data/ dir (zero setup)
// Override: set DATABASE_URL for PostgreSQL
const defaultUrl = isVercel ? 'file:/tmp/project-r.db' : `file:${path.join(process.cwd(), 'data', 'project-r.db')}`;

export default defineConfig({
  datasource: {
    url: process.env.DATABASE_URL || defaultUrl,
  },
});
