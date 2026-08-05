import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  // Route handlers import through the `@/` alias that tsconfig defines, so the
  // tests that drive them in-process need the same mapping.
  resolve: {
    alias: { "@": fileURLToPath(new URL(".", import.meta.url)) },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    /**
     * The DB-backed tests get their own disposable SQLite file, created by the
     * global setup. Run against the dev database they were not isolated — an
     * unrelated pending job broke them, then the failing run consumed it and the
     * evidence vanished. See tests/setup/testDb.ts.
     */
    env: { DATABASE_URL: "file:./test.db" },
    globalSetup: ["./tests/setup/testDb.ts"],
    /**
     * One database file, so one file at a time.
     *
     * Several suites now exercise real database semantics against the same
     * SQLite file. Run in parallel they delete each other's fixtures mid-test —
     * which surfaces as a foreign-key violation or a token that vanished
     * between being issued and redeemed, neither of which says anything about
     * the code under test. The whole suite runs in about a second; isolation is
     * worth more than the parallelism here.
     */
    fileParallelism: false,
  },
});
