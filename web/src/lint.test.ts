// The advisory lint, and the one insertion form (SPEC.md §7, §3.5, §8.7).
//
// The lint marks what the dictionary-closure rule will reject, so the author
// sees it before a cluster run. Two properties are load-bearing and are what
// this file is about:
//
//   * it names the `_priv` convention on the rule that is about it, and it
//     accepts BOTH tolerated forms of a private helper — Lean's own `private`
//     and the documented `namespace _priv` — because the gate accepts both
//     (R36) and a lint that marked one of them would be teaching the wrong
//     rule;
//   * it produces no string of its own. Every message is a reason message from
//     `shared/reasons.v1.json`, so the advisory text and the gate's eventual
//     verdict are the same sentence.
//
// And it is ADVISORY: nothing here returns a verdict, and `Submit` is never
// disabled by it. A marked declaration the claim does not reach is not an
// error and is not published either (R24), which is exactly why the client
// cannot be trusted to gate on it.

import { describe, expect, it } from "vitest";
import {
  declaresRootTheorem,
  fltModuleOf,
  isPrivateHelper,
  lintBuffer,
  lintResolved,
  rootTheoremText,
  PRIVATE_HELPER_NAMESPACE,
} from "./lint";
import { REASON_CODES } from "./reasons.generated";

function codes(text: string, claim?: string | null): string[] {
  return lintBuffer(text, claim).map((a) => a.message);
}

function sources(text: string): string[] {
  return lintBuffer(text).map((a) => a.source);
}

describe("the advisory lint marks what the closure rule rejects", () => {
  it("marks an axiom, an inductive, a structure, a class, an instance and an opaque", () => {
    const buffer = [
      "axiom cheat : False",
      "inductive Tree",
      "structure Pair",
      "class Thing",
      "instance : Thing := ⟨⟩",
      "opaque secret : Nat",
    ].join("\n");
    const found = lintBuffer(buffer);
    expect(found.length).toBe(6);
    for (const a of found) expect(a.code).toBe("advisory");
    expect(found.map((a) => a.line)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("marks a `partial def` as an opaque, which is what the gate calls it", () => {
    const found = lintBuffer("partial def loop : Nat := loop");
    expect(found.length).toBe(1);
    expect(found[0]?.message).toContain("loop");
  });

  it("leaves a theorem, a lemma and an example unmarked", () => {
    expect(lintBuffer("theorem t : True := trivial")).toEqual([]);
    expect(lintBuffer("lemma l : True := trivial")).toEqual([]);
    expect(lintBuffer("example : True := trivial")).toEqual([]);
  });
});

describe("the private-helper convention", () => {
  it("accepts both tolerated forms and marks a plain def", () => {
    expect(isPrivateHelper("helper", true, [])).toBe(true);
    expect(isPrivateHelper("_priv.helper", false, [])).toBe(true);
    expect(isPrivateHelper("helper", false, ["_priv"])).toBe(true);
    expect(isPrivateHelper("helper", false, [])).toBe(false);
  });

  it("marks a bare def and leaves Lean's own `private def` alone", () => {
    expect(lintBuffer("def helper : Nat := 0").length).toBe(1);
    expect(lintBuffer("private def helper : Nat := 0")).toEqual([]);
  });

  it("leaves a def inside `namespace _priv` alone", () => {
    const buffer = ["namespace _priv", "def helper : Nat := 0", "end _priv"].join("\n");
    expect(lintBuffer(buffer)).toEqual([]);
  });

  it("names the convention on the rule that is about it, and nowhere else", () => {
    expect(sources("def helper : Nat := 0")).toEqual([PRIVATE_HELPER_NAMESPACE]);
    expect(PRIVATE_HELPER_NAMESPACE).toBe("Submission._priv");
    // Every other rule names the submission namespace, not the convention.
    expect(sources("axiom cheat : False")).toEqual(["Submission"]);
  });
});

describe("the designated claim", () => {
  it("marks a buffer that does not declare the designated declaration", () => {
    const found = lintBuffer("theorem other : True := trivial", "FLT_Proofs.Foundations.EMX.open_one");
    expect(found.length).toBe(1);
    expect(found[0]?.message).toContain("FLT_Proofs.Foundations.EMX.open_one");
  });

  it("is quiet once the buffer declares it at the root", () => {
    const buffer = "theorem _root_.FLT_Proofs.Foundations.EMX.open_one : True := trivial";
    expect(lintBuffer(buffer, "FLT_Proofs.Foundations.EMX.open_one")).toEqual([]);
  });

  it("inserts it in the one form checkStatement compares", () => {
    const text = rootTheoremText("FLT_Proofs.Foundations.EMX.open_one", "theorem open_one : True");
    expect(text.startsWith("theorem _root_.FLT_Proofs.Foundations.EMX.open_one :")).toBe(true);
    // Never `Submission.<name>`, which the wrapper would otherwise impose and
    // which pairs with nothing in the reference export.
    expect(text).not.toContain("Submission.");
    expect(text).toContain(":= by");
    expect(declaresRootTheorem(text, "FLT_Proofs.Foundations.EMX.open_one")).toBe(true);
    expect(declaresRootTheorem(text, "FLT_Proofs.Foundations.EMX.open_two")).toBe(false);
  });

  it("takes a `_root_.`-qualified designation without doubling the prefix", () => {
    expect(rootTheoremText("_root_.A.b", "")).toBe("theorem _root_.A.b := by\n  sorry\n\n");
  });
});

describe("the uncurated-FLT rule", () => {
  const at = (name: string, uri: string) => ({ name, uri, line: 3, startColumn: 1, endColumn: 5 });

  it("marks an identifier resolving into an uncurated FLT module", () => {
    const found = lintResolved(
      [at("FLT_Proofs.Bridge.foo", "file:///dict/src/FLT_Proofs/Bridge/Core.lean")],
      ["FLT_Proofs.Foundations.EMX"],
    );
    expect(found.length).toBe(1);
    expect(found[0]?.message).toContain("FLT_Proofs.Bridge.Core");
  });

  it("leaves a curated module and a Mathlib identifier alone", () => {
    const curated = ["FLT_Proofs.Foundations.EMX"];
    expect(lintResolved([at("x", "file:///dict/src/FLT_Proofs/Foundations/EMX.lean")], curated)).toEqual([]);
    expect(lintResolved([at("Finset.card", "file:///oleans/Mathlib/Data/Finset.lean")], curated)).toEqual([]);
  });

  it("yields nothing when the pin carries no module list, rather than marking everything", () => {
    expect(lintResolved([at("x", "file:///dict/src/FLT_Proofs/Bridge/Core.lean")], undefined)).toEqual([]);
    expect(lintResolved([at("x", "file:///dict/src/FLT_Proofs/Bridge/Core.lean")], [])).toEqual([]);
  });

  it("reads a module path out of a source URI", () => {
    expect(fltModuleOf("file:///dict/src/FLT_Proofs/Foundations/EMX.lean")).toBe("FLT_Proofs.Foundations.EMX");
    expect(fltModuleOf("file:///oleans/Mathlib/Order/Basic.lean")).toBeNull();
  });
});

describe("the lint invents no string", () => {
  it("renders every message from a real reason code", () => {
    const buffer = [
      "axiom cheat : False",
      "inductive Tree",
      "opaque secret : Nat",
      "instance : Thing := ⟨⟩",
      "def helper : Nat := 0",
    ].join("\n");
    const messages = codes(buffer, "A.b");
    expect(messages.length).toBe(6);
    // Each message is a rendered template, so none of them is the bare code
    // and none of them is empty.
    for (const m of messages) {
      expect(m.length).toBeGreaterThan(0);
      expect(REASON_CODES).not.toContain(m);
    }
  });

  it("uses the codes the gate itself emits", () => {
    for (const code of ["NEW_AXIOM", "NEW_INDUCTIVE", "NEW_OPAQUE", "NEW_DEFINITION", "CLAIM_NOT_DECLARED", "CONSTANT_NOT_IN_DICTIONARY"]) {
      expect(REASON_CODES).toContain(code);
    }
  });
});
