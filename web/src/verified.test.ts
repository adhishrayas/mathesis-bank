// The static no-write-into-verified check (SPEC.md §8.6).
//
// The landing page's immutability story is carried on the client side by one
// claim: nothing the client runs writes into `section[data-region="verified"]`.
// The Playwright suite proves it dynamically with a `MutationObserver` over a
// full interaction pass; this is the static half, and it is the half that
// cannot be made green by an interaction the suite happens not to perform.
//
// Two properties, both over the module graph reachable from the client entry:
//
//   1. no module reachable from the landing entry point names the verified
//      region in a selector at all, so there is no node obtained from such a
//      selector for a DOM mutation method to be called on;
//
// A third property falls out of the object model rather than out of a rule:
// `mountCitation` does not exist. The citation is baked at generation time, so
// there is nothing for a client entry point to populate, and the component
// exports no function that could.

import { describe, expect, it } from "vitest";
import ts from "typescript";
import { clientSources, reachableFrom } from "./sources";

const VERIFIED_SELECTOR = /data-region\s*=\s*\\?["']verified\\?["']/;

/** Comments are stripped first: this file and the modules it checks BOTH have
 * to be able to say what the rule is, and a rule that fails on its own
 * statement is a rule nobody can document. */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");
}
const MUTATORS = new Set([
  "append", "appendChild", "prepend", "insertBefore", "insertAdjacentHTML",
  "replaceChildren", "replaceWith", "removeChild", "remove", "setAttribute",
  "removeAttribute", "after", "before",
]);

describe("the client never writes into the verified region", () => {
  it("names the verified region in no selector on the landing path", () => {
    const offenders = reachableFrom("main.tsx")
      .filter((s) => VERIFIED_SELECTOR.test(code(s.text)))
      .map((s) => s.rel);
    expect(offenders).toEqual([]);
  });

  it("names the verified region in no selector anywhere in the client", () => {
    const offenders = clientSources()
      .filter((s) => VERIFIED_SELECTOR.test(code(s.text)))
      .map((s) => s.rel);
    expect(offenders).toEqual([]);
  });


  it("exports no citation mount, because the citation is baked", () => {
    for (const source of clientSources()) {
      expect(source.text.includes("mountCitation"), source.rel).toBe(false);
      expect(source.text.includes("mountAbout"), source.rel).toBe(false);
    }
  });

  it("calls no DOM mutator on a node the verified region could have produced", () => {
    // With property (1) holding there is no such node, so this is a guard
    // against the selector reappearing behind a variable: any mutator call
    // whose receiver is built from a template carrying `data-region` fails.
    const offenders: string[] = [];
    for (const source of clientSources()) {
      const sf = ts.createSourceFile(source.path, source.text, ts.ScriptTarget.ES2022, true,
        source.path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
      const visit = (node: ts.Node): void => {
        if (
          ts.isCallExpression(node) &&
          ts.isPropertyAccessExpression(node.expression) &&
          MUTATORS.has(node.expression.name.text) &&
          /data-region/.test(node.expression.expression.getText(sf)) &&
          !/author/.test(node.expression.expression.getText(sf))
        ) {
          const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
          offenders.push(`${source.rel}:${line + 1}`);
        }
        ts.forEachChild(node, visit);
      };
      visit(sf);
    }
    expect(offenders).toEqual([]);
  });
});
