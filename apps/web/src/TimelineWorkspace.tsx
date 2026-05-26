import { useEffect, useMemo, useState } from "react";
import {
  relationStatuses,
  relationTypes,
  type AbstractNode,
  type Citation,
  type Relation,
  type RelationStatus,
  type RelationType,
  type SourceStructure,
} from "@agent-thinking/contracts";
import { api } from "./api";

interface TimelineItem {
  relation: Relation;
  sourceTitle: string;
  targetTitle: string;
  date: string | null;
  dateSource: string | null;
}

const frontmatterDateKeys = [
  "date",
  "created",
  "created_at",
  "published",
  "published_at",
  "publication_date",
  "updated",
  "updated_at",
];

export function TimelineWorkspace({
  libraryId,
  refreshKey,
  onError,
  onOpenCitation,
}: {
  libraryId: string;
  refreshKey: number;
  onError: (message: string) => void;
  onOpenCitation: (citation: Citation) => void;
}) {
  const [items, setItems] = useState<TimelineItem[]>([]);
  const [status, setStatus] = useState<RelationStatus | "">("");
  const [type, setType] = useState<RelationType | "">("");
  const [newestFirst, setNewestFirst] = useState(false);

  useEffect(() => {
    const load = async () => {
      try {
        const graph = await api.graph(libraryId, {
          ...(status ? { status } : {}),
          ...(type ? { type } : {}),
        });
        const relations = graph.edges.flatMap((edge) => edge.relation ? [edge.relation] : []);
        const versionIds = [...new Set(relations.flatMap((relation) => relation.citations.map((citation) => citation.versionId)))];
        const structures = await Promise.all(versionIds.map(async (versionId) => [versionId, await api.structure(versionId)] as const));
        const structureByVersion = new Map(structures);
        const titles = new Map(
          graph.nodes.flatMap((node) => node.nodeType === "abstract" ? [[node.id, node.data] as const] : []),
        );
        setItems(relations.map((relation) => timelineItem(relation, titles, structureByVersion)));
      } catch (cause) {
        onError((cause as Error).message);
      }
    };
    void load();
  }, [libraryId, refreshKey, status, type]);

  const dated = useMemo(() => items.filter((item) => item.date !== null).sort((left, right) => {
    const order = (left.date ?? "").localeCompare(right.date ?? "");
    return newestFirst ? -order : order;
  }), [items, newestFirst]);
  const undated = useMemo(() => items.filter((item) => item.date === null), [items]);
  const years = new Set(dated.map((item) => item.date?.slice(0, 4))).size;

  return (
    <section className="timeline-workspace card">
      <header className="timeline-toolbar">
        <div>
          <h2>时间脉络</h2>
          <p>仅按证据中可识别的日期或来源 frontmatter 日期排列，不自动推断事件时间。</p>
        </div>
        <div className="timeline-filters">
          <select value={status} onChange={(event) => setStatus(event.target.value as RelationStatus | "")}>
            <option value="">可见关系</option>
            {relationStatuses.map((item) => <option key={item} value={item}>{item}</option>)}
          </select>
          <select value={type} onChange={(event) => setType(event.target.value as RelationType | "")}>
            <option value="">所有类型</option>
            {relationTypes.map((item) => <option key={item} value={item}>{item}</option>)}
          </select>
          <button onClick={() => setNewestFirst((value) => !value)}>{newestFirst ? "从新到旧" : "从旧到新"}</button>
        </div>
      </header>
      <div className="timeline-summary">
        <span>可定位关系 <strong>{dated.length}</strong></span>
        <span>时间跨度 <strong>{years}</strong> 年</span>
        <span>未标注时间 <strong>{undated.length}</strong></span>
      </div>
      <div className="timeline-scroll">
        {dated.length === 0 && <p className="timeline-empty">当前关系证据中没有识别到明确日期；可在 Markdown frontmatter 添加 `date` 或 `published` 字段后重新分析。</p>}
        <div className="timeline-line">
          {dated.map((item) => <TimelineCard key={item.relation.id} item={item} onOpenCitation={onOpenCitation} />)}
        </div>
        {undated.length > 0 && (
          <section className="timeline-undated">
            <h3>未标注时间</h3>
            <p>这些关系仍可查看和审核，但无法安全放入时间轴。</p>
            <div className="timeline-undated-grid">
              {undated.map((item) => <TimelineCard key={item.relation.id} item={item} onOpenCitation={onOpenCitation} />)}
            </div>
          </section>
        )}
      </div>
    </section>
  );
}

function TimelineCard({ item, onOpenCitation }: { item: TimelineItem; onOpenCitation: (citation: Citation) => void }) {
  return (
    <article className={`timeline-card ${item.relation.type === "contradicts" ? "conflict" : ""}`}>
      {item.date && <time dateTime={item.date}>{formatDate(item.date)}</time>}
      <div className="timeline-card-heading">
        <strong>{item.relation.type}</strong>
        <small>{item.relation.status}</small>
      </div>
      <h3>{item.sourceTitle} <span>→</span> {item.targetTitle}</h3>
      <p>{item.relation.reason}</p>
      {item.dateSource && <label>时间来源：{item.dateSource}</label>}
      <div className="timeline-citations">
        {item.relation.citations.map((citation) => (
          <button key={citation.chunkId} onClick={() => onOpenCitation(citation)}>
            {citation.documentName}
            {citation.pageNumber ? ` / P${citation.pageNumber}` : citation.startLine ? ` / L${citation.startLine}-${citation.endLine ?? citation.startLine}` : ""}
          </button>
        ))}
      </div>
    </article>
  );
}

function timelineItem(
  relation: Relation,
  nodes: Map<string, AbstractNode>,
  structures: Map<string, SourceStructure>,
): TimelineItem {
  for (const citation of relation.citations) {
    const inText = extractDate(citation.excerpt);
    if (inText) {
      return {
        relation,
        sourceTitle: nodes.get(relation.sourceNodeId)?.title ?? "未知节点",
        targetTitle: nodes.get(relation.targetNodeId)?.title ?? "未知节点",
        date: inText,
        dateSource: `${citation.documentName} 原文摘录`,
      };
    }
  }
  for (const citation of relation.citations) {
    const frontmatter = structures.get(citation.versionId)?.metadata?.frontmatter ?? {};
    for (const key of frontmatterDateKeys) {
      const inMetadata = extractDate(frontmatter[key] ?? "");
      if (inMetadata) {
        return {
          relation,
          sourceTitle: nodes.get(relation.sourceNodeId)?.title ?? "未知节点",
          targetTitle: nodes.get(relation.targetNodeId)?.title ?? "未知节点",
          date: inMetadata,
          dateSource: `${citation.documentName} frontmatter.${key}`,
        };
      }
    }
  }
  return {
    relation,
    sourceTitle: nodes.get(relation.sourceNodeId)?.title ?? "未知节点",
    targetTitle: nodes.get(relation.targetNodeId)?.title ?? "未知节点",
    date: null,
    dateSource: null,
  };
}

function extractDate(text: string): string | null {
  const day = /(?:^|\D)(\d{4})[年/-](\d{1,2})[月/-](\d{1,2})(?:日|\D|$)/.exec(text);
  if (day) return `${day[1]}-${day[2]!.padStart(2, "0")}-${day[3]!.padStart(2, "0")}`;
  const month = /(?:^|\D)(\d{4})[年/-](\d{1,2})(?:月|\D|$)/.exec(text);
  if (month) return `${month[1]}-${month[2]!.padStart(2, "0")}`;
  const year = /(?:^|\D)((?:19|20)\d{2})(?:年|\D|$)/.exec(text);
  return year?.[1] ?? null;
}

function formatDate(date: string): string {
  const [year, month, day] = date.split("-");
  if (day) return `${year}年${Number(month)}月${Number(day)}日`;
  if (month) return `${year}年${Number(month)}月`;
  return `${year}年`;
}
