import { executeArgumentResponseSkill } from "./argument-response.js";
import { executeFacetCountSkill } from "./facet-count.js";
import { executeFacetSumSkill } from "./facet-sum.js";
import { executeTimelineSkill } from "./timeline.js";
import type { AoriSkillExecutionInput, AoriSkillExecutionResult } from "./types.js";

export async function executeAoriSkill(input: AoriSkillExecutionInput): Promise<AoriSkillExecutionResult> {
  if (input.route.skill === "facet_count") return executeFacetCountSkill(input);
  if (input.route.skill === "facet_sum") return executeFacetSumSkill(input);
  if (input.route.skill === "argument_response") return executeArgumentResponseSkill(input);
  if (input.route.skill === "timeline") return executeTimelineSkill(input);
  throw new Error(`AORI skill ${input.route.skill} is routed but not implemented yet.`);
}
