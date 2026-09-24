// The rules `reason-lint` applies to `shared/reasons.v1.json` (SPEC.md §6.3).
//
// A reason message is the one visible string outside the label catalogue, so it
// carries its own lint: short, unexplanatory, naming the object of its own
// stage, and emitted by exactly one component.

import { scanBanned, scanFirewall } from "./scan.js";

export const MAX_TEMPLATE = 120;

/** §6.3's vocabulary rule for reason messages. */
export const REASON_WORDS = /\b(this|here|we|our|you|your|welcome|platform)\b/i;

/**
 * The object each stage is about. A template names its stage's object or a
 * `{param}`; a message that names neither is describing something other than
 * what failed.
 */
export const STAGE_OBJECTS = {
  precheck: [
    "source", "prelude", "import", "namespace", "declaration", "name", "claim", "accession",
    "pin", "profile", "submission", "session", "buffer", "editor", "line", "byte", "theorem",
    "verification", "dictionary", "module", "kind",
  ],
  build: ["elaboration", "compiler", "build", "memory"],
  export: ["export", "exporter"],
  replay: ["replay", "kernel", "export"],
  axioms: ["axiom", "closure", "constant", "type", "whitelist"],
  statement: ["statement", "reference", "target", "identity", "export"],
  triviality: ["claim", "statement"],
  closure: [
    "constant", "declaration", "dictionary", "export", "claim", "namespace", "module",
    "graph", "argument", "statement", "helper", "theorem",
  ],
  assemble: ["statement", "renderer", "claim", "constant", "dictionary", "accession"],
  degraded: ["registry"],
  infra: [
    "job", "node", "namespace", "image", "volume", "claim", "blob", "collector", "renderer",
    "base", "export", "reference", "exit", "quota", "verdict",
  ],
};

/**
 * §6.3's ownership table: the component that emits each stage's codes.
 * `degraded` is the read path and has no emitting component at all.
 */
export const STAGE_PRODUCERS = {
  precheck: ["gateway"],
  build: ["runner"],
  export: ["runner", "adjudicate"],
  replay: ["adjudicate"],
  axioms: ["adjudicate"],
  statement: ["adjudicate"],
  triviality: ["adjudicate"],
  closure: ["adjudicate"],
  assemble: ["adjudicate", "serve"],
  degraded: [],
  infra: ["runner", "adjudicate"],
};

export const TERMINAL_STATES = new Set(["rejected", "failed", null]);

/**
 * @returns {Array<{file,selector,kind,value,offset}>} in the same shape
 *   `prose-lint` reports, so one consumer reads both.
 */
export function lintReasons(path, raw, terms) {
  const json = JSON.parse(raw);
  const out = [];
  const at = (needle) => Math.max(raw.indexOf(needle), 0);
  const fail = (code, kind, value) =>
    out.push({ file: path, selector: code, kind, value, offset: at(`"${code}"`) });

  const stages = new Set(json.stages ?? []);
  const seen = new Set();

  for (const r of json.reasons ?? []) {
    const code = r.code;
    if (typeof code !== "string" || !/^[A-Z][A-Z0-9_]*$/.test(code ?? "")) {
      fail(String(code), "bad_label", "not a reason code");
      continue;
    }
    if (seen.has(code)) fail(code, "bad_label", "duplicate code");
    seen.add(code);

    if (!stages.has(r.stage)) {
      fail(code, "unknown_field", `stage ${r.stage}`);
      continue;
    }
    if (!TERMINAL_STATES.has(r.terminal_state ?? null)) {
      fail(code, "unknown_field", `terminal_state ${r.terminal_state}`);
    }

    const t = r.message_template;
    if (typeof t !== "string" || t.length === 0) {
      fail(code, "missing_data_field", "no message_template");
      continue;
    }
    if (t.length > MAX_TEMPLATE) fail(code, "bad_label", `${t.length} characters`);
    if (/!$/.test(t.trim())) fail(code, "bad_label", "ends in !");
    if (REASON_WORDS.test(t)) fail(code, "unknown_string", t);

    const used = [...t.matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
    const declared = r.params ?? [];
    for (const p of used) if (!declared.includes(p)) fail(code, "unknown_field", `{${p}} is not declared`);
    for (const p of declared) if (!used.includes(p)) fail(code, "missing_data_field", `${p} is never rendered`);

    const objects = STAGE_OBJECTS[r.stage] ?? [];
    const namesObject = objects.some((w) => new RegExp(`\\b${w}`, "i").test(t));
    if (used.length === 0 && !namesObject) {
      fail(code, "unknown_string", `names neither a {param} nor the ${r.stage} object`);
    }

    for (const hit of scanBanned(t)) fail(code, "banned_token", hit.value);
    for (const hit of scanFirewall(t, terms)) fail(code, "firewall", hit.value);

    // `reason_has_producer`: exactly one emitting component outside `degraded`.
    const allowed = STAGE_PRODUCERS[r.stage] ?? [];
    const producer = r.producer ?? null;
    if (r.stage === "degraded") {
      if (producer !== null) fail(code, "unknown_field", `degraded carries producer ${producer}`);
    } else if (producer === null) {
      fail(code, "missing_data_field", "no emitting component");
    } else if (!allowed.includes(producer)) {
      fail(code, "unknown_field", `producer ${producer} does not own stage ${r.stage}`);
    }
  }

  // Every declared stage must carry at least one code, or the taxonomy names a
  // stage nothing can reach.
  for (const stage of stages) {
    if (!(json.reasons ?? []).some((r) => r.stage === stage)) {
      out.push({ file: path, selector: stage, kind: "dead_label", value: `stage ${stage} has no code`, offset: at(`"${stage}"`) });
    }
  }
  return out;
}
