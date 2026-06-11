import { describe, expect, it, vi } from "vitest";
import type { ModelProvider } from "../src/services/models.js";
import { getConfig } from "../src/config.js";
import { parseDocument } from "../src/services/parser.js";

let pageText = "";
vi.mock("pdfjs-dist/legacy/build/pdf.mjs", () => ({
  getDocument: () => ({
    promise: Promise.resolve({
      numPages: 1,
      getPage: async () => ({
        getTextContent: async () => ({ items: [{ str: pageText }] }),
        getViewport: () => ({ width: 20, height: 20 }),
        render: () => ({ promise: Promise.resolve() }),
      }),
      destroy: async () => undefined,
    }),
  }),
}));

const recognize = vi.fn(async () => ({ data: { text: "本地 OCR 内容" } }));
vi.mock("tesseract.js", () => ({
  createWorker: async () => ({ recognize, terminate: async () => undefined }),
}));

function model(): ModelProvider {
  return {
    name: "test",
    configured: true,
    reviewBenchmarkAnswer: async () => ({
      verdict: "aligned",
      summary: "test",
      expectedAnswerSummary: "test",
      actualAnswerSummary: "test",
      matchedExpected: [],
      missingExpected: [],
      unexpectedAnswerPoints: [],
      differences: [],
      sourceComparisons: [],
      improvementActions: [],
    }),
    embed: async () => [],
    extract: async () => ({ nodes: [], relations: [] }),
    extractAoriDocument: async () => ({
      understanding: { summary: "ok", centralQuestion: "ok", evidenceChunkIds: [] },
      aspects: [],
      selfQuestions: [],
      reflectiveReport: { summary: "ok", completenessRisk: "none", warnings: [], truncationCount: 0 },
    }),
    precheckStatement: async () => ({ status: "supported", reason: "ok", suggestions: [] }),
    reconstructMapping: async () => "ok",
    auditMapping: async () => ({ status: "clean", summary: "ok", findings: [] }),
    rebuildGraphFromMappingAudit: async () => ({ nodes: [], relations: [], themes: [] }),
    analyzePulseQuestion: async () => ({
      questionType: "normal",
      requiresExhaustiveEvidence: false,
      requiresStructuredEvidence: true,
      requiresNumericalReconciliation: false,
      requiresSourceQuotes: true,
      requiresTimelineCompleteness: false,
      requiresEntityCoverage: false,
      allowedPartialAnswer: true,
      answerMustExposeGaps: true,
      evidenceTargets: [],
      keyEntities: [],
      expectedEvidenceTypes: ["quote"],
      riskLevel: "medium",
      reasoning: "test fallback",
    }),
    classifyQuestionTask: async ({ question }) => ({
      question,
      taskType: "summary",
      targetSubjects: [],
      targetObjects: [],
      expectedAnswerShape: "summary",
      requiredEvidenceRoles: ["direct_fact"],
      exclusionRoles: ["background_fact"],
      ambiguityNotes: [],
      needsDedupe: false,
      needsReconciliation: false,
      needsPerspectiveOrAuthority: false,
      mustExposeGaps: true,
      rationale: "test",
      confidence: 0.5,
    }),
    planRetrievalTasks: async ({ question }) => [{
      id: "rt-test",
      purpose: "find_direct_facts",
      query: question,
      targetRoles: ["direct_fact"],
      requiredContext: "retrieval_unit",
      expectedOutput: "evidence_rows",
      rationale: "test",
    }],
    planPulseEvidence: async () => ({
      objective: "test",
      steps: [],
      stopCondition: "test",
      expectedEvidenceShape: "test",
      maxIterations: 1,
    }),
    extractPulseEvidenceRows: async () => [],
    reviewEvidenceRowClassifications: async () => [],
    judgePulseEvidenceSufficiency: async () => ({
      sufficient: false,
      status: "partial_answer_only",
      gaps: [],
      reasoning: "test",
    }),
    synthesizePulseAnswer: async () => ({ answer: "ok", summary: "ok" }),
    rewritePulseAnswer: async ({ draft }) => draft,
    answerPulse: async () => ({ answer: "ok", summary: "ok" }),
    selectPulseNavigation: async (_question, _step, candidates) => ({
      selectedIds: candidates.slice(0, 1).map((candidate) => candidate.id),
      observation: "ok",
      rationale: "ok",
    }),
    planDemandAnswer: async ({ question }) => ({
      answerGoal: question,
      targetScope: { reason: "test" },
      requiredRecords: [{
        recordName: "test_records",
        source: "aspect_items",
        fields: [{ name: "answer_value", description: "test", required: true }],
        coverage: "some",
      }],
      answerPolicy: {
        mustCiteSourceChunks: true,
        allowPartialAnswer: true,
        exposeUncertainty: true,
        whatCountsAsInsufficient: "test",
      },
      reason: "test",
      confidence: 0.5,
    }),
    extractDemandEvidenceRecord: async (input) => ({
      recordId: `record-${input.sourceItem.id}`,
      recordName: input.recordSpec.recordName,
      sourceItemId: input.sourceItem.id,
      fields: {},
      evidenceChunkIds: input.chunks.map((chunk) => chunk.id),
    }),
    synthesizeDemandAnswer: async () => ({ answer: "ok", summary: "ok" }),
    routeAoriSkill: async () => ({
      skill: "normal_traversal",
      targetAspects: [],
      requiredFields: [],
      operationPlan: "test",
      confidence: 0.5,
      reason: "test",
      ambiguity: [],
    }),
    extractFacetFactRow: async (input) => ({
      rowId: `row-${input.item.id}`,
      itemId: input.item.id,
      itemTitle: input.item.title,
      itemSummary: input.item.summary,
      fields: {},
      evidenceChunkIds: input.chunks.map((chunk) => chunk.id),
    }),
    planFacetCountOperation: async () => ({
      countTarget: "unknown",
      filters: [],
      dedupeBy: [],
      countPolicy: "test",
    }),
    evaluateTimeFilter: async () => ({ match: "include", reason: "test" }),
    dedupeFacetCountRows: async () => ({
      countPolicy: "test",
      included: [],
      excluded: [],
      uncertain: [],
      finalCount: 0,
    }),
    synthesizeFacetCountAnswer: async () => ({ answer: "ok", summary: "ok" }),
    decideAoriBfsExpansion: async (input) => ({
      decisions: input.currentLayer.map((node) => ({
        nodeId: node.nodeId,
        decision: "need",
        answerRelevant: true,
        shouldCollectChunks: node.chunkCount > 0,
        reason: "test",
      })),
      stopTraversal: false,
    }),
    chooseAoriDfsNext: async (input) => ({
      selectedNextNodeIds: input.candidates.slice(0, 1).map((candidate) => candidate.nodeId),
      recordCurrentChunks: input.currentNode.chunkCount > 0,
      backtrack: input.candidates.length === 0,
      stopTraversal: false,
      reason: "test",
    }),
    summarizeChunkForQuestion: async (input) => ({
      chunkId: input.chunkId,
      relevant: true,
      shortSummary: input.chunkText.slice(0, 80),
      supportedFacts: [input.chunkText.slice(0, 80)],
      unsupportedClaims: [],
      keyQuotes: [input.chunkText.slice(0, 40)],
      confidence: 0.8,
      usage: "answer_core",
    }),
    synthesizeAnswerFromChunks: async () => ({ answer: "ok", summary: "ok" }),
    stream: async function* () { yield { type: "content", text: "ok" }; },
    test: async () => ({ ok: true, provider: "test", message: "ok" }),
  };
}

describe("PDF parsing and OCR", () => {
  const config = getConfig({
    dataDir: "./data/test",
    ocrCacheDir: "./data/test/ocr",
    provider: "fake",
    ocrProvider: "aliyun",
  });

  it("uses embedded PDF text without OCR when text is available", async () => {
    pageText = "This document includes enough embedded readable PDF text.";
    const onOcrRequired = vi.fn();
    const sections = await parseDocument({
      buffer: Buffer.from("pdf"),
      mediaType: "application/pdf",
      ocrMode: "local",
      config,
      model: model(),
      onOcrRequired,
    });
    expect(sections[0]?.text).toContain("embedded readable");
    expect(onOcrRequired).not.toHaveBeenCalled();
  });

  it("supports both local and cloud OCR for image-only pages", async () => {
    pageText = "";
    const local = await parseDocument({
      buffer: Buffer.from("pdf"),
      mediaType: "application/pdf",
      ocrMode: "local",
      config,
      model: model(),
      onOcrRequired: () => undefined,
    });
    const cloud = await parseDocument({
      buffer: Buffer.from("pdf"),
      mediaType: "application/pdf",
      ocrMode: "cloud",
      config,
      model: model(),
      cloudOcr: async () => "云端 OCR 内容",
      onOcrRequired: () => undefined,
    });
    expect(local[0]?.text).toBe("本地 OCR 内容");
    expect(cloud[0]?.text).toBe("云端 OCR 内容");
    expect(recognize).toHaveBeenCalled();
  });

  it("extracts text from an imported DOCX document", async () => {
    const sections = await parseDocument({
      buffer: docxBuffer("Word 中的研究结论"),
      mediaType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      ocrMode: "local",
      config,
      model: model(),
      onOcrRequired: () => undefined,
    });
    expect(sections[0]?.text).toContain("Word 中的研究结论");
  });

  it("extracts text from a Confluence MHTML export saved with a DOC extension", async () => {
    const sections = await parseDocument({
      buffer: Buffer.from([
        "Message-ID: <export@example.test>",
        "Subject: Exported From Confluence",
        "MIME-Version: 1.0",
        'Content-Type: multipart/related; boundary="part"',
        "",
        "--part",
        "Content-Type: text/html; charset=UTF-8",
        "Content-Transfer-Encoding: quoted-printable",
        "",
        "<html><body><h1>=E8=88=AA=E7=8F=AD=E6=95=B0=E6=8D=AE</h1><p>=E5=AE=9E=E6=97=B6=E6=8E=A8=E9=80=81</p></body></html>",
        "--part--",
        "",
      ].join("\r\n")),
      mediaType: "application/msword",
      ocrMode: "local",
      config,
      model: model(),
      onOcrRequired: () => undefined,
    });
    expect(sections[0]?.text).toContain("航班数据");
    expect(sections[0]?.text).toContain("实时推送");
  });
});

function docxBuffer(text: string): Buffer {
  const entries = [
    {
      name: "[Content_Types].xml",
      content: Buffer.from(
        '<?xml version="1.0" encoding="UTF-8"?>' +
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
        "</Types>",
      ),
    },
    {
      name: "word/document.xml",
      content: Buffer.from(
        '<?xml version="1.0" encoding="UTF-8"?>' +
        '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
        `<w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`,
      ),
    },
  ];
  const files: Buffer[] = [];
  const directory: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name);
    const checksum = crc32(entry.content);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(entry.content.length, 18);
    local.writeUInt32LE(entry.content.length, 22);
    local.writeUInt16LE(name.length, 26);
    files.push(local, name, entry.content);
    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(20, 6);
    header.writeUInt32LE(checksum, 16);
    header.writeUInt32LE(entry.content.length, 20);
    header.writeUInt32LE(entry.content.length, 24);
    header.writeUInt16LE(name.length, 28);
    header.writeUInt32LE(offset, 42);
    directory.push(header, name);
    offset += local.length + name.length + entry.content.length;
  }
  const directoryContent = Buffer.concat(directory);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directoryContent.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...files, directoryContent, end]);
}

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc & 1) ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
