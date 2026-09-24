// The layered DAG layout.
//
// The geometry is fixed by SPEC.md §8.5: `x = 24 + depth·260`, `y = 24 +
// order·112`, one down and one up barycenter pass, ties broken by decl BYTE
// order. It is deliberately reimplemented here in the same shape as the Rust
// generator's `dag_svg`, because both renderers must emit the same SVG for the
// same record (`renderer_parity`, SPEC.md §13) and a shared layout that lived in
// only one of them would make that test unwritable.
//
// Nothing here consults the viewport, a clock or a random source: the same
// record always yields the same coordinates, in the same order.

import type { DagEdge, DagNode } from "./types";

export const COL_PITCH = 260;
export const ROW_PITCH = 112;
export const ORIGIN = 24;
export const NODE_W = 220;
export const NODE_H = 88;

/** Oversize thresholds (SPEC.md §8.5). Above either one the `Graph` option is
 * rendered disabled — its label unchanged — and `List` is the only layout. */
export const MAX_GRAPH_NODES = 400;
export const MAX_GRAPH_EDGES = 4000;

export function oversized(nodeCount: number, edgeCount: number): boolean {
  return nodeCount > MAX_GRAPH_NODES || edgeCount > MAX_GRAPH_EDGES;
}

const UTF8 = new TextEncoder();

/** Byte order over the UTF-8 encoding, which is what `str::cmp` compares in the
 * generator. JavaScript's own `<` compares UTF-16 code units and disagrees with
 * it above U+FFFF, so the tie-break is written out rather than borrowed. */
export function byteOrder(a: string, b: string): number {
  const x = UTF8.encode(a);
  const y = UTF8.encode(b);
  const n = Math.min(x.length, y.length);
  for (let i = 0; i < n; i += 1) {
    const xi = x[i] as number;
    const yi = y[i] as number;
    if (xi !== yi) return xi < yi ? -1 : 1;
  }
  return x.length === y.length ? 0 : x.length < y.length ? -1 : 1;
}

export interface Placement {
  decl_name: string;
  kind: string;
  citable: boolean;
  is_root: boolean;
  depth: number;
  order: number;
  x: number;
  y: number;
}

export interface Layout {
  width: number;
  height: number;
  /** In the record's own node order, which is the order the generator emits. */
  nodes: Placement[];
  placement: Map<string, Placement>;
  /** Sorted by `(used_by, uses)`, the generator's emission order. */
  edges: DagEdge[];
  maxDepth: number;
  maxRows: number;
}

export function layout(nodes: DagNode[], edges: DagEdge[]): Layout {
  const maxDepth = nodes.reduce((m, n) => Math.max(m, n.depth), 0);
  const columns: DagNode[][] = [];
  for (let d = 0; d <= maxDepth; d += 1) columns.push([]);
  for (const n of nodes) (columns[n.depth] as DagNode[]).push(n);
  for (const c of columns) {
    c.sort((x, y) => (x.topo !== y.topo ? x.topo - y.topo : byteOrder(x.decl_name, y.decl_name)));
  }

  const order = new Map<string, number>();
  for (const c of columns) c.forEach((n, i) => order.set(n.decl_name, i));

  for (let pass = 0; pass < 2; pass += 1) {
    const range: number[] = [];
    if (pass === 0) {
      for (let i = 1; i < columns.length; i += 1) range.push(i);
    } else {
      for (let i = columns.length - 2; i >= 0; i -= 1) range.push(i);
    }
    for (const ci of range) {
      const column = columns[ci] as DagNode[];
      const scored: { b: number; n: DagNode }[] = column.map((n) => {
        const neighbours: number[] = [];
        for (const e of edges) {
          if (pass === 0 && e.uses === n.decl_name) {
            const o = order.get(e.used_by);
            if (o !== undefined) neighbours.push(o);
          } else if (pass === 1 && e.used_by === n.decl_name) {
            const o = order.get(e.uses);
            if (o !== undefined) neighbours.push(o);
          }
        }
        const b =
          neighbours.length === 0
            ? (order.get(n.decl_name) ?? 0)
            : neighbours.reduce((s, v) => s + v, 0) / neighbours.length;
        return { b, n };
      });
      scored.sort((x, y) => (x.b !== y.b ? x.b - y.b : byteOrder(x.n.decl_name, y.n.decl_name)));
      columns[ci] = scored.map((s) => s.n);
      (columns[ci] as DagNode[]).forEach((n, i) => order.set(n.decl_name, i));
    }
  }

  const placement = new Map<string, Placement>();
  let maxRows = 0;
  columns.forEach((c, d) => {
    maxRows = Math.max(maxRows, c.length);
    c.forEach((n, i) => {
      placement.set(n.decl_name, {
        decl_name: n.decl_name,
        kind: n.kind,
        citable: n.citable,
        is_root: n.is_root,
        depth: d,
        order: i,
        x: ORIGIN + d * COL_PITCH,
        y: ORIGIN + i * ROW_PITCH,
      });
    });
  });

  const sortedEdges = [...edges].sort(
    (x, y) => byteOrder(x.used_by, y.used_by) || byteOrder(x.uses, y.uses),
  );

  return {
    width: ORIGIN + (maxDepth + 1) * COL_PITCH,
    height: ORIGIN + maxRows * ROW_PITCH,
    nodes: nodes.map((n) => placement.get(n.decl_name)).filter((p): p is Placement => !!p),
    placement,
    edges: sortedEdges,
    maxDepth,
    maxRows,
  };
}

/** The generator's own truncation of a node caption: the last dotted segment,
 * cut at 25 characters. Reproduced exactly, because the two SVGs are compared
 * character for character. */
export function shortDecl(decl: string): string {
  const parts = decl.split(".");
  const tail = parts[parts.length - 1] ?? decl;
  const chars = Array.from(tail);
  return chars.length > 26 ? chars.slice(0, 25).join("") + "…" : tail;
}

export function edgePath(from: Placement, to: Placement): string {
  const x1 = from.x;
  const y1 = from.y;
  const x2 = to.x;
  const y2 = to.y;
  return `M${x1 + 220} ${y1 + 44} C${x1 + 240} ${y1 + 44} ${x2 - 20} ${y2 + 44} ${x2} ${y2 + 44}`;
}
