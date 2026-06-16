import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { PendingChunk } from "../../src/domain/chunker.js";

const helperDir = dirname(fileURLToPath(import.meta.url));

export const csairReportFixturePath = join(
  helperDir,
  "..",
  "fixtures",
  "csair-2024-report-first-21-pages.txt",
);

function normalizeFixtureText(text: string): string {
  return text.replace(/\r\n?/g, "\n");
}

function extractBetween(text: string, startMarker: string, endMarker: string): string {
  const start = text.indexOf(startMarker);
  if (start < 0) throw new Error(`Missing fixture marker: ${startMarker}`);
  const end = text.indexOf(endMarker, start + startMarker.length);
  if (end < 0) throw new Error(`Missing fixture marker: ${endMarker}`);
  return text.slice(start, end).trim();
}

function cleanSection(text: string): string {
  return text
    .replace(/^\s*===== 第 \d+ 页 =====\s*$/gmu, "")
    .replace(/^\s*\d+\s*$/gmu, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function normalizeBondBalanceSection(text: string): string {
  const cleaned = cleanSection(text);
  const rows = cleaned
    .split(/(?=中国南方航)/u)
    .map((part) => part.replace(/\s+/g, " ").trim())
    .flatMap((block) => {
      const year = block.match(/(\d{2})\s*南航/u)?.[1];
      const code = block.match(/\b(?:SCP|MTN)\d{3}\b/u)?.[0];
      const amount = block.match(/(\d+(?:\.\d+)?)\s+\d+(?:\.\d+)?%/u)?.[1];
      if (!year || !code || !amount) return [];
      return [`${year}南航集${code} | ${amount}`];
    });
  if (rows.length === 0) return cleaned;
  return [
    "表：存续债券详细信息",
    "债券简称 | 债券余额(亿元)",
    ...rows,
  ].join("\n");
}

function normalizeExplanation17Section(text: string): string {
  const cleaned = cleanSection(text).replace(/\s+/g, " ");
  const otherCurrent = cleaned.match(/其他流动负债\s+[\d,]+\.\d+\s+([\d,]+\.\d+)\s+[\d,]+\.\d+/u)?.[1];
  const currentDue = cleaned.match(/一年内到期的非流动负债\s+[\d,]+\.\d+\s+(-?[\d,]+\.\d+)\s+[\d,]+\.\d+/u)?.[1];
  const bonds = cleaned.match(/应付债券\s+[\d,]+\.\d+\s+(-?[\d,]+\.\d+)\s+[\d,]+\.\d+/u)?.[1];
  if (!otherCurrent || !currentDue || !bonds) return cleaned;
  return [
    "执行《企业会计准则解释第17号》。",
    `其他流动负债增加${otherCurrent.replace(/,/g, "")}元。`,
    `一年内到期的非流动负债减少${currentDue.replace(/^-/, "").replace(/,/g, "")}元。`,
    `应付债券减少${bonds.replace(/^-/, "").replace(/,/g, "")}元。`,
  ].join("\n");
}

function sectionChunk(
  ordinal: number,
  headingPath: string,
  text: string,
  startChar: number,
): PendingChunk {
  const cleaned = cleanSection(text);
  return {
    ordinal,
    headingPath,
    pageNumber: null,
    startChar,
    endChar: startChar + cleaned.length,
    text: cleaned,
  };
}

export async function loadCsairReportFixtureText(path = csairReportFixturePath): Promise<string> {
  return readFile(path, "utf8");
}

export function buildCsairSemanticChunks(sourceText: string): PendingChunk[] {
  const text = normalizeFixtureText(sourceText);
  const sections = [
    {
      headingPath: "第二章 / 二、企业报告期内情况 / （五）报告期内除债券外的其他有息债务的逾期情况",
      text: extractBetween(text, "（五）报告期内除债券外的其他有息债务的逾期情况", "（六）债务融资工具中介机构情况"),
    },
    {
      headingPath: "第三章 / 一、存续债券情况 / （一）存续债券详细信息",
      text: normalizeBondBalanceSection(extractBetween(text, "（一）存续债券详细信息", "（二）是否存在逾期未偿还债券")),
    },
    {
      headingPath: "第三章 / 一、存续债券情况 / （二）是否存在逾期未偿还债券",
      text: extractBetween(text, "（二）是否存在逾期未偿还债券", "二、报告期内信用评级调整情况"),
    },
    {
      headingPath: "第三章 / 三、报告期内债务融资工具募集资金使用情况 / （一）募集资金使用情况",
      text: extractBetween(
        text,
        "（一）报告期内存续（含报告期内到期）债务融资工具\n募集资金使用情况",
        "（二）报告期内存续（含报告期内到期）债务融资工具\n募集资金用途变更情况",
      ),
    },
    {
      headingPath: "第三章 / 三、报告期内债务融资工具募集资金使用情况 / （二）募集资金用途变更情况及相关不涉及事项",
      text: extractBetween(
        text,
        "（二）报告期内存续（含报告期内到期）债务融资工具\n募集资金用途变更情况",
        "第四章 报告期内重要事项",
      ),
    },
    {
      headingPath: "第四章 / 一、报告期内会计政策变更等情况 / （一）会计政策变更情况 / 解释第17号",
      text: normalizeExplanation17Section(extractBetween(text, "1、执行《企业会计准则解释第 17 号》", "2、执行《企业数据资源相关会计处理暂行规定》")),
    },
    {
      headingPath: "第四章 / 一、报告期内会计政策变更等情况 / （三）会计差错更正情况",
      text: extractBetween(text, "（三）会计差错更正情况", "（四）是否被出具非标准意见的审计报告"),
    },
    {
      headingPath: "第四章 / 四、受限资产情况",
      text: extractBetween(text, "四、受限资产情况", "五、对外担保情况"),
    },
    {
      headingPath: "第四章 / 五、对外担保情况 / （一）截至报告期末的对外担保情况",
      text: extractBetween(text, "（一）截至报告期末的对外担保情况", "（二）对单笔或同一担保对象累计超过报告期末净资产"),
    },
  ];

  let startChar = 0;
  return sections.map((section, ordinal) => {
    const chunk = sectionChunk(ordinal, section.headingPath, section.text, startChar);
    startChar = chunk.endChar + 2;
    return chunk;
  });
}
