import type { Chunk, TraversalSeedCandidate } from "@agent-thinking/contracts";
import type { AgentDatabase } from "../../db.js";
import { buildAoriTraversalMap } from "../aori-traversal-answer.js";
import { previewText, termOverlap, uniqueStrings } from "./utils.js";

export function collectSeedCandidates(db: AgentDatabase, libraryId: string, question: string): TraversalSeedCandidate[] {
  const candidates: TraversalSeedCandidate[] = [];
  const seen = new Set<string>();
  const add = (candidate: TraversalSeedCandidate): void => {
    const key = `${candidate.source}:${candidate.chunkId}`;
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push(candidate);
  };
  const map = buildAoriTraversalMap(db, libraryId);
  for (const node of Object.values(map.nodesById)) {
    const score = Math.max(termOverlap(question, `${node.title} ${node.summary}`), node.confidence * 0.65);
    if (score < 0.08 && !node.chunkIds.length) continue;
    for (const chunkId of node.chunkIds.slice(0, 3)) {
      add({
        chunkId,
        source: "AORI",
        score,
        reliability: 0.95,
        reason: `AORI node ${node.title} matched traversal seed collection.`,
      });
    }
  }
  for (const result of db.searchText(libraryId, question, 8)) {
    add({
      chunkId: result.chunk.id,
      source: "keyword",
      score: Math.max(0.35, Math.min(1, result.score)),
      reliability: 0.6,
      reason: "keyword seed from chunk FTS",
    });
  }
  for (const chunk of keywordFallbackChunks(db, libraryId, question)) {
    add({
      chunkId: chunk.id,
      source: "vector",
      score: Math.max(0.2, termOverlap(question, `${chunk.headingPath ?? ""} ${chunk.text}`)),
      reliability: 0.8,
      reason: "deterministic vector-slot fallback seed from text overlap",
    });
  }
  return candidates;
}

export function keywordFallbackChunks(db: AgentDatabase, libraryId: string, question: string): Chunk[] {
  const indexes = db.listAoriDocumentIndexes(libraryId);
  const indexedChunkIds = uniqueStrings(indexes.flatMap((index) => [
    ...index.understanding.evidenceChunkIds,
    ...index.aspects.flatMap((aspect) => [
      ...aspect.items.flatMap((item) => item.evidenceChunkIds),
      ...aspect.relations.flatMap((relation) => relation.evidenceChunkIds),
    ]),
    ...index.selfQuestions.flatMap((entry) => entry.evidenceChunkIds),
  ]));
  return db.getChunksByIds(indexedChunkIds)
    .map((chunk) => ({ chunk, score: termOverlap(question, `${chunk.headingPath ?? ""} ${previewText(chunk.text, 120)}`) }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score || left.chunk.ordinal - right.chunk.ordinal)
    .slice(0, 5)
    .map((entry) => entry.chunk);
}
