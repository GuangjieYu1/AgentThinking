/**
 * 用例1+3: Markdown 表格检测与字段提取（纯函数，不调模型）
 *
 * 测试从 models.ts 导出的两个纯函数：
 *   1. detectMdTable(text) — 识别 pipe table，提取表头与行
 *   2. extractMdTableValue(chunkText, fieldName) — 按列名提取值
 */
import { describe, expect, it } from "vitest";
import { detectMdTable, extractMdTableValue } from "../src/services/models.js";

/** 从 MD table 文本中提取所有字段 */
function extractMdTableFields(
  text: string,
  fieldNames: string[]
): Record<string, string[] | null> {
  return Object.fromEntries(
    fieldNames.map((name) => [name, extractMdTableValue(text, name)])
  );
}

// ─── 测试 ───

describe("detectMdTable", () => {
  it("识别标准 3 列表格", () => {
    const text = [
      "| 债券简称 | 募集金额 | 利率 |",
      "|---------|---------|------|",
      "| 22南航集MTN001 | 15.00 | 2.50% |",
      "| 24南航集SCP005 | 5.60  | 2.00% |",
    ].join("\n");

    const table = detectMdTable(text);
    expect(table).not.toBeNull();
    expect(table!.headers).toEqual(["债券简称", "募集金额", "利率"]);
    expect(table!.rows).toHaveLength(2);
    expect(table!.rows[0]).toEqual(["22南航集MTN001", "15.00", "2.50%"]);
    expect(table!.rows[1]).toEqual(["24南航集SCP005", "5.60", "2.00%"]);
  });

  it("识别含空单元格的表格", () => {
    const text = [
      "| 项目 | 金额 | 备注 |",
      "|------|------|------|",
      "| 货币资金 | 12.83 | |",
      "| 固定资产 | | 注4 |",
    ].join("\n");

    const table = detectMdTable(text);
    expect(table).not.toBeNull();
    expect(table!.rows[0]).toEqual(["货币资金", "12.83", ""]);
    expect(table!.rows[1]).toEqual(["固定资产", "", "注4"]);
  });

  it("识别带前后空格的表头", () => {
    const text = [
      "|  债券 简称  |  余 额  |  利 率  |",
      "|------------|--------|--------|",
      "| 22南航集 MTN001 | 15 | 2.50% |",
    ].join("\n");

    const table = detectMdTable(text);
    expect(table).not.toBeNull();
    expect(table!.headers).toEqual(["债券 简称", "余 额", "利 率"]);
  });

  it("普通文本返回 null", () => {
    expect(detectMdTable("这是一段普通文本。")).toBeNull();
    expect(detectMdTable("## 标题\n正文内容")).toBeNull();
  });

  it("只有表头没有数据行返回空 rows", () => {
    const text = [
      "| 列A | 列B |",
      "|-----|-----|",
    ].join("\n");

    const table = detectMdTable(text);
    expect(table).not.toBeNull();
    expect(table!.headers).toEqual(["列A", "列B"]);
    expect(table!.rows).toHaveLength(0);
  });

  it("表头后不是分隔行则返回 null", () => {
    const text = [
      "| 列A | 列B |",
      "| 这是数据不是分隔线 |",
    ].join("\n");

    expect(detectMdTable(text)).toBeNull();
  });

  it("docling 输出的真实债券表", () => {
    const text = [
      "| 债券全称 | 债 券 简称 | 债券 余额 | 利率 |",
      "|---------|----------|---------|-------|",
      "| 中国南方航 空集团有限 公司2022年 度第一期中 期票据 | 22南航 集 MTN001 | 15 | 2.50% |",
      "| 中国南方航 空集团有限 公司2024年 度第五期超 短期融资券 | 24南航 集 SCP005 | 5.6 | 2.00% |",
    ].join("\n");

    const table = detectMdTable(text);
    expect(table).not.toBeNull();
    expect(table!.rows).toHaveLength(2);
    expect(table!.rows[0]?.[2]).toBe("15");
  });
});

describe("extractMdTableValue", () => {
  const tableText = [
    "| 债券简称 | 募集金额 | 利率 |",
    "|---------|---------|------|",
    "| 22南航集MTN001 | 15.00 | 2.50% |",
    "| 24南航集SCP005 | 5.60  | 2.00% |",
    "| 24南航集SCP006 | 10.00 | 1.85% |",
  ].join("\n");

  it("按精确列名提取值", () => {
    const value = extractMdTableValue(tableText, "募集金额");
    expect(value).toEqual(["15.00", "5.60", "10.00"]);
  });

  it("忽略列名中的空格匹配", () => {
    const value = extractMdTableValue(tableText, " 募 集 金 额 ");
    expect(value).toEqual(["15.00", "5.60", "10.00"]);
  });

  it("不存在的列名返回 null", () => {
    expect(extractMdTableValue(tableText, "到期日")).toBeNull();
  });

  it("非表格文本返回 null", () => {
    expect(extractMdTableValue("普通文本", "任何列")).toBeNull();
  });

  it("利率列正确提取", () => {
    const value = extractMdTableValue(tableText, "利率");
    expect(value).toEqual(["2.50%", "2.00%", "1.85%"]);
  });

  it("空数据（—）被过滤", () => {
    const text = [
      "| 项目 | 金额 |",
      "|------|------|",
      "| 短期借款 | — |",
      "| 应付票据 | 53500 |",
    ].join("\n");
    const value = extractMdTableValue(text, "金额");
    expect(value).toEqual(["53500"]); // "—" 被过滤，只剩有效值
  });
});

describe("extractMdTableFields", () => {
  const tableText = [
    "| 项目 | 金额 | 受限原因 |",
    "|------|------|---------|",
    "| 货币资金 | 12.83 | 法定准备金 |",
    "| 固定资产 | 36.84 | 抵押 |",
  ].join("\n");

  it("批量提取多个字段", () => {
    const result = extractMdTableFields(tableText, ["金额", "受限原因"]);
    expect(result["金额"]).toEqual(["12.83", "36.84"]);
    expect(result["受限原因"]).toEqual(["法定准备金", "抵押"]);
  });

  it("部分字段不存在时返回 null", () => {
    const result = extractMdTableFields(tableText, ["金额", "不存在列"]);
    expect(result["金额"]).toEqual(["12.83", "36.84"]);
    expect(result["不存在列"]).toBeNull();
  });
});
