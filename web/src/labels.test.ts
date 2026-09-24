import { readFileSync } from "node:fs";
import { resolve } from "node:path";
// The labels AST check (SPEC.md §8.7), with defined semantics.
//
// No string literal in `web/src/**` may flow into JSX text, into one of the five
// reader-facing attributes, or into a `textContent`/`innerText` assignment,
// unless it is an identifier reached through `LABELS`/`VALUES`, a value from an
// API response, or a `renderReason` result.
//
// It is a real parse rather than a line scan: a line scan cannot tell
// `aria-label: LABELS.clear` (lawful — the one icon-only control the design
// admits) from `aria-label: "Clear"` (a visible string with no catalogue diff),
// and a rule that rejects both makes the shipped surface unbuildable.

import { describe, expect, it } from "vitest";
import ts from "typescript";
import { LABELS, VALUES, VALUE_LIST } from "./labels";
import { clientSources } from "./sources";

/** The five attributes a viewer can read. `placeholder` is banned outright:
 * every input is labelled, so no field needs one. */
const READER_ATTRS = new Set(["placeholder", "title", "aria-label", "aria-description", "alt"]);

/**
 * Expressions that are a lawful source of a visible string.
 *
 * The rule is about LITERALS. An identifier, a property access, a call and an
 * interpolated template all carry a value from somewhere else — a catalogue
 * entry, an API response, a `renderReason` result — and none of them can put a
 * new sentence on a page without a diff somewhere that does show up. A string
 * literal can, and is the whole of what this check refuses; the empty string,
 * which clears a transient value, is the one literal allowed.
 */
function isLawfulSource(node: ts.Node): boolean {
  if (ts.isStringLiteralLike(node)) return node.text === "";
  if (ts.isConditionalExpression(node)) {
    return isLawfulSource(node.whenTrue) && isLawfulSource(node.whenFalse);
  }
  if (
    ts.isBinaryExpression(node) &&
    (node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken ||
      node.operatorToken.kind === ts.SyntaxKind.BarBarToken)
  ) {
    return isLawfulSource(node.left) && isLawfulSource(node.right);
  }
  if (ts.isParenthesizedExpression(node)) return isLawfulSource(node.expression);
  if (ts.isAsExpression(node)) return isLawfulSource(node.expression);
  return true;
}

interface Offence {
  where: string;
  what: string;
}

function scan(): Offence[] {
  const offences: Offence[] = [];
  for (const source of clientSources()) {
    const sf = ts.createSourceFile(source.path, source.text, ts.ScriptTarget.ES2022, true,
      source.path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    const at = (node: ts.Node): string => {
      const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
      return `${source.rel}:${line + 1}`;
    };

    const visit = (node: ts.Node): void => {
      // 1. JSX text
      if (ts.isJsxText(node) && node.text.trim() !== "") {
        offences.push({ where: at(node), what: `jsx text ${JSON.stringify(node.text.trim())}` });
      }
      // 2. textContent / innerText assignment
      if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        ts.isPropertyAccessExpression(node.left) &&
        (node.left.name.text === "textContent" || node.left.name.text === "innerText") &&
        !isLawfulSource(node.right)
      ) {
        offences.push({ where: at(node), what: `${node.left.name.text} = ${node.right.getText(sf)}` });
      }
      // 3. reader-facing attributes, in an object literal, a JSX attribute or a
      //    `setAttribute` call
      if (ts.isPropertyAssignment(node)) {
        const key = propertyName(node.name);
        if (key !== null && READER_ATTRS.has(key)) {
          if (key === "placeholder") offences.push({ where: at(node), what: "placeholder attribute" });
          else if (!isLawfulSource(node.initializer)) {
            offences.push({ where: at(node), what: `${key} = ${node.initializer.getText(sf)}` });
          }
        }
      }
      if (ts.isJsxAttribute(node)) {
        const key = node.name.getText(sf);
        if (READER_ATTRS.has(key)) {
          if (key === "placeholder") offences.push({ where: at(node), what: "placeholder attribute" });
          else if (node.initializer && ts.isStringLiteral(node.initializer)) {
            offences.push({ where: at(node), what: `${key} = ${node.initializer.text}` });
          }
        }
      }
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === "setAttribute" &&
        node.arguments.length === 2 &&
        ts.isStringLiteralLike(node.arguments[0] as ts.Node)
      ) {
        const key = (node.arguments[0] as ts.StringLiteralLike).text;
        if (READER_ATTRS.has(key)) {
          if (key === "placeholder") offences.push({ where: at(node), what: "placeholder attribute" });
          else if (!isLawfulSource(node.arguments[1] as ts.Node)) {
            offences.push({ where: at(node), what: `${key} = ${(node.arguments[1] as ts.Node).getText(sf)}` });
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return offences;
}

function propertyName(name: ts.PropertyName): string | null {
  if (ts.isIdentifier(name)) return name.text;
  if (ts.isStringLiteral(name)) return name.text;
  return null;
}

describe("the label catalogue is the only source of a visible string", () => {
  it("lets no string literal reach JSX text, an assignment or a reader attribute", () => {
    expect(scan().map((o) => `${o.where}: ${o.what}`)).toEqual([]);
  });

  it("names no label twice, so one token never denotes two columns", () => {
    const seen = new Map<string, string>();
    for (const [key, text] of Object.entries(LABELS)) {
      const prior = seen.get(text);
      expect(prior, `${key} and ${prior} both render ${text}`).toBeUndefined();
      seen.set(text, key);
    }
  });
});

describe("the catalogue's shape", () => {
  it("keeps every entry to four words and none a sentence", () => {
    for (const [key, text] of Object.entries(LABELS)) {
      expect(text.split(/\s+/).length, `${key}: ${text}`).toBeLessThanOrEqual(4);
      for (const end of [".", "!", "?"]) expect(text.endsWith(end), `${key}: ${text}`).toBe(false);
    }
  });

  it("carries no explanatory vocabulary", () => {
    const banned = /\b(this|here|we|our|you|your|welcome|platform|page|shows|allows|lets|helps)\b/i;
    for (const [key, text] of Object.entries(LABELS)) {
      expect(banned.test(text), `${key}: ${text}`).toBe(false);
    }
  });

  it("does not carry the bare token Kind, which denoted three columns", () => {
    expect(Object.values(LABELS)).not.toContain("Kind");
    for (const k of ["Profile kind", "Declaration kind", "Accession kind"]) {
      expect(Object.values(LABELS)).toContain(k);
    }
  });

  it("does not carry the deleted entries", () => {
    for (const gone of ["List only", "Retry", "Module", "Revisions", "Toolchain"]) {
      expect(Object.values(LABELS)).not.toContain(gone);
    }
  });

  it("classifies the three surface states as values rather than labels", () => {
    for (const v of ["Elaborating", "Ready", "Copied"]) {
      expect(VALUE_LIST).toContain(v);
      expect(Object.values(LABELS)).not.toContain(v);
    }
    expect(VALUES.emDash).toBe("—");
  });

  it("declares the nine verification states as values", () => {
    for (const s of [
      "received", "queued", "building", "exporting", "adjudicating",
      "assembling", "admitted", "rejected", "failed",
    ]) {
      expect(VALUE_LIST).toContain(s);
    }
  });

  it("places every entry the surfaces render", () => {
    // A catalogue entry no module can render is a dead string; `prose-lint`
    // fails on one over the captured surfaces, and this is the half of that
    // check the client can make on its own.
    const client = clientSources().map((s) => s.text).join("\n");
    // The generator is the renderer of record: a label key quoted anywhere in
    // its pages module is placed, the same test the client sources get below.
    const pagesRs = readFileSync(
      resolve(process.cwd(), "../services/registry/crates/record/src/pages.rs"),
      "utf8",
    );
    const generated = new Set<string>([...pagesRs.matchAll(/"([A-Za-z]+)"/g)].map((m) => m[1]!));
    const unplaced = (Object.keys(LABELS) as (keyof typeof LABELS)[]).filter((key) => {
      if (generated.has(key)) return false;
      return !new RegExp(`\\bLABELS\\.${key}\\b|"${key}"`).test(client);
    });
    expect(unplaced).toEqual([]);
  });
});
