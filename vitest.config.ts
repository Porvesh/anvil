import { defineConfig } from "vitest/config";

export default defineConfig({
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
  },
});
