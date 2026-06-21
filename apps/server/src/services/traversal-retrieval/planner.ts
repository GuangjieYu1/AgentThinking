import type { TraversalRetrievalPattern, TraversalSubTask } from "@agent-thinking/contracts";

export function patternForQuestion(question: string): TraversalRetrievalPattern {
  if (/合计|总计|总额|募集|金额|余额|表|明细|sum|total/i.test(question)) return "table_horizontal";
  if (/时间|日期|年度|年|月|timeline|when/i.test(question)) return "timeline_chain";
  if (/哪些|名单|变动|成员|entity|who/i.test(question)) return "entity_scatter";
  if (/说明|详细|原因|政策|章节|section/i.test(question)) return "hierarchical_depth";
  return "single_point";
}

export function completenessForPattern(pattern: TraversalRetrievalPattern, question: string): TraversalSubTask["completenessType"] {
  if (pattern === "table_horizontal" && /合计|总计|总额|金额|余额|sum|total/i.test(question)) return "sum_alignment";
  if (pattern === "table_horizontal" && /几|多少|count|number/i.test(question)) return "row_count";
  if (pattern === "timeline_chain") return "timeline_end";
  if (pattern === "single_point") return "none";
  return "entity_boundary";
}

export function directionBiasForPattern(pattern: TraversalRetrievalPattern): TraversalSubTask["directionBias"] {
  if (pattern === "hierarchical_depth" || pattern === "timeline_chain") return "down_first";
  if (pattern === "single_point") return "none";
  return "side_first";
}

export function fallbackPatterns(pattern: TraversalRetrievalPattern): TraversalRetrievalPattern[] {
  if (pattern === "table_horizontal") return ["hierarchical_depth", "entity_scatter"];
  if (pattern === "entity_scatter") return ["timeline_chain", "hierarchical_depth"];
  if (pattern === "timeline_chain") return ["entity_scatter", "hierarchical_depth"];
  if (pattern === "hierarchical_depth") return ["entity_scatter", "table_horizontal"];
  return [];
}

export function makeSubTask(question: string): TraversalSubTask {
  const pattern = patternForQuestion(question);
  return {
    id: "subtask-1",
    question,
    pattern,
    patternConfidence: pattern === "single_point" ? 0.6 : 0.72,
    fallbackPatterns: fallbackPatterns(pattern),
    completenessType: completenessForPattern(pattern, question),
    mergePolicy: "independent_section",
    directionBias: directionBiasForPattern(pattern),
    rationale: "Traversal v2 deterministic planner selected the closest retrieval pattern from question terms.",
  };
}
