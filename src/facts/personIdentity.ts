import type {
  DocSearchOutcome,
  PersonFactCard,
  PersonRef,
  SourceRef,
} from '../types';
import { getDb } from '../events/db';
import { sourceRef } from '../docs/sourceRef';
import { factNode } from './factGraph';
import {
  resolveFactEntity,
  type FactEntityCandidate,
} from './historyLookup';
import { materializePersonCard } from './personCard';
import type { IdentityIntent } from '../llm/identityIntent';

export interface PersonIdentityCandidate extends PersonRef {
  aliases: string[];
}

export type PersonIdentityOutcome =
  | {
      status: 'resolved';
      person: PersonRef;
      card: PersonFactCard;
      source: SourceRef;
    }
  | {
      status: 'ambiguous' | 'not_found';
      query: string;
      candidates: PersonIdentityCandidate[];
    }
  | {
      status: 'card_unavailable';
      person: PersonRef;
      pack_name: string;
    };

type Passage = DocSearchOutcome['results'][number];

function personRef(candidate: FactEntityCandidate): PersonRef {
  return {
    pack_id: candidate.pack_id,
    id: candidate.id,
    name: candidate.name,
  };
}

function aliases(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((alias): alias is string => typeof alias === 'string')
    : [];
}

function candidates(rows: FactEntityCandidate[]): PersonIdentityCandidate[] {
  return rows.map(row => ({
    ...personRef(row),
    aliases: aliases(factNode(row)?.attrs.aliases),
  }));
}

function packName(packId: string): string {
  const result = getDb().execute('SELECT name FROM packs WHERE id = ?', [packId]);
  return result.rows?.length ? String(result.rows.item(0).name) : packId;
}

function linkedPassage(person: PersonRef): Passage | null {
  const result = getDb().execute(
    `SELECT d.id, d.pack_id, d.source_file, d.heading, d.content,
            p.name AS pack_name
     FROM person_card_chunks i
     JOIN doc_chunks d ON d.id = i.chunk_id AND d.pack_id = i.pack_id
     JOIN packs p ON p.id = i.pack_id AND p.enabled = 1
     WHERE i.pack_id = ? AND i.person_id = ?
       AND NOT EXISTS (
         SELECT 1 FROM fact_exclusions x
         WHERE x.pack_id = i.pack_id AND x.node_id = i.person_id
       )`,
    [person.pack_id, person.id],
  );
  if (!result.rows?.length) {
    return null;
  }
  const row = result.rows.item(0);
  return {
    id: Number(row.id),
    pack_id: String(row.pack_id),
    source_file: String(row.source_file),
    heading: String(row.heading),
    content: String(row.content),
    pack_name: String(row.pack_name),
  };
}

/** Resolve a confident identity shape against enabled graph people, then fetch
 * exactly the chunk linked to that pack-local person ID. No retrieval ranking
 * participates anywhere in this path. */
export function lookupPersonIdentity(intent: IdentityIntent): PersonIdentityOutcome {
  let person: PersonRef | null = null;
  if (intent.anchoredPerson) {
    const node = factNode(intent.anchoredPerson);
    if (node?.type === 'person') {
      person = {
        pack_id: node.pack_id,
        id: node.id,
        name: node.name,
      };
    }
  } else {
    const resolution = resolveFactEntity(intent.topic, 'person');
    if (resolution.status !== 'resolved') {
      return {
        status: resolution.status,
        query: intent.topic,
        candidates: candidates(resolution.candidates),
      };
    }
    person = {
      pack_id: resolution.node.pack_id,
      id: resolution.node.id,
      name: resolution.node.name,
    };
  }

  if (!person) {
    return { status: 'not_found', query: intent.topic, candidates: [] };
  }
  const passage = linkedPassage(person);
  if (!passage) {
    return { status: 'card_unavailable', person, pack_name: packName(person.pack_id) };
  }
  const card = materializePersonCard(passage, person);
  if (!card) {
    return { status: 'card_unavailable', person, pack_name: passage.pack_name };
  }
  return {
    status: 'resolved',
    person,
    card,
    source: sourceRef(passage, [person.name]),
  };
}
