import type {
  AoriSkillRouterInput,
  AoriTraversalMap,
  AoriTraversalNode,
} from "@agent-thinking/contracts";

function centralQuestionFromSummary(summary: string): string | undefined {
  const marker = "\n\nCentral question:";
  const index = summary.indexOf(marker);
  if (index < 0) return undefined;
  const value = summary.slice(index + marker.length).trim();
  return value || undefined;
}

function uniqueBy<T>(values: T[], keyOf: (value: T) => string): T[] {
  const seen = new Set<string>();
  const result: T[] = [];
  for (const value of values) {
    const key = keyOf(value);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(value);
  }
  return result;
}

function aspectInput(node: AoriTraversalNode, map: AoriTraversalMap): AoriSkillRouterInput["aspects"][number] {
  return {
    aspectId: node.aspectId ?? node.id.replace(/^aspect:/, ""),
    title: node.title,
    kind: node.aspectKind ?? "other",
    domainKind: node.domainKind ?? "unknown",
    summary: node.summary,
    ...(centralQuestionFromSummary(node.summary) ? { centralQuestion: centralQuestionFromSummary(node.summary) } : {}),
    itemCount: node.childIds
      .map((childId) => map.nodesById[childId])
      .filter((child): child is AoriTraversalNode => child?.type === "aspect_item").length,
  };
}

export function buildAoriSkillRouterInput(question: string, map: AoriTraversalMap): AoriSkillRouterInput {
  const aspectNodes = Object.values(map.nodesById).filter((node) => node.type === "aspect");
  const relationLexicon = uniqueBy(
    map.relations.map((relation) => ({
      domainRelation: relation.label,
      summary: relation.summary,
    })),
    (entry) => entry.domainRelation,
  ).slice(0, 40);
  const selfQuestions = Object.values(map.nodesById)
    .filter((node) => node.type === "self_question")
    .slice(0, 40)
    .map((node) => ({
      question: node.title,
      answer: node.summary,
      status: node.evidenceStatus === "supported" ? "answered" : "unchecked",
    }));

  return {
    question,
    globalSummary: map.globalSummary,
    documentCards: map.documentCards,
    aspects: aspectNodes.map((node) => aspectInput(node, map)),
    ...(relationLexicon.length > 0 ? { relationLexicon } : {}),
    ...(selfQuestions.length > 0 ? { selfQuestions } : {}),
  };
}
