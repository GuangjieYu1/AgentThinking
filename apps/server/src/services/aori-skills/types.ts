import type {
  AoriSkillName,
  AoriSkillRoute,
  AoriTraversalMap,
  Chunk,
  EvidencePack,
  PulseAnswerOutput,
  PulseStreamEvent,
} from "@agent-thinking/contracts";
import type { PendingPulseHit } from "../../db.js";
import type { ModelProvider } from "../models.js";

export type PulseEventSink = (event: PulseStreamEvent) => void | Promise<void>;

export interface AoriSkillExecutionInput {
  libraryId: string;
  question: string;
  map: AoriTraversalMap;
  route: AoriSkillRoute;
  chunksById: Map<string, Chunk>;
  model: ModelProvider;
  eventSink?: PulseEventSink;
}

export interface AoriSkillExecutionResult {
  skill: AoriSkillName;
  answer: PulseAnswerOutput;
  evidencePack: EvidencePack;
  diagnostics: Record<string, unknown>;
  chunks: Chunk[];
  hits: PendingPulseHit[];
}

export async function emitSkillEvent(
  eventSink: PulseEventSink | undefined,
  type: PulseStreamEvent extends infer Event
    ? Event extends { type: infer Type; message: string; payload?: unknown }
      ? Type
      : never
    : never,
  message: string,
  payload?: unknown,
): Promise<void> {
  if (!eventSink) return;
  await eventSink((payload === undefined ? { type, message } : { type, message, payload }) as PulseStreamEvent);
}
