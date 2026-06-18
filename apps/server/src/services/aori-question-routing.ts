import type { QuestionAspectPlan, SemanticUnit } from "@agent-thinking/contracts";

export const SEMANTIC_SELECTION_THRESHOLD = 0.65;

function scoreQuestion(text: string, question: string): number {
  const q = question.normalize("NFKC").toLowerCase();
  const t = text.normalize("NFKC").toLowerCase();
  const tokens = [...new Set(q.split(/[\s，。！？?;；:：、“”"'()（）]+/).map((part) => part.trim()).filter((part) => part.length >= 2))];
  const fragments = new Set<string>(tokens);
  for (const token of tokens) {
    if (/[\u4e00-\u9fff]/.test(token) && token.length >= 4) {
      for (let index = 0; index < token.length - 1; index += 1) {
        fragments.add(token.slice(index, index + 2));
      }
    }
  }
  const fragmentList = [...fragments].filter((fragment) => fragment.length >= 2);
  if (fragmentList.length === 0) return 0;
  const hits = fragmentList.filter((fragment) => t.includes(fragment)).length;
  return hits / fragmentList.length;
}

export function inferQuestionType(question: string): QuestionAspectPlan["questionType"] {
  if (/区别|不同|不能混|口径/.test(question)) return "concept_boundary";
  if (/是否|不涉及|不存在|未发生|无/.test(question)) return "negative_fact";
  if (/影响|导致|为什么|原因|闭合|重分类/.test(question)) return "event_effect";
  if (/包括哪些|由哪些|列出|构成/.test(question)) return "exhaustive_list";
  if (/多少|合计|总额|余额|计算/.test(question)) return "numeric_aggregation";
  return "general_qa";
}

function strategyFor(questionType: QuestionAspectPlan["questionType"]): QuestionAspectPlan["execution"]["strategy"] {
  if (questionType === "numeric_aggregation") return "deterministic_numeric";
  if (questionType === "concept_boundary") return "concept_boundary";
  if (questionType === "event_effect") return "event_boundary";
  if (questionType === "negative_fact") return "negative_fact";
  if (questionType === "exhaustive_list") return "table_exhaustive";
  return "fallback_demand";
}

function preferredKindsFor(questionType: QuestionAspectPlan["questionType"]): SemanticUnit["kind"][] {
  if (questionType === "numeric_aggregation") return ["reconciliation", "metric", "table"];
  if (questionType === "negative_fact") return ["negative_fact"];
  if (questionType === "event_effect") return ["event", "causal_chain", "reconciliation"];
  if (questionType === "exhaustive_list") return ["table", "event"];
  if (questionType === "concept_boundary") return ["metric", "table"];
  return ["table", "metric", "event", "negative_fact", "reconciliation", "causal_chain"];
}

export function buildQuestionAspectPlan(question: string, candidates: SemanticUnit[]): QuestionAspectPlan {
  const questionType = inferQuestionType(question);
  const orderedKinds = preferredKindsFor(questionType);
  const ranked = candidates
    .map((unit) => {
      const relevance = scoreQuestion(`${unit.title ?? ""} ${unit.summary}`, question);
      const kindBoost = orderedKinds.indexOf(unit.kind);
      const kindScore = kindBoost < 0 ? 0 : (orderedKinds.length - kindBoost) / (orderedKinds.length + 1);
      const typeBonus =
        questionType === "numeric_aggregation" && unit.kind === "reconciliation" ? 0.18
          : questionType === "numeric_aggregation" && (unit.kind === "metric" || unit.kind === "table") ? 0.08
            : questionType === "negative_fact" && unit.kind === "negative_fact" ? 0.16
              : questionType === "event_effect" && (unit.kind === "event" || unit.kind === "causal_chain") ? 0.12
                : 0;
      const score = Number((relevance * 0.62 + kindScore * 0.18 + unit.confidence * 0.12 + typeBonus).toFixed(4));
      return { unit, score };
    })
    .sort((left, right) => right.score - left.score);
  const selected = ranked
    .filter((entry) => entry.score >= SEMANTIC_SELECTION_THRESHOLD)
    .slice(0, questionType === "concept_boundary" ? 2 : 4);
  const selectedIds = new Set(selected.map((entry) => entry.unit.id));
  return {
    questionType,
    target: {
      questionType,
      targetDescription: question,
      constraints: {
        aggregation: questionType === "numeric_aggregation" ? "sum" : questionType === "concept_boundary" ? "compare" : "none",
        requireCompleteSet: questionType === "exhaustive_list" || questionType === "concept_boundary",
      },
      rawQuestion: question,
    },
    selectedAspects: selected.map((entry) => ({
      aspectId: entry.unit.id,
      decision: "selected",
      reason: `Semantic unit matched question type ${questionType} with score ${entry.score}.`,
      confidence: entry.score,
    })),
    rejectedAspects: ranked
      .filter((entry) => !selectedIds.has(entry.unit.id))
      .slice(0, 8)
      .map((entry) => ({
        aspectId: entry.unit.id,
        decision: "rejected",
        reason: entry.score < SEMANTIC_SELECTION_THRESHOLD
          ? `Semantic unit score ${entry.score} is below the semantic routing threshold.`
          : "Higher-scoring semantic units were selected first.",
        confidence: entry.score,
      })),
    execution: {
      strategy: strategyFor(questionType),
      aggregation: questionType === "numeric_aggregation" ? "sum" : questionType === "concept_boundary" ? "compare" : "none",
      requireCompleteEvidence: questionType === "numeric_aggregation" || questionType === "exhaustive_list" || questionType === "concept_boundary",
    },
    confidence: selected[0]?.score ?? 0,
  };
}
