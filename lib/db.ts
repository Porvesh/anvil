import { PrismaClient } from "@prisma/client";

/**
 * Prisma client singleton. Next.js dev mode hot-reloads modules, which would
 * otherwise spawn a new PrismaClient (and a new connection pool) on every edit
 * until the DB refuses connections. Caching on `globalThis` keeps one instance.
 */
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === "development" ? ["error", "warn"] : ["error"],
  });

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;
