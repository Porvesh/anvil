/**
 * Who owns a row.
 *
 * Anvil has two kinds of owner and every read and write path has to agree on
 * how they relate, so the rule lives here once:
 *
 * - **Anonymous**: a client-generated `sessionId` in localStorage.
 * - **Signed in**: a `userId` from the account cookie, which also keeps sending
 *   its browser's `sessionId` so work stays attributable if the account is
 *   later deleted.
 *
 * Reads by an anonymous caller deliberately exclude rows that already belong to
 * an account (`userId: null`). Without that clause, signing out on a shared
 * machine would still show the account's history to whoever used the browser
 * next — the localStorage id is unchanged by signing out, and after a merge it
 * points at rows the account now owns.
 */
import type { NextRequest } from "next/server";
import { readAuthSession } from "./session";

export interface Owner {
  userId: string | null;
  /** The browser's anonymous id. Always recorded, signed in or not. */
  sessionId: string;
  email: string | null;
}

export function resolveOwner(req: NextRequest, sessionId: string): Owner {
  const session = readAuthSession(req);
  return { userId: session?.userId ?? null, sessionId, email: session?.email ?? null };
}

/** Prisma filter selecting exactly the rows this owner may read. */
export function ownerFilter(owner: Owner): { userId: string } | { sessionId: string; userId: null } {
  return owner.userId ? { userId: owner.userId } : { sessionId: owner.sessionId, userId: null };
}

/** Columns to stamp on a row this owner is creating. */
export function ownerColumns(owner: Owner): { sessionId: string; userId: string | null } {
  return { sessionId: owner.sessionId, userId: owner.userId };
}
