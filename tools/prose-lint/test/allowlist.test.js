// `html_allowlist_agreement` (SPEC §13, cross-language): the Go sanitizer and
// this linter read one table under two profiles, and `about` differs from
// `note` in exactly `h2`.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadAllowlist, checkAgreement, effectiveSets } from "../src/allowlist.js";
import { run } from "../src/cli.js";
import { repo, here } from "./helpers.js";

const shared = join(repo, "shared/html-allowlist.v1.json");

test("the shipped allowlist agrees with itself: about is note plus h2", () => {
  const al = loadAllowlist(shared);
  assert.deepEqual(checkAgreement(al), []);
  const sets = effectiveSets(al);
  assert.deepEqual(
    sets.about.elements.filter((e) => !sets.note.elements.includes(e)),
    ["h2"],
  );
  assert.deepEqual(sets.note.attributes, { a: ["href"] });
  assert.deepEqual(sets.note.url_schemes, ["http", "https", "mailto"]);
});

test("a profile that differs by more than h2 fails the agreement", () => {
  const dir = mkdtempSync(join(tmpdir(), "prose-lint-al-"));
  const json = JSON.parse(readFileSync(shared, "utf8"));
  json.profiles.about.adds = ["h2", "h1"];
  const path = join(dir, "html-allowlist.v1.json");
  writeFileSync(path, JSON.stringify(json));
  const findings = checkAgreement(loadAllowlist(path));
  assert.equal(findings.length, 1);
  assert.equal(findings[0].kind, "about_shell");
  assert.match(findings[0].value, /h1/);
});

test("--print-allowlist emits the effective sets both consumers compare", () => {
  const out = execFileSync(process.execPath, [join(here, "..", "src", "cli.js"), "--print-allowlist"], {
    encoding: "utf8",
  });
  const sets = JSON.parse(out);
  assert.deepEqual(Object.keys(sets).sort(), ["about", "note"]);
  assert.ok(sets.about.elements.includes("h2"));
  assert.ok(!sets.note.elements.includes("h2"));
});

test("an authored region is checked against its profile", () => {
  const dir = mkdtempSync(join(tmpdir(), "prose-lint-about-"));
  const body = join(dir, "body.html");
  writeFileSync(body, '<p>A sentence the owner wrote.</p><script>alert(1)</script><h2>Section</h2>\n');
  const report = run({
    ...base(dir),
    about: body,
  });
  const kinds = report.violations.map((v) => v.kind);
  assert.ok(kinds.includes("unknown_role"), "the script element is not refused");
  assert.ok(
    !report.violations.some((v) => v.value.includes("<h2>")),
    "h2 is in the about profile and must be accepted",
  );
});

function base(dir) {
  return {
    trees: [],
    doms: [],
    fresh: true,
    labels: join(repo, "services/registry/crates/record/labels.json"),
    fields: join(repo, "services/registry/crates/record/fields.json"),
    allowlist: shared,
    terms: join(repo, ".firewall-terms"),
    reasons: join(repo, "shared/reasons.v1.json"),
    report: join(dir, ".prose-lint.json"),
  };
}
