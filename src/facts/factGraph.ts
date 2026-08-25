import { MultiDirectedGraph } from 'graphology';
import { bidirectional } from 'graphology-shortest-path/unweighted';
import { bfsFromNode, dfsFromNode } from 'graphology-traversal';
import type { DbConnection } from '../events/engine';
import type { GraphEdge, GraphNode } from '../types';

export const FACT_RELATIONS = {
  attendance: 'attended',
  project: 'worked_on',
  sponsorship: 'sponsored_by',
} as const;

export interface FactNodeRef {
  pack_id: string;
  id: string;
}

interface NodeAttributes extends GraphNode {}
interface EdgeAttributes extends GraphEdge {}

type FactGraph = MultiDirectedGraph<NodeAttributes, EdgeAttributes>;

export interface FactGraphStats {
  nodes: number;
  edges: number;
}

export interface FactRelation {
  node: GraphNode;
  edge: GraphEdge;
  direction: 'in' | 'out';
}

export interface FactTraversalNode {
  node: GraphNode;
  depth: number;
}

export interface FactTraversal {
  nodes: FactTraversalNode[];
  edges: GraphEdge[];
}

export interface FactPath {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

let graph: FactGraph = new MultiDirectedGraph<NodeAttributes, EdgeAttributes>();

function nodeKey(ref: FactNodeRef): string {
  return JSON.stringify([ref.pack_id, ref.id]);
}

function parseAttrs(raw: string, ref: FactNodeRef): Record<string, unknown> {
  let attrs: unknown;
  try {
    attrs = JSON.parse(raw);
  } catch {
    throw new Error(`Invalid graph attrs for ${ref.pack_id}/${ref.id}`);
  }
  if (!attrs || typeof attrs !== 'object' || Array.isArray(attrs)) {
    throw new Error(`Invalid graph attrs for ${ref.pack_id}/${ref.id}`);
  }
  return attrs as Record<string, unknown>;
}

function nodeRecord(g: FactGraph, key: string): GraphNode {
  return g.getNodeAttributes(key);
}

function edgeRecord(g: FactGraph, key: string): GraphEdge {
  return g.getEdgeAttributes(key);
}

function relationView(types?: readonly string[]): FactGraph {
  if (!types?.length) {
    return graph;
  }
  const allowed = new Set(types);
  const view = graph.copy();
  for (const edge of graph.edges()) {
    if (!allowed.has(graph.getEdgeAttribute(edge, 'type'))) {
      view.dropEdge(edge);
    }
  }
  return view;
}

let lastRefreshError: string | null = null;

/** The failure from the last safe refresh, or null when it succeeded — the
 * Packs screen surfaces this so a bad pack is visible instead of silent. */
export function factGraphRefreshError(): string | null {
  return lastRefreshError;
}

/** Runtime refresh (boot, pack toggle/remove, post-import): a bad pack row
 * must never take the app down — install already rejected invalid graph
 * data loudly, so a throw here means on-disk state predates the validators
 * (or was hand-edited). Keep serving the previous graph, record the failure,
 * and return null. Validators that WANT the throw call refreshFactGraph. */
export function refreshFactGraphSafe(conn: DbConnection): FactGraphStats | null {
  try {
    const stats = refreshFactGraph(conn);
    lastRefreshError = null;
    return stats;
  } catch (e) {
    lastRefreshError = e instanceof Error ? e.message : String(e);
    console.warn('[factGraph] refresh failed; previous graph kept:', e);
    return null;
  }
}

/** Rebuild from enabled SQLite rows, then swap only after the graph is valid. */
export function refreshFactGraph(conn: DbConnection): FactGraphStats {
  const nodeRows = conn.execute(
    `SELECT n.pack_id, n.id, n.type, n.name, n.attrs
     FROM nodes n
     JOIN packs p ON p.id = n.pack_id
     WHERE p.enabled = 1
       AND NOT EXISTS (
         SELECT 1 FROM fact_exclusions x
         WHERE x.pack_id = n.pack_id AND x.node_id = n.id
       )
     ORDER BY n.pack_id, n.id`,
  ).rows?._array ?? [];
  const edgeRows = conn.execute(
    `SELECT e.id, e.pack_id, e.src, e.dst, e.type, e.year, e.evidence_ref, e.attrs
     FROM edges e
     JOIN packs p ON p.id = e.pack_id
     WHERE p.enabled = 1
       AND NOT EXISTS (
         SELECT 1 FROM fact_exclusions x
         WHERE x.pack_id = e.pack_id AND x.node_id = e.src
       )
       AND NOT EXISTS (
         SELECT 1 FROM fact_exclusions x
         WHERE x.pack_id = e.pack_id AND x.node_id = e.dst
       )
     ORDER BY e.id`,
  ).rows?._array ?? [];
  const next = new MultiDirectedGraph<NodeAttributes, EdgeAttributes>();

  for (const row of nodeRows) {
    const ref = { pack_id: String(row.pack_id), id: String(row.id) };
    next.addNode(nodeKey(ref), {
      ...ref,
      type: String(row.type),
      name: String(row.name),
      attrs: parseAttrs(String(row.attrs), ref),
    });
  }

  for (const row of edgeRows) {
    const pack_id = String(row.pack_id);
    const src = String(row.src);
    const dst = String(row.dst);
    const source = nodeKey({ pack_id, id: src });
    const target = nodeKey({ pack_id, id: dst });
    if (!next.hasNode(source) || !next.hasNode(target)) {
      throw new Error(`Dangling graph edge ${pack_id}/${src} -> ${dst}`);
    }
    const id = Number(row.id);
    next.addDirectedEdgeWithKey(`edge:${id}`, source, target, {
      id,
      pack_id,
      src,
      dst,
      type: String(row.type),
      year: row.year == null ? null : Number(row.year),
      evidence_ref: String(row.evidence_ref),
      // Edge provenance attrs (tier, stated_on, year_source, said_names) —
      // pre-migration rows carry '{}' by DEFAULT; a NULL from an engine that
      // never ran the migration reads the same.
      attrs: parseAttrs(row.attrs == null ? '{}' : String(row.attrs), { pack_id, id: `edge:${id}` }),
    });
  }

  graph = next;
  return factGraphStats();
}

export function factGraphStats(): FactGraphStats {
  return { nodes: graph.order, edges: graph.size };
}

export function factNodes(type?: string): GraphNode[] {
  return graph
    .mapNodes((_key, attrs) => attrs)
    .filter(node => !type || node.type === type);
}

export function factNode(ref: FactNodeRef): GraphNode | null {
  const key = nodeKey(ref);
  return graph.hasNode(key) ? nodeRecord(graph, key) : null;
}

export function factNeighborNodes(
  ref: FactNodeRef,
  direction: 'in' | 'out' | 'both' = 'out',
  relationTypes?: readonly string[],
): GraphNode[] {
  const view = relationView(relationTypes);
  const key = nodeKey(ref);
  if (!view.hasNode(key)) {
    return [];
  }
  const neighbors =
    direction === 'in'
      ? view.inNeighbors(key)
      : direction === 'out'
        ? view.outNeighbors(key)
        : [...new Set([...view.inNeighbors(key), ...view.outNeighbors(key)])];
  return neighbors.map(neighbor => nodeRecord(view, neighbor));
}

export function factRelations(
  ref: FactNodeRef,
  direction: 'in' | 'out',
  relationTypes?: readonly string[],
): FactRelation[] {
  const view = relationView(relationTypes);
  const key = nodeKey(ref);
  if (!view.hasNode(key)) {
    return [];
  }
  const relations: FactRelation[] = [];
  const collect = (
    edge: string,
    _attrs: EdgeAttributes,
    source: string,
    target: string,
  ) => {
    const other = direction === 'out' ? target : source;
    relations.push({
      node: nodeRecord(view, other),
      edge: edgeRecord(view, edge),
      direction,
    });
  };
  if (direction === 'out') {
    view.forEachOutEdge(key, collect);
  } else {
    view.forEachInEdge(key, collect);
  }
  return relations;
}

export function traverseFacts(
  ref: FactNodeRef,
  direction: 'in' | 'out',
  order: 'bfs' | 'dfs' = 'bfs',
  relationTypes?: readonly string[],
): FactTraversal {
  const view = relationView(relationTypes);
  const start = nodeKey(ref);
  if (!view.hasNode(start)) {
    return { nodes: [], edges: [] };
  }
  const nodes: FactTraversalNode[] = [];
  const visited = new Set([start]);
  const visit = (key: string, _attrs: NodeAttributes, depth: number) => {
    visited.add(key);
    if (depth > 0) {
      nodes.push({ node: nodeRecord(view, key), depth });
    }
  };
  const opts = { mode: direction === 'out' ? 'outbound' : 'inbound' } as const;
  if (order === 'bfs') {
    bfsFromNode(view, start, visit, opts);
  } else {
    dfsFromNode(view, start, visit, opts);
  }
  const edges = view
    .filterEdges((_edge, _attrs, source, target) => {
      return visited.has(source) && visited.has(target);
    })
    .map(edge => edgeRecord(view, edge));
  return { nodes, edges };
}

export function shortestFactPath(
  source: FactNodeRef,
  target: FactNodeRef,
  direction: 'in' | 'out' = 'out',
  relationTypes?: readonly string[],
): FactPath | null {
  const view = relationView(relationTypes);
  const start = nodeKey(source);
  const finish = nodeKey(target);
  if (!view.hasNode(start) || !view.hasNode(finish)) {
    return null;
  }
  const raw =
    direction === 'out'
      ? bidirectional(view, start, finish)
      : bidirectional(view, finish, start)?.reverse() ?? null;
  if (!raw) {
    return null;
  }
  const edges: GraphEdge[] = [];
  for (let i = 0; i < raw.length - 1; i++) {
    const from = direction === 'out' ? raw[i] : raw[i + 1];
    const to = direction === 'out' ? raw[i + 1] : raw[i];
    for (const edge of view.outEdges(from, to)) {
      edges.push(edgeRecord(view, edge));
    }
  }
  return {
    nodes: raw.map(key => nodeRecord(view, key)),
    edges,
  };
}

export function attendanceByPerson(ref: FactNodeRef, year?: number): FactRelation[] {
  return factRelations(ref, 'out', [FACT_RELATIONS.attendance]).filter(relation => {
    const relationYear = relation.edge.year ?? Number(relation.node.name);
    return (
      relation.node.type === 'year' &&
      (year === undefined || relationYear === year)
    );
  });
}

export function projectsByPerson(ref: FactNodeRef): FactRelation[] {
  return factRelations(ref, 'out', [FACT_RELATIONS.project]).filter(
    relation => relation.node.type === 'project',
  );
}

export function peopleInYear(ref: FactNodeRef): FactRelation[] {
  return factRelations(ref, 'in', [FACT_RELATIONS.attendance]).filter(
    relation => relation.node.type === 'person',
  );
}

export function sponsorshipLineage(
  ref: FactNodeRef,
  direction: 'sponsors' | 'sponsees' = 'sponsors',
): FactTraversal {
  return traverseFacts(
    ref,
    direction === 'sponsors' ? 'out' : 'in',
    'bfs',
    [FACT_RELATIONS.sponsorship],
  );
}
