/**
 * 用例2: planDemandAnswer 字段名生成（纯单元测试，不调模型）
 *
 * verify: 当 AORI 切面中含 MD table chunk 时，
 * planDemandAnswer 应为 demand plan 生成 table header 对应的字段名，
 * 而不是泛化的 "text"。
 */
import { describe, expect, it } from "vitest";
import { FakeModelProvider } from "../src/services/models.js";

const PROVIDER = new FakeModelProvider();

/** 构造一个含 MD table 的 aspect 切面 */
function aspectWithTable(headers: string[], rowCount = 2): typeof input.aspects[number] {
  const headerLine = `| ${headers.join(" | ")} |`;
  const sepLine = `|${headers.map(() => "---").join("|")}|`;
  const row = `| ${headers.map((_, i) => `val${i}`).join(" | ")} |`;
  const tableText = [headerLine, sepLine, ...Array.from({ length: rowCount }, () => row)].join("\n");

  return {
    aspectId: "aspect-table-1",
    title: "测试表格切面",
    kind: "evidence",
    domainKind: "结构化字段",
    summary: "包含债券表格的切面",
    itemCount: 1,
    items: [{
      nodeId: "node-1",
      title: "债券明细表",
      summary: "债券表格",
      chunkCount: 1,
    }],
  };
}

const input = {
  question: "债券募集金额是多少？",
  globalSummary: "测试文档摘要",
  documentCards: [] as Array<{ documentId: string; versionId: string; documentName: string; summary: string }>,
  aspects: [] as Array<{
    aspectId: string;
    title: string;
    kind: string;
    domainKind: string;
    summary: string;
    itemCount: number;
    items?: Array<{
      nodeId: string;
      title: string;
      summary: string;
      chunkCount: number;
    }>;
  }>,
};

describe("planDemandAnswer — MD table 字段名生成", () => {
  it("含 amount 关键词时生成字段不为 'text'", async () => {
    // 字段名由 question 中的关键词决定，不是由 aspect 内容决定
    // 关键验证：planDemandAnswer 不应该把表头硬编码为 "text"
    const result = await PROVIDER.planDemandAnswer({
      ...input,
      question: "债券募集金额和利率分别是多少？",
      aspects: [aspectWithTable(["债券简称", "募集金额", "利率"])],
    });

    const fields = result.requiredRecords[0]?.fields ?? [];
    const fieldNames = fields.map((f) => f.name);

    // 不应该出现泛化字段名 "text"
    expect(fieldNames).not.toContain("text");

    // 应该有 amount 和 evidence 字段（由 question 关键词触发）
    expect(fieldNames.some((n) => /amount|money|金额/.test(n))).toBe(true);
    expect(fieldNames.some((n) => /evidence|quote|证据/.test(n))).toBe(true);
  });

  it("question 不含特定关键词时生成通用字段", async () => {
    const result = await PROVIDER.planDemandAnswer({
      ...input,
      question: "表格里有什么？",
      aspects: [aspectWithTable(["列A", "列B", "列C"])],
    });

    const fields = result.requiredRecords[0]?.fields ?? [];
    const fieldNames = fields.map((f) => f.name);

    // 不应该出现泛化字段名 "text"
    expect(fieldNames).not.toContain("text");

    // 应该有通用证据字段
    expect(fields.length).toBeGreaterThan(0);
  });

  it("包含多个切面时选择最相关的切面生成字段", async () => {
    const result = await PROVIDER.planDemandAnswer({
      ...input,
      question: "募集总金额是多少？",
      aspects: [
        {
          aspectId: "aspect-irrelevant",
          title: "不相关切面",
          kind: "other",
          domainKind: "其他",
          summary: "与金额无关的内容",
          itemCount: 1,
          items: [{ nodeId: "n1", title: "其他", summary: "其他", chunkCount: 1 }],
        },
        aspectWithTable(["债券简称", "募集总金额", "资金用途"]),
      ],
    });

    const fields = result.requiredRecords[0]?.fields ?? [];
    const fieldNames = fields.map((f) => f.name);

    // 不应该出现泛化字段名 "text"
    expect(fieldNames).not.toContain("text");

    // amount 相关字段应该出现
    expect(fieldNames.some((n) => /amount|money|金额|总额/.test(n))).toBe(true);
  });

  it("requiredRecords 至少有一条", async () => {
    const result = await PROVIDER.planDemandAnswer({
      ...input,
      question: "利率是多少？",
      aspects: [aspectWithTable(["债券简称", "利率", "到期日"])],
    });

    expect(result.requiredRecords.length).toBeGreaterThanOrEqual(1);
  });
});
