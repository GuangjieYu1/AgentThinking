import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ModelUsageMetricsCollector, PulseStreamEvent } from "@agent-thinking/contracts";
import { AgentDatabase } from "../src/db.js";
import { FakeModelProvider } from "../src/services/models.js";
import { PulseEngine } from "../src/services/pulse.js";
import { VectorStore } from "../src/services/vector-store.js";

const temporaryDirectories: string[] = [];

async function database(): Promise<AgentDatabase> {
  const dir = await mkdtemp(join(tmpdir(), "agent-thinking-pulse-"));
  temporaryDirectories.push(dir);
  return new AgentDatabase(dir);
}

function seedPulseGraph(db: AgentDatabase) {
  const library = db.createLibrary("Pulse paths");
  const version = db.createDocumentVersion(library.id, "pulse.txt", "text/plain", "pulse", "pulse").version;
  const chunks = db.replaceChunks(library.id, version.id, [
    { ordinal: 0, headingPath: null, pageNumber: null, startChar: 0, endChar: 11, text: "alpha topic" },
    { ordinal: 1, headingPath: null, pageNumber: null, startChar: 12, endChar: 23, text: "bridge node" },
    { ordinal: 2, headingPath: null, pageNumber: null, startChar: 24, endChar: 34, text: "beta topic" },
    { ordinal: 3, headingPath: null, pageNumber: null, startChar: 35, endChar: 49, text: "loose neighbor" },
  ]);
  db.saveExtraction(library.id, {
    nodes: [
      { key: "alpha", kind: "concept", title: "Alpha", summary: "alpha topic", evidenceChunkIds: [chunks[0]!.id], aspects: [] },
      { key: "bridge", kind: "concept", title: "Bridge", summary: "bridge node", evidenceChunkIds: [chunks[1]!.id], aspects: [] },
      { key: "beta", kind: "claim", title: "Beta", summary: "beta topic", evidenceChunkIds: [chunks[2]!.id], aspects: [] },
      { key: "loose", kind: "concept", title: "Loose", summary: "loose neighbor", evidenceChunkIds: [chunks[3]!.id], aspects: [] },
    ],
    relations: [
      { sourceKey: "alpha", targetKey: "bridge", type: "related_to", reason: "alpha to bridge", confidence: 0.8, evidenceChunkIds: [] },
      { sourceKey: "bridge", targetKey: "beta", type: "related_to", reason: "bridge to beta", confidence: 0.8, evidenceChunkIds: [] },
      { sourceKey: "alpha", targetKey: "loose", type: "related_to", reason: "incidental neighbor", confidence: 0.8, evidenceChunkIds: [] },
    ],
  }, version.id);
  return { library };
}

class InstrumentedFakeModelProvider extends FakeModelProvider {
  private usageCollector: ModelUsageMetricsCollector | undefined;

  override setUsageMetricsCollector(collector: ModelUsageMetricsCollector | undefined): void {
    this.usageCollector = collector;
  }

  override async synthesizePulseAnswer(input: Parameters<FakeModelProvider["synthesizePulseAnswer"]>[0]) {
    this.usageCollector?.onModelUsage({
      model: "fake-model",
      path: "/pulse/synthesize",
      promptTokens: 120,
      completionTokens: 40,
      totalTokens: 160,
      promptCacheHitTokens: 80,
      promptCacheMissTokens: 40,
    });
    return super.synthesizePulseAnswer(input);
  }
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("pulse activation", () => {
  it("keeps direct evidence and bridge paths without lighting unrelated one-hop neighbors", async () => {
    const db = await database();
    const { library } = seedPulseGraph(db);

    const pulse = await new PulseEngine(db, new VectorStore(db), new FakeModelProvider()).create(library.id, "alpha beta");
    const labels = pulse.hits.map((hit) => hit.label);
    expect(labels).toEqual(expect.arrayContaining(["Alpha", "Beta", "Bridge"]));
    expect(labels).not.toContain("Loose");
    expect(pulse.hits.some((hit) => hit.pathRole === "expanded")).toBe(false);
    expect(pulse.hits.filter((hit) => hit.targetType === "relation").map((hit) => hit.label).join("\n")).not.toContain("Loose");
    db.close();
  });

  it("records progressive input mode and visible navigation explanations", async () => {
    const db = await database();
    const { library } = seedPulseGraph(db);
    const streamedEvents: string[] = [];

    const pulse = await new PulseEngine(db, new VectorStore(db), new FakeModelProvider())
      .create(library.id, "alpha beta", "progressive", (event) => {
        streamedEvents.push(event.type);
      });

    expect(pulse.pulse.inputMode).toBe("progressive");
    expect(pulse.hits.length).toBeGreaterThan(0);
    expect(pulse.hits.every((hit) => hit.stepIndex !== null)).toBe(true);
    expect(pulse.hits.some((hit) => hit.observation?.length)).toBe(true);
    expect(pulse.hits.some((hit) => hit.rationale?.length)).toBe(true);
    expect(pulse.hits.map((hit) => hit.label)).toContain("Bridge");
    expect(streamedEvents).toEqual(expect.arrayContaining(["candidates", "decision", "backtrack"]));
    db.close();
  });

  it("emits per-call model usage events and stores them in pulse metrics", async () => {
    const db = await database();
    const { library } = seedPulseGraph(db);
    const streamedEvents: PulseStreamEvent[] = [];

    const pulse = await new PulseEngine(db, new VectorStore(db), new InstrumentedFakeModelProvider())
      .create(library.id, "alpha beta", "progressive", (event) => {
        streamedEvents.push(event);
      });

    const usageEvent = streamedEvents.find((event): event is Extract<PulseStreamEvent, { type: "model_usage" }> => event.type === "model_usage");
    expect(usageEvent?.message).toContain("fake-model /pulse/synthesize");
    expect(usageEvent?.payload).toMatchObject({
      sequence: 1,
      model: "fake-model",
      path: "/pulse/synthesize",
      totalTokens: 160,
      promptCacheHitTokens: 80,
      promptCacheMissTokens: 40,
    });
    expect(pulse.pulse.metrics?.modelCalls).toBe(1);
    expect(pulse.pulse.metrics?.promptCacheHitRate).toBeCloseTo(80 / 120);
    expect(pulse.pulse.metrics?.modelUsageCalls).toHaveLength(1);
    expect(pulse.pulse.metrics?.modelUsageCalls?.[0]).toMatchObject({
      sequence: 1,
      model: "fake-model",
      path: "/pulse/synthesize",
      totalTokens: 160,
      promptCacheHitRate: 80 / 120,
    });
    db.close();
  });
});
