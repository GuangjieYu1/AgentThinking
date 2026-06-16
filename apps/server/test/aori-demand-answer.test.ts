import { describe, expect, it } from "vitest";
import type { Chunk, EvidenceRecord } from "@agent-thinking/contracts";
import {
  limitDemandSourceItemsByCoverage,
  type DemandSourceItem,
  validateDemandEvidenceRecordCitations,
} from "../src/services/aori-demand-answer.js";

describe("limitDemandSourceItemsByCoverage", () => {
  it("narrows single coverage to a uniquely matching source item", () => {
    const items: DemandSourceItem[] = [
      {
        id: "railway",
        title: "广茂铁路",
        summary: "广茂铁路主线全长364.6公里。",
        chunkIds: ["chunk-1"],
      },
      {
        id: "opera",
        title: "锣鼓经",
        summary: "大陆传统器乐及戏曲里面常用的打击乐记谱方法。",
        chunkIds: ["chunk-2"],
      },
    ];

    const selected = limitDemandSourceItemsByCoverage("广茂铁路主线全长多少公里？", items, "single");

    expect(selected.map((item) => item.id)).toEqual(["railway"]);
  });

  it("keeps ambiguous single-coverage candidates when the question lacks a stable item signal", () => {
    const items: DemandSourceItem[] = [
      {
        id: "zou-you",
        title: "邹游",
        summary: "中国足球运动员，司职中场。",
        chunkIds: ["chunk-1"],
      },
      {
        id: "zhang-shichang",
        title: "张世昌",
        summary: "中国足球运动员，司职守门员。",
        chunkIds: ["chunk-2"],
      },
    ];

    const selected = limitDemandSourceItemsByCoverage("他司职什么位置？", items, "single");

    expect(selected.map((item) => item.id)).toEqual(["zou-you", "zhang-shichang"]);
  });
});

describe("validateDemandEvidenceRecordCitations", () => {
  it("pins field and record citations to the chunk that actually contains the quoted evidence", () => {
    const chunksById = new Map<string, Chunk>([
      ["chunk-1", { id: "chunk-1", text: "广茂铁路由三茂铁路股份有限公司管理运营。", ordinal: 0 } as Chunk],
      ["chunk-2", { id: "chunk-2", text: "广茂铁路主线全长364.6公里。", ordinal: 1 } as Chunk],
    ]);
    const record: EvidenceRecord = {
      recordId: "record-1",
      recordName: "广茂铁路信息",
      sourceItemId: "railway",
      evidenceChunkIds: ["chunk-1", "chunk-2"],
      fields: {
        answer_text: {
          value: "364.6公里",
          chunkId: "chunk-1",
          confidence: 0.92,
          evidenceChunkIds: ["chunk-1", "chunk-2"],
          quote: "主线全长364.6公里",
        },
      },
    };

    const normalized = validateDemandEvidenceRecordCitations(record, chunksById);

    expect(normalized.evidenceChunkIds).toEqual(["chunk-2"]);
    expect(normalized.fields.answer_text?.chunkId).toBe("chunk-2");
    expect(normalized.fields.answer_text?.evidenceChunkIds).toEqual(["chunk-2"]);
  });
});
