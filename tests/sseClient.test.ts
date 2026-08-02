import { afterEach, describe, expect, it, vi } from "vitest";
import { streamSSE } from "../lib/sseClient";

afterEach(() => vi.unstubAllGlobals());

describe("streamSSE", () => {
  it("consumes deltas and reports provider errors without losing later frames", async () => {
    const body = [
      'data: {"type":"delta","text":"hello "}\n\n',
      "data: not-json\n\n",
      'data: {"type":"error","message":"busy"}\n\n',
      'data: {"type":"delta","text":"world"}\n\n',
    ].join("");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(body, { status: 200 })));
    const deltas: string[] = [];
    const errors: string[] = [];

    await streamSSE("/api/hint", {}, { onDelta: (text) => deltas.push(text), onError: (text) => errors.push(text) });

    expect(deltas.join("")).toBe("hello world");
    expect(errors).toEqual(["busy"]);
  });

  it("surfaces the route's actionable JSON error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        Response.json({ error: "The AI service is busy right now. Your work is safe; try again shortly." }, { status: 503 }),
      ),
    );

    await expect(streamSSE("/api/hint", {}, { onDelta: () => {} })).rejects.toThrow("work is safe");
  });

  it("passes an AbortSignal to fetch", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('data: {"type":"done"}\n\n'));
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();

    await streamSSE("/api/hint", {}, { onDelta: () => {} }, { signal: controller.signal });

    expect(fetchMock.mock.calls[0][1].signal).toBe(controller.signal);
  });

  it("delivers generation phases and the completed problem payload", async () => {
    const body = [
      'data: {"type":"phase","phase":"writing","note":"Writing the problem"}\n\n',
      'data: {"type":"done","problemId":"problem-123"}\n\n',
    ].join("");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(body, { status: 200 })));
    const phases: string[] = [];
    let problemId: unknown;

    await streamSSE("/api/generate/tailored", {}, {
      onDelta: () => {},
      onPhase: (phase, note) => phases.push(`${phase}:${note}`),
      onDone: (payload) => {
        problemId = payload.problemId;
      },
    });

    expect(phases).toEqual(["writing:Writing the problem"]);
    expect(problemId).toBe("problem-123");
  });
});
