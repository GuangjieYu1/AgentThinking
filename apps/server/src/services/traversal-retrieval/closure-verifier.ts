import type {
  TraversalCompletenessType,
  TraversalClosureVerdict,
  TraversalEvidenceItem,
  TraversalScoutResult,
  TraversalSummaryIndicator,
} from "@agent-thinking/contracts";

export interface ClosureRoleInfo {
  role: string;
  indicator?: TraversalSummaryIndicator | undefined;
  confidence: number;
}

export interface ClosureVerifierInput {
  completenessType: TraversalCompletenessType;
  evidence: TraversalEvidenceItem[];
  scout?: TraversalScoutResult | undefined;
  roleMap?: Map<string, ClosureRoleInfo> | undefined;
  rowBoundaryChecked?: boolean | undefined;
  rowBoundaryEvidence?: Record<string, unknown> | undefined;
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

function normalizeMetric(value: string | undefined): string {
  return (value ?? "").normalize("NFKC").replace(/\s+/g, "").toLowerCase();
}

function metricEquivalent(left: string | undefined, right: string | undefined): boolean {
  const normalizedLeft = normalizeMetric(left);
  const normalizedRight = normalizeMetric(right);
  if (!normalizedLeft || !normalizedRight) return false;
  if (normalizedLeft === normalizedRight || normalizedLeft.includes(normalizedRight) || normalizedRight.includes(normalizedLeft)) return true;
  const leftChars = new Set([...normalizedLeft].filter((char) => /[\p{Script=Han}A-Za-z0-9]/u.test(char)));
  const rightChars = new Set([...normalizedRight].filter((char) => /[\p{Script=Han}A-Za-z0-9]/u.test(char)));
  let overlap = 0;
  for (const char of leftChars) if (rightChars.has(char)) overlap += 1;
  return overlap >= 2 && overlap / Math.max(1, Math.min(leftChars.size, rightChars.size)) >= 0.45;
}

function sameDeclaredValue(left: number | undefined, right: number | undefined): boolean {
  return typeof left === "number" && typeof right === "number" && Math.abs(left - right) <= 0.01;
}

function roleForEvidence(input: ClosureVerifierInput, item: TraversalEvidenceItem): ClosureRoleInfo | undefined {
  return input.roleMap?.get(item.chunkId);
}

function dataRowEvidence(input: ClosureVerifierInput): TraversalEvidenceItem[] {
  return input.evidence.filter((item) => {
    const role = roleForEvidence(input, item);
    return role?.role === "data_row" && role.confidence >= 0.6;
  });
}

function uncountedNumericEvidence(input: ClosureVerifierInput): TraversalEvidenceItem[] {
  return input.evidence.filter((item) => {
    if (numericValue(item.value) === undefined) return false;
    const role = roleForEvidence(input, item);
    if (!role) return true;
    return role.role === "unknown" || role.role === "data_row" && role.confidence < 0.6;
  });
}

function conflictingDeclarations(input: ClosureVerifierInput, declared: number): NonNullable<TraversalScoutResult["competingDeclarations"]> {
  const scout = input.scout;
  if (!scout) return [];
  return scout.competingDeclarations.filter((entry) => {
    if (entry.sourceChunkId === scout.sourceChunkId) return false;
    if (entry.confidence !== "high") return false;
    if (!sameDeclaredValue(entry.value, declared)) return false;
    const metricConflict = scout.metric ? !metricEquivalent(entry.metric, scout.metric) : false;
    const scopeConflict = scout.scope && entry.scope ? normalizeMetric(entry.scope) !== normalizeMetric(scout.scope) : false;
    const indicatorConflict = scout.bindingColumn && entry.bindingColumn
      ? normalizeMetric(entry.bindingColumn) !== normalizeMetric(scout.bindingColumn)
      : false;
    return metricConflict || scopeConflict || indicatorConflict;
  });
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
    const countedEvidence = dataRowEvidence(input);
    const uncountedNumeric = uncountedNumericEvidence(input);
    const values = countedEvidence.flatMap((item) => {
      const value = numericValue(item.value);
      return value === undefined ? [] : [value];
    });
    const collectedSum = values.reduce((sum, value) => sum + value, 0);
    const gap = typeof declared === "number" ? Number((declared - collectedSum).toFixed(6)) : undefined;
    const unitConsistency = input.scout?.unit
      ? countedEvidence.every((item) => !item.unit || item.unit === input.scout?.unit)
      : true;
    const metricBinding = input.scout?.metric
      ? countedEvidence.some((item) => metricEquivalent(item.metric, input.scout?.metric))
      : true;
    const competingConflicts = typeof declared === "number" ? conflictingDeclarations(input, declared) : [];
    const competingCheck = typeof declared === "number" ? competingConflicts.length === 0 : false;
    const numericSum = typeof gap === "number" && Math.abs(gap) <= 0.01;
    const rowBoundary = input.rowBoundaryChecked === true;
    const rowBoundaryEvidence = input.rowBoundaryEvidence ?? {};
    const countedDataRowChunkIds = countedEvidence.map((item) => item.chunkId);

    if (!input.scout || input.scout.calibrationStatus !== "calibrated" || typeof declared !== "number") {
      return verdict("sum_alignment", "continue", "Declared value is not calibrated yet.", {
        declaredValueFound: false,
        collectedSum,
        evidenceCount: input.evidence.length,
        countedDataRowCount: countedEvidence.length,
        countedDataRowChunkIds,
      });
    }
    if (!input.roleMap) {
      return verdict("sum_alignment", "low_confidence", "Role map is required before numeric sum closure can be trusted.", {
        declaredValue: declared,
        collectedSum,
        gap,
        roleMapPresent: false,
        evidenceCount: input.evidence.length,
        countedDataRowChunkIds,
      });
    }
    if (uncountedNumeric.length > 0) {
      return verdict("sum_alignment", "low_confidence", "Numeric rows with unknown or low-confidence roles were excluded from the sum.", {
        declaredValue: declared,
        collectedSum,
        gap,
        uncountedNumericChunkIds: uncountedNumeric.map((item) => item.chunkId),
        countedDataRowChunkIds,
        rowBoundary,
        rowBoundaryEvidence,
      });
    }
    if (!metricBinding || !competingCheck) {
      return verdict("sum_alignment", "mismatch", "Collected values do not bind cleanly to the calibrated target metric or conflict with another declaration.", {
        declaredValue: declared,
        collectedSum,
        gap,
        unitConsistency,
        metricBinding,
        competingCheck,
        competingConflicts,
        countedDataRowChunkIds,
        rowBoundary,
        rowBoundaryEvidence,
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
        countedDataRowChunkIds,
        rowBoundary,
        rowBoundaryEvidence,
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
        countedDataRowChunkIds,
        rowBoundary,
        rowBoundaryEvidence,
      });
    }
    return verdict("sum_alignment", "closed", "Numeric sum, metric binding, unit consistency, and row boundary passed.", {
      declaredValue: declared,
      collectedSum,
      gap,
      unitConsistency,
      metricBinding,
      competingCheck,
      countedDataRowChunkIds,
      rowBoundary,
      rowBoundaryEvidence,
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
