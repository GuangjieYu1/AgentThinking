import { afterEach, describe, expect, it } from "vitest";
import type { DemandAnswerPlan, EvidenceRecord } from "@agent-thinking/contracts";
import {
  aoriPulseEvalScenarios,
  assessEvalScenario,
  cleanupEvalDatabases,
  diagnosticsFrom,
  EvalModelProvider,
  runEvalScenario,
} from "./helpers/aori-pulse-eval-fixtures.js";

afterEach(async () => {
  await cleanupEvalDatabases();
});

describe("AORI/Pulse fixed eval fixtures", () => {
  it.each(aoriPulseEvalScenarios)("$name stays source-bound and demand-plan based", async (scenario) => {
    const { db, pulse, events } = await runEvalScenario(scenario, { model: new EvalModelProvider() });
    const assessment = assessEvalScenario(scenario, pulse, events);

    expect(assessment.strictPass).toBe(true);

    const diagnostics = diagnosticsFrom(pulse);
    const records = diagnostics.evidenceRecords as EvidenceRecord[];
    const plan = diagnostics.demandPlan as DemandAnswerPlan;

    expect(diagnostics.answerPipeline).toBe("aori_demand");
    expect(diagnostics.selectedSkill).toBeUndefined();
    expect(records).toHaveLength(scenario.expected.recordCount);
    expect(diagnostics.sourceChunkIds).toHaveLength(scenario.expected.selectedChunkCount);
    expect(pulse.evidencePack?.chunkEvidencePack?.selectedChunks).toHaveLength(scenario.expected.selectedChunkCount);
    expect(pulse.evidencePack?.citations.length ?? 0).toBeGreaterThanOrEqual(scenario.expected.selectedChunkCount);
    expect(pulse.evidencePack?.gaps).toHaveLength(scenario.expected.gapCount ?? 0);
    expect(plan.answerPolicy.mustCiteSourceChunks).toBe(true);
    expect(records.every((record) => record.evidenceChunkIds.length > 0)).toBe(true);
    expect(records.every((record) => Object.values(record.fields).every((field) => field.evidenceChunkIds.length > 0))).toBe(true);

    db.close();
  });
});
