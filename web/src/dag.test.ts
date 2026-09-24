// The DAG layout snapshot.
//
// The geometry is a contract with the Rust generator: the same record must
// produce the same coordinates, the same column order and the same edge
// emission order in both renderers, or `renderer_parity` (SPEC.md §13) fails on
// a difference no reviewer would see. The fixture below is written out in full
// rather than snapshotted to a side file, so a change to the layout shows up as
// a diff in the numbers themselves.

import { describe, expect, it } from "vitest";
import { byteOrder, edgePath, layout, oversized, shortDecl } from "./dag";
import type { DagEdge, DagNode } from "./types";

function node(decl: string, depth: number, topo: number, extra: Partial<DagNode> = {}): DagNode {
  return {
    decl_name: decl,
    kind: "theorem",
    pretty: `${decl} : True`,
    type_sha256: "0".repeat(64),
    is_root: depth === 0,
    citable: true,
    depth,
    topo,
    dictionary_leaves: [],
    ...extra,
  };
}

/**
 *   Submission.main ─┬─ Submission.stepB ── Submission.leaf
 *                    └─ Submission.stepA ──┘
 * The root is depth 0; the two steps share depth 1 and are ordered by the
 * barycenter passes rather than by the order they arrive in.
 */
const NODES: DagNode[] = [
  node("Submission.main", 0, 0),
  node("Submission.stepB", 1, 2),
  node("Submission.stepA", 1, 1),
  node("Submission.leaf", 2, 3, { citable: false }),
];

const EDGES: DagEdge[] = [
  { used_by: "Submission.main", uses: "Submission.stepB", via: "value" },
  { used_by: "Submission.main", uses: "Submission.stepA", via: "value" },
  { used_by: "Submission.stepA", uses: "Submission.leaf", via: "value" },
  { used_by: "Submission.stepB", uses: "Submission.leaf", via: "value" },
];

describe("the layered layout", () => {
  it("places every node on the fixed lattice", () => {
    const l = layout(NODES, EDGES);
    const at = (decl: string): [number, number] => {
      const p = l.placement.get(decl);
      if (!p) throw new Error(decl);
      return [p.x, p.y];
    };
    expect(at("Submission.main")).toEqual([24, 24]);
    expect(at("Submission.stepA")).toEqual([284, 24]);
    expect(at("Submission.stepB")).toEqual([284, 136]);
    expect(at("Submission.leaf")).toEqual([544, 24]);
    expect([l.width, l.height]).toEqual([804, 248]);
    expect(l.maxDepth).toBe(2);
    expect(l.maxRows).toBe(2);
  });

  it("emits the edges in `(used_by, uses)` order, which is the generator's", () => {
    const l = layout(NODES, EDGES);
    expect(l.edges.map((e) => `${e.used_by}->${e.uses}`)).toEqual([
      "Submission.main->Submission.stepA",
      "Submission.main->Submission.stepB",
      "Submission.stepA->Submission.leaf",
      "Submission.stepB->Submission.leaf",
    ]);
  });

  it("draws an edge as the generator's own cubic", () => {
    const l = layout(NODES, EDGES);
    const from = l.placement.get("Submission.main");
    const to = l.placement.get("Submission.stepA");
    if (!from || !to) throw new Error("placement");
    expect(edgePath(from, to)).toBe("M244 68 C264 68 264 68 284 68");
  });

  it("is a pure function of the record, whatever order the rows arrive in", () => {
    const shuffled = [NODES[1], NODES[3], NODES[0], NODES[2]] as DagNode[];
    const a = layout(NODES, EDGES);
    const b = layout(shuffled, [...EDGES].reverse());
    for (const n of NODES) {
      expect(b.placement.get(n.decl_name)).toEqual(a.placement.get(n.decl_name));
    }
  });

  it("breaks ties by decl BYTE order, not by UTF-16 code unit order", () => {
    // U+FF21 encodes as EF BC A1 and U+1D400 as F0 9D 90 80: UTF-8 orders the
    // first before the second, UTF-16 orders the surrogate pair first.
    expect(byteOrder("Ａ", "\u{1D400}")).toBe(-1);
    expect("Ａ" < "\u{1D400}").toBe(false);
    expect(byteOrder("a", "a")).toBe(0);
    expect(byteOrder("ab", "a")).toBe(1);
  });

  it("truncates a caption the way the generator does", () => {
    expect(shortDecl("Submission.main")).toBe("main");
    expect(shortDecl("Submission.a_very_long_declaration_name_here")).toBe(
      "a_very_long_declaration_n…",
    );
    expect(shortDecl("exactly_twenty_six_chars__")).toBe("exactly_twenty_six_chars__");
  });

  it("refuses the graph beyond the node and edge bounds", () => {
    expect(oversized(400, 4000)).toBe(false);
    expect(oversized(401, 0)).toBe(true);
    expect(oversized(0, 4001)).toBe(true);
  });
});
