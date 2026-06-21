import type {
  TraversalActiveFront,
  TraversalEvidenceItem,
  TraversalLegalMove,
  TraversalScoutResult,
  TraversalSelectedMove,
  TraversalSubTask,
} from "@agent-thinking/contracts";

export interface LLMPolicyInput {
  subTask: TraversalSubTask;
  front: TraversalActiveFront;
  moves: TraversalLegalMove[];
  scout: TraversalScoutResult;
  evidence: TraversalEvidenceItem[];
}

export interface LLMPolicyDecision {
  selected: TraversalSelectedMove;
  stopProposal: boolean;
}

export class LocalLLMPolicy {
  choose(input: LLMPolicyInput): LLMPolicyDecision {
    const stop = input.moves.find((move) => move.move === "stop_current_front");
    const siblingNext = input.moves.find((move) => move.move === "sibling_next");
    if (input.front.lastSkeleton.role === "summary" && input.scout.tableHarvestPlan) {
      const plan = input.scout.tableHarvestPlan;
      const indicator = plan.subtotalChunkIds.includes(input.front.anchorChunkId)
        ? "subtotal"
        : plan.finalSummaryChunkId === input.front.anchorChunkId
          ? "total"
          : "unknown";
      if (indicator === "total" && stop) {
        return {
          selected: {
            move: stop.move,
            reason: "TableHarvestPlan final summary reached",
            confidence: 0.9,
          },
          stopProposal: true,
        };
      }
      if ((indicator === "subtotal" || indicator === "unknown") && siblingNext) {
        return {
          selected: {
            move: siblingNext.move,
            ...(siblingNext.target ? { target: siblingNext.target } : {}),
            reason: indicator === "subtotal"
              ? "TableHarvestPlan subtotal continues via sibling_next"
              : "TableHarvestPlan unknown summary continues via sibling_next",
            confidence: indicator === "subtotal" ? 0.9 : 0.72,
          },
          stopProposal: false,
        };
      }
    }
    const indicator = input.front.lastSkeleton.indicator;
    const summaryCandidate = input.front.lastSkeleton.role === "summary" || (
      input.subTask.pattern === "table_horizontal" &&
      input.evidence.length > 0 &&
      input.scout.calibrationStatus === "calibrated" &&
      /合计|总计|小计|汇总|total|subtotal|summary/i.test(input.front.lastSkeleton.preview)
    );
    const finalSummary = indicator === "total" || indicator === "final_total";
    const unknownSummary = !indicator || indicator === "unknown_summary";
    if (summaryCandidate && indicator === "subtotal") {
      if (siblingNext) {
        return {
          selected: {
            move: siblingNext.move,
            ...(siblingNext.target ? { target: siblingNext.target } : {}),
            reason: "subtotal summary continues via sibling_next",
            confidence: 0.86,
          },
          stopProposal: false,
        };
      }
    }
    if (summaryCandidate && (finalSummary || unknownSummary) && stop) {
      return {
        selected: {
          move: stop.move,
          ...(stop.target ? { target: stop.target } : {}),
          reason: "summary_candidate stop proposal",
          confidence: 0.72,
        },
        stopProposal: true,
      };
    }

    const orderedMoveTypes = input.subTask.pattern === "table_horizontal"
      ? input.subTask.directionBias === "down_first"
        ? ["child", "sibling_next", "nearby", "parent", "sibling_prev"] as const
        : ["sibling_next", "child", "nearby", "sibling_prev", "parent"] as const
      : input.subTask.directionBias === "down_first"
        ? ["child", "sibling_next", "nearby", "parent", "sibling_prev"] as const
        : ["sibling_next", "nearby", "child", "sibling_prev", "parent"] as const;
    for (const moveType of orderedMoveTypes) {
      const move = input.moves.find((candidate) => candidate.move === moveType);
      if (move) {
        return {
          selected: {
            move: move.move,
            ...(move.target ? { target: move.target } : {}),
            reason: input.subTask.pattern === "table_horizontal" && move.move === "sibling_next"
              ? "table_horizontal policy prioritizes sibling_next"
              : `policy selected ${move.move}`,
            confidence: input.subTask.pattern === "table_horizontal" && move.move === "sibling_next" ? 0.82 : 0.64,
          },
          stopProposal: false,
        };
      }
    }
    return {
      selected: {
        move: "stop_current_front",
        reason: "no non-stop legal moves remain",
        confidence: 0.5,
      },
      stopProposal: true,
    };
  }
}
