// The advisory lint.
//
// It marks what the dictionary-closure rule (SPEC.md §3.5) will reject, so the
// author sees it before a cluster run, and it NEVER disables `Submit`: a marked
// declaration the claim does not reach is not an error and is not published
// either — it never enters the export, the DAG or the axiom manifest (R24),
// which is exactly why the client cannot be trusted to gate on it.
//
// Every message it produces is a reason message from `shared/reasons.v1.json`,
// rendered by `renderReason`. The lint invents no string of its own, so the
// advisory text and the gate's eventual verdict are the same sentence.

import { renderReason } from "./reasons.generated";

export interface Advisory {
  /** 1-based, as Monaco counts lines. */
  line: number;
  startColumn: number;
  endColumn: number;
  code: string;
  message: string;
  /** The private-helper convention, named on the rule that is about it. */
  source: string;
}

export const PRIVATE_HELPER_NAMESPACE = "Submission._priv";
export const SUBMISSION_NAMESPACE = "Submission";

/**
 * The text the editor inserts for a designated claim.
 *
 * `theorem _root_.<decl_name>` is the ONE form that produces the exact name
 * `checkStatement` compares (SPEC.md §6.1, §8.7, R35): the buffer is wrapped in
 * `namespace Submission … end Submission`, so an ordinary `theorem foo` inside
 * it becomes `Submission.foo`, which pairs with nothing in the reference
 * export. It lives here rather than beside the editor so the one form can be
 * asserted without starting Monaco.
 */
export function rootTheoremText(declName: string, statement: string): string {
  const bare = declName.replace(/^_root_\./, "");
  const body = statement.trim() === "" ? "" : ` :\n    ${statement.split("\n").join("\n    ")}`;
  return `theorem _root_.${bare}${body} := by\n  sorry\n\n`;
}

/** Whether a buffer already declares the designated claim in that one form. */
export function declaresRootTheorem(text: string, declName: string): boolean {
  const bare = declName.replace(/^_root_\./, "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`_root_\\.${bare}\\b`).test(text);
}

const MODIFIERS = /^(?:@\[[^\]]*\]\s*|private\s+|protected\s+|noncomputable\s+|unsafe\s+|partial\s+|scoped\s+|local\s+)*/;
const HEAD =
  /^(axiom|inductive|structure|class|instance|opaque|abbrev|def|theorem|lemma|example)\b\s*(?:_root_\.)?([^\s:({[⦃⟨|]*)/;

interface Head {
  keyword: string;
  name: string;
  isPrivate: boolean;
  isPartial: boolean;
  column: number;
}

function head(line: string): Head | null {
  const indent = line.length - line.trimStart().length;
  const rest = line.slice(indent);
  const mods = MODIFIERS.exec(rest);
  const prefix = mods ? mods[0] : "";
  const m = HEAD.exec(rest.slice(prefix.length));
  if (!m) return null;
  return {
    keyword: m[1] as string,
    name: (m[2] as string) || "",
    isPrivate: /\bprivate\b/.test(prefix),
    isPartial: /\bpartial\b/.test(prefix),
    column: indent + prefix.length + 1,
  };
}

/** Whether a declaration written inside the wrapper is a tolerated private
 * helper: Lean's own `private`, or the documented `namespace _priv` convention
 * (SPEC.md §3.5, R36). Both forms are accepted by the gate; neither is a
 * dictionary entry and neither is citable by another post. */
export function isPrivateHelper(name: string, isPrivate: boolean, namespaces: string[]): boolean {
  if (isPrivate) return true;
  if (name.startsWith("_priv.")) return true;
  return namespaces.includes("_priv");
}

/**
 * Advisory findings over the buffer alone.
 *
 * `claimDecl` is the designated declaration; when it is set and the buffer does
 * not declare it, that is the one finding the `Proves` lock exists to surface
 * (SPEC.md §8.7 region 2, R12).
 */
export function lintBuffer(text: string, claimDecl?: string | null): Advisory[] {
  const out: Advisory[] = [];
  const lines = text.split("\n");
  const namespaces: string[] = [];
  const declared = new Set<string>();

  lines.forEach((raw, i) => {
    const line = raw.replace(/--.*$/, "");
    const ns = /^\s*namespace\s+([^\s]+)/.exec(line);
    if (ns) {
      namespaces.push(ns[1] as string);
      return;
    }
    if (/^\s*end\b/.test(line)) {
      namespaces.pop();
      return;
    }
    const h = head(line);
    if (!h) return;
    // An `instance` may be anonymous and STILL creates a constant, which the
    // closure rule rejects like any other new definition; only `example`
    // creates none. Skipping every nameless head let `instance : C := ⟨⟩`
    // through unmarked, so the author met the rule at the gate instead of in
    // the editor.
    if (h.name === "" && h.keyword !== "instance") return;

    const qualified = h.name === "" ? null : qualify(h.name, namespaces, raw);
    if (qualified) declared.add(qualified);
    // An anonymous instance's real name is Lean's to choose at elaboration, so
    // the advisory renders the single permitted null rendering rather than a
    // name the author never wrote. The marker's own position identifies it.
    const params: Record<string, string> = qualified === null ? {} : { constant: qualified };

    const at = { line: i + 1, startColumn: h.column, endColumn: h.column + h.keyword.length };
    const helper = isPrivateHelper(h.name, h.isPrivate, namespaces);

    switch (h.keyword) {
      case "axiom":
        out.push({ ...at, code: "advisory", source: SUBMISSION_NAMESPACE,
          message: renderReason("NEW_AXIOM", params) });
        break;
      case "inductive":
      case "structure":
      case "class":
        out.push({ ...at, code: "advisory", source: SUBMISSION_NAMESPACE,
          message: renderReason("NEW_INDUCTIVE", params) });
        break;
      case "opaque":
        out.push({ ...at, code: "advisory", source: SUBMISSION_NAMESPACE,
          message: renderReason("NEW_OPAQUE", params) });
        break;
      case "instance":
        out.push({ ...at, code: "advisory", source: SUBMISSION_NAMESPACE,
          message: renderReason("NEW_DEFINITION", params) });
        break;
      case "def":
      case "abbrev":
        if (h.isPartial) {
          out.push({ ...at, code: "advisory", source: SUBMISSION_NAMESPACE,
            message: renderReason("NEW_OPAQUE", params) });
        } else if (!helper) {
          // The one rule that is about the convention, so the convention is what
          // the marker names.
          out.push({ ...at, code: "advisory", source: PRIVATE_HELPER_NAMESPACE,
            message: renderReason("NEW_DEFINITION", params) });
        }
        break;
      default:
        break;
    }
  });

  if (claimDecl) {
    const wanted = claimDecl.replace(/^_root_\./, "");
    if (!declared.has(wanted) && !declared.has(`${SUBMISSION_NAMESPACE}.${wanted}`)) {
      out.push({
        line: 1,
        startColumn: 1,
        endColumn: 1,
        code: "advisory",
        source: SUBMISSION_NAMESPACE,
        message: renderReason("CLAIM_NOT_DECLARED", { decl: claimDecl }),
      });
    }
  }
  return out;
}

/** The name the constant will carry. The server wraps the buffer in `namespace
 * Submission … end Submission` (R35), and the editor template carries those
 * lines, so a declaration written at the top level of the buffer is
 * `Submission.<name>` unless it is written `_root_.<name>`. */
export function qualify(name: string, namespaces: string[], rawLine: string): string {
  if (/_root_\./.test(rawLine)) return name;
  const parts = namespaces.filter((n) => n !== "");
  return [...parts, name].join(".");
}

/** The FLT module a definition URI points into, or null when it points
 * elsewhere. `file:///dict/src/FLT_Proofs/Foundations/EMX.lean` →
 * `FLT_Proofs.Foundations.EMX`. */
export function fltModuleOf(uri: string): string | null {
  const m = /\/(FLT_Proofs\/[^?#]*)\.lean$/.exec(uri);
  if (!m) return null;
  return (m[1] as string).split("/").join(".");
}

/**
 * The uncurated-FLT rule, over identifiers the language server has already
 * resolved. `curatedModules` is the module list of the active pin; when the pin
 * does not carry it the rule yields nothing, because the alternative — marking
 * every FLT identifier including the curated ones — would be noise rather than
 * a lint, and the client is not served the constant table (SPEC.md §10).
 */
export function lintResolved(
  resolved: { name: string; uri: string; line: number; startColumn: number; endColumn: number }[],
  curatedModules: string[] | undefined,
): Advisory[] {
  if (!curatedModules || curatedModules.length === 0) return [];
  const curated = new Set(curatedModules);
  const out: Advisory[] = [];
  for (const r of resolved) {
    const module = fltModuleOf(r.uri);
    if (module === null || curated.has(module)) continue;
    out.push({
      line: r.line,
      startColumn: r.startColumn,
      endColumn: r.endColumn,
      code: "advisory",
      source: SUBMISSION_NAMESPACE,
      message: renderReason("CONSTANT_NOT_IN_DICTIONARY", { constant: r.name, module }),
    });
  }
  return out;
}
