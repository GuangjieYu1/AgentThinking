import { afterEach, describe, expect, it } from "vitest";
import type { DemandAnswerPlan, EvidenceRecord } from "@agent-thinking/contracts";
import {
  aoriPulseEvalScenarios,
  assessEvalScenario,
  cleanupEvalDatabases,
  createEvalWorkspace,
  diagnosticsFrom,
  EvalModelProvider,
  runEvalScenario,
} from "./helpers/aori-pulse-eval-fixtures.js";

afterEach(async () => {
  await cleanupEvalDatabases();
});

describe("AORI/Pulse public dataset eval fixtures", () => {
  it("indexes deduped context excerpts without answer labels or metadata prompts", () => {
    expect(aoriPulseEvalScenarios).toHaveLength(25);
    expect(aoriPulseEvalScenarios.some((scenario) => scenario.name.includes("multihop"))).toBe(false);
    for (const scenario of aoriPulseEvalScenarios) {
      expect(scenario.expected.testsetAnswers.length).toBeGreaterThan(0);
      expect(scenario.items[0]?.text).not.toContain("answer_value:");
      expect(scenario.items[0]?.text).not.toContain("evidence:");
      expect(scenario.items[0]?.text).not.toContain("question_id:");
      expect(scenario.items[0]?.text).not.toContain("source_url:");
      expect(scenario.items[0]?.text).not.toContain("context_excerpt:");
    }
  });

  it("runs all questions as direct pulses against one shared eval knowledge base", async () => {
    const model = new EvalModelProvider();
    const workspace = await createEvalWorkspace(model);

    try {
      for (const scenario of aoriPulseEvalScenarios.slice(0, 6)) {
        const { pulse, events } = await runEvalScenario(scenario, { model, workspace });
        const assessment = assessEvalScenario(scenario, pulse, events);

        const diagnostics = diagnosticsFrom(pulse);
        const records = diagnostics.evidenceRecords as EvidenceRecord[];
        const plan = diagnostics.demandPlan as DemandAnswerPlan;

        expect(pulse.pulse.answer.length).toBeGreaterThan(0);
        expect(assessment.structuralPass).toBe(true);
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
      }
    } finally {
      workspace.db.close();
    }
  });
});
