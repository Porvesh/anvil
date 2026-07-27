import { describe, expect, it } from "vitest";
import { DRAFT_MAX_AGE_MS, clearSolveDraft, parseSolveDraft, readSolveDraft, writeSolveDraft } from "../lib/solveDraft";

class MemoryStorage implements Storage {
  private values = new Map<string, string>();
  get length() {
    return this.values.size;
  }
  clear() {
    this.values.clear();
  }
  getItem(key: string) {
    return this.values.get(key) ?? null;
  }
  key(index: number) {
    return [...this.values.keys()][index] ?? null;
  }
  removeItem(key: string) {
    this.values.delete(key);
  }
  setItem(key: string, value: string) {
    this.values.set(key, value);
  }
}

describe("solve draft recovery", () => {
  it("round-trips a multi-file debug draft", () => {
    const storage = new MemoryStorage();
    expect(
      writeSolveDraft(
        {
          problemId: "p1",
          mode: "debug",
          files: [{ path: "service.py", content: "return fixed" }],
          activePath: "service.py",
          runs: [{ passed: 2, failed: 0, output: "", at: 12 }],
          runResult: { ok: true, output: "", tests: [{ name: "works", passed: true }] },
          chat: [{ role: "user", content: "check my reasoning" }],
        },
        storage,
      ),
    ).toBe(true);

    const draft = readSolveDraft("p1", "debug", storage);
    expect(draft?.mode).toBe("debug");
    expect(draft?.mode === "debug" && draft.files[0].content).toBe("return fixed");
    expect(draft?.chat).toHaveLength(1);
  });

  it("rejects stale, mismatched, and malformed drafts", () => {
    const base = {
      version: 1,
      problemId: "p1",
      mode: "review",
      updatedAt: 1_000,
      chat: [],
      comments: [{ line: 4, body: "race" }],
    };
    expect(parseSolveDraft(base, "p1", "review", 1_000)).toBeTruthy();
    expect(parseSolveDraft(base, "p2", "review", 1_000)).toBeNull();
    expect(parseSolveDraft(base, "p1", "debug", 1_000)).toBeNull();
    expect(parseSolveDraft(base, "p1", "review", 1_000 + DRAFT_MAX_AGE_MS + 1)).toBeNull();
    expect(parseSolveDraft({ ...base, comments: [{ line: "four" }] }, "p1", "review", 1_000)).toBeNull();
  });

  it("removes a saved draft after successful completion", () => {
    const storage = new MemoryStorage();
    writeSolveDraft({ problemId: "p1", mode: "design", code: "# plan", chat: [] }, storage);
    clearSolveDraft("p1", storage);
    expect(readSolveDraft("p1", "design", storage)).toBeNull();
  });
});
