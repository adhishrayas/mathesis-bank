// The field catalogue check (SPEC.md §8, R40).
//
// `web/src/fields.ts` is the single authored source. There is no Go→TS codegen
// and no OpenAPI document, so this file and `npm run fields:export -- --check`
// are what keep `crates/record/fields.json` — the copy the Rust templates and
// `prose-lint` read — from drifting.
//
// The one thing the catalogue must not grow is a third `source: "ui"` field:
// the two that exist, `ide.status` and `clipboard.state`, are what let those two
// required snapshots render a state as a VALUE with a real field rather than as
// a label standing in for one.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { FIELDS, manifestGaps, manifestLeaves, type Field, type SchemaNode, type Shape } from "./fields";
import { REPO_DIR } from "./sources";

const SHAPES: Shape[] = [
  "enum", "accession", "timestamp", "integer", "sha256-prefix", "decl",
  "login",
  "name", "label", "em-dash", "lean-statement", "citation",
];

const EXPORTED = join(REPO_DIR, "services", "registry", "crates", "record", "fields.json");

describe("the field catalogue", () => {
  it("declares exactly two ui fields", () => {
    const ui = FIELDS.filter((f) => f.source === "ui").map((f) => f.field).sort();
    expect(ui).toEqual(["clipboard.state", "ide.status"]);
  });

  it("gives every field one of the declared shapes", () => {
    for (const f of FIELDS) expect(SHAPES, f.field).toContain(f.shape);
  });

  it("names no field twice", () => {
    expect(new Set(FIELDS.map((f) => f.field)).size).toBe(FIELDS.length);
  });

  it("gives every field a declared source", () => {
    for (const f of FIELDS) expect(["manifest", "api", "ui"], f.field).toContain(f.source);
  });

  it("keeps the exported copy byte-identical to the authored one", () => {
    const exported = JSON.parse(readFileSync(EXPORTED, "utf8")) as Field[];
    expect(exported).toEqual(FIELDS);
    expect(readFileSync(EXPORTED, "utf8")).toBe(JSON.stringify(FIELDS, null, 2) + "\n");
  });

  it("carries a field for every value a post and its argument's page emit", () => {
    // The author, the ⋯ menu, the claim and the DAG, then the page's DOI,
    // citation and verification rows — enumerated so a renamed field fails here
    // rather than in `prose-lint` over a built tree.
    const names = new Set(FIELDS.map((f) => f.field));
    for (const field of [
      "profile.citation_name", "profile.login", "profile.kind", "argument.cites",
      "accession.kind", "claim.accession", "argument.accession",
      "claim.decl_name", "claim.pretty", "clipboard.state",
      "argument_node.decl_name", "argument_node.kind", "argument_node.pretty",
      "dictionary_constant.name", "replay_accepted", "axiom_manifest",
      "statement_identity", "substrate", "dictionary.label",
      "argument.export_sha256", "argument.created_at", "citation.text", "citation.bibtex",
    ]) {
      expect(names, field).toContain(field);
    }
  });

  it("carries the single permitted null rendering as a field of its own", () => {
    const nul = FIELDS.find((f) => f.field === "null");
    expect(nul?.shape).toBe("em-dash");
  });
});

// The manifest half of `npm run fields:export -- --check`. The schema itself is
// written by the `record` component, so what is checked here is the rule, over
// schemas that exercise both of its verdicts; the script runs the same two
// functions over the real file when the tree carries one.
describe("the manifest leaf check", () => {
  const schema: SchemaNode = {
    properties: {
      doi: { "x-field": "argument.accession" },
      statement: { properties: { pretty: { "x-field": "argument_node.pretty" } } },
      dag: { properties: { nodes: { items: { properties: { decl: { "x-field": "argument_node.decl_name" } } } } } },
      verification: { allOf: [{ properties: { replay: { "x-field": "replay_accepted" } } }] },
    },
  };

  it("finds every annotated leaf, through properties, items and allOf", () => {
    expect(manifestLeaves(schema)).toEqual([
      "argument.accession",
      "argument_node.pretty",
      "argument_node.decl_name",
      "replay_accepted",
    ]);
  });

  it("passes a schema every one of whose leaves is a manifest field", () => {
    expect(manifestGaps(schema, FIELDS)).toEqual([]);
  });

  it("fails a leaf with no entry at all", () => {
    const gaps = manifestGaps({ properties: { x: { "x-field": "claim.invented" } } }, FIELDS);
    expect(gaps).toEqual([{ field: "claim.invented", reason: "absent" }]);
  });

  it("fails a leaf whose entry is not a manifest field", () => {
    // `ide.status` is a real catalogue entry and a real surface state, and it
    // is exactly what must not appear in a generated record.
    const gaps = manifestGaps({ properties: { x: { "x-field": "ide.status" } } }, FIELDS);
    expect(gaps).toEqual([{ field: "ide.status", reason: "ui" }]);
  });

  it("names each leaf once however often the schema repeats it", () => {
    const twice: SchemaNode = {
      properties: { a: { "x-field": "claim.pretty" }, b: { "x-field": "claim.pretty" } },
    };
    expect(manifestLeaves(twice)).toEqual(["claim.pretty"]);
  });
});
