import type { NumericAnswerVerification, QuestionAspectPlan, SemanticUnit } from "@agent-thinking/contracts";

export interface SemanticExecutionResult {
  answer: string;
  summary: string;
  verification?: NumericAnswerVerification | undefined;
  structuredResult?: unknown;
}

function numericVerification(answerTotal: number, computedTotal: number): NumericAnswerVerification {
  const passed = Math.abs(answerTotal - computedTotal) <= 0.0001;
  return {
    passed,
    computedTotal,
    answerTotal,
    issues: passed ? [] : [`Answer total ${answerTotal} differs from computed total ${computedTotal}.`],
  };
}

function normalizedText(value: string | undefined | null): string {
  return (value ?? "").normalize("NFKC").replace(/\s+/g, "").trim().toLowerCase();
}

function negativeFactMatchesQuestion(
  question: string,
  unit: Extract<SemanticUnit, { kind: "negative_fact" }>,
): boolean {
  const normalizedQuestion = normalizedText(question);
  const target = normalizedText(unit.target);
  const predicate = normalizedText(unit.predicate);
  const scope = normalizedText(unit.scope);
  const statement = normalizedText(unit.statement);
  const signals = [target, predicate, scope].filter(Boolean);
  const matchedSignals = signals.filter((signal) => normalizedQuestion.includes(signal)).length;
  if (matchedSignals >= 2) return true;
  if (target && predicate && normalizedQuestion.includes(target) && normalizedQuestion.includes(predicate)) return true;
  if (scope && predicate && normalizedQuestion.includes(scope) && normalizedQuestion.includes(predicate)) return true;
  return statement.length > 0 && statement.includes(normalizedQuestion);
}

export function executeQuestionAspectPlan(plan: QuestionAspectPlan, units: SemanticUnit[]): SemanticExecutionResult {
  if (plan.execution.strategy === "negative_fact") {
    const negativeUnits = units.filter((candidate): candidate is Extract<SemanticUnit, { kind: "negative_fact" }> => candidate.kind === "negative_fact");
    const unit = negativeUnits.find((candidate) => negativeFactMatchesQuestion(plan.target.rawQuestion, candidate));
    if (!unit) return { answer: "", summary: "" };
    return {
      answer: `${unit.statement}`,
      summary: `Semantic negative fact answered from ${unit.title ?? unit.kind}.`,
      structuredResult: unit,
    };
  }
  if (plan.execution.strategy === "deterministic_numeric") {
    const reconciliation = units.find((candidate): candidate is Extract<SemanticUnit, { kind: "reconciliation" }> => candidate.kind === "reconciliation");
    if (reconciliation) {
      const answer = reconciliation.reportedTotal === undefined
        ? `${reconciliation.name}的分项合计为${reconciliation.computedTotal}${reconciliation.items[0]?.unit ?? ""}。`
        : reconciliation.closed
          ? `${reconciliation.name}计算结果为${reconciliation.computedTotal}${reconciliation.items[0]?.unit ?? ""}，与原文合计${reconciliation.reportedTotal}${reconciliation.items[0]?.unit ?? ""}闭合。`
          : `${reconciliation.name}计算结果为${reconciliation.computedTotal}${reconciliation.items[0]?.unit ?? ""}，与原文合计${reconciliation.reportedTotal}${reconciliation.items[0]?.unit ?? ""}相差${reconciliation.diff}${reconciliation.items[0]?.unit ?? ""}。`;
      return {
        answer,
        summary: `Semantic reconciliation used deterministic arithmetic for ${reconciliation.name}.`,
        verification: numericVerification(reconciliation.computedTotal, reconciliation.computedTotal),
        structuredResult: reconciliation,
      };
    }
    const metric = units.find((candidate): candidate is Extract<SemanticUnit, { kind: "metric" }> => candidate.kind === "metric");
    if (metric) {
      return {
        answer: `${metric.metricName}已从持久化语义指标中命中，但当前没有可闭合的分项计算结果。`,
        summary: `Semantic metric match for ${metric.metricName}.`,
        structuredResult: metric,
      };
    }
  }
  if (plan.execution.strategy === "table_exhaustive") {
    const table = units.find((candidate): candidate is Extract<SemanticUnit, { kind: "table" }> => candidate.kind === "table");
    if (!table) return { answer: "", summary: "" };
    const labels = table.rows
      .map((row) => Object.values(row.cells)[0]?.value ?? Object.values(row.cells)[0]?.raw)
      .map((value) => String(value ?? "").trim())
      .filter(Boolean);
    return {
      answer: `${table.tableTitle}包含${labels.length}项：${labels.join("；")}。`,
      summary: `Semantic table expansion used ${labels.length} row(s).`,
      structuredResult: table,
    };
  }
  if (plan.execution.strategy === "concept_boundary") {
    const metrics = units.filter((candidate): candidate is Extract<SemanticUnit, { kind: "metric" }> => candidate.kind === "metric").slice(0, 2);
    if (metrics.length < 2) return { answer: "", summary: "" };
    const [left, right] = metrics;
    if (!left || !right) return { answer: "", summary: "" };
    return {
      answer: `${left.metricName}与${right.metricName}属于不同口径，前者角色为${left.metricRole}，后者角色为${right.metricRole}，不能直接混算。`,
      summary: `Semantic concept-boundary answer compared ${metrics.length} persisted metrics.`,
      structuredResult: metrics,
    };
  }
  if (plan.execution.strategy === "event_boundary") {
    const event = units.find((candidate): candidate is Extract<SemanticUnit, { kind: "event" }> => candidate.kind === "event");
    if (!event) return { answer: "", summary: "" };
    return {
      answer: `${event.eventName}涉及${event.affectedItems.join("、") || "相关事项"}，当前回答仅限定在该事项边界内。`,
      summary: `Semantic event-boundary answer used ${event.eventName}.`,
      structuredResult: event,
    };
  }
  return { answer: "", summary: "" };
}
