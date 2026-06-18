import { randomUUID } from "node:crypto";
import type {
  AoriDocumentDraft,
  Chunk,
  EventSemanticUnitDraft,
  MetricSemanticUnitDraft,
  NegativeFactSemanticUnitDraft,
  ReconciliationSemanticUnitDraft,
  ReflectiveFindingDraft,
  SemanticUnitDraft,
  TableSemanticUnitDraft,
  TableCell,
  TableColumn,
  TableRow,
} from "@agent-thinking/contracts";

interface SemanticIndexInput {
  libraryId: string;
  documentId: string;
  versionId: string;
  chunks: Chunk[];
}

interface DraftSemanticOutput {
  semanticUnits: NonNullable<AoriDocumentDraft["semanticUnits"]>;
  reflectiveFindings: NonNullable<AoriDocumentDraft["reflectiveFindings"]>;
}

type IdentifiedTableSemanticUnitDraft = TableSemanticUnitDraft & { id: string };
type IdentifiedReconciliationSemanticUnitDraft = ReconciliationSemanticUnitDraft & { id: string };

function uniqueStrings(values: Array<string | undefined | null>): string[] {
  return [...new Set(values.map((value) => value?.trim() ?? "").filter(Boolean))];
}

function truncateText(value: string, max: number): string {
  const text = value.trim();
  return text.length > max ? text.slice(0, max - 1).trimEnd() : text;
}

function normalizeColumnName(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/\s+/g, "")
    .replace(/[（(].*?[)）]/g, "")
    .trim()
    .toLowerCase();
}

function inferMetricRole(name: string): "balance" | "amount" | "change" | "planned" | "actual" | "remaining" | "total" | "ratio" | "status" | "unknown" {
  const normalized = name.normalize("NFKC");
  if (/余额/.test(normalized)) return "balance";
  if (/募集|发生额|金额|合计/.test(normalized)) return "amount";
  if (/变动|增减|调整/.test(normalized)) return "change";
  if (/计划|预计/.test(normalized)) return "planned";
  if (/实际|已/.test(normalized)) return "actual";
  if (/剩余|未/.test(normalized)) return "remaining";
  if (/合计|总额|总计/.test(normalized)) return "total";
  if (/率|比例|占比/.test(normalized)) return "ratio";
  if (/状态|是否/.test(normalized)) return "status";
  return "unknown";
}

function inferTableSemanticRole(column: string): TableColumn["semanticRole"] {
  const normalized = column.normalize("NFKC");
  if (/项目|名称|类别|品种|简称/.test(normalized)) return "label";
  if (/日期|时间|期间/.test(normalized)) return "date";
  if (/状态|是否/.test(normalized)) return "status";
  if (/说明|备注/.test(normalized)) return "description";
  if (/合计|总额|总计/.test(normalized)) return "total";
  if (/金额|余额|比例|利率|数量|资金/.test(normalized)) return "metric";
  return "unknown";
}

function detectUnit(text: string): string | undefined {
  const match = /(单位[:：]\s*([^\s|]+))|(亿元|万元|元|%)/u.exec(text);
  return match?.[2] || match?.[3] || undefined;
}

function parseCellValue(raw: string): TableCell {
  const cleaned = raw.trim();
  const numeric = cleaned.replaceAll(",", "");
  if (/^(true|false)$/i.test(cleaned)) return { raw, value: /^true$/i.test(cleaned), normalizedValue: /^true$/i.test(cleaned) };
  if (/^-?\d+(?:\.\d+)?$/.test(numeric)) {
    const value = Number(numeric);
    return Number.isFinite(value) ? { raw, value, normalizedValue: value } : { raw };
  }
  return { raw, value: cleaned, normalizedValue: cleaned };
}

function splitMarkdownRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return trimmed.split("|").map((part) => part.trim());
}

function cellText(cell: TableCell | undefined): string {
  const value = cell?.normalizedValue ?? cell?.value ?? cell?.raw ?? "";
  return String(value).trim();
}

function cellNumber(cell: TableCell | undefined): number {
  const value = cell?.normalizedValue ?? cell?.value;
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    const numeric = Number(value.replaceAll(",", ""));
    return Number.isFinite(numeric) ? numeric : NaN;
  }
  const raw = cell?.raw.replaceAll(",", "") ?? "";
  const numeric = Number(raw);
  return Number.isFinite(numeric) ? numeric : NaN;
}

function parseMarkdownTable(chunk: Chunk): {
  title: string;
  columns: TableColumn[];
  rows: TableRow[];
  unitHints: string[];
  findings: ReflectiveFindingDraft[];
} | undefined {
  const lines = chunk.text.split("\n").map((line) => line.trim()).filter(Boolean);
  const tableLines = lines.filter((line) => line.includes("|"));
  if (tableLines.length < 2) return undefined;
  const headerCells = splitMarkdownRow(tableLines[0] ?? "");
  if (headerCells.length < 2) return undefined;
  const dataLines = tableLines.slice(1).filter((line) => !/^[:\-|\s]+$/.test(line));
  if (dataLines.length === 0) return undefined;
  const unitHint = detectUnit(chunk.text);
  const columns: TableColumn[] = headerCells.map((name) => ({
    name,
    normalizedName: normalizeColumnName(name),
    ...(unitHint ? { unit: unitHint } : {}),
    semanticRole: inferTableSemanticRole(name),
  }));
  const rows: TableRow[] = dataLines.map((line, index) => {
    const values = splitMarkdownRow(line);
    const cells = Object.fromEntries(columns.map((column, columnIndex) => [
      column.name,
      parseCellValue(values[columnIndex] ?? ""),
    ]));
    return {
      id: `table-row-${index + 1}`,
      ordinal: index,
      cells,
      sourceChunkIds: [chunk.id],
    };
  });
  const titleLine = lines.find((line) => !line.includes("|") && line.length <= 120) ?? chunk.headingPath ?? "Detected table";
  const findings: ReflectiveFindingDraft[] = [];
  if (rows.length < 2) {
    findings.push({
      id: `finding-${randomUUID()}`,
      semanticUnitId: "",
      findingType: "incomplete_table",
      severity: "medium",
      message: "Detected markdown-like table has fewer than two data rows.",
    });
  }
  return {
    title: truncateText(titleLine, 240),
    columns,
    rows,
    unitHints: unitHint ? [unitHint] : [],
    findings,
  };
}

function parseColonMetricChunk(chunk: Chunk): DraftSemanticOutput {
  const lines = chunk.text.split("\n").map((line) => line.trim()).filter(Boolean);
  const metricLines = lines.filter((line) => /[:：]/.test(line) && /\d/.test(line));
  if (metricLines.length < 2) return { semanticUnits: [], reflectiveFindings: [] };
  const unit = detectUnit(chunk.text);
  const columns: TableColumn[] = [
    { name: "label", normalizedName: "label", semanticRole: "label" },
    { name: "value", normalizedName: "value", ...(unit ? { unit } : {}), semanticRole: "metric" },
  ];
  const rows: TableRow[] = metricLines.map((line, index) => {
    const [rawLabel, rawValue] = line.split(/[:：]/, 2);
    return {
      id: `table-row-${index + 1}`,
      ordinal: index,
      cells: {
        label: parseCellValue(rawLabel ?? ""),
        value: parseCellValue(rawValue ?? ""),
      },
      sourceChunkIds: [chunk.id],
    };
  });
  const tableId = `semantic-table-${randomUUID()}`;
  const tableUnit: IdentifiedTableSemanticUnitDraft = {
    id: tableId,
    kind: "table",
    title: chunk.headingPath ?? "Detected metric block",
    summary: truncateText(chunk.text.slice(0, 600), 3000),
    sourceChunkIds: [chunk.id],
    sourceNodeIds: chunk.documentTreeNodeId ? [chunk.documentTreeNodeId] : [],
    confidence: 0.55,
    reflectionStatus: rows.length >= 2 ? "ok" : "needs_review",
    reflectionNotes: rows.length >= 2 ? [] : ["Detected metric block has limited row coverage."],
    tableTitle: chunk.headingPath ?? "Detected metric block",
    sectionTitle: chunk.headingPath ?? undefined,
    columns,
    rows,
    unitHints: unit ? [unit] : [],
    tableRole: "financial_metric_table",
  };
  const metricUnits: MetricSemanticUnitDraft[] = rows.map((row) => {
    const metricName = String(row.cells.label?.value ?? row.cells.label?.raw ?? "").trim();
    return {
      id: `semantic-metric-${randomUUID()}`,
      kind: "metric",
      title: metricName,
      summary: `${metricName} extracted from structured metric block.`,
      sourceChunkIds: [chunk.id],
      sourceNodeIds: chunk.documentTreeNodeId ? [chunk.documentTreeNodeId] : [],
      confidence: 0.52,
      reflectionStatus: metricName ? "ok" : "needs_review",
      reflectionNotes: metricName ? [] : ["Metric name could not be normalized cleanly."],
      metricName,
      tableId,
      tableTitle: tableUnit.tableTitle,
      columnName: "value",
      unit,
      metricRole: inferMetricRole(metricName),
      aggregationAllowed: true,
      aggregationType: "sum",
    };
  });
  const reconciliation = buildReconciliationFromRows(tableUnit, rows, unit);
  return {
    semanticUnits: [tableUnit, ...metricUnits, ...(reconciliation ? [reconciliation] : [])],
    reflectiveFindings: [],
  };
}

function buildReconciliationFromRows(
  tableUnit: IdentifiedTableSemanticUnitDraft,
  rows: TableRow[],
  unit?: string,
): IdentifiedReconciliationSemanticUnitDraft | undefined {
  const labelColumn = tableUnit.columns.find((column) => column.semanticRole === "label") ?? tableUnit.columns[0];
  const valueColumn =
    tableUnit.columns.find((column) => column.semanticRole === "total") ??
    tableUnit.columns.find((column) => column.semanticRole === "metric") ??
    tableUnit.columns.find((column) => rows.some((row) => Number.isFinite(cellNumber(row.cells[column.name]))));
  if (!labelColumn || !valueColumn) return undefined;
  const resolvedUnit = unit ?? valueColumn.unit ?? tableUnit.unitHints[0] ?? "";
  const items = rows
    .map((row) => {
      const label = cellText(row.cells[labelColumn.name]);
      const numeric = cellNumber(row.cells[valueColumn.name]);
      if (!label || !Number.isFinite(numeric)) return undefined;
      return {
        label,
        value: numeric,
        unit: resolvedUnit,
        sign: 1 as const,
        sourceRowId: row.id,
      };
    })
    .filter((item): item is NonNullable<typeof item> => Boolean(item));
  if (items.length < 2) return undefined;
  const totalItem = items.find((item) => /合计|总额|总计/.test(item.label));
  const components = items.filter((item) => item !== totalItem);
  if (components.length < 2) return undefined;
  const computedTotal = Number(components.reduce((sum, item) => sum + item.value, 0).toFixed(6));
  const reportedTotal = totalItem?.value;
  const diff = reportedTotal === undefined ? undefined : Number((reportedTotal - computedTotal).toFixed(6));
  return {
    id: `semantic-reconciliation-${randomUUID()}`,
    kind: "reconciliation",
    title: `${tableUnit.tableTitle} reconciliation`,
    summary: reportedTotal === undefined
      ? `Computed itemized total is ${computedTotal}${unit ?? ""}, with no reported total available in source.`
      : `Computed total ${computedTotal}${unit ?? ""} compared against reported total ${reportedTotal}${unit ?? ""}.`,
    sourceChunkIds: tableUnit.sourceChunkIds,
    sourceNodeIds: tableUnit.sourceNodeIds,
    confidence: reportedTotal === undefined ? 0.5 : 0.7,
    reflectionStatus: reportedTotal === undefined ? "needs_review" : Math.abs(diff ?? 0) <= 0.0001 ? "ok" : "conflicting",
    reflectionNotes: reportedTotal === undefined
      ? ["Reported total missing; computed total cannot be claimed as closed against source."]
      : Math.abs(diff ?? 0) <= 0.0001
        ? []
        : [`Reported total differs from computed total by ${diff}.`],
    name: `${tableUnit.tableTitle} reconciliation`,
    sourceTableId: tableUnit.id,
    formulaType: "sum",
    items: components,
    computedTotal,
    ...(reportedTotal === undefined ? {} : { reportedTotal, diff }),
    closed: reportedTotal !== undefined && Math.abs(diff ?? 0) <= 0.0001,
  };
}

function negativeFactFromChunk(chunk: Chunk): DraftSemanticOutput {
  const lines = chunk.text.split("\n").map((line) => line.trim()).filter(Boolean);
  const negativeLines = lines.filter((line) => /(不涉及|不存在|未发生|无重大|没有)/.test(line) && line.length <= 180);
  if (negativeLines.length === 0) return { semanticUnits: [], reflectiveFindings: [] };
  const units: NegativeFactSemanticUnitDraft[] = negativeLines.map((statement) => {
    const normalized = statement.replace(/[。；;]+$/g, "").trim();
    const predicateMatch = /(不涉及|不存在|未发生|无重大变化|没有)/.exec(normalized);
    const predicate = predicateMatch?.[1] ?? "negative_statement";
    const predicateIndex = predicateMatch?.index ?? -1;
    const target = predicateIndex > 0
      ? normalized.slice(0, predicateIndex).trim()
      : chunk.headingPath ?? normalized;
    const scope = predicateIndex >= 0
      ? normalized.slice(predicateIndex + predicate.length).trim() || chunk.headingPath || "document_scope"
      : chunk.headingPath ?? "document_scope";
    const explicit = Boolean(predicateMatch);
    return {
      id: `semantic-negative-${randomUUID()}`,
      kind: "negative_fact",
      title: target,
      summary: statement,
      sourceChunkIds: [chunk.id],
      sourceNodeIds: chunk.documentTreeNodeId ? [chunk.documentTreeNodeId] : [],
      confidence: 0.68,
      reflectionStatus: explicit && target && scope ? "ok" : "needs_review",
      reflectionNotes: explicit && target && scope ? [] : ["Negative fact scope may be ambiguous."],
      target,
      predicate,
      scope,
      statement,
      certainty: explicit ? "explicit" : "implicit",
    };
  });
  const findings: NonNullable<AoriDocumentDraft["reflectiveFindings"]> = units
    .filter((unit) => unit.reflectionStatus !== "ok")
    .map((unit) => ({
      id: `finding-${randomUUID()}`,
      semanticUnitId: unit.id!,
      findingType: "ambiguous_scope" as const,
      severity: "medium" as const,
      message: "Negative fact was detected, but its target or scope may be incomplete.",
    }));
  return { semanticUnits: units, reflectiveFindings: findings };
}

function eventFromChunk(chunk: Chunk): DraftSemanticOutput {
  const text = chunk.text.replace(/\s+/g, " ").trim();
  const eventIndicators = /(变更|更正|调整|担保|违约|履责|用途|受限|影响)/;
  if (!eventIndicators.test(text) || text.length < 20) return { semanticUnits: [], reflectiveFindings: [] };
  const title = chunk.headingPath ?? text.slice(0, 60);
  const affectedItems = uniqueStrings([
    ...(text.match(/《[^》]+》/g) ?? []),
    ...(text.match(/[一-龥A-Za-z0-9]{2,24}(?:资产|负债|资金|工具|项目|事项|安排|义务|债券|用途|担保|融资)/g) ?? []),
  ]).slice(0, 8);
  const unit: EventSemanticUnitDraft = {
    id: `semantic-event-${randomUUID()}`,
    kind: "event",
    title,
    summary: truncateText(text.slice(0, 900), 3000),
    sourceChunkIds: [chunk.id],
    sourceNodeIds: chunk.documentTreeNodeId ? [chunk.documentTreeNodeId] : [],
    confidence: 0.45,
    reflectionStatus: "needs_review",
    reflectionNotes: ["Event boundary was inferred conservatively from local source text."],
    eventName: title,
    eventCategory: /更正/.test(text) ? "error_correction" : /变更|调整/.test(text) ? "policy_change" : /担保|履责/.test(text) ? "contract_obligation" : "business_event",
    affectedItems,
    sourceSectionTitle: chunk.headingPath ?? "document_scope",
  };
  return {
    semanticUnits: [unit],
    reflectiveFindings: [],
  };
}

export function buildDraftSemanticIndex(input: SemanticIndexInput): DraftSemanticOutput {
  const semanticUnits: SemanticUnitDraft[] = [];
  const reflectiveFindings: NonNullable<AoriDocumentDraft["reflectiveFindings"]> = [];

  for (const chunk of input.chunks) {
    const markdownTable = parseMarkdownTable(chunk);
    if (markdownTable) {
      const tableId = `semantic-table-${randomUUID()}`;
      const tableUnit: IdentifiedTableSemanticUnitDraft = {
        id: tableId,
        kind: "table",
        title: markdownTable.title,
        summary: truncateText(chunk.text.slice(0, 800), 3000),
        sourceChunkIds: [chunk.id],
        sourceNodeIds: chunk.documentTreeNodeId ? [chunk.documentTreeNodeId] : [],
        confidence: 0.74,
        reflectionStatus: markdownTable.findings.length === 0 ? "ok" : "needs_review",
        reflectionNotes: markdownTable.findings.map((finding) => finding.message),
        tableTitle: markdownTable.title,
        sectionTitle: chunk.headingPath ?? undefined,
        columns: markdownTable.columns,
        rows: markdownTable.rows,
        unitHints: markdownTable.unitHints,
        tableRole: "financial_metric_table",
      };
      semanticUnits.push(tableUnit);
      for (const column of markdownTable.columns.filter((column) => column.semanticRole === "metric" || column.semanticRole === "total")) {
        const metricUnit: MetricSemanticUnitDraft = {
          id: `semantic-metric-${randomUUID()}`,
          kind: "metric",
          title: column.name,
          summary: `${column.name} extracted from ${tableUnit.tableTitle}.`,
          sourceChunkIds: [chunk.id],
          sourceNodeIds: chunk.documentTreeNodeId ? [chunk.documentTreeNodeId] : [],
          confidence: 0.62,
          reflectionStatus: "ok",
          reflectionNotes: [],
          metricName: column.name,
          tableId,
          tableTitle: tableUnit.tableTitle,
          columnName: column.name,
          unit: column.unit,
          metricRole: inferMetricRole(column.name),
          aggregationAllowed: true,
          aggregationType: "sum",
        };
        semanticUnits.push(metricUnit);
      }
      const reconciliation = buildReconciliationFromRows(tableUnit, markdownTable.rows, markdownTable.unitHints[0]);
      if (reconciliation) {
        semanticUnits.push(reconciliation);
        if (!reconciliation.closed && reconciliation.reportedTotal !== undefined) {
          reflectiveFindings.push({
            id: `finding-${randomUUID()}`,
            semanticUnitId: reconciliation.id!,
            findingType: "calculation_not_closed",
            severity: "high",
            message: `Reconciliation diff is ${reconciliation.diff}.`,
          });
        }
      }
      for (const finding of markdownTable.findings) {
        reflectiveFindings.push({
          ...finding,
          semanticUnitId: tableId,
        });
      }
    }

    const colonMetrics = parseColonMetricChunk(chunk);
    semanticUnits.push(...colonMetrics.semanticUnits);
    reflectiveFindings.push(...colonMetrics.reflectiveFindings);

    const negatives = negativeFactFromChunk(chunk);
    semanticUnits.push(...negatives.semanticUnits);
    reflectiveFindings.push(...negatives.reflectiveFindings);

    const events = eventFromChunk(chunk);
    semanticUnits.push(...events.semanticUnits);
    reflectiveFindings.push(...events.reflectiveFindings);
  }

  const dedupedUnits = [...new Map(semanticUnits.map((unit) => [
    `${unit.kind}:${unit.title ?? ""}:${unit.sourceChunkIds.join(",")}`,
    unit,
  ])).values()];
  const validUnitIds = new Set(dedupedUnits.flatMap((unit) => unit.id ? [unit.id] : []));
  return {
    semanticUnits: dedupedUnits,
    reflectiveFindings: reflectiveFindings.filter((finding) => validUnitIds.has(finding.semanticUnitId)),
  };
}
