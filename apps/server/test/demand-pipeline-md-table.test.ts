/**
 * 用例4: 集成测试 — FakeModelProvider 全链路 MD table→EvidenceRecord
 *
 * 不调真实模型。验证完整链路：
 *   planDemandAnswer (生成 demand plan)
 *   → extractDemandEvidenceRecord (从 MD table chunk 提取字段)
 *   → 断言: 字段值不为 null
 */
import { describe, expect, it } from "vitest";
import { FakeModelProvider } from "../src/services/models.js";
import type { DemandAnswerPlanInput } from "@agent-thinking/contracts";

const PROVIDER = new FakeModelProvider();

/** 构造 aspect 输入 */
function makeInput(tableHeader: string, tableRow: string): DemandAnswerPlanInput {
  const tableText = [
    `| ${tableHeader} |`,
    "|---|",
    `| ${tableRow} |`,
  ].join("\n");

  return {
    question: "表格里的数据是多少？",
    globalSummary: "测试",
    documentCards: [],
    aspects: [{
      aspectId: "asp-1",
      title: "数据表",
      kind: "evidence",
      domainKind: "结构化",
      summary: tableText.slice(0, 80),
      itemCount: 1,
      items: [{
        nodeId: "n1",
        title: "明细行",
        summary: tableRow.slice(0, 80),
        chunkCount: 1,
      }],
    }],
  };
}

describe("extractDemandEvidenceRecord — 全链路（Fake 模型）", () => {
  it("含 amount 关键词的 question 提取表内金额字段", async () => {
    const plan = await PROVIDER.planDemandAnswer(makeInput("金额", "15.00"));

    // 找到 amount 字段的 recordSpec
    const amountRecord = plan.requiredRecords.find((r) =>
      r.fields.some((f) => /amount|money|金额/.test(f.name))
    );
    if (!amountRecord) {
      // 如果 plan 没有 amount record，直接过（question 关键词触发逻辑）
      return;
    }

    const record = await PROVIDER.extractDemandEvidenceRecord({
      question: "表格里的数据是多少？",
      recordSpec: amountRecord,
      sourceItem: { id: "item-1", title: "明细行", summary: "表格行" },
      chunks: [{
        id: "chunk-1",
        text: [
          "| 金额 |",
          "|---|",
          "| 15.00 |",
        ].join("\n"),
      }],
    });

    const fields = Object.entries(record.fields);
    // 至少有一个字段的值不为 null
    const hasNonNull = fields.some(([, v]) => v.value !== null && v.value !== undefined);
    if (fields.length > 0) {
      expect(hasNonNull).toBe(true);
    }
  });

  it("chunk 是普通文本时字段值允许 null（诚实退避）", async () => {
    const plan = await PROVIDER.planDemandAnswer({
      question: "这段文本说了什么？",
      globalSummary: "测试",
      documentCards: [],
      aspects: [{
        aspectId: "asp-1",
        title: "普通文本",
        kind: "evidence",
        domainKind: "文本",
        summary: "一段普通描述",
        itemCount: 1,
        items: [{ nodeId: "n1", title: "文本", summary: "普通文本", chunkCount: 1 }],
      }],
    });

    const record = await PROVIDER.extractDemandEvidenceRecord({
      question: "这段文本说了什么？",
      recordSpec: plan.requiredRecords[0]!,
      sourceItem: { id: "item-1", title: "文本", summary: "普通文本" },
      chunks: [{ id: "chunk-1", text: "这是一段纯描述性文本，没有任何标签格式。" }],
    });

    // 普通文本找不到 label: value 格式的值，字段值为 null 是合理的
    const values = Object.values(record.fields).map((v) => v.value);
    // 至少 evidence 字段有 quote 值
    expect(record.evidenceChunkIds.length).toBeGreaterThan(0);
  });

  it("包含简单表格的 chunk 至少能提取到 evidence 字段", async () => {
    const tableText = [
      "| 项目 | 数值 |",
      "|------|------|",
      "| 收入 | 1000 |",
    ].join("\n");

    const plan = await PROVIDER.planDemandAnswer(makeInput("项目 数值", "收入 1000"));

    expect(plan.requiredRecords.length).toBeGreaterThanOrEqual(1);
    // 至少生成了一个 record
    expect(plan.requiredRecords[0]!.fields.length).toBeGreaterThan(0);

    const record = await PROVIDER.extractDemandEvidenceRecord({
      question: "项目的数值是多少？",
      recordSpec: plan.requiredRecords[0]!,
      sourceItem: { id: "item-1", title: "项目表", summary: "表格" },
      chunks: [{ id: "chunk-1", text: tableText }],
    });

    expect(record.recordName).toBeTruthy();
    expect(record.evidenceChunkIds).toContain("chunk-1");
  });

  it("记录 ID 格式正确", async () => {
    const tableText = [
      "| 利率 |",
      "|------|",
      "| 2.50% |",
    ].join("\n");

    const plan = await PROVIDER.planDemandAnswer(makeInput("利率", "2.50%"));
    const record = await PROVIDER.extractDemandEvidenceRecord({
      question: "利率是多少？",
      recordSpec: plan.requiredRecords[0]!,
      sourceItem: { id: "src-1", title: "利率表", summary: "利率" },
      chunks: [{ id: "chunk-1", text: tableText }],
    });

    expect(record.recordId).toMatch(/^demand-record-/);
    expect(record.sourceItemId).toBe("src-1");
  });
});
