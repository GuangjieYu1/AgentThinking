import { describe, expect, it } from "vitest";
import type { Chunk, MappingAuditResult } from "@agent-thinking/contracts";
import {
  buildMappingAuditMetrics,
  mergeProgrammaticFindings,
  programmaticSemanticCoverageAudit,
} from "../src/services/mapping-audit-rules.js";
import type { MappingAuditContext } from "../src/services/models.js";

function chunk(id: string, ordinal: number, headingPath = "Topic"): Chunk {
  return {
    id,
    libraryId: "library-1",
    versionId: "version-1",
    ordinal,
    headingPath,
    pageNumber: null,
    startLine: null,
    endLine: null,
    blockId: null,
    startChar: ordinal * 10,
    endChar: ordinal * 10 + 9,
    text: `chunk ${id}`,
    aspects: [],
  };
}

function baseContext(): MappingAuditContext {
  return {
    versionId: "version-1",
    documentName: "source.md",
    chunks: [chunk("c1", 0), chunk("c2", 1), chunk("c3", 2), chunk("c4", 3, "Other")],
    nodes: [
      { id: "n1", kind: "claim", title: "Claim", summary: "summary", level: 1, evidenceChunkIds: ["c1"] },
      { id: "n2", kind: "concept", title: "Concept 2", summary: "summary", level: 1, evidenceChunkIds: ["c2"] },
      { id: "n3", kind: "concept", title: "Concept 3", summary: "summary", level: 1, evidenceChunkIds: ["c4"] },
      { id: "n4", kind: "concept", title: "No evidence", summary: "summary", level: 1, evidenceChunkIds: [] },
    ],
    relations: [
      {
        id: "r1",
        type: "related_to",
        sourceNodeId: "n1",
        sourceTitle: "Claim",
        targetNodeId: "n3",
        targetTitle: "Concept 3",
        reason: "weak",
        confidence: 0.5,
        evidenceChunkIds: ["c1"],
      },
      {
        id: "r2",
        type: "supports",
        sourceNodeId: "n3",
        sourceTitle: "Concept 3",
        targetNodeId: "n4",
        targetTitle: "No evidence",
        reason: "unsupported",
        confidence: 0.8,
        evidenceChunkIds: [],
      },
      {
        id: "r3",
        type: "related_to",
        sourceNodeId: "n1",
        sourceTitle: "Claim",
        targetNodeId: "n4",
        targetTitle: "No evidence",
        reason: "weak",
        confidence: 0.5,
        evidenceChunkIds: ["c1"],
      },
      {
        id: "r4",
        type: "related_to",
        sourceNodeId: "n1",
        sourceTitle: "Claim",
        targetNodeId: "missing",
        targetTitle: "Missing",
        reason: "bad endpoint",
        confidence: 0.5,
        evidenceChunkIds: ["c1"],
      },
    ],
  };
}

describe("programmatic semantic coverage rules", () => {
  it("flags chunks without any node or relation evidence mapping", () => {
    const findings = programmaticSemanticCoverageAudit(baseContext());
    expect(findings.some((finding) => finding.kind === "missing_source_meaning" && finding.evidenceChunkIds.includes("c3"))).toBe(true);
  });

  it("flags nodes and relations without evidence", () => {
    const findings = programmaticSemanticCoverageAudit(baseContext());
    expect(findings.some((finding) => finding.kind === "unsupported_graph_claim" && finding.nodeIds.includes("n4"))).toBe(true);
    expect(findings.some((finding) => finding.kind === "unsupported_graph_claim" && finding.relationIds.includes("r2"))).toBe(true);
  });

  it("flags structurally wrong relations", () => {
    const findings = programmaticSemanticCoverageAudit(baseContext());
    expect(findings.some((finding) => finding.kind === "wrong_relation" && finding.relationIds.includes("r4"))).toBe(true);
  });

  it("flags adjacent chunk boundary loss candidates", () => {
    const findings = programmaticSemanticCoverageAudit(baseContext());
    expect(findings.some((finding) => finding.kind === "chunk_boundary_loss")).toBe(true);
  });

  it("flags weak related_to communities as overgeneralization candidates", () => {
    const context = baseContext();
    context.relations = [
      { id: "r1", type: "related_to", sourceNodeId: "n1", sourceTitle: "Claim", targetNodeId: "n2", targetTitle: "Concept 2", reason: "weak", confidence: 0.5, evidenceChunkIds: ["c1"] },
      { id: "r2", type: "related_to", sourceNodeId: "n1", sourceTitle: "Claim", targetNodeId: "n3", targetTitle: "Concept 3", reason: "weak", confidence: 0.5, evidenceChunkIds: ["c1"] },
      { id: "r3", type: "related_to", sourceNodeId: "n1", sourceTitle: "Claim", targetNodeId: "n4", targetTitle: "No evidence", reason: "weak", confidence: 0.5, evidenceChunkIds: ["c1"] },
    ];
    const findings = programmaticSemanticCoverageAudit(context);
    expect(findings.some((finding) => finding.kind === "overgeneralization" && finding.nodeIds.includes("n1"))).toBe(true);
  });

  it("merges programmatic and LLM findings with open lifecycle defaults", () => {
    const ruleFindings = programmaticSemanticCoverageAudit(baseContext());
    const audit: MappingAuditResult = {
      status: "clean",
      summary: "ok",
      reconstruction: "text",
      findings: [{
        kind: "other",
        severity: "low",
        title: "LLM finding",
        description: "Check this",
        suggestion: "Review",
        evidenceChunkIds: ["c1"],
        nodeIds: [],
        relationIds: [],
        userComment: "",
      }],
    };
    const merged = mergeProgrammaticFindings(audit, ruleFindings);
    expect(merged.status).toBe("major_issues");
    expect(merged.findings.every((finding) => finding.status === "open")).toBe(true);
    expect(merged.findings.every((finding) => finding.ruleCategory)).toBe(true);
  });

  it("builds mapping audit metrics", () => {
    const context = baseContext();
    const findings = programmaticSemanticCoverageAudit(context);
    const metrics = buildMappingAuditMetrics(context, findings);
    expect(metrics.chunkCount).toBe(4);
    expect(metrics.nodeCount).toBe(4);
    expect(metrics.relationCount).toBe(4);
    expect(metrics.findingCount).toBe(findings.length);
    expect(metrics.mediumSeverityCount! + metrics.lowSeverityCount! + metrics.highSeverityCount!).toBe(findings.length);
    expect(metrics.unsupportedClaimRate).toBeGreaterThan(0);
    expect(metrics.wrongRelationRate).toBeGreaterThan(0);
    expect(metrics.coverageScore).toBeLessThan(1);
  });
});
