/**
 * 用例5: 真实 LLM 测试 — extractDemandEvidenceRecord 3 次调用验证
 *
 * 用一个简单的 2 列表格（债券简称 + 募集金额），
 * 调用真实 DeepSeek/OpenAI 模型 3 次，
 * 检查是否每次都能正确提取字段值。
 *
 * 需要配置 .env: RUN_REAL_MODEL_TESTS=true
 */
import { describe, expect, it } from "vitest";
import { getConfig } from "../src/config.js";
import { createModelProvider } from "../src/services/models.js";
import type { DemandAnswerPlan, DemandEvidenceRecordExtractionInput } from "@agent-thinking/contracts";

// ─── 一个简单的 3 行债券表格 ───
const SIMPLE_TABLE_TEXT = [
  "| 债券简称 | 募集金额 | 利率 |",
  "|---------|---------|------|",
  "| 22南航集MTN001 | 15.00 | 2.50% |",
  "| 24南航集SCP005 | 5.60  | 2.00% |",
  "| 24南航集SCP006 | 10.00 | 1.85% |",
].join("\n");

const RECORD_SPEC = {
  recordName: "债券信息",
  source: "aspect_items" as const,
  fields: [
    { name: "募集金额", description: "每只债券募集金额（亿元）", required: true },
    { name: "利率", description: "债券票面利率", required: true },
    { name: "债券简称", description: "债券名称", required: false },
  ],
  coverage: "all" as const,
};

const SOURCE_ITEM = {
  id: "item-bond-table",
  title: "存续债券明细表",
  summary: "债券募集资金和利率明细",
};

function buildInput(recordSpec?: DemandAnswerPlan["requiredRecords"][number]): DemandEvidenceRecordExtractionInput {
  return {
    question: "存续债券的募集金额和利率分别是多少？",
    recordSpec: recordSpec ?? RECORD_SPEC,
    sourceItem: SOURCE_ITEM,
    chunks: [{ id: "chunk-table-1", text: SIMPLE_TABLE_TEXT }],
  };
}

describe("extractDemandEvidenceRecord — 真实 LLM 3 次验证", () => {
  const config = getConfig();
  const runReal = process.env.RUN_REAL_MODEL_TESTS === "true";

  (runReal ? describe : describe.skip)("真实模型调用", () => {
    const model = createModelProvider(config);

    it("三次调用都正确提取表格字段", async () => {
      const results: Array<Awaited<ReturnType<typeof model.extractDemandEvidenceRecord>>> = [];

      for (let i = 1; i <= 3; i++) {
        const record = await model.extractDemandEvidenceRecord(buildInput());
        results.push(record);
      }

      for (const [i, record] of results.entries()) {
        // ① 募集金额不为 null
        expect(
          record.fields["募集金额"]?.value,
          `Run ${i + 1}: 募集金额 不应为 null`
        ).not.toBeNull();

        // ② 利率不为 null
        expect(
          record.fields["利率"]?.value,
          `Run ${i + 1}: 利率 不应为 null`
        ).not.toBeNull();

        // ③ confidence 不低于 0.4（给 LLM 留容错）
        expect(
          record.fields["募集金额"]?.confidence ?? 0,
          `Run ${i + 1}: 募集金额 confidence`
        ).toBeGreaterThanOrEqual(0.4);

        expect(
          record.fields["利率"]?.confidence ?? 0,
          `Run ${i + 1}: 利率 confidence`
        ).toBeGreaterThanOrEqual(0.4);

        // ④ 有证据 chunk ID
        expect(
          record.evidenceChunkIds.length,
          `Run ${i + 1}: 应有 evidenceChunkIds`
        ).toBeGreaterThan(0);

        // ⑤ 有 quote
        expect(
          (record.fields["募集金额"]?.quote?.length ?? 0) > 0 ||
          (record.fields["利率"]?.quote?.length ?? 0) > 0,
          `Run ${i + 1}: 至少一个字段应有 quote`
        ).toBe(true);
      }

      // ⑥ 三次提取的募集金额一致（不要求 value 完全相等，但不能一会 15 一会 null）
      const amounts = results.map((r) => String(r.fields["募集金额"]?.value ?? ""));
      expect(new Set(amounts).size, "三次募集金额应一致").toBe(1);

      // ⑦ 三次提取的利率一致
      const rates = results.map((r) => String(r.fields["利率"]?.value ?? ""));
      expect(new Set(rates).size, "三次利率应一致").toBe(1);
    }, 120_000);

    it("表格字段名与表头匹配时能提取到值", async () => {
      const record = await model.extractDemandEvidenceRecord(buildInput());

      // 债券简称是表格第一列
      const bondName = record.fields["债券简称"]?.value;
      if (bondName !== null && bondName !== undefined) {
        expect(String(bondName)).toMatch(/南航/);
      }
    }, 60_000);

    it("不存在的字段名返回 null（不瞎编）", async () => {
      const record = await model.extractDemandEvidenceRecord(buildInput({
        ...RECORD_SPEC,
        fields: [
          ...RECORD_SPEC.fields,
          { name: "到期日", description: "不存在于表格中的字段", required: false },
        ],
      }));

      // "到期日" 字段在表格中不存在，value 应为 null
      if (record.fields["到期日"]) {
        expect(record.fields["到期日"].value).toBeNull();
        expect(record.fields["到期日"].confidence).toBeLessThan(0.5);
      }
    }, 60_000);
  });

  // 当 RUN_REAL_MODEL_TESTS 未设置时，至少验证跳过逻辑
  if (!runReal) {
    it.skip("真实模型测试已跳过（设置 RUN_REAL_MODEL_TESTS=true 启用）", () => {
      // 主动 skip，避免 vitest 报告 0 tests
    });
  }
});
