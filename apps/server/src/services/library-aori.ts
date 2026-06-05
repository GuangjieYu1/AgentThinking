import { randomUUID } from "node:crypto";
import type {
  AoriDocumentIndex,
  Aspect,
  AspectItem,
  AspectKind,
  AspectRelation,
  EntityAlignment,
  LibraryAoriProfile,
  LibraryAspect,
  LibraryEntity,
  LibraryMergePlan,
  LibraryRelation,
  LibraryRelationAssertion,
  LibraryRelationLexiconEntry,
  RelationAssertionDraft,
  SourceRef,
} from "@agent-thinking/contracts";
import type { AgentDatabase } from "../db.js";

const entityAspectKinds = new Set<AspectKind>(["entity", "person", "organization", "place", "object"]);

function timestamp(): string {
  return new Date().toISOString();
}

function normalizeLabel(value: string): string {
  return value.normalize("NFKC").trim().toLowerCase();
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function quoteFromRefs(refs: SourceRef[]): string | null {
  return refs.find((ref) => ref.quote?.trim())?.quote?.trim() ?? null;
}

function evidenceRefsFor(index: AoriDocumentIndex, chunkIds: string[], reason: string): SourceRef[] {
  return chunkIds.slice(0, 6).map((chunkId) => ({
    documentId: index.documentId,
    versionId: index.versionId,
    chunkId,
    reason,
  }));
}

function relationFamily(domainRelation: string, baseRelation: string): string {
  const normalized = normalizeLabel(domainRelation);
  if (!normalized || normalized === "unknown") return baseRelation || "related_to";
  return normalized;
}

function aggregateRelationLabel(assertions: LibraryRelationAssertion[]): string {
  const labels = uniqueStrings(assertions.map((assertion) => assertion.domainRelation));
  const joined = labels.join(" / ");
  const hasFriend = labels.some((label) => label.includes("朋友") || normalizeLabel(label).includes("friend"));
  const hasEnemy = labels.some((label) => label.includes("敌") || normalizeLabel(label).includes("enemy"));
  if (hasFriend && hasEnemy) return "亦敌亦友";
  if (labels.length > 1) return "多重关系";
  return labels[0] ?? "aggregate relation";
}

function entityTypeFromAspect(aspect: Aspect | undefined): string {
  if (!aspect) return "unknown";
  return entityAspectKinds.has(aspect.kind) ? aspect.kind : aspect.domainKind || aspect.kind;
}

function documentRelationToLibrary(index: AoriDocumentIndex, existing: LibraryAoriProfile | undefined) {
  if (!existing || existing.assertions.length === 0) {
    return {
      relationType: "seed",
      domainRelation: "initial_document",
      explanation: "This is the first AORI document contributing to the Library AORI profile.",
      confidence: 0.8,
    };
  }
  const hasSharedAspect = index.aspects.some((aspect) =>
    existing.aspects.some((libraryAspect) =>
      normalizeLabel(libraryAspect.title) === normalizeLabel(aspect.title) ||
      normalizeLabel(libraryAspect.domainKind) === normalizeLabel(aspect.domainKind),
    ),
  );
  return {
    relationType: hasSharedAspect ? "same_topic" : "supplement",
    domainRelation: hasSharedAspect ? "shares_library_aspects" : "adds_new_context",
    explanation: hasSharedAspect
      ? "The document shares at least one aspect title/domain kind with existing Library AORI material."
      : "The document contributes new AORI material without a strong existing aspect match.",
    confidence: hasSharedAspect ? 0.72 : 0.58,
  };
}

export class LibraryAoriService {
  constructor(private readonly db: AgentDatabase) {}

  mergeDocument(index: AoriDocumentIndex): LibraryMergePlan {
    const existingProfile = this.db.getLibraryAoriProfile(index.libraryId);
    const existing = existingProfile.available ? existingProfile : undefined;
    const createdAt = timestamp();
    const entityAlignments: EntityAlignment[] = [];
    const aspectAlignments: LibraryMergePlan["aspectAlignments"] = [];
    const relationAlignments: LibraryMergePlan["relationAlignments"] = [];
    const assertionsToAdd: RelationAssertionDraft[] = [];
    const documentRelation = documentRelationToLibrary(index, existing);

    this.db.upsertLibraryAoriProfile(
      index.libraryId,
      existing
        ? `Library AORI contains ${existing.entities.length} entities, ${existing.aspects.length} aspects, and ${existing.assertions.length} relation assertions.`
        : `Library AORI initialized from ${index.documentName}.`,
    );
    this.db.saveLibraryDocumentRelation({
      libraryId: index.libraryId,
      documentId: index.documentId,
      versionId: index.versionId,
      relationType: documentRelation.relationType,
      domainRelation: documentRelation.domainRelation,
      explanation: documentRelation.explanation,
      confidence: documentRelation.confidence,
      createdAt,
    });

    const profileBefore = this.db.getLibraryAoriProfile(index.libraryId);
    const currentEntities = profileBefore.available ? profileBefore.entities : [];
    const currentAspects = profileBefore.available ? profileBefore.aspects : [];
    const currentLexicon = profileBefore.available ? profileBefore.relationLexicon : [];
    const entityByDocumentItemId = new Map<string, LibraryEntity>();
    const aspectByDocumentAspectId = new Map<string, LibraryAspect>();

    const upsertEntity = (item: AspectItem, aspect: Aspect | undefined): LibraryEntity => {
      const normalized = normalizeLabel(item.title);
      const matched = currentEntities.find((entity) =>
        normalizeLabel(entity.canonicalName) === normalized ||
        entity.aliases.some((alias) => normalizeLabel(alias) === normalized),
      );
      const evidenceRefs = evidenceRefsFor(index, item.evidenceChunkIds, `Entity evidence for ${item.title}`);
      if (matched) {
        const next: LibraryEntity = {
          ...matched,
          aliases: uniqueStrings([...matched.aliases, item.title]),
          summary: matched.summary || item.summary,
          evidenceRefs: [...matched.evidenceRefs, ...evidenceRefs].slice(0, 30),
          confidence: Math.max(matched.confidence, item.confidence),
          updatedAt: createdAt,
        };
        this.db.upsertLibraryEntity(next);
        entityAlignments.push({
          documentEntityName: item.title,
          libraryEntityId: next.id,
          decision: "same",
          reason: "Document AORI item matched an existing library entity label with source evidence retained.",
          evidenceChunkIds: item.evidenceChunkIds,
          confidence: Math.max(0.55, item.confidence),
        });
        entityByDocumentItemId.set(item.id, next);
        return next;
      }
      const entity: LibraryEntity = {
        id: `library-entity-${randomUUID()}`,
        libraryId: index.libraryId,
        canonicalName: item.title,
        aliases: uniqueStrings([item.title]),
        entityType: entityTypeFromAspect(aspect),
        summary: item.summary,
        firstSeenDocumentId: index.documentId,
        evidenceRefs,
        confidence: Math.max(0.35, item.confidence),
        createdAt,
        updatedAt: createdAt,
      };
      this.db.upsertLibraryEntity(entity);
      currentEntities.push(entity);
      entityAlignments.push({
        documentEntityName: item.title,
        libraryEntityId: entity.id,
        decision: "new",
        reason: "No existing library entity matched this source-bound AORI item.",
        evidenceChunkIds: item.evidenceChunkIds,
        confidence: entity.confidence,
      });
      entityByDocumentItemId.set(item.id, entity);
      return entity;
    };

    const upsertAspect = (aspect: Aspect): LibraryAspect => {
      const matched = currentAspects.find((libraryAspect) =>
        normalizeLabel(libraryAspect.title) === normalizeLabel(aspect.title) ||
        normalizeLabel(libraryAspect.domainKind) === normalizeLabel(aspect.domainKind),
      );
      const evidenceRefs = evidenceRefsFor(index, aspect.items.flatMap((item) => item.evidenceChunkIds), `Aspect evidence for ${aspect.title}`);
      if (matched) {
        const next: LibraryAspect = {
          ...matched,
          relatedDocumentAspectIds: uniqueStrings([...matched.relatedDocumentAspectIds, aspect.id]),
          evidenceRefs: [...matched.evidenceRefs, ...evidenceRefs].slice(0, 30),
          confidence: Math.max(matched.confidence, aspect.confidence),
          updatedAt: createdAt,
        };
        this.db.upsertLibraryAspect(next);
        aspectAlignments.push({
          documentAspectId: aspect.id,
          libraryAspectId: next.id,
          decision: "map_to_existing",
          reason: "Document aspect matched an existing LibraryAspect by semantic title/domain kind.",
          confidence: next.confidence,
        });
        aspectByDocumentAspectId.set(aspect.id, next);
        return next;
      }
      const libraryAspect: LibraryAspect = {
        id: `library-aspect-${randomUUID()}`,
        libraryId: index.libraryId,
        title: aspect.title,
        kind: aspect.kind,
        domainKind: aspect.domainKind,
        summary: aspect.summary,
        relatedDocumentAspectIds: [aspect.id],
        parentAspectId: null,
        evidenceRefs,
        confidence: Math.max(0.35, aspect.confidence),
        createdAt,
        updatedAt: createdAt,
      };
      this.db.upsertLibraryAspect(libraryAspect);
      currentAspects.push(libraryAspect);
      aspectAlignments.push({
        documentAspectId: aspect.id,
        libraryAspectId: libraryAspect.id,
        decision: "new_aspect",
        reason: "No existing LibraryAspect matched this document aspect.",
        confidence: libraryAspect.confidence,
      });
      aspectByDocumentAspectId.set(aspect.id, libraryAspect);
      return libraryAspect;
    };

    for (const aspect of index.aspects) {
      const libraryAspect = upsertAspect(aspect);
      for (const item of aspect.items) {
        if (entityAspectKinds.has(aspect.kind) || aspect.relations.some((relation) => relation.sourceItemId === item.id || relation.targetItemId === item.id)) {
          upsertEntity(item, aspect);
        }
      }
      aspectByDocumentAspectId.set(aspect.id, libraryAspect);
    }

    const itemById = new Map(index.aspects.flatMap((aspect) => aspect.items.map((item) => [item.id, item] as const)));
    const aspectById = new Map(index.aspects.map((aspect) => [aspect.id, aspect] as const));
    for (const aspect of index.aspects) {
      for (const relation of aspect.relations) {
        const sourceItem = itemById.get(relation.sourceItemId);
        const targetItem = itemById.get(relation.targetItemId);
        if (!sourceItem || !targetItem) continue;
        const sourceEntity = entityByDocumentItemId.get(sourceItem.id) ?? upsertEntity(sourceItem, aspectById.get(aspect.id));
        const targetEntity = entityByDocumentItemId.get(targetItem.id) ?? upsertEntity(targetItem, aspectById.get(aspect.id));
        const libraryAspect = aspectByDocumentAspectId.get(aspect.id);
        const family = relationFamily(relation.domainRelation || relation.relationName, relation.baseRelation);
        const matchedLexicon = currentLexicon.find((entry) => normalizeLabel(entry.relationFamily) === normalizeLabel(family));
        const lexiconEntry: LibraryRelationLexiconEntry = matchedLexicon
          ? {
            ...matchedLexicon,
            examples: [
              ...matchedLexicon.examples,
              ...evidenceRefsFor(index, relation.evidenceChunkIds, `Relation example for ${relation.domainRelation}`),
            ].slice(0, 30),
            confidence: Math.max(matchedLexicon.confidence, relation.confidence),
            updatedAt: createdAt,
          }
          : {
            id: `library-relation-lexicon-${randomUUID()}`,
            libraryId: index.libraryId,
            domainRelation: relation.domainRelation || relation.relationName,
            relationFamily: family,
            normalizedMeaning: relation.normalizedRelation ?? relation.reason,
            examples: evidenceRefsFor(index, relation.evidenceChunkIds, `Relation example for ${relation.domainRelation}`),
            confidence: Math.max(0.35, relation.confidence),
            createdAt,
            updatedAt: createdAt,
          };
        this.db.upsertLibraryRelationLexiconEntry(lexiconEntry);
        if (!matchedLexicon) currentLexicon.push(lexiconEntry);
        relationAlignments.push({
          documentRelation: relation.domainRelation || relation.relationName,
          decision: matchedLexicon ? "abstract_under_family" : "new_relation",
          relationFamily: family,
          reason: matchedLexicon
            ? "Document relation was grouped under an existing Library relation family."
            : "Document relation introduced a new Library relation family.",
          confidence: lexiconEntry.confidence,
        });

        const draft: RelationAssertionDraft = {
          sourceEntityId: sourceEntity.id,
          targetEntityId: targetEntity.id,
          sourceAspectId: libraryAspect?.id ?? null,
          targetAspectId: libraryAspect?.id ?? null,
          domainRelation: relation.domainRelation || relation.relationName,
          relationFamily: family,
          assertionText: `${sourceItem.title} ${relation.domainRelation || relation.relationName} ${targetItem.title}`,
          documentAspectId: aspect.id,
          documentItemId: sourceItem.id,
          documentRelationId: relation.id,
          evidenceChunkIds: relation.evidenceChunkIds,
          quote: null,
          confidence: relation.confidence,
        };
        assertionsToAdd.push(draft);
        this.db.upsertLibraryRelationAssertion({
          id: `library-assertion-${relation.id}`,
          libraryId: index.libraryId,
          ...draft,
          documentId: index.documentId,
          versionId: index.versionId,
          quote: draft.quote ?? quoteFromRefs(evidenceRefsFor(index, relation.evidenceChunkIds, "Relation assertion quote")),
          confidence: Math.max(0.35, draft.confidence),
          status: relation.evidenceStatus === "unsupported" ? "uncertain" : "active",
          createdAt,
          updatedAt: createdAt,
        });
      }
    }

    const latestProfile = this.db.getLibraryAoriProfile(index.libraryId);
    const aggregateUpdates: LibraryMergePlan["aggregateUpdates"] = [];
    if (latestProfile.available) {
      const byPair = new Map<string, LibraryRelationAssertion[]>();
      for (const assertion of latestProfile.assertions) {
        if (!assertion.sourceEntityId || !assertion.targetEntityId) continue;
        const [sourceId, targetId] = [assertion.sourceEntityId, assertion.targetEntityId].sort();
        const key = `${sourceId}::${targetId}`;
        const group = byPair.get(key) ?? [];
        group.push(assertion);
        byPair.set(key, group);
      }
      for (const assertions of byPair.values()) {
        const first = assertions[0];
        if (!first?.sourceEntityId || !first.targetEntityId) continue;
        const pair = [first.sourceEntityId, first.targetEntityId].sort() as [string, string];
        const [sourceId, targetId] = pair;
        const aggregate: LibraryRelation = {
          id: `library-relation-${sourceId}-${targetId}`,
          libraryId: index.libraryId,
          sourceId,
          targetId,
          aggregateRelation: aggregateRelationLabel(assertions),
          relationFamily: "aggregate",
          summary: assertions.map((assertion) => assertion.assertionText).join("；").slice(0, 1000),
          assertionIds: assertions.map((assertion) => assertion.id),
          confidence: Math.max(0.35, ...assertions.map((assertion) => assertion.confidence)),
          createdAt,
          updatedAt: createdAt,
        };
        this.db.upsertLibraryRelation(aggregate);
        aggregateUpdates.push({
          sourceId,
          targetId,
          aggregateRelation: aggregate.aggregateRelation,
          relationFamily: aggregate.relationFamily,
          assertionIds: aggregate.assertionIds,
          summary: aggregate.summary,
          confidence: aggregate.confidence,
        });
      }
    }

    const plan: LibraryMergePlan = {
      id: `library-merge-${index.versionId}`,
      libraryId: index.libraryId,
      documentId: index.documentId,
      versionId: index.versionId,
      documentRelationToLibrary: documentRelation,
      entityAlignments,
      aspectAlignments,
      relationAlignments,
      assertionsToAdd,
      aggregateUpdates,
      unresolvedQuestions: [],
      applied: true,
      createdAt,
      updatedAt: createdAt,
    };
    this.db.saveLibraryMergePlan(plan);
    const finalProfile = this.db.getLibraryAoriProfile(index.libraryId);
    if (finalProfile.available) {
      this.db.upsertLibraryAoriProfile(
        index.libraryId,
        `Library AORI contains ${finalProfile.entities.length} entities, ${finalProfile.aspects.length} aspects, ${finalProfile.assertions.length} assertions, and ${finalProfile.relations.length} aggregate relations.`,
      );
    }
    return plan;
  }
}
