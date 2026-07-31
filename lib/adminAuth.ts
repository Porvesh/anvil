import { timingSafeEqual } from "node:crypto";

/** Constant-time bearer-token check for operator-only generation endpoints. */
export function isGenerationAdmin(req: Request): boolean {
  const expected = process.env.GENERATION_ADMIN_TOKEN;
  const header = req.headers.get("authorization");
  const provided = header?.startsWith("Bearer ") ? header.slice(7) : "";
  if (!expected || !provided) return false;
  const left = Buffer.from(expected);
  const right = Buffer.from(provided);
  return left.length === right.length && timingSafeEqual(left, right);
}
