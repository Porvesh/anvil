/**
 * Give the test suite its own database.
 *
 * The queue tests exercise real database semantics (claimJob is only meaningful
 * as what the *database* does under concurrency), so they can't be mocked — but
 * pointed at the dev database they were not isolated: `claimJob` takes the
 * oldest pending job in the whole table, while cleanup only removed rows for the
 * suite's own session id. Any unrelated pending job — one left claimed by a
 * killed worker, one enqueued by the running dev server — got picked up instead
 * of the test's, and the run failed.
 *
 * It was a nasty flake precisely because it self-cleared: the failing run
 * *claimed* the foreign job, so the next run passed and the evidence was gone.
 *
 * This creates a disposable SQLite file per run and pushes the schema into it.
 * `prisma/*.db` is already gitignored, and the file is recreated from scratch
 * every time, so no state survives between runs.
 */
import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import { resolve } from "node:path";

/** Must match `test.env.DATABASE_URL` in vitest.config.ts. */
const TEST_DB_URL = "file:./test.db";

/** Prisma resolves a relative `file:` URL against the schema's directory. */
const TEST_DB_PATH = resolve(process.cwd(), "prisma/test.db");

export default function setup() {
  for (const suffix of ["", "-journal", "-wal", "-shm"]) {
    rmSync(`${TEST_DB_PATH}${suffix}`, { force: true });
  }

  execFileSync("npx", ["prisma", "db", "push", "--skip-generate", "--accept-data-loss"], {
    env: { ...process.env, DATABASE_URL: TEST_DB_URL },
    stdio: "pipe",
  });
}
