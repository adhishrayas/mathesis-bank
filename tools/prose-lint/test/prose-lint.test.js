// The self-tests SPEC §13 names, plus one per violation kind and one per hole
// the earlier design left open.

import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { fixtures, lint, of, kinds, SMALL } from "./helpers.js";

const dirty = (name, extra = []) => lint([join(fixtures, "dirty", name), ...extra]);

test("the real catalogue, field table, allowlist and About body pass their own rules", () => {
  const r = lint([]);
  assert.deepEqual(r.violations, []);
  assert.ok(r.labels > 0 && r.fields > 0);
});

test("a generated tree that obeys Rule 1 is clean", () => {
  const r = lint([join(fixtures, "tree-clean")]);
  assert.deepEqual(r.violations, []);
  assert.equal(r.checked_files, 4);
});

test("`This page shows…` is not a string a page may render", () => {
  const r = dirty("this-page-shows");
  assert.deepEqual(kinds(r), ["unknown_string"]);
  assert.match(of(r, "unknown_string")[0].value, /^This page shows/);
  assert.ok(of(r, "unknown_string")[0].offset > 0);
});

test("a concept-explaining tooltip is an attribute violation", () => {
  const r = dirty("tooltip");
  assert.deepEqual(kinds(r), ["attribute"]);
  assert.match(r.violations[0].value, /^title=/);
});

test("lorem is a banned token", () => {
  const r = dirty("lorem");
  assert.ok(kinds(r).includes("banned_token"));
});

test("an uncatalogued control label fails", () => {
  const r = dirty("uncatalogued-control");
  assert.deepEqual(kinds(r), ["unknown_string"]);
  assert.equal(r.violations[0].value, "Publish");
});

test("an internal-corpus handle fails the firewall", () => {
  const r = dirty("firewall-handle");
  assert.ok(of(r, "firewall").some((v) => v.value === "WMSpec"));
});

test("an absolute path off this machine fails the firewall", () => {
  const r = dirty("absolute-path");
  assert.deepEqual(
    of(r, "firewall").map((v) => v.value),
    ["/Users/"],
  );
});

test("a data value without a data-field fails", () => {
  const r = dirty("value-no-field");
  assert.deepEqual(kinds(r), ["missing_data_field"]);
});

test("a data-field naming no real field fails", () => {
  const r = dirty("unknown-field");
  assert.deepEqual(kinds(r), ["unknown_field"]);
  assert.equal(r.violations[0].value, "claim.vibes");
});

test("a value that disagrees with the page's values.json fails, byte for byte", () => {
  const r = dirty("value-mismatch");
  assert.deepEqual(kinds(r), ["value_mismatch"]);
  assert.match(r.violations[0].value, /MTH\.C-2026-5001.*MTH\.C-2026-5002/);
});

test("a page whose value count differs from its values.json fails", () => {
  const r = dirty("values-count");
  assert.deepEqual(kinds(r), ["value_mismatch"]);
  assert.match(r.violations[0].value, /2 value elements, 1 entries/);
});

test("a generated page that renders a value with no sibling values.json fails", () => {
  const r = dirty("missing-values-json");
  assert.ok(of(r, "value_mismatch").some((v) => /and no sibling values\.json/.test(v.value)));
});

test("any placeholder attribute at all fails", () => {
  const r = dirty("placeholder");
  assert.deepEqual(kinds(r), ["placeholder_present"]);
});

test("a `pre` with no declared role is itself the violation", () => {
  const r = dirty("pre-no-role");
  assert.ok(kinds(r).includes("unknown_role"));
  assert.equal(of(r, "unknown_role")[0].value, '<pre data-role="">');
});

test("an ordinary `code` element is linted like any other", () => {
  const r = dirty("code-prose");
  assert.deepEqual(kinds(r), ["unknown_string"]);
  assert.equal(r.violations[0].selector, "html > body > main > code");
});

test("a value wrapping a catalogue entry is laundering", () => {
  const r = dirty("laundered");
  assert.ok(kinds(r).every((k) => k === "value_laundering"));
  assert.ok(of(r, "value_laundering").length >= 1);
});

test("a value whose text is prose fails by the four-word rule", () => {
  const r = dirty("value-prose");
  assert.deepEqual(kinds(r), ["value_is_prose"]);
});

test("the About page is a shell of exactly three children", () => {
  const r = dirty("about-shell");
  assert.deepEqual(kinds(r), ["about_shell"]);
  assert.match(r.violations[0].value, /4 element children/);
});

test("href, class, id and data-* are out of the attribute rule's scope by name", () => {
  const r = dirty("structural-attributes");
  assert.deepEqual(r.violations, []);
});

test("lean-statement and citation are the two shapes exempt from the prose rules", () => {
  const r = dirty("exempt-shapes");
  assert.deepEqual(r.violations, []);
});

test("the exemption is the role and the shape together, not either alone", () => {
  // The shape exempts the text from the four-word and vocabulary rules; the
  // role exempts it from the catalogue rule. A value carrying the shape and not
  // the role, or the role and no declared value, is unchecked text.
  const a = dirty("lean-statement-no-role");
  assert.deepEqual(kinds(a), ["unknown_role"]);
  assert.match(a.violations[0].value, /^claim\.pretty is a lean-statement value/);

  const b = dirty("lean-role-not-a-value");
  assert.deepEqual(kinds(b), ["unknown_role"]);
  assert.match(b.violations[0].value, /is not a lean-statement value$/);
});

test("a value may be carried only in one of the three declared attributes", () => {
  const r = dirty("attr-value-not-a-carrier");
  assert.deepEqual(kinds(r), ["attribute"]);
  assert.match(r.violations[0].value, /^data-attr-value="data-title" is not one of alt, /);
});

test("a snapshot value that violates its field's declared shape fails", () => {
  const r = lint(["--dom", join(fixtures, "dom-shape"), ...SMALL, "--fresh"]);
  const bad = of(r, "value_mismatch").map((v) => v.value);
  assert.equal(bad.length, 2);
  assert.ok(bad.some((v) => v.startsWith("claim.accession")));
  assert.ok(bad.some((v) => v.startsWith("note.updated_at")));
});

test("a catalogue entry rendered only inside a carved-out region still counts as rendered", () => {
  const r = lint(["--dom", join(fixtures, "dom-coverage"), ...SMALL, "--fresh"]);
  assert.deepEqual(r.violations, []);
  for (const label of ["Note", "Updated", "Edit", "Save", "Cancel"]) {
    assert.ok(r.rendered.includes(label), `${label} is not counted as rendered`);
  }
});

test("a catalogue entry no captured surface renders is a dead label", () => {
  const r = lint(["--dom", join(fixtures, "dom-coverage-missing"), ...SMALL, "--fresh"]);
  assert.deepEqual(
    of(r, "dead_label").map((v) => v.value),
    ["Cancel"],
  );
});

test("coverage carries across the release gate's two invocations", () => {
  const report = join(mkdtempSync(join(tmpdir(), "prose-lint-carry-")), ".prose-lint.json");
  const tree = lint([join(fixtures, "tree-clean")], { report });
  assert.deepEqual(tree.violations, []);
  const dom = lint(["--dom", join(fixtures, "dom-coverage")], { report });
  // The union covers what neither input covers alone.
  assert.ok(dom.rendered.includes("Frozen export"), "a tree-only entry is not carried");
  assert.ok(dom.rendered.includes("Reload"), "a snapshot-only entry is missing");
  assert.ok(of(dom, "dead_label").length < tree.labels);
});

test("the report has the shape the release gate reads", () => {
  const r = lint([join(fixtures, "tree-clean")]);
  assert.deepEqual(Object.keys(r).sort(), [
    "checked_files",
    "fields",
    "labels",
    "labels_sha256",
    "rendered",
    "roots",
    "violations",
  ]);
  assert.equal(typeof r.checked_files, "number");
});

test("a name is one to four words of letters in any script", async () => {
  const { shapeViolation } = await import("../src/catalogue.js");
  for (const ok of ["Dhruv Gupta", "Yaël Dillies", "Alex Meiburg", "J. R. R. Tolkien", "O’Brien", "Jean-Luc"]) {
    assert.equal(shapeViolation("name", ok), null, ok);
  }
  for (const bad of ["", " Dhruv", "this page shows the record", "<b>Dhruv</b>", "Dhruv  Gupta", "zetetic_dhruv"]) {
    assert.equal(shapeViolation("name", bad), "name", bad);
  }
});
