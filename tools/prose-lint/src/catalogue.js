// The label catalogue and the field table: the two files that decide what a
// string is allowed to be (SPEC.md §8, §13 Rule 1).

import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { scanBanned, scanFirewall } from "./scan.js";

/** The vocabulary rule, applied to catalogue entries and to value text. */
export const PROSE_WORDS = /\b(this|here|we|our|you|your|welcome|platform|page|shows|allows|lets|helps)\b/i;

/** The declared shapes. `lean-statement` and `citation` are the two exempt from
 * the four-word and vocabulary rules; every other shape stays constrained. */
export const SHAPES = new Set([
  "accession",
  "decl",
  "label",
  "login",
  "integer",
  "timestamp",
  "sha256-prefix",
  "enum",
  "em-dash",
  "lean-statement",
  "citation",
]);

export const EXEMPT_SHAPES = new Set(["lean-statement", "citation"]);

export function loadCatalogue(path) {
  const raw = readFileSync(path, "utf8");
  const json = JSON.parse(raw);
  const labels = Object.entries(json.labels);
  return {
    path,
    raw,
    sha256: createHash("sha256").update(raw).digest("hex"),
    labels,
    labelText: new Set(labels.map(([, t]) => t)),
    values: new Set(json.values ?? []),
  };
}

export function loadFields(path) {
  const raw = readFileSync(path, "utf8");
  const json = JSON.parse(raw);
  return {
    path,
    raw,
    list: json,
    byField: new Map(json.map((f) => [f.field, f])),
  };
}

/** Where a JSON key or string sits in the file, so a finding carries an offset. */
function offsetOf(raw, needle) {
  const at = raw.indexOf(needle);
  return at === -1 ? 0 : at;
}

/**
 * The catalogue rules: no entry longer than four words, none ending in `.`,
 * `!` or `?`, none matching the vocabulary regex, and both scans.
 */
export function checkCatalogue(cat, terms) {
  const out = [];
  const entries = [
    ...cat.labels.map(([key, text]) => [`labels.${key}`, text, `"${key}"`]),
    ...[...cat.values].map((text, i) => [`values[${i}]`, text, JSON.stringify(text)]),
  ];
  for (const [selector, text, needle] of entries) {
    const offset = offsetOf(cat.raw, needle);
    const push = (kind, value) => out.push({ file: cat.path, selector, kind, value, offset });
    if (text.trim().split(/\s+/).length > 4) push("bad_label", text);
    if (/[.!?]$/.test(text)) push("bad_label", text);
    if (PROSE_WORDS.test(text)) push("bad_label", text);
    for (const hit of scanBanned(text)) push("banned_token", hit.value);
    for (const hit of scanFirewall(text, terms)) push("firewall", hit.value);
  }
  return out;
}

/** Every field must declare a shape the linter knows how to check. */
export function checkFields(fields) {
  const out = [];
  for (const f of fields.list) {
    if (typeof f.field !== "string" || f.field === "") {
      out.push({
        file: fields.path,
        selector: "fields[]",
        kind: "missing_data_field",
        value: JSON.stringify(f),
        offset: 0,
      });
      continue;
    }
    if (!SHAPES.has(f.shape)) {
      out.push({
        file: fields.path,
        selector: `fields.${f.field}`,
        kind: "unknown_field",
        value: String(f.shape),
        offset: offsetOf(fields.raw, `"${f.field}"`),
      });
    }
  }
  return out;
}

/** The shape checks. `null` means the text is acceptable. */
export function shapeViolation(shape, text) {
  switch (shape) {
    case "accession":
      return /^MTH\.[CR]-\d{4}-\d{4,6}$/.test(text) ? null : "accession";
    case "decl":
      return /^[^\s]+$/.test(text) ? null : "decl";
    case "login":
      return /^[^\s]+$/.test(text) ? null : "login";
    case "integer":
      return /^\d+$/.test(text) ? null : "integer";
    case "timestamp":
      return /^\d{4}-\d{2}-\d{2}T[\d:.]+(Z|[+-]\d{2}:\d{2})$/.test(text) ? null : "timestamp";
    case "sha256-prefix":
      return /^[0-9a-f]{12,64}$/.test(text) ? null : "sha256-prefix";
    case "em-dash":
      return text === "—" ? null : "em-dash";
    case "enum":
      // A single token: a state word, a profile kind, a declaration kind or a
      // reason code. The catalogue's value list covers the enums a page also
      // renders as bare text; a node kind and a reason code are values only.
      return /^\S*$/.test(text) ? null : "enum";
    default:
      // `label` is decided by the four-word and vocabulary rules;
      // `lean-statement` and `citation` are exempt from both by name.
      return null;
  }
}
