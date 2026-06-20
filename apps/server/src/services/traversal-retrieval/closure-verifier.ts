import type {
  TraversalCompletenessType,
  TraversalClosureVerdict,
  TraversalEvidenceItem,
  TraversalScoutResult,
} from "@agent-thinking/contracts";

export interface ClosureVerifierInput {
  completenessType: TraversalCompletenessType;
  evidence: TraversalEvidenceItem[];
  scout?: TraversalScoutResult | undefined;
  rowBoundaryChecked?: boolean | undefined;
  exhaustedDirections?: string[] | undefined;
  documentTimeRange?: { from?: string | undefined; to?: string | undefined } | undefined;
}

function numericValue(value: number | string | undefined): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return undefined;
  const parsed = Number(value.replace(/,/g, "").replace(/[^\d.+-]/g, ""));
  return Number.isFinite(parsed) ? parsed : undefined;
}

function confidence(status: TraversalClosureVerdict["status"]): TraversalClosureVerdict["confidence"] {
  return status === "closed" ? "high" : status === "partial" || status === "continue" ? "medium" : "low";
}

function verdict(
  verifierType: TraversalCompletenessType,
  status: TraversalClosureVerdict["status"],
  summary: string,
  checks: Record<string, unknown>,
): TraversalClosureVerdict {
  return {
    status,
    verifierType,
    confidence: confidence(status),
    summary,
    checks,
  };
}

export class ClosureVerifier {
  verify(input: ClosureVerifierInput): TraversalClosureVerdict {
    if (input.completenessType === "sum_alignment") return this.verifySumAlignment(input);
    if (input.completenessType === "row_count") return this.verifyRowCount(input);
    if (input.completenessType === "entity_boundary") return this.verifyEntityBoundary(input);
    if (input.completenessType === "timeline_end") return this.verifyTimelineEnd(input);
    return verdict("none", "closed", "No typed closure required.", { notApplicable: true });
  }

  private verifySumAlignment(input: ClosureVerifierInput): TraversalClosureVerdict {
    const declared = input.scout?.declaredValue;
    const values = input.evidence.flatMap((item) => {
      const value = numericValue(item.value);
      return value === undefined ? [] : [value];
    });
    const collectedSum = values.reduce((sum, value) => sum + value, 0);
    const gap = typeof declared === "number" ? Number((declared - collectedSum).toFixed(6)) : undefined;
    const unitConsistency = input.scout?.unit
      ? input.evidence.every((item) => !item.unit || item.unit === input.scout?.unit)
      : true;
    const metricBinding = input.scout?.metric
      ? input.evidence.some((item) => item.metric && (item.metric.includes(input.scout!.metric!) || input.scout!.metric!.includes(item.metric)))
      : true;
    const competingValues = new Set((input.scout?.competingDeclarations ?? []).map((entry) => entry.value));
    const competingCheck = typeof declared === "number" ? !competingValues.has(declared) : false;
    const numericSum = typeof gap === "number" && Math.abs(gap) <= 0.01;
    const rowBoundary = input.rowBoundaryChecked === true;

    if (!input.scout || input.scout.calibrationStatus !== "calibrated" || typeof declared !== "number") {
      return verdict("sum_alignment", "continue", "Declared value is not calibrated yet.", {
        declaredValueFound: false,
        collectedSum,
        evidenceCount: input.evidence.length,
      });
    }
    if (!metricBinding || !competingCheck) {
      return verdict("sum_alignment", "mismatch", "Collected values do not bind to the calibrated target metric.", {
        declaredValue: declared,
        collectedSum,
        gap,
        unitConsistency,
        metricBinding,
        competingCheck,
        rowBoundary,
      });
    }
    if (!numericSum) {
      return verdict("sum_alignment", "failed", "Collected numeric sum does not match the declared value.", {
        declaredValue: declared,
        collectedSum,
        gap,
        unitConsistency,
        metricBinding,
        competingCheck,
        rowBoundary,
      });
    }
    if (!rowBoundary) {
      return verdict("sum_alignment", "partial", "Numeric sum matches, but row boundary was not verified.", {
        declaredValue: declared,
        collectedSum,
        gap,
        unitConsistency,
        metricBinding,
        competingCheck,
        rowBoundary,
      });
    }
    return verdict("sum_alignment", "closed", "Numeric sum, metric binding, unit consistency, and row boundary passed.", {
      declaredValue: declared,
      collectedSum,
      gap,
      unitConsistency,
      metricBinding,
      competingCheck,
      rowBoundary,
    });
  }

  private verifyRowCount(input: ClosureVerifierInput): TraversalClosureVerdict {
    const declared = input.scout?.declaredValue;
    const counted = input.evidence.length;
    const boundary = input.rowBoundaryChecked === true;
    if (typeof declared !== "number") {
      return verdict("row_count", "continue", "Declared row count is not calibrated yet.", {
        declaredCountFound: false,
        counted,
        boundary,
      });
    }
    if (counted < declared) {
      return verdict("row_count", "failed", "Collected row count is below declared count.", {
        declared,
        counted,
        missingRows: declared - counted,
        boundary,
      });
    }
    if (!boundary) {
      return verdict("row_count", "partial", "Row count matches, but boundary was not verified.", {
        declared,
        counted,
        boundary,
      });
    }
    return verdict("row_count", "closed", "Declared row count and row boundary passed.", {
      declared,
      counted,
      boundary,
    });
  }

  private verifyEntityBoundary(input: ClosureVerifierInput): TraversalClosureVerdict {
    const exhausted = input.exhaustedDirections ?? [];
    const consecutiveEmpty = exhausted.some((entry) => /empty_?3|3 consecutive|连续空/.test(entry));
    const sectionBoundary = exhausted.some((entry) => /different_section|section_boundary|headingPath|章节/.test(entry));
    const contentTypeChange = exhausted.some((entry) => /role_changed|content_type|unrelated|类型变化/.test(entry));
    const budgetCapped = exhausted.some((entry) => /budget|cap|预算/.test(entry));
    if (consecutiveEmpty && sectionBoundary && contentTypeChange && !budgetCapped) {
      return verdict("entity_boundary", "closed", "Entity zone boundary was verified by empty-run, section, and content-type checks.", {
        consecutiveEmpty,
        sectionBoundary,
        contentTypeChange,
        budgetCapped,
        entityCount: input.evidence.length,
      });
    }
    if (consecutiveEmpty && !budgetCapped) {
      return verdict("entity_boundary", "partial", "Entity search found an empty-run boundary, but structural section boundary is incomplete.", {
        consecutiveEmpty,
        sectionBoundary,
        contentTypeChange,
        budgetCapped,
        entityCount: input.evidence.length,
      });
    }
    return verdict("entity_boundary", "low_confidence", "Entity boundary is not sufficiently verified.", {
      consecutiveEmpty,
      sectionBoundary,
      contentTypeChange,
      budgetCapped,
      entityCount: input.evidence.length,
    });
  }

  private verifyTimelineEnd(input: ClosureVerifierInput): TraversalClosureVerdict {
    const times = input.evidence
      .map((item) => typeof item.value === "string" ? item.value : undefined)
      .filter((value): value is string => Boolean(value));
    const from = input.documentTimeRange?.from;
    const to = input.documentTimeRange?.to;
    const hasStart = from ? times.some((time) => time >= from) : times.length > 0;
    const hasEnd = to ? times.some((time) => time <= to) : times.length > 0;
    const boundary = input.rowBoundaryChecked === true || (input.exhaustedDirections ?? []).some((entry) => /outside_time_scope|different_section|timeline_end/.test(entry));
    if (times.length === 0) {
      return verdict("timeline_end", "continue", "No timeline events have been collected.", {
        eventCount: 0,
        from,
        to,
        boundary,
      });
    }
    if (hasStart && hasEnd && boundary) {
      return verdict("timeline_end", "closed", "Timeline coverage and terminal boundary passed.", {
        eventCount: times.length,
        from,
        to,
        boundary,
      });
    }
    return verdict("timeline_end", "partial", "Timeline events were collected, but period coverage or terminal boundary is incomplete.", {
      eventCount: times.length,
      from,
      to,
      boundary,
    });
  }
}
