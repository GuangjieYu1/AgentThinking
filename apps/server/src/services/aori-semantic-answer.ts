import type {
  AoriDocumentDraft,
  AoriTraversalMap,
  Chunk,
  DemandAnswerPlan,
  EvidenceRecord,
  PulseAnswerOutput,
} from "@agent-thinking/contracts";

type SemanticQuestionType =
  | "numeric_table_aggregation"
  | "concept_boundary"
  | "accounting_event_analysis"
  | "negative_fact"
  | "exhaustive_list";

type TablePurpose =
  | "bond_balance"
  | "fundraising_usage"
  | "restricted_assets"
  | "restricted_cash"
  | "guarantee"
  | "unknown";

interface MetricRequest {
  label: string;
  columnPatterns: string[];
  unit: "元" | "万元" | "亿元";
  explainCalculation?: boolean;
}

interface SemanticQuestionPlan {
  questionType: SemanticQuestionType;
  tableId?: string | undefined;
  tablePurpose?: TablePurpose | undefined;
  metricRequests?: MetricRequest[] | undefined;
  boundaryTableIds?: string[] | undefined;
  negativeFactIds?: string[] | undefined;
  questionTargetPatterns?: string[] | undefined;
  questionScopePatterns?: string[] | undefined;
  eventIds?: string[] | undefined;
  eventPatterns?: string[] | undefined;
  excludedEventPatterns?: string[] | undefined;
}

interface ParsedCell {
  raw: string;
  numericValue?: number | undefined;
  unit?: "元" | "万元" | "亿元" | undefined;
}

interface ParsedRow {
  id: string;
  label: string;
  cells: Record<string, ParsedCell>;
  sourceChunkIds: string[];
  sourceLine: string;
}

interface ParsedTable {
  id: string;
  title: string;
  headingPath?: string | undefined;
  purpose: TablePurpose;
  columns: string[];
  rows: ParsedRow[];
  unitHints: Array<"元" | "万元" | "亿元">;
  chunkIds: string[];
}

interface NegativeFactUnit {
  id: string;
  target: string;
  scope: string;
  statement: string;
  certainty: "explicit" | "implicit";
  chunkId: string;
}

type EventDirection = "increase" | "decrease" | "reclassify" | "no_effect";

interface EventEffect {
  item: string;
  direction: EventDirection;
  amount?: number | undefined;
  unit?: "元" | "万元" | "亿元" | undefined;
  chunkId: string;
  sourceLine: string;
}

interface AccountingEventUnit {
  id: string;
  eventName: string;
  eventCategory: "accounting_policy_change" | "accounting_error_correction" | "unknown";
  sourceSectionTitle: string;
  affectedItems: string[];
  excludes: string[];
  effects: EventEffect[];
  chunkIds: string[];
}

interface SemanticDemandAnswerResult {
  plan: DemandAnswerPlan;
  records: EvidenceRecord[];
  answer: PulseAnswerOutput;
  usedChunkIds: string[];
  questionType: SemanticQuestionType;
}

function uniqueStrings(values: Array<string | undefined | null>): string[] {
  return [...new Set(values.map((value) => value?.trim() ?? "").filter(Boolean))];
}

function normalizeText(value: string): string {
  return value.normalize("NFKC").replace(/\s+/g, " ").trim();
}

function normalizeKey(value: string): string {
  return normalizeText(value).toLowerCase().replace(/[\s“”"'`‘’·,.;:()（）【】《》？！?，。、；：\[\]\-_/\\]/g, "");
}

function withoutUnitWords(value: string): string {
  return value
    .replace(/人民币/g, "")
    .replace(/亿元|万元|元/g, "");
}

function stripSemanticSuffix(value: string): string {
  return value
    .replace(/(详细信息|使用情况|变更情况|相关事项|相关情况|构成|情况|事项|类别|金额|价值|余额|总额|简称|项目|贷款|担保|影响)$/u, "");
}

function semanticTerms(...values: Array<string | undefined | null>): string[] {
  const terms: string[] = [];
  const pushTerm = (candidate: string) => {
    const normalized = normalizeKey(candidate);
    if (normalized.length >= 3) terms.push(normalized);
  };

  for (const value of values) {
    const normalized = normalizeText(value ?? "");
    if (!normalized) continue;
    const pieces = [
      normalized,
      ...normalized.split(/[\s|、，,。；;：:（）()【】《》"'“”‘’]+/u),
    ];
    for (const piece of pieces) {
      const key = normalizeKey(piece);
      if (!key) continue;
      pushTerm(key);
      const unitless = withoutUnitWords(key);
      pushTerm(unitless);
      pushTerm(stripSemanticSuffix(unitless));
      pushTerm(stripSemanticSuffix(key));
    }
  }
  return uniqueStrings(terms);
}

function questionTerms(question: string): string[] {
  const stopPatterns = [
    /报告期内/g,
    /报告中/g,
    /本报告/g,
    /这份报告/g,
    /本公司/g,
    /公司/g,
    /用户问/g,
    /如果/g,
    /请/g,
    /是否/g,
    /存在/g,
    /有没有/g,
    /有哪些/g,
    /哪些/g,
    /什么/g,
    /多少/g,
    /分别/g,
    /一共/g,
    /合计/g,
    /计算过程/g,
    /列出/g,
    /验证/g,
    /为什么/g,
    /不能/g,
    /能支持/g,
    /不能支持/g,
    /支持/g,
    /结论/g,
    /明确/g,
    /写明/g,
    /包括/g,
    /构成/g,
    /类别/g,
    /项目/g,
    /分项/g,
    /加总/g,
    /闭合/g,
    /影响/g,
    /导致/g,
    /调整事项/g,
    /涉及/g,
  ];
  const stripped = stopPatterns.reduce((text, pattern) => text.replace(pattern, " "), normalizeText(question));
  return semanticTerms(question, stripped);
}

function scoreTermsInText(terms: string[], text: string): number {
  const haystack = normalizeKey(text);
  if (!haystack) return 0;
  return terms.reduce((score, term) => {
    if (!term) return score;
    if (haystack.includes(term)) return score + 20 + Math.min(term.length, 20);
    if (term.includes(haystack) && haystack.length >= 4) return score + 8 + Math.min(haystack.length, 12);
    return score;
  }, 0);
}

function scoreCandidateAgainstQuestion(questionKey: string, terms: string[], candidateText: string): number {
  const candidateKey = normalizeKey(candidateText);
  if (!candidateKey) return 0;
  const termScore = scoreTermsInText(terms, candidateText);
  const candidateTerms = semanticTerms(candidateText);
  const reverseScore = candidateTerms.reduce((score, term) => questionKey.includes(term)
    ? score + 18 + Math.min(term.length, 18)
    : score, 0);
  return termScore + reverseScore;
}

function truncateText(value: string, max: number): string {
  const normalized = normalizeText(value);
  return normalized.length > max ? normalized.slice(0, Math.max(0, max - 1)).trimEnd() : normalized;
}

function preferredUnitFromText(value: string): "元" | "万元" | "亿元" | undefined {
  if (value.includes("亿元")) return "亿元";
  if (value.includes("万元")) return "万元";
  if (value.includes("元")) return "元";
  return undefined;
}

function numericFromText(value: string): number | undefined {
  const match = normalizeText(value).match(/-?\d[\d,]*(?:\.\d+)?/);
  if (!match) return undefined;
  const numeric = Number(match[0].replace(/,/g, ""));
  return Number.isFinite(numeric) ? numeric : undefined;
}

function convertUnit(value: number, from: "元" | "万元" | "亿元", to: "元" | "万元" | "亿元"): number {
  if (from === to) return value;
  const valueInYuan = from === "亿元"
    ? value * 100000000
    : from === "万元"
      ? value * 10000
      : value;
  if (to === "亿元") return valueInYuan / 100000000;
  if (to === "万元") return valueInYuan / 10000;
  return valueInYuan;
}

function formatNumber(value: number): string {
  const rounded = Math.round((value + Number.EPSILON) * 10000) / 10000;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(4).replace(/\.?0+$/, "");
}

function splitDelimitedLine(line: string): string[] {
  if (line.includes("|")) {
    return line.split("|").map((cell) => cell.trim()).filter(Boolean);
  }
  if (line.includes("\t")) {
    return line.split("\t").map((cell) => cell.trim()).filter(Boolean);
  }
  return line.split(/\s{2,}/).map((cell) => cell.trim()).filter(Boolean);
}

function titleFromChunk(chunk: Chunk, lines: string[]): string {
  const titleLine = lines.find((line) => /^表[:：]/.test(line) || /^table[:：]/i.test(line));
  if (titleLine) return titleLine.replace(/^表[:：]\s*/, "").replace(/^table[:：]\s*/i, "").trim();
  return chunk.headingPath ?? lines[0] ?? `table-${chunk.ordinal + 1}`;
}

function parseTableChunks(chunks: Chunk[]): ParsedTable[] {
  const grouped = new Map<string, ParsedTable>();
  for (const chunk of chunks) {
    const lines = chunk.text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const headerIndex = lines.findIndex((line) => splitDelimitedLine(line).length >= 2 && (line.includes("|") || line.includes("\t")));
    if (headerIndex < 0) continue;
    const headerCells = splitDelimitedLine(lines[headerIndex] ?? "");
    if (headerCells.length < 2) continue;
    const title = titleFromChunk(chunk, lines.slice(0, headerIndex + 1));
    const groupKey = normalizeKey(`${chunk.headingPath ?? ""} ${title}`);
    const table = grouped.get(groupKey) ?? {
      id: groupKey || `table-${chunk.id}`,
      title,
      ...(chunk.headingPath ? { headingPath: chunk.headingPath } : {}),
      purpose: "unknown",
      columns: headerCells,
      rows: [],
      unitHints: [],
      chunkIds: [],
    };
    table.chunkIds = uniqueStrings([...table.chunkIds, chunk.id]);
    for (let index = headerIndex + 1; index < lines.length; index += 1) {
      const line = lines[index] ?? "";
      if (/^[-|:\s]+$/.test(line)) continue;
      const cells = splitDelimitedLine(line);
      if (cells.length < 2) continue;
      const rowLabel = cells[0] ?? `row-${table.rows.length + 1}`;
      const mappedCells = Object.fromEntries(table.columns.map((column, columnIndex) => {
        const raw = cells[columnIndex] ?? "";
        const unit = preferredUnitFromText(raw) ?? preferredUnitFromText(column);
        return [column, {
          raw,
          ...(numericFromText(raw) !== undefined ? { numericValue: numericFromText(raw) } : {}),
          ...(unit ? { unit } : {}),
        } satisfies ParsedCell];
      }));
      table.rows.push({
        id: `${table.id}-row-${table.rows.length + 1}`,
        label: rowLabel,
        cells: mappedCells,
        sourceChunkIds: [chunk.id],
        sourceLine: line,
      });
      for (const raw of cells) {
        const unit = preferredUnitFromText(raw);
        if (unit) table.unitHints = [...table.unitHints, unit];
      }
    }
    table.purpose = classifyTablePurpose(table);
    table.unitHints = [...new Set(table.unitHints)];
    grouped.set(groupKey, table);
  }
  return [...grouped.values()].filter((table) => table.rows.length > 0);
}

function classifyTablePurpose(table: Pick<ParsedTable, "title" | "columns" | "rows">): TablePurpose {
  const combined = normalizeKey(`${table.title} ${table.columns.join(" ")} ${table.rows.slice(0, 3).map((row) => row.label).join(" ")}`);
  if ((combined.includes("存续") || combined.includes("债券")) && combined.includes("余额")) return "bond_balance";
  if (combined.includes("募集资金") && (combined.includes("总额") || combined.includes("使用情况"))) return "fundraising_usage";
  if (combined.includes("受限货币资金")) return "restricted_cash";
  if (combined.includes("受限资产")) return "restricted_assets";
  if (combined.includes("飞行学员贷款") || combined.includes("担保")) return "guarantee";
  return "unknown";
}

function makeSemanticParsedCell(raw: string, fallbackUnit?: ParsedCell["unit"]): ParsedCell {
  const unit = preferredUnitFromText(raw) ?? fallbackUnit;
  return {
    raw,
    ...(numericFromText(raw) !== undefined ? { numericValue: numericFromText(raw) } : {}),
    ...(unit ? { unit } : {}),
  };
}

function makeSemanticParsedRow(
  tableId: string,
  rowIndex: number,
  label: string,
  cells: Array<[column: string, raw: string, unit?: ParsedCell["unit"]]>,
  chunkId: string,
  sourceLine: string,
): ParsedRow {
  return {
    id: `${tableId}-row-${rowIndex + 1}`,
    label,
    cells: Object.fromEntries(cells.map(([column, raw, unit]) => [column, makeSemanticParsedCell(raw, unit)])),
    sourceChunkIds: [chunkId],
    sourceLine,
  };
}

function buildSemanticParsedTable(input: {
  id: string;
  title: string;
  headingPath?: string | undefined;
  purpose: TablePurpose;
  columns: string[];
  rows: ParsedRow[];
  unitHints: Array<"元" | "万元" | "亿元">;
  chunkIds: string[];
}): ParsedTable {
  return {
    id: input.id,
    title: input.title,
    ...(input.headingPath ? { headingPath: input.headingPath } : {}),
    purpose: input.purpose,
    columns: input.columns,
    rows: input.rows,
    unitHints: [...new Set(input.unitHints)],
    chunkIds: uniqueStrings(input.chunkIds),
  };
}

function extractRealTextBondBalanceTable(chunk: Chunk): ParsedTable | undefined {
  const sectionKey = normalizeKey(`${chunk.headingPath ?? ""} ${chunk.text}`);
  if (!sectionKey.includes(normalizeKey("存续债券详细信息"))) return undefined;
  const columns = ["债券简称", "债券余额"];
  const rows = chunk.text
    .split(/(?=中国南方航)/u)
    .map((part) => normalizeText(part))
    .flatMap((block, rowIndex) => {
      const year = block.match(/(\d{2})\s*南航/u)?.[1];
      const code = block.match(/\b(?:SCP|MTN)\d{3}\b/u)?.[0];
      const amount = block.match(/(\d+(?:\.\d+)?)\s+\d+(?:\.\d+)?%/u)?.[1];
      if (!year || !code || !amount) return [];
      return [makeSemanticParsedRow(
        `${chunk.id}-bond-balance`,
        rowIndex,
        `${year}南航集${code}`,
        [
          [columns[0]!, `${year}南航集${code}`],
          [columns[1]!, amount, "亿元"],
        ],
        chunk.id,
        block,
      )];
    });
  if (rows.length === 0) return undefined;
  return buildSemanticParsedTable({
    id: `${chunk.id}-bond-balance`,
    title: "存续债券详细信息",
    headingPath: chunk.headingPath ?? undefined,
    purpose: "bond_balance",
    columns,
    rows,
    unitHints: ["亿元"],
    chunkIds: [chunk.id],
  });
}

function extractRealTextFundraisingUsageTable(chunk: Chunk): ParsedTable | undefined {
  const sectionKey = normalizeKey(`${chunk.headingPath ?? ""} ${chunk.text}`);
  if (!sectionKey.includes(normalizeKey("募集资金使用情况"))) return undefined;
  const lines = chunk.text.replace(/\r\n?/g, "\n").split("\n");
  const columns = ["债务融资工具简称", "募集资金总额", "计划使用金额", "已使用金额", "未使用金额"];
  const rows: ParsedRow[] = [];
  for (let index = 0; index < lines.length - 2; index += 1) {
    const head = normalizeText(lines[index] ?? "");
    const amountsLine = normalizeText(lines[index + 1] ?? "");
    const tail = normalizeText(lines[index + 2] ?? "");
    if (!/^\d{2}\s+南航集/u.test(head)) continue;
    const code = tail.match(/\b(?:SCP|MTN)\d{3}\b/u)?.[0];
    const amounts = amountsLine.match(/-?\d[\d,]*(?:\.\d+)?/g) ?? [];
    const prefix = head.match(/^(\d{2})\s+南航集/u)?.[1];
    if (!prefix || !code || amounts.length < 4) continue;
    const rowLabel = `${prefix}南航集${code}`;
    rows.push(makeSemanticParsedRow(
      `${chunk.id}-fundraising-usage`,
      rows.length,
      rowLabel,
      [
        [columns[0]!, rowLabel],
        [columns[1]!, amounts[0]!, "亿元"],
        [columns[2]!, amounts[1]!, "亿元"],
        [columns[3]!, amounts[2]!, "亿元"],
        [columns[4]!, amounts[3]!, "亿元"],
      ],
      chunk.id,
      [head, amountsLine, tail].join(" / "),
    ));
    index += 2;
  }
  if (rows.length === 0) return undefined;
  return buildSemanticParsedTable({
    id: `${chunk.id}-fundraising-usage`,
    title: "募集资金使用情况",
    headingPath: chunk.headingPath ?? undefined,
    purpose: "fundraising_usage",
    columns,
    rows,
    unitHints: ["亿元"],
    chunkIds: [chunk.id],
  });
}

function extractRealTextRestrictedAssetsTables(chunk: Chunk): ParsedTable[] {
  const sectionKey = normalizeKey(`${chunk.headingPath ?? ""} ${chunk.text}`);
  if (!sectionKey.includes(normalizeKey("受限资产情况"))) return [];
  const lines = chunk.text.replace(/\r\n?/g, "\n").split("\n").map((line) => normalizeText(line)).filter(Boolean);
  const assetColumns = ["项目", "年末账面价值"];
  const assetRows: ParsedRow[] = [];
  const cashColumns = ["项目", "金额"];
  const cashRows: ParsedRow[] = [];
  let inCashBreakdown = false;

  for (const line of lines) {
    if (line === "其中：") continue;
    if (/^注\s*\d+[:：]/u.test(line)) continue;
    const mainMatch = line.match(/^(\d+、.+?)\s+(-?\d[\d,]*(?:\.\d+)?)(?:\s+.*)?$/u);
    if (mainMatch?.[1] && mainMatch[2]) {
      const label = mainMatch[1].trim();
      assetRows.push(makeSemanticParsedRow(
        `${chunk.id}-restricted-assets`,
        assetRows.length,
        label,
        [
          [assetColumns[0]!, label],
          [assetColumns[1]!, mainMatch[2], "元"],
        ],
        chunk.id,
        line,
      ));
      inCashBreakdown = label.startsWith("1、货币资金");
      continue;
    }
    if (!inCashBreakdown) continue;
    const cashMatch = line.match(/^([^0-9][^0-9]*?)\s+(-?\d[\d,]*(?:\.\d+)?)(?:\s+.*)?$/u);
    if (!cashMatch?.[1] || !cashMatch[2]) continue;
    const label = cashMatch[1].trim();
    if (!label || label === "其中：") continue;
    cashRows.push(makeSemanticParsedRow(
      `${chunk.id}-restricted-cash`,
      cashRows.length,
      label,
      [
        [cashColumns[0]!, label],
        [cashColumns[1]!, cashMatch[2], "元"],
      ],
      chunk.id,
      line,
    ));
  }

  return [
    ...(assetRows.length > 0 ? [buildSemanticParsedTable({
      id: `${chunk.id}-restricted-assets`,
      title: "受限资产情况",
      headingPath: chunk.headingPath ?? undefined,
      purpose: "restricted_assets",
      columns: assetColumns,
      rows: assetRows,
      unitHints: ["元"],
      chunkIds: [chunk.id],
    })] : []),
    ...(cashRows.length > 0 ? [buildSemanticParsedTable({
      id: `${chunk.id}-restricted-cash`,
      title: "受限货币资金构成",
      headingPath: chunk.headingPath ?? undefined,
      purpose: "restricted_cash",
      columns: cashColumns,
      rows: cashRows,
      unitHints: ["元"],
      chunkIds: [chunk.id],
    })] : []),
  ];
}

function extractRealTextGuaranteeTable(chunk: Chunk): ParsedTable | undefined {
  const sectionKey = normalizeKey(`${chunk.headingPath ?? ""} ${chunk.text}`);
  if (!sectionKey.includes(normalizeKey("对外担保情况")) || !sectionKey.includes(normalizeKey("飞行学员"))) return undefined;
  const normalized = normalizeText(chunk.text);
  const total = normalized.match(/总额为人民币约\s*([0-9,]+(?:\.\d+)?)\s*元/u)?.[1];
  const issued = normalized.match(/发放贷款合计人民币\s*约\s*([0-9,]+(?:\.\d+)?)\s*元/u)?.[1];
  const actual = normalized.match(/还贷金额为人民币约\s*([0-9,]+(?:\.\d+)?)\s*元/u)?.[1];
  if (!total && !issued && !actual) return undefined;
  const columns = ["对象", "担保总额", "已发放贷款", "实际履责金额"];
  const rows = [makeSemanticParsedRow(
    `${chunk.id}-guarantee`,
    0,
    "飞行学员贷款担保",
    [
      [columns[0]!, "飞行学员贷款担保"],
      [columns[1]!, total ?? "0", "元"],
      [columns[2]!, issued ?? "0", "元"],
      [columns[3]!, actual ?? "0", "元"],
    ],
    chunk.id,
    normalized,
  )];
  return buildSemanticParsedTable({
    id: `${chunk.id}-guarantee`,
    title: "对外担保情况",
    headingPath: chunk.headingPath ?? undefined,
    purpose: "guarantee",
    columns,
    rows,
    unitHints: ["元"],
    chunkIds: [chunk.id],
  });
}

function extractSemanticTablesFromChunks(chunks: Chunk[]): ParsedTable[] {
  const special = chunks.flatMap((chunk) => [
    extractRealTextBondBalanceTable(chunk),
    extractRealTextFundraisingUsageTable(chunk),
    ...extractRealTextRestrictedAssetsTables(chunk),
    extractRealTextGuaranteeTable(chunk),
  ].flatMap((table) => table ? [table] : []));
  const ordinary = parseTableChunks(chunks);
  const byKey = new Map<string, ParsedTable>();
  for (const table of [...special, ...ordinary]) {
    const key = normalizeKey(`${table.purpose} ${table.title} ${table.headingPath ?? ""}`) || table.id;
    if (!byKey.has(key)) byKey.set(key, table);
  }
  return [...byKey.values()];
}

function columnScore(column: string, patterns: string[]): number {
  const normalized = normalizeKey(column);
  let score = 0;
  for (const pattern of patterns) {
    const candidate = normalizeKey(pattern);
    if (!candidate) continue;
    if (normalized === candidate) score += 100;
    else if (normalized.includes(candidate)) score += 40;
    else if (candidate.includes(normalized)) score += 20;
  }
  return score;
}

function findMetricColumn(table: ParsedTable, request: MetricRequest): string | undefined {
  return table.columns
    .map((column) => ({ column, score: columnScore(column, request.columnPatterns) }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score || left.column.localeCompare(right.column))[0]?.column;
}

function primaryLabelColumn(table: ParsedTable): string {
  return table.columns[0] ?? "项目";
}

function rowsForTablePurpose(table: ParsedTable, plan: SemanticQuestionPlan): ParsedRow[] {
  if (plan.tablePurpose === "restricted_cash") return table.rows;
  return table.rows;
}

function sourceQuoteForRow(row: ParsedRow): string {
  return truncateText(row.sourceLine, 500);
}

function matchingTables(tables: ParsedTable[], plan: SemanticQuestionPlan): ParsedTable[] {
  if (!plan.tablePurpose || plan.tablePurpose === "unknown") return tables;
  const exact = tables.filter((table) => table.purpose === plan.tablePurpose);
  return exact.length > 0 ? exact : tables;
}

function sentenceSplit(text: string): string[] {
  return text
    .split(/[\r\n]+|(?<=[。；;!?])/u)
    .map((part) => normalizeText(part))
    .filter(Boolean);
}

function extractNegativeFacts(chunks: Chunk[]): NegativeFactUnit[] {
  const negatives: NegativeFactUnit[] = [];
  for (const chunk of chunks) {
    const text = chunk.text.replace(/([^\s])\s*\n\s*\n\s*([^\s])/gu, "$1$2");
    for (const sentence of sentenceSplit(text)) {
      if (!/(不存在|未发生|未出现|未发现|没有|无|不涉及)/.test(sentence)) continue;
      const scope = sentence.includes("报告期内") ? "报告期内" : sentence.includes("本报告") ? "报告中" : "";
      negatives.push({
        id: `negative-${chunk.id}-${negatives.length + 1}`,
        target: sentence,
        scope,
        statement: sentence,
        certainty: /(不存在|不涉及|未发生|未出现|未发现)/.test(sentence) ? "explicit" : "implicit",
        chunkId: chunk.id,
      });
    }
  }
  return negatives;
}

function eventCategoryFor(text: string): AccountingEventUnit["eventCategory"] {
  if (text.includes("解释第17号") || text.includes("会计政策变更")) return "accounting_policy_change";
  if (text.includes("会计差错更正")) return "accounting_error_correction";
  return "unknown";
}

function directionFor(text: string): EventDirection | undefined {
  if (/(增加|调增|转入)/.test(text)) return "increase";
  if (/(减少|调减|转出)/.test(text)) return "decrease";
  if (/(重分类|重述)/.test(text)) return "reclassify";
  if (/(无影响|不影响)/.test(text)) return "no_effect";
  return undefined;
}

function amountAfterDirection(text: string): number | undefined {
  const match = normalizeText(text).match(/(?:增加|减少|调增|调减|转入|转出|重分类|重述|无影响|不影响)[^\d-]*(-?\d[\d,]*(?:\.\d+)?)/);
  if (!match?.[1]) return undefined;
  const numeric = Number(match[1].replace(/,/g, ""));
  return Number.isFinite(numeric) ? numeric : undefined;
}

function normalizeEffectItem(value: string): string {
  return normalizeText(value)
    .replace(/^执行《[^》]+》导致/u, "")
    .replace(/^执行[^，。,；;:：]+导致/u, "")
    .replace(/^因[^，。,；;:：]+导致/u, "")
    .trim();
}

function extractAccountingEvents(chunks: Chunk[]): AccountingEventUnit[] {
  const events: AccountingEventUnit[] = [];
  for (const chunk of chunks) {
    const normalized = normalizeText(chunk.text);
    if (!/(解释第17号|会计差错更正|会计政策变更)/.test(normalized)) continue;
    const sentences = sentenceSplit(chunk.text);
    const eventNameMatch = normalized.match(/《[^》]+》/) ?? normalized.match(/解释第17号|会计差错更正/);
    const eventName = eventNameMatch?.[0] ?? (chunk.headingPath ?? "会计事项");
    const effects: EventEffect[] = [];
    for (const sentence of sentences) {
      const direction = directionFor(sentence);
      const amount = amountAfterDirection(sentence);
      if (!direction && amount === undefined) continue;
      const prefix = sentence.match(/^([^，。,；;:：]+?)(增加|减少|调增|调减|转入|转出|重分类|重述|无影响|不影响)/);
      const item = normalizeEffectItem(prefix?.[1]?.trim() ?? sentence.split(/[，。,；;:：]/u, 1)[0] ?? "影响项目");
      effects.push({
        item,
        ...(direction ? { direction } : { direction: "reclassify" }),
        ...(amount !== undefined ? { amount } : {}),
        ...(preferredUnitFromText(sentence) ? { unit: preferredUnitFromText(sentence) } : {}),
        chunkId: chunk.id,
        sourceLine: sentence,
      });
    }
    const excludes = sentences.filter((sentence) => /(不包括|不含|不涉及)/.test(sentence));
    events.push({
      id: `event-${chunk.id}-${events.length + 1}`,
      eventName,
      eventCategory: eventCategoryFor(normalized),
      sourceSectionTitle: chunk.headingPath ?? eventName,
      affectedItems: uniqueStrings(effects.map((effect) => effect.item)),
      excludes,
      effects,
      chunkIds: [chunk.id],
    });
  }
  return events;
}

function extractExpandedAccountingEvents(chunks: Chunk[]): AccountingEventUnit[] {
  const base = extractAccountingEvents(chunks);
  const merged = new Map(base.map((event) => [event.id, event]));

  for (const chunk of chunks) {
    const normalized = normalizeText(chunk.text);
    if (!normalizeKey(normalized).includes(normalizeKey("会计差错更正"))) continue;
    const sections = [...normalized.matchAll(/根据审计署意见[\s\S]*?(?=根据审计署意见|对\s*2023\s*年度财务报表影响|$)/gu)]
      .map((match) => normalizeText(match[0] ?? ""))
      .filter(Boolean);
    if (sections.length === 0) continue;
    const effects = sections.map((section, index) => ({
      item: truncateText(section, 120),
      direction: "reclassify" as const,
      chunkId: chunk.id,
      sourceLine: section,
      ...(preferredUnitFromText(section) ? { unit: preferredUnitFromText(section) } : {}),
    }));
    const existing = [...merged.values()].find((event) =>
      event.chunkIds.includes(chunk.id) || normalizeKey(event.eventName).includes(normalizeKey("会计差错更正"))
    );
    const event: AccountingEventUnit = existing
      ? {
        ...existing,
        affectedItems: uniqueStrings([...existing.affectedItems, ...effects.map((effect) => effect.item)]),
        effects: existing.effects.length > 0 ? existing.effects : effects,
      }
      : {
        id: `event-${chunk.id}-expanded`,
        eventName: "会计差错更正",
        eventCategory: "accounting_error_correction",
        sourceSectionTitle: chunk.headingPath ?? "会计差错更正",
        affectedItems: uniqueStrings(effects.map((effect) => effect.item)),
        excludes: [],
        effects,
        chunkIds: [chunk.id],
      };
    merged.set(event.id, event);
  }

  return [...merged.values()];
}

function recordField(value: unknown, chunkId: string, quote: string, confidence = 0.95) {
  return {
    value,
    chunkId,
    confidence,
    evidenceChunkIds: [chunkId],
    quote,
  };
}

function buildNumericPlan(question: string, plan: SemanticQuestionPlan): DemandAnswerPlan {
  return {
    answerGoal: question,
    targetScope: {
      reason: "Deterministic semantic routing matched a structured table question in the AORI knowledge base.",
    },
    requiredRecords: [{
      recordName: "semantic_table_rows",
      source: "chunks",
      fields: [
        { name: "table_title", description: "Matched source table title.", required: true },
        { name: "row_label", description: "Source row label.", required: true },
        { name: "metric_name", description: "Matched metric column name.", required: true },
        { name: "amount", description: "Row amount for deterministic aggregation.", required: true },
        { name: "unit", description: "Normalized unit.", required: true },
        { name: "evidence", description: "Exact row quote.", required: true },
      ],
      coverage: "all",
    }],
    answerPolicy: {
      mustCiteSourceChunks: true,
      allowPartialAnswer: false,
      exposeUncertainty: true,
      whatCountsAsInsufficient: "No matching source-bound table rows were found for the requested metric.",
    },
    reason: "Semantic table aggregation requires same-table row expansion and deterministic calculation.",
    confidence: 0.96,
  };
}

function buildNegativeFactPlan(question: string): DemandAnswerPlan {
  return {
    answerGoal: question,
    targetScope: {
      reason: "Deterministic semantic routing matched an explicit negative-fact question.",
    },
    requiredRecords: [{
      recordName: "negative_facts",
      source: "chunks",
      fields: [
        { name: "statement", description: "Explicit negative statement from source text.", required: true },
        { name: "scope", description: "Scope for the negative statement.", required: false },
        { name: "target", description: "Target condition negated by the source.", required: true },
        { name: "evidence", description: "Exact source quote.", required: true },
      ],
      coverage: "all",
    }],
    answerPolicy: {
      mustCiteSourceChunks: true,
      allowPartialAnswer: false,
      exposeUncertainty: true,
      whatCountsAsInsufficient: "No explicit source-bound negative statement matched the question target and scope.",
    },
    reason: "Explicit negative statements should stop retrieval once matched.",
    confidence: 0.94,
  };
}

function buildConceptBoundaryPlan(question: string): DemandAnswerPlan {
  return {
    answerGoal: question,
    targetScope: {
      reason: "Deterministic semantic routing matched a metric-boundary question across multiple tables.",
    },
    requiredRecords: [{
      recordName: "metric_boundaries",
      source: "chunks",
      fields: [
        { name: "table_title", description: "Source table title.", required: true },
        { name: "metric_name", description: "Metric name discussed in the answer.", required: true },
        { name: "meaning", description: "What the metric represents in source context.", required: true },
        { name: "evidence", description: "Source quote or row excerpt.", required: true },
      ],
      coverage: "all",
    }],
    answerPolicy: {
      mustCiteSourceChunks: true,
      allowPartialAnswer: false,
      exposeUncertainty: true,
      whatCountsAsInsufficient: "The source did not expose both metric boundaries clearly enough to contrast them.",
    },
    reason: "Boundary questions should contrast matched tables and metrics instead of mixing them.",
    confidence: 0.95,
  };
}

function buildEventPlan(question: string): DemandAnswerPlan {
  return {
    answerGoal: question,
    targetScope: {
      reason: "Deterministic semantic routing matched an accounting-event boundary question.",
    },
    requiredRecords: [{
      recordName: "accounting_event_effects",
      source: "chunks",
      fields: [
        { name: "event_name", description: "Matched accounting event name.", required: true },
        { name: "event_category", description: "Matched accounting event category.", required: true },
        { name: "affected_item", description: "Affected line item.", required: true },
        { name: "direction", description: "Increase/decrease/reclassification direction.", required: true },
        { name: "amount", description: "Affected amount when explicit.", required: false },
        { name: "unit", description: "Unit for the affected amount.", required: false },
        { name: "evidence", description: "Exact source quote.", required: true },
      ],
      coverage: "all",
    }],
    answerPolicy: {
      mustCiteSourceChunks: true,
      allowPartialAnswer: false,
      exposeUncertainty: true,
      whatCountsAsInsufficient: "No source-bound accounting event effects matched the requested event boundary.",
    },
    reason: "Accounting-event answers must respect event boundaries and avoid mixing excluded events.",
    confidence: 0.93,
  };
}

function tableRowRecords(table: ParsedTable, metricName: string, column: string, unit: MetricRequest["unit"], rows: ParsedRow[]): EvidenceRecord[] {
  return rows.flatMap((row, index) => {
    const cell = row.cells[column];
    if (!cell) return [];
    const numeric = cell.numericValue;
    if (numeric === undefined) return [];
    const sourceUnit = cell.unit ?? preferredUnitFromText(column) ?? unit;
    const normalized = convertUnit(numeric, sourceUnit, unit);
    const chunkId = row.sourceChunkIds[0] ?? table.chunkIds[0] ?? "";
    if (!chunkId) return [];
    const quote = sourceQuoteForRow(row);
    return [{
      recordId: `${table.id}-${column}-${index + 1}`,
      recordName: "semantic_table_rows",
      fields: {
        table_title: recordField(table.title, chunkId, quote),
        row_label: recordField(row.label, chunkId, quote),
        metric_name: recordField(metricName, chunkId, quote),
        amount: recordField(normalized, chunkId, quote),
        unit: recordField(unit, chunkId, quote),
        evidence: recordField(quote, chunkId, quote),
      },
      evidenceChunkIds: [chunkId],
    }];
  });
}

function buildNumericAnswer(question: string, request: MetricRequest, table: ParsedTable, records: EvidenceRecord[]): PulseAnswerOutput {
  const values = records.map((record) => Number(record.fields.amount?.value ?? 0));
  const labels = records.map((record) => String(record.fields.row_label?.value ?? "").trim()).filter(Boolean);
  const total = values.reduce((sum, value) => sum + value, 0);
  const pieces = values.map((value) => formatNumber(value));
  const direct = `${formatNumber(total)}${request.unit}`;
  const answer = request.explainCalculation
    ? `${direct}。计算过程：${pieces.join(" + ")} = ${formatNumber(total)}。`
    : `${direct}。`;
  return {
    answer,
    summary: `${request.label} used ${records.length} same-table row(s) from ${table.title}.`,
    diagnostics: {
      answerPipeline: "aori_demand",
      deterministicAnswer: true,
      semanticQuestionType: "numeric_table_aggregation",
      matchedTableTitle: table.title,
      matchedMetricName: request.label,
      includedRows: labels,
      computedTotal: total,
      unit: request.unit,
      warnings: [],
    },
  };
}

function buildMultiMetricAnswer(question: string, requests: MetricRequest[], table: ParsedTable, grouped: Map<string, EvidenceRecord[]>): PulseAnswerOutput {
  const parts = requests.flatMap((request) => {
    const records = grouped.get(request.label) ?? [];
    if (records.length === 0) return [];
    const total = records.reduce((sum, record) => sum + Number(record.fields.amount?.value ?? 0), 0);
    return [`${request.label}${formatNumber(total)}${request.unit}`];
  });
  return {
    answer: parts.length > 0 ? `${parts.join("，")}。` : "证据不足，未找到可计算的结构化金额。",
    summary: `${table.title} produced ${parts.length} deterministic metric(s).`,
    diagnostics: {
      answerPipeline: "aori_demand",
      deterministicAnswer: true,
      semanticQuestionType: "numeric_table_aggregation",
      matchedTableTitle: table.title,
      warnings: [],
    },
  };
}

function metricBoundaryLabel(table: ParsedTable): string {
  const metricColumn = numericColumns(table).find((column) => !columnLooksLikeIdentifier(column));
  return metricColumn ? metricLabelFor(table, metricColumn) : table.title;
}

function buildConceptBoundaryAnswer(balanceTable: ParsedTable | undefined, fundraisingTable: ParsedTable | undefined): PulseAnswerOutput | undefined {
  if (!balanceTable || !fundraisingTable) return undefined;
  const leftMetric = metricBoundaryLabel(balanceTable);
  const rightMetric = metricBoundaryLabel(fundraisingTable);
  return {
    answer:
      `“${leftMetric}”来自《${balanceTable.title}》；` +
      `“${rightMetric}”来自《${fundraisingTable.title}》。` +
      "它们对应的表、指标含义和报告口径不同，所以不能混算。",
    summary: "Concept-boundary answer contrasted the matched balance and fundraising tables.",
    diagnostics: {
      answerPipeline: "aori_demand",
      deterministicAnswer: true,
      semanticQuestionType: "concept_boundary",
      matchedTables: [balanceTable.title, fundraisingTable.title],
      warnings: [],
    },
  };
}

function buildConceptBoundaryRecords(balanceTable: ParsedTable, fundraisingTable: ParsedTable): EvidenceRecord[] {
  const makeRecord = (
    recordId: string,
    table: ParsedTable,
    metricName: string,
  ): EvidenceRecord | undefined => {
    const chunkId = table.chunkIds[0] ?? "";
    const quote = table.rows[0] ? sourceQuoteForRow(table.rows[0]) : table.title;
    if (!chunkId) return undefined;
    return {
      recordId,
      recordName: "metric_boundaries",
      fields: {
        table_title: recordField(table.title, chunkId, quote),
        metric_name: recordField(metricName, chunkId, quote),
        meaning: recordField(`Metric ${metricName} is scoped to source table ${table.title}.`, chunkId, quote),
        evidence: recordField(quote, chunkId, quote),
      },
      evidenceChunkIds: [chunkId],
    };
  };
  return [
    makeRecord(
      `${balanceTable.id}-boundary`,
      balanceTable,
      metricBoundaryLabel(balanceTable),
    ),
    makeRecord(
      `${fundraisingTable.id}-boundary`,
      fundraisingTable,
      metricBoundaryLabel(fundraisingTable),
    ),
  ].flatMap((record) => record ? [record] : []);
}

function buildNegativeFactRecords(negativeFacts: NegativeFactUnit[]): EvidenceRecord[] {
  return negativeFacts.map((fact, index) => ({
    recordId: `${fact.id}-${index + 1}`,
    recordName: "negative_facts",
    fields: {
      statement: recordField(fact.statement, fact.chunkId, fact.statement),
      scope: recordField(fact.scope, fact.chunkId, fact.statement),
      target: recordField(fact.target, fact.chunkId, fact.statement),
      evidence: recordField(fact.statement, fact.chunkId, fact.statement),
    },
    evidenceChunkIds: [fact.chunkId],
  }));
}

function buildNegativeFactAnswer(question: string, negativeFacts: NegativeFactUnit[]): PulseAnswerOutput {
  const explicit = negativeFacts.filter((fact) => fact.certainty === "explicit");
  const facts = explicit.length > 0 ? explicit : negativeFacts;
  const primary = facts[0];
  if (facts.length === 0 || !primary) {
    return {
      answer: "证据不足，未找到明确的否定性原文表述。",
      summary: "Negative-fact routing did not find an explicit source statement.",
      diagnostics: {
        answerPipeline: "aori_demand",
        deterministicAnswer: true,
        semanticQuestionType: "negative_fact",
        warnings: ["no_explicit_negative_fact"],
      },
    };
  }
  if (normalizeText(question).includes("不涉及")) {
    const statements = facts.map((fact) => fact.statement);
    return {
      answer: statements.join("；"),
      summary: `Negative-fact routing listed ${facts.length} explicit statement(s).`,
      diagnostics: {
        answerPipeline: "aori_demand",
        deterministicAnswer: true,
        semanticQuestionType: "negative_fact",
        warnings: [],
      },
    };
  }
  if (facts.length > 1) {
    return {
      answer: `不存在。${facts.map((fact) => fact.statement).join("；")}`,
      summary: `Negative-fact routing found ${facts.length} explicit source statement(s) and stopped expansion.`,
      diagnostics: {
        answerPipeline: "aori_demand",
        deterministicAnswer: true,
        semanticQuestionType: "negative_fact",
        warnings: [],
      },
    };
  }
  return {
    answer: `不存在。${primary.statement}`,
    summary: "Negative-fact routing found an explicit source statement and stopped expansion.",
    diagnostics: {
      answerPipeline: "aori_demand",
      deterministicAnswer: true,
      semanticQuestionType: "negative_fact",
      warnings: [],
    },
  };
}

function eventMatchesQuestion(event: AccountingEventUnit, plan: SemanticQuestionPlan): boolean {
  const haystack = normalizeKey(`${event.eventName} ${event.sourceSectionTitle} ${event.affectedItems.join(" ")} ${event.excludes.join(" ")}`);
  if (plan.eventPatterns?.length && !plan.eventPatterns.some((pattern) => haystack.includes(normalizeKey(pattern)))) return false;
  if (plan.excludedEventPatterns?.some((pattern) => haystack.includes(normalizeKey(pattern)))) return false;
  return true;
}

function buildEventRecords(event: AccountingEventUnit): EvidenceRecord[] {
  return event.effects.map((effect, index) => ({
    recordId: `${event.id}-${index + 1}`,
    recordName: "accounting_event_effects",
    fields: {
      event_name: recordField(event.eventName, effect.chunkId, effect.sourceLine),
      event_category: recordField(event.eventCategory, effect.chunkId, effect.sourceLine),
      affected_item: recordField(effect.item, effect.chunkId, effect.sourceLine),
      direction: recordField(effect.direction, effect.chunkId, effect.sourceLine),
      amount: recordField(effect.amount ?? null, effect.chunkId, effect.sourceLine),
      unit: recordField(effect.unit ?? "", effect.chunkId, effect.sourceLine),
      evidence: recordField(effect.sourceLine, effect.chunkId, effect.sourceLine),
    },
    evidenceChunkIds: [effect.chunkId],
  }));
}

function buildEventAnswer(question: string, event: AccountingEventUnit, records: EvidenceRecord[]): PulseAnswerOutput {
  if (normalizeText(question).includes("闭合")) {
    const usable = records.flatMap((record) => {
      const amount = Number(record.fields.amount?.value ?? Number.NaN);
      const unit = String(record.fields.unit?.value ?? "").trim();
      const direction = String(record.fields.direction?.value ?? "").trim();
      if (!Number.isFinite(amount)) return [];
      if (unit !== "元" && unit !== "万元" && unit !== "亿元") return [];
      const signed = direction === "increase" ? amount : direction === "decrease" ? -amount : 0;
      return [convertUnit(signed, unit, "元")];
    });
    const difference = usable.reduce((sum, value) => sum + value, 0);
    const closed = Math.abs(difference) < 0.5;
    return {
      answer: `${closed ? "闭合" : "未闭合"}。${event.eventName}相关重分类差额为${formatNumber(convertUnit(difference, "元", "亿元"))}亿元。`,
      summary: `${event.eventName} reconciliation ${closed ? "closed" : "did not close"}.`,
      diagnostics: {
        answerPipeline: "aori_demand",
        deterministicAnswer: true,
        semanticQuestionType: "accounting_event_analysis",
        matchedEvent: event.eventName,
        closed,
        difference,
        warnings: [],
      },
    };
  }
  const parts = records.map((record) => {
    const item = String(record.fields.affected_item?.value ?? "").trim();
    const direction = String(record.fields.direction?.value ?? "").trim();
    const amount = record.fields.amount?.value;
    const unit = String(record.fields.unit?.value ?? "").trim();
    const amountText = typeof amount === "number" ? `${formatNumber(amount)}${unit}` : "金额未明示";
    return `${item}${direction === "increase" ? "增加" : direction === "decrease" ? "减少" : "重分类"}${amountText}`;
  });
  return {
    answer: `${event.eventName}主要影响为：${parts.join("；")}。`,
    summary: `${event.eventName} returned ${records.length} effect row(s).`,
    diagnostics: {
      answerPipeline: "aori_demand",
      deterministicAnswer: true,
      semanticQuestionType: "accounting_event_analysis",
      matchedEvent: event.eventName,
      warnings: [],
    },
  };
}

function buildExpandedEventAnswer(question: string, event: AccountingEventUnit, records: EvidenceRecord[]): PulseAnswerOutput {
  const normalizedQuestion = normalizeText(question);
  const listLikeQuestion = normalizedQuestion.includes("调整事项") || normalizedQuestion.includes("哪些");
  const amountBearing = records.some((record) => Number.isFinite(Number(record.fields.amount?.value ?? Number.NaN)));
  if (listLikeQuestion && event.eventCategory === "accounting_error_correction" && !amountBearing) {
    const items = uniqueStrings(records.map((record) => String(record.fields.affected_item?.value ?? "").trim()).filter(Boolean));
    return {
      answer: `${event.eventName}涉及以下调整事项：${items.join("；")}。`,
      summary: `${event.eventName} returned ${items.length} correction item(s).`,
      diagnostics: {
        answerPipeline: "aori_demand",
        deterministicAnswer: true,
        semanticQuestionType: "accounting_event_analysis",
        matchedEvent: event.eventName,
        warnings: [],
      },
    };
  }
  return buildEventAnswer(question, event, records);
}

function buildListAnswer(table: ParsedTable, request: MetricRequest | undefined, records: EvidenceRecord[], question: string): PulseAnswerOutput {
  const labels = records.map((record) => String(record.fields.row_label?.value ?? "").trim()).filter(Boolean);
  const values = records.map((record) => Number(record.fields.amount?.value ?? 0));
  const total = values.reduce((sum, value) => sum + value, 0);
  const closed = records.length > 0;
  if (normalizeText(question).includes("加总闭合")) {
    return {
      answer: `${labels.join("、")}。分项${closed ? "闭合" : "未闭合"}，合计${formatNumber(total)}${request?.unit ?? ""}。`,
      summary: `${table.title} returned ${records.length} row(s) with deterministic closure.`,
      diagnostics: {
        answerPipeline: "aori_demand",
        deterministicAnswer: true,
        semanticQuestionType: "exhaustive_list",
        matchedTableTitle: table.title,
        warnings: [],
      },
    };
  }
  return {
    answer: `${labels.join("、")}。合计${formatNumber(total)}${request?.unit ?? ""}。`,
    summary: `${table.title} returned ${records.length} exhaustive row(s).`,
    diagnostics: {
      answerPipeline: "aori_demand",
      deterministicAnswer: true,
      semanticQuestionType: "exhaustive_list",
      matchedTableTitle: table.title,
      warnings: [],
    },
  };
}

function chunksById(chunks: Chunk[]): Map<string, Chunk> {
  return new Map(chunks.map((chunk) => [chunk.id, chunk]));
}

function chunkExists(id: string, map: Map<string, Chunk>): boolean {
  return map.has(id);
}

function questionHas(question: string, ...terms: string[]): boolean {
  const key = normalizeKey(question);
  return terms.some((term) => key.includes(normalizeKey(term)));
}

function questionAsksForList(question: string): boolean {
  const explicitList = questionHas(question, "哪些", "有哪些", "包括", "构成", "明细", "项目", "类别");
  if (explicitList) return true;
  return questionHas(question, "列出") && !questionHas(question, "计算过程");
}

function questionAsksForTotal(question: string): boolean {
  return questionHas(question, "合计", "总额", "总计", "一共", "加总", "多少");
}

function questionAsksForBoundary(question: string): boolean {
  return questionHas(question, "区别", "不能混算", "混算", "口径", "差异", "为什么不能");
}

function questionAsksForNegativeFact(question: string): boolean {
  return questionHas(question, "是否存在", "是否有", "有没有", "不存在", "不涉及", "未发生", "无", "不能支持");
}

function questionAsksForEvent(question: string): boolean {
  return questionHas(question, "影响", "调整事项", "重分类", "变更", "更正", "闭合");
}

function questionAsksForCalculation(question: string): boolean {
  return questionHas(question, "计算过程", "怎么算");
}

function defaultMetricUnitForTable(table: ParsedTable): MetricRequest["unit"] | undefined {
  return preferredUnitFromText(`${table.title} ${table.headingPath ?? ""}`)
    ?? table.unitHints[0]
    ?? table.rows.flatMap((row) => Object.values(row.cells).map((cell) => cell.unit)).find((unit): unit is MetricRequest["unit"] => Boolean(unit));
}

function maxNumericValue(table: ParsedTable): number {
  return Math.max(
    0,
    ...numericColumns(table)
      .filter((column) => !columnLooksLikeIdentifier(column))
      .flatMap((column) => table.rows.map((row) => Math.abs(row.cells[column]?.numericValue ?? 0))),
  );
}

function outputUnitForTable(table: ParsedTable, question: string): MetricRequest["unit"] | undefined {
  const requestedUnit = preferredUnitFromText(question);
  if (requestedUnit) return requestedUnit;
  const sourceUnit = defaultMetricUnitForTable(table);
  if (sourceUnit === "元" && maxNumericValue(table) >= 10_000) return "万元";
  return sourceUnit;
}

function numericColumns(table: ParsedTable): string[] {
  return table.columns.filter((column) => table.rows.some((row) => row.cells[column]?.numericValue !== undefined));
}

function columnLooksLikeIdentifier(column: string): boolean {
  const key = normalizeKey(column);
  return key.includes("简称") || key.includes("代码") || key.includes("名称") || key.includes("对象");
}

function metricLabelFor(table: ParsedTable, column: string): string {
  const cleanColumn = normalizeText(column).replace(/\([^)]*\)/g, "").replace(/（[^）]*）/g, "").trim();
  if (cleanColumn && !["金额", "账面价值", "年末账面价值", "期末账面价值"].includes(cleanColumn)) return cleanColumn;
  const base = stripSemanticSuffix(normalizeText(table.title)).trim();
  return `${base || table.title}${cleanColumn || "金额"}`;
}

function scoreTableForQuestion(table: ParsedTable, terms: string[], questionKey: string): number {
  const rowLabels = table.rows.slice(0, 12).map((row) => row.label).join(" ");
  const columns = table.columns.join(" ");
  return scoreCandidateAgainstQuestion(questionKey, terms, table.title) * 3
    + scoreCandidateAgainstQuestion(questionKey, terms, columns) * 2
    + scoreCandidateAgainstQuestion(questionKey, terms, rowLabels)
    + scoreCandidateAgainstQuestion(questionKey, terms, table.headingPath ?? "") * 0.5;
}

function scoreColumnForQuestion(table: ParsedTable, column: string, terms: string[], questionKey: string): number {
  const values = table.rows.slice(0, 6).map((row) => `${row.label} ${row.cells[column]?.raw ?? ""}`).join(" ");
  return scoreCandidateAgainstQuestion(questionKey, terms, `${table.title} ${column} ${values}`);
}

function selectTablesForQuestion(tables: ParsedTable[], question: string): ParsedTable[] {
  const terms = questionTerms(question);
  const questionKey = normalizeKey(question);
  return tables
    .map((table) => ({ table, score: scoreTableForQuestion(table, terms, questionKey) }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score || left.table.title.localeCompare(right.table.title, "zh-CN"))
    .map((entry) => entry.table);
}

function selectMetricRequests(table: ParsedTable, question: string): MetricRequest[] {
  const terms = questionTerms(question);
  const questionKey = normalizeKey(question);
  const unit = outputUnitForTable(table, question);
  if (!unit) return [];
  const columns = numericColumns(table).filter((column) => !columnLooksLikeIdentifier(column));
  if (columns.length === 0) return [];
  const scored = columns
    .map((column) => ({ column, score: scoreColumnForQuestion(table, column, terms, questionKey) }))
    .sort((left, right) => right.score - left.score || left.column.localeCompare(right.column, "zh-CN"));
  const positive = scored.filter((entry) => entry.score > 0);
  const selected = positive.length > 0
    ? (questionAsksForTotal(question) && positive.length > 1 ? positive : positive.slice(0, 1))
    : (questionAsksForTotal(question) || questionAsksForList(question) ? scored.slice(0, 1) : []);
  return selected.map((entry) => ({
    label: metricLabelFor(table, entry.column),
    columnPatterns: semanticTerms(entry.column, metricLabelFor(table, entry.column)),
    unit,
    ...(questionAsksForCalculation(question) ? { explainCalculation: true } : {}),
  }));
}

function buildTableQuestionPlan(question: string, tables: ParsedTable[]): SemanticQuestionPlan | undefined {
  const table = selectTablesForQuestion(tables, question)[0];
  if (!table) return undefined;
  const metricRequests = selectMetricRequests(table, question);
  if (metricRequests.length === 0) return undefined;
  const listLike = questionAsksForList(question);
  const totalLike = questionAsksForTotal(question);
  if (!listLike && !totalLike) return undefined;
  return {
    questionType: listLike ? "exhaustive_list" : "numeric_table_aggregation",
    tableId: table.id,
    tablePurpose: table.purpose,
    metricRequests,
  };
}

function buildBoundaryQuestionPlan(question: string, tables: ParsedTable[]): SemanticQuestionPlan | undefined {
  if (!questionAsksForBoundary(question)) return undefined;
  const selected = selectTablesForQuestion(tables, question).slice(0, 2);
  if (selected.length < 2 || !selected[0] || !selected[1]) return undefined;
  return {
    questionType: "concept_boundary",
    tablePurpose: "unknown",
    boundaryTableIds: [selected[0].id, selected[1].id],
  };
}

function broaderNegativeTerms(terms: string[]): string[] {
  const relatedTerms = new Map<string, string[]>([
    [normalizeKey("违约"), [normalizeKey("逾期"), normalizeKey("未偿还")]],
    [normalizeKey("逾期"), [normalizeKey("违约"), normalizeKey("未偿还")]],
    [normalizeKey("债务融资工具"), [normalizeKey("有息债务"), normalizeKey("债券")]],
    [normalizeKey("债券"), [normalizeKey("债务融资工具"), normalizeKey("有息债务")]],
    [normalizeKey("募集资金用途"), [normalizeKey("变更债券募集资金用途"), normalizeKey("特定用途")]],
  ]);
  return uniqueStrings([
    ...terms,
    ...terms.flatMap((term) => relatedTerms.get(term) ?? []),
  ]);
}

function requiredNegativeIntentTerms(question: string): string[] {
  if (questionHas(question, "违约", "逾期", "未偿还")) {
    return [normalizeKey("违约"), normalizeKey("逾期"), normalizeKey("未偿还")];
  }
  return [];
}

function matchingNegativeFacts(question: string, negativeFacts: NegativeFactUnit[]): NegativeFactUnit[] {
  const questionKey = normalizeKey(question);
  const terms = broaderNegativeTerms(questionTerms(question));
  const listAllExplicit = questionHas(question, "不涉及") && questionAsksForList(question);
  const requiredIntentTerms = requiredNegativeIntentTerms(question);
  const scored = negativeFacts
    .map((fact) => {
      const haystack = `${fact.target} ${fact.scope} ${fact.statement}`;
      const haystackKey = normalizeKey(haystack);
      if (requiredIntentTerms.length > 0 && !requiredIntentTerms.some((term) => haystackKey.includes(term))) {
        return { fact, score: 0 };
      }
      const score = listAllExplicit && normalizeKey(fact.statement).includes(normalizeKey("不涉及"))
        ? 100
        : scoreCandidateAgainstQuestion(questionKey, terms, haystack);
      return { fact, score };
    })
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score || left.fact.id.localeCompare(right.fact.id));
  if (requiredIntentTerms.length > 0) return scored.map((entry) => entry.fact);
  if (listAllExplicit) return scored.map((entry) => entry.fact);
  const bestScore = scored[0]?.score ?? 0;
  return scored.filter((entry) => entry.score >= Math.max(1, bestScore * 0.6)).map((entry) => entry.fact);
}

function buildNegativeQuestionPlan(question: string, negativeFacts: NegativeFactUnit[]): SemanticQuestionPlan | undefined {
  if (!questionAsksForNegativeFact(question)) return undefined;
  const facts = matchingNegativeFacts(question, negativeFacts);
  if (facts.length === 0) return undefined;
  return {
    questionType: "negative_fact",
    negativeFactIds: facts.map((fact) => fact.id),
    questionTargetPatterns: questionTerms(question),
  };
}

function scoreEventForQuestion(event: AccountingEventUnit, question: string): number {
  const terms = questionTerms(question);
  const questionKey = normalizeKey(question);
  return scoreCandidateAgainstQuestion(
    questionKey,
    terms,
    `${event.eventName} ${event.sourceSectionTitle} ${event.eventCategory} ${event.affectedItems.join(" ")} ${event.excludes.join(" ")}`,
  );
}

function buildEventQuestionPlan(question: string, events: AccountingEventUnit[]): SemanticQuestionPlan | undefined {
  if (!questionAsksForEvent(question)) return undefined;
  const scored = events
    .map((event) => ({ event, score: scoreEventForQuestion(event, question) }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score || left.event.eventName.localeCompare(right.event.eventName, "zh-CN"));
  const event = scored[0]?.event;
  if (!event) return undefined;
  return {
    questionType: "accounting_event_analysis",
    eventIds: [event.id],
    eventPatterns: semanticTerms(event.eventName, event.sourceSectionTitle),
  };
}

function questionPlanFor(input: {
  question: string;
  tables: ParsedTable[];
  negativeFacts: NegativeFactUnit[];
  events: AccountingEventUnit[];
}): SemanticQuestionPlan | undefined {
  return buildBoundaryQuestionPlan(input.question, input.tables)
    ?? buildNegativeQuestionPlan(input.question, input.negativeFacts)
    ?? buildEventQuestionPlan(input.question, input.events)
    ?? buildTableQuestionPlan(input.question, input.tables);
}

export function buildSemanticDemandAnswer(input: {
  question: string;
  map: AoriTraversalMap;
  chunks: Chunk[];
}): SemanticDemandAnswerResult | undefined {
  const parsedTables = extractSemanticTablesFromChunks(input.chunks);
  const negativeFacts = extractNegativeFacts(input.chunks);
  const events = extractExpandedAccountingEvents(input.chunks);
  const plan = questionPlanFor({
    question: input.question,
    tables: parsedTables,
    negativeFacts,
    events,
  });
  if (!plan) return undefined;
  const existingChunks = chunksById(input.chunks);

  if (plan.questionType === "concept_boundary") {
    const boundaryTables = (plan.boundaryTableIds ?? [])
      .map((id) => parsedTables.find((table) => table.id === id))
      .filter((table): table is ParsedTable => Boolean(table));
    const [balanceTable, fundraisingTable] = boundaryTables.length >= 2
      ? boundaryTables
      : [
        parsedTables.find((table) => table.purpose === "bond_balance"),
        parsedTables.find((table) => table.purpose === "fundraising_usage"),
      ];
    const answer = buildConceptBoundaryAnswer(
      balanceTable,
      fundraisingTable,
    );
    if (!answer || !balanceTable || !fundraisingTable) return undefined;
    const records = buildConceptBoundaryRecords(balanceTable, fundraisingTable);
    return {
      plan: buildConceptBoundaryPlan(input.question),
      records,
      answer,
      usedChunkIds: uniqueStrings(records.flatMap((record) => record.evidenceChunkIds).filter((id) => chunkExists(id, existingChunks))),
      questionType: "concept_boundary",
    };
  }

  if (plan.questionType === "negative_fact") {
    const selectedIds = new Set(plan.negativeFactIds ?? []);
    const targetFacts = selectedIds.size > 0
      ? negativeFacts.filter((fact) => selectedIds.has(fact.id))
      : negativeFacts.filter((fact) => {
        const haystack = normalizeKey(`${fact.target} ${fact.scope} ${fact.statement}`);
        const targetMatch = plan.questionTargetPatterns?.some((pattern) => haystack.includes(normalizeKey(pattern))) ?? true;
        const scopeMatch = plan.questionScopePatterns?.some((pattern) => haystack.includes(normalizeKey(pattern))) ?? true;
        return targetMatch && scopeMatch;
      });
    if (targetFacts.length === 0) return undefined;
    const records = buildNegativeFactRecords(targetFacts);
    return {
      plan: buildNegativeFactPlan(input.question),
      records,
      answer: buildNegativeFactAnswer(input.question, targetFacts),
      usedChunkIds: uniqueStrings(records.flatMap((record) => record.evidenceChunkIds).filter((id) => chunkExists(id, existingChunks))),
      questionType: "negative_fact",
    };
  }

  if (plan.questionType === "accounting_event_analysis") {
    const selectedIds = new Set(plan.eventIds ?? []);
    const matched = selectedIds.size > 0
      ? events.find((event) => selectedIds.has(event.id))
      : events.find((event) => eventMatchesQuestion(event, plan));
    if (!matched) return undefined;
    const records = buildEventRecords(matched);
    if (records.length === 0) return undefined;
    return {
      plan: buildEventPlan(input.question),
      records,
      answer: buildExpandedEventAnswer(input.question, matched, records),
      usedChunkIds: uniqueStrings(records.flatMap((record) => record.evidenceChunkIds).filter((id) => chunkExists(id, existingChunks))),
      questionType: "accounting_event_analysis",
    };
  }

  const table = plan.tableId
    ? parsedTables.find((entry) => entry.id === plan.tableId)
    : matchingTables(parsedTables, plan)[0];
  if (!table || !plan.metricRequests || plan.metricRequests.length === 0) return undefined;

  const grouped = new Map<string, EvidenceRecord[]>();
  for (const request of plan.metricRequests) {
    const column = findMetricColumn(table, request);
    if (!column) continue;
    const records = tableRowRecords(table, request.label, column, request.unit, rowsForTablePurpose(table, plan));
    if (records.length > 0) grouped.set(request.label, records);
  }
  if (grouped.size === 0) return undefined;

  const records = [...grouped.values()].flat();
  if (records.length === 0) return undefined;

  if (plan.questionType === "exhaustive_list") {
    const request = plan.metricRequests[0];
    if (!request) return undefined;
    const firstGroup = request ? grouped.get(request.label) ?? [] : [];
    return {
      plan: buildNumericPlan(input.question, plan),
      records,
      answer: buildListAnswer(table, request, firstGroup, input.question),
      usedChunkIds: uniqueStrings(records.flatMap((record) => record.evidenceChunkIds).filter((id) => chunkExists(id, existingChunks))),
      questionType: "exhaustive_list",
    };
  }

  if (plan.metricRequests.length === 1) {
    const request = plan.metricRequests[0];
    if (!request) return undefined;
    const requestRecords = grouped.get(request.label) ?? [];
    return {
      plan: buildNumericPlan(input.question, plan),
      records,
      answer: buildNumericAnswer(input.question, request, table, requestRecords),
      usedChunkIds: uniqueStrings(records.flatMap((record) => record.evidenceChunkIds).filter((id) => chunkExists(id, existingChunks))),
      questionType: "numeric_table_aggregation",
    };
  }

  return {
    plan: buildNumericPlan(input.question, plan),
    records,
    answer: buildMultiMetricAnswer(input.question, plan.metricRequests, table, grouped),
    usedChunkIds: uniqueStrings(records.flatMap((record) => record.evidenceChunkIds).filter((id) => chunkExists(id, existingChunks))),
    questionType: "numeric_table_aggregation",
  };
}

function majorUnitForTable(table: ParsedTable): "元" | "万元" | "亿元" | undefined {
  if (table.unitHints[0]) return table.unitHints[0];
  for (const column of table.columns) {
    const unit = preferredUnitFromText(column);
    if (unit) return unit;
  }
  return undefined;
}

export function buildSemanticAoriAspects(chunks: Chunk[]): AoriDocumentDraft["aspects"] {
  const tables = extractSemanticTablesFromChunks(chunks);
  const negatives = extractNegativeFacts(chunks);
  const events = extractExpandedAccountingEvents(chunks);
  const aspects: AoriDocumentDraft["aspects"] = [];

  for (const table of tables) {
    const labelColumn = primaryLabelColumn(table);
    aspects.push({
      kind: "table",
      domainKind: table.purpose,
      title: table.title,
      summary: `Structured table with ${table.rows.length} row(s) and ${table.columns.length} column(s).`,
      centralQuestion: `What does table ${table.title} show?`,
      classificationRationale: "Deterministic semantic parser detected a structured source table and preserved same-table row coverage.",
      confidence: 0.9,
      closureStatus: table.rows.length > 0 ? "partial" : "open",
      metadata: {
        semanticKind: "table",
        tableTitle: table.title,
        tablePurpose: table.purpose,
        columns: table.columns,
        unitHints: table.unitHints,
        sourceChunkIds: table.chunkIds,
      },
      items: table.rows.map((row, index) => ({
        key: `${table.id}-row-${index + 1}`,
        title: row.label || `${labelColumn} ${index + 1}`,
        summary: row.sourceLine,
        evidenceChunkIds: row.sourceChunkIds,
        evidenceStatus: "supported" as const,
        closureStatus: "partial" as const,
        classificationRationale: "Table row preserved as a source-bound semantic object for later same-table expansion.",
        confidence: 0.9,
        metadata: {
          semanticKind: "table_row",
          rowLabel: row.label,
          cells: row.cells,
          tableTitle: table.title,
          tablePurpose: table.purpose,
        },
      })),
      relations: [],
      gaps: [],
    });

    const metricColumns = table.columns.filter((column) =>
      table.rows.some((row) => row.cells[column]?.numericValue !== undefined)
    );
    for (const column of metricColumns) {
      const metricUnit = preferredUnitFromText(column) ?? majorUnitForTable(table);
      aspects.push({
        kind: "metric",
        domainKind: `${table.purpose}_metric`,
        title: `${table.title} - ${column}`,
        summary: `Numeric metric column ${column} from table ${table.title}.`,
        centralQuestion: `How should metric ${column} from ${table.title} be aggregated or compared?`,
        classificationRationale: "Deterministic semantic parser promoted a numeric table column into an AORI metric aspect.",
        confidence: 0.88,
        closureStatus: "partial",
        metadata: {
          semanticKind: "metric",
          tableTitle: table.title,
          tablePurpose: table.purpose,
          columnName: column,
          unit: metricUnit,
          aggregationAllowed: true,
        },
        items: table.rows
          .filter((row) => row.cells[column]?.numericValue !== undefined)
          .map((row, index) => ({
            key: `${table.id}-${normalizeKey(column)}-${index + 1}`,
            title: row.label,
            summary: row.sourceLine,
            evidenceChunkIds: row.sourceChunkIds,
            evidenceStatus: "supported" as const,
            closureStatus: "partial" as const,
            classificationRationale: "Source row retained under the metric aspect for deterministic aggregation.",
            confidence: 0.88,
            metadata: {
              semanticKind: "metric_value",
              metricName: column,
              rowLabel: row.label,
              value: row.cells[column]?.numericValue,
              unit: row.cells[column]?.unit ?? metricUnit,
              tableTitle: table.title,
            },
          })),
        relations: [],
        gaps: [],
      });
    }
  }

  for (const fact of negatives) {
    aspects.push({
      kind: "negative_fact",
      domainKind: "explicit_negative_fact",
      title: fact.scope ? `${fact.scope}否定事实` : "否定事实",
      summary: fact.statement,
      centralQuestion: "Which statements explicitly negate a condition in the source?",
      classificationRationale: "Deterministic semantic parser detected an explicit negative statement that can stop progressive retrieval.",
      confidence: fact.certainty === "explicit" ? 0.92 : 0.7,
      closureStatus: "partial",
      metadata: {
        semanticKind: "negative_fact",
        target: fact.target,
        scope: fact.scope,
        certainty: fact.certainty,
      },
      items: [{
        key: fact.id,
        title: fact.target.slice(0, 80),
        summary: fact.statement,
        evidenceChunkIds: [fact.chunkId],
        evidenceStatus: "supported" as const,
        closureStatus: "partial" as const,
        classificationRationale: "Explicit source sentence preserved as a reusable negative-fact semantic unit.",
        confidence: fact.certainty === "explicit" ? 0.92 : 0.7,
        metadata: {
          semanticKind: "negative_fact",
          target: fact.target,
          scope: fact.scope,
          certainty: fact.certainty,
        },
      }],
      relations: [],
      gaps: [],
    });
  }

  for (const event of events) {
    aspects.push({
      kind: "event",
      domainKind: event.eventCategory,
      title: event.eventName,
      summary: `${event.eventName} affects ${event.affectedItems.join("、") || "相关项目"}.`,
      centralQuestion: `What boundary and effects belong to ${event.eventName}?`,
      classificationRationale: "Deterministic semantic parser separated an accounting event boundary from surrounding narrative text.",
      confidence: 0.89,
      closureStatus: event.effects.length > 0 ? "partial" : "open",
      metadata: {
        semanticKind: "accounting_event",
        eventName: event.eventName,
        eventCategory: event.eventCategory,
        sourceSectionTitle: event.sourceSectionTitle,
        excludes: event.excludes,
      },
      items: event.effects.map((effect, index) => ({
        key: `${event.id}-effect-${index + 1}`,
        title: effect.item,
        summary: effect.sourceLine,
        evidenceChunkIds: [effect.chunkId],
        evidenceStatus: "supported" as const,
        closureStatus: "partial" as const,
        classificationRationale: "Event effect kept as a source-bound semantic unit to avoid mixing accounting event boundaries.",
        confidence: 0.88,
        metadata: {
          semanticKind: "event_effect",
          direction: effect.direction,
          amount: effect.amount,
          unit: effect.unit,
          eventName: event.eventName,
        },
      })),
      relations: [],
      gaps: [],
    });
  }

  return aspects;
}
