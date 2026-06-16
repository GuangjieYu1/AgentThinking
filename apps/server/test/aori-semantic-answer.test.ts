import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Chunk, SearchResult } from "@agent-thinking/contracts";
import { AgentDatabase } from "../src/db.js";
import { buildAoriDocumentIndex } from "../src/services/aori.js";
import { FakeModelProvider } from "../src/services/models.js";
import { PulseEngine } from "../src/services/pulse.js";
import { VectorStore } from "../src/services/vector-store.js";
import { buildCsairSemanticChunks, loadCsairReportFixtureText } from "./helpers/csair-report-fixture.js";

const temporaryDirectories: string[] = [];

async function database(): Promise<AgentDatabase> {
  const dir = await mkdtemp(join(tmpdir(), "agent-thinking-aori-semantic-"));
  temporaryDirectories.push(dir);
  return new AgentDatabase(dir);
}

class ThrowingVectorStore extends VectorStore {
  override search(): SearchResult[] {
    throw new Error("legacy semantic chunk search should not run when semantic AORI answering is available");
  }
}

function saveSemanticFixture(db: AgentDatabase, input: {
  libraryId: string;
  versionId: string;
  documentId: string;
  documentName: string;
  chunks: Chunk[];
}): void {
  db.saveAoriDocumentIndex(buildAoriDocumentIndex({
    libraryId: input.libraryId,
    documentId: input.documentId,
    documentName: input.documentName,
    versionId: input.versionId,
    chunks: input.chunks,
    drafts: [{
      groupId: "fixture-group",
      draft: {
        understanding: {
          summary: "South Air annual report semantic fixture derived from the real TXT source.",
          centralQuestion: "What structured financial facts can be answered deterministically from the report text?",
          evidenceChunkIds: input.chunks.map((chunk) => chunk.id),
          evidenceStatus: "supported",
          closureStatus: "partial",
          classificationRationale: "Fixture uses deterministic semantic aspects built from real report text.",
          confidence: 0.9,
        },
        aspects: [],
        selfQuestions: [],
        reflectiveReport: { summary: "ok", completenessRisk: "none", warnings: [], truncationCount: 0 },
      },
    }],
    rationaleTrace: [],
    reflectiveReport: { summary: "ok", completenessRisk: "none", warnings: [], truncationCount: 0 },
    createdAt: "2026-01-01T00:00:00.000Z",
  }));
}

async function loadRealReportChunks(db: AgentDatabase, libraryName: string) {
  const library = db.createLibrary(libraryName);
  const version = db.createDocumentVersion(
    library.id,
    "csair-2024-report-first-21-pages.txt",
    "text/plain",
    "csair-report-fixture-hash",
    "csair-2024-report-first-21-pages.txt",
    { indexStrategy: "aspect_oriented_reflective" },
  ).version;
  const fixtureText = await loadCsairReportFixtureText();
  const chunks = db.replaceChunks(library.id, version.id, buildCsairSemanticChunks(fixtureText));
  saveSemanticFixture(db, {
    libraryId: library.id,
    versionId: version.id,
    documentId: version.documentId,
    documentName: "csair-2024-report-first-21-pages.txt",
    chunks,
  });
  return { library, version, chunks };
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("AORI semantic answering", () => {
  it("adds semantic table, metric, negative fact, and accounting event aspects from the real South Air report TXT", async () => {
    const db = await database();
    try {
      const { version } = await loadRealReportChunks(db, "South Air Semantic Index");

      const aori = db.getAoriDocumentIndex(version.id);
      expect(aori.available).toBe(true);
      if (!aori.available) throw new Error(aori.message);

      const aspectKinds = aori.aspects.map((aspect) => aspect.kind);
      expect(aspectKinds).toEqual(expect.arrayContaining(["table", "metric", "negative_fact", "event"]));

      const tablePurposes = aori.aspects
        .filter((aspect) => aspect.kind === "table")
        .map((aspect) => aspect.metadata?.tablePurpose);
      expect(tablePurposes).toEqual(expect.arrayContaining([
        "bond_balance",
        "fundraising_usage",
        "restricted_assets",
        "restricted_cash",
        "guarantee",
      ]));

      const negativeAspect = aori.aspects.find((aspect) => aspect.kind === "negative_fact");
      expect(negativeAspect?.items[0]?.metadata).toMatchObject({
        semanticKind: "negative_fact",
        certainty: "explicit",
      });

      const eventAspect = aori.aspects.find((aspect) =>
        aspect.kind === "event" && aspect.metadata?.eventCategory === "accounting_policy_change"
      );
      expect(eventAspect?.metadata).toMatchObject({
        semanticKind: "accounting_event",
        eventCategory: "accounting_policy_change",
      });

      const correctionAspect = aori.aspects.find((aspect) =>
        aspect.kind === "event" && aspect.metadata?.eventCategory === "accounting_error_correction"
      );
      expect(correctionAspect?.items.length).toBeGreaterThan(0);
    } finally {
      db.close();
    }
  });

  it("answers South Air report questions with deterministic semantic routing instead of model arithmetic", async () => {
    const db = await database();
    try {
      const { library } = await loadRealReportChunks(db, "South Air Semantic Answer");
      const engine = new PulseEngine(db, new ThrowingVectorStore(db), new FakeModelProvider(), { aoriAnswerMode: "demand" });

      const bondBalance = await engine.create(library.id, "存续债券余额合计是多少亿元？请列出计算过程。");
      expect(bondBalance.pulse.answer).toContain("83.6");
      expect(bondBalance.pulse.answer).toContain("15 + 5.6 + 10 + 21 + 24 + 8 = 83.6");
      expect(bondBalance.pulse.metrics?.modelCalls).toBe(0);
      expect((bondBalance.evidencePack?.diagnostics as Record<string, unknown>).deterministicAnswer).toBe(true);

      const fundraising = await engine.create(library.id, "报告期内存续含到期债务融资工具募集资金总额合计是多少亿元？");
      expect(fundraising.pulse.answer).toContain("210.4");
      expect(fundraising.pulse.answer).not.toContain("83.6");
      expect(fundraising.pulse.metrics?.modelCalls).toBe(0);

      const boundary = await engine.create(library.id, "“存续债券余额”和“募集资金总额”有什么区别？为什么不能混算？");
      expect(boundary.pulse.answer).toContain("存续债券详细信息");
      expect(boundary.pulse.answer).toContain("募集资金使用情况");
      expect(boundary.pulse.answer).toContain("不能混算");

      const negative = await engine.create(library.id, "报告期内是否存在募集资金用途变更？");
      expect(negative.pulse.answer).toContain("不存在");
      expect(negative.pulse.answer).toContain("不存在变更债券募集资金用途情况");
      expect(negative.pulse.metrics?.modelCalls).toBe(0);

      const event = await engine.create(library.id, "执行《企业会计准则解释第17号》对其他流动负债、应付债券分别有什么影响？");
      expect(event.pulse.answer).toContain("5510302936.57");
      expect(event.pulse.answer).toContain("5498187219.88");
      expect(event.pulse.answer).not.toContain("会计差错更正");

      const correction = await engine.create(library.id, "会计差错更正一共涉及哪些调整事项？");
      expect(correction.pulse.answer).toContain("长期股权投资");
      expect(correction.pulse.answer).toContain("永续债");
      expect(correction.pulse.answer).toContain("保理融资租");
      expect(correction.pulse.answer).toContain("商誉");
      expect(correction.pulse.metrics?.modelCalls).toBe(0);

      const restrictedAssets = await engine.create(library.id, "受限资产包括哪些类别？合计金额是多少？");
      expect(restrictedAssets.pulse.answer).toContain("货币资金");
      expect(restrictedAssets.pulse.answer).toContain("固定资产");
      expect(restrictedAssets.pulse.answer).toContain("733478.0133");

      const restrictedCash = await engine.create(library.id, "受限货币资金由哪些项目构成？分项是否加总闭合？");
      expect(restrictedCash.pulse.answer).toContain("存放中央银行法定准备金");
      expect(restrictedCash.pulse.answer).toContain("128304.9687");
      expect(restrictedCash.pulse.answer).toContain("闭合");

      const guarantee = await engine.create(library.id, "公司对飞行学员贷款提供了什么担保？担保总额、已发放贷款、实际履责金额分别是多少？");
      expect(guarantee.pulse.answer).toContain("69600");
      expect(guarantee.pulse.answer).toContain("6400");
      expect(guarantee.pulse.answer).toContain("7.4");
      expect(guarantee.pulse.metrics?.modelCalls).toBe(0);

      const notInvolved = await engine.create(library.id, "报告中有哪些事项明确写明“不涉及”？");
      expect(notInvolved.pulse.answer).toContain("不涉及");
      expect(notInvolved.pulse.metrics?.modelCalls).toBe(0);
    } finally {
      db.close();
    }
  });
});
