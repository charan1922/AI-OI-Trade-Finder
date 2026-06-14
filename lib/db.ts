import path from 'node:path';
import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3';
import { PrismaClient } from '@prisma/client';

const isVercel = process.env.VERCEL === '1';
const dbPath = isVercel ? '/tmp/project-r.db' : path.join(process.cwd(), 'data', 'project-r.db');

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

export function getPrisma(): PrismaClient {
  if (!globalForPrisma.prisma) {
    const adapter = new PrismaBetterSqlite3({ url: `file:${dbPath}` });
    globalForPrisma.prisma = new PrismaClient({ adapter });
  }
  return globalForPrisma.prisma;
}

// Lazy proxy — Prisma only connects on first actual DB call, not at import time
export const prisma = new Proxy({} as PrismaClient, {
  get(_target, prop) {
    return Reflect.get(getPrisma(), prop);
  },
});
