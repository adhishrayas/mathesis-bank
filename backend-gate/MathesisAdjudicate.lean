/-
Copyright (c) 2026 Dhruv Gupta. All rights reserved.
Released under Apache 2.0 license as described in the file LICENSE.
Authors: Dhruv Gupta
-/
import Lean
import Export.Parse
import Mathesis.Verdict
import Mathesis.Primitive.CheckProof
import Mathesis.Manifest

/-!
# `mathesis-adjudicate` — the security-critical re-derivation gate

An adversarial audit found the prior CI trusted RECORDED MANIFEST FIELDS (a deposit's
self-reported axiom list, self-reported replay status) instead of re-deriving them from the
export artifact itself. This executable is the fix: it loads the export text, PARSES it into an
`ExportedEnv` in-process, and RE-RUNS both the kernel replay (`CheckProof.replayLean`) and the
axiom-closure check (`CheckProof.checkAxioms`) from scratch. Nothing about admission is read from
the deposit's manifest — the manifest is not even an input to this program.

## The one property that makes this a gate and not theater

`permittedAxioms` below is a SOURCE CONSTANT: `propext`, `Classical.choice`, `Quot.sound`, and
nothing else. It is not a CLI argument, not a file, not an environment variable — there is no
runtime path by which a deposit (or a compromised caller) can widen it. Widening the permitted
axiom set requires editing and recompiling this file. That immutability IS the security property:
a self-describing deposit must never be able to expand what it is allowed to assume.

## CLI contract

    mathesis-adjudicate [--reference <R.export>] <candidate.export> -- <decl1> <decl2> ...

* `--reference <R.export>` — OPTIONAL. When present, `<R.export>` is the bank-owned frozen
  reference environment and the STATEMENT-IDENTITY leg runs: each target in the candidate must prove
  *the same statement* as in R (the UK-i definition-smuggling defense — a candidate that silently
  redefines a constant its statement depends on is caught here even though its own axioms/replay are
  clean). When absent, behavior is exactly self-seeded (replay + axiom audit + triviality only), the
  form the deployed `verify.yml` depends on.
* `<candidate.export>` — a `lean4export` text artifact (the frozen/durable form
  `Manifest.loadFrozenText` reads); the deposit under audit.
* `--` — mandatory separator (mirrors `Manifest.freezeExportText`'s own argv convention).
* `<declN>` — target theorem names to adjudicate, in the *root* namespace as they appear in the
  export (e.g. `WMSpec.fiber_saturated`).

Emits one JSON object to stdout (schema in `main`'s doc) and exits 0 IFF the kernel replay is
accepted AND every target's axiom audit passes AND (when a reference is given) the statement-identity
leg passes; 1 otherwise. Exit code is the actual gate — CI should key on it, not on parsing the JSON.
-/

open Lean Export Mathesis Mathesis.CheckProof Mathesis.Manifest

namespace MathesisAdjudicate

/-! ### The immutable permitted-axiom whitelist (the security boundary) -/

/-- **THE permitted axiom set.** Exactly `propext`, `Classical.choice`, `Quot.sound` — Lean's three
standard noncomputable/quotient axioms, and nothing a deposit or its manifest can add to. Declared
`Array Name` (not read from argv/file/env) so that widening it is a source change, not a runtime
one. -/
def permittedAxioms : Array Name := #[``propext, ``Classical.choice, ``Quot.sound]

/-- The whitelist rendered as strings, for the JSON `permitted` field. -/
def permittedAxiomStrings : Array String := permittedAxioms.map (·.toString)

/-! ### `collectAxioms` — informative axiom-reachability traversal

Mirrors `CheckProof.Axioms.loop`'s worklist closure exactly, but ACCUMULATES every axiom it
reaches into a `Std.HashSet Name` instead of throwing on the first one outside `permitted`. This is
purely informative (the `axioms_reached` field of the report); the actual pass/fail gate decision
is `CheckProof.checkAxioms`, called separately below and unaffected by this function. -/

namespace CollectAxioms

structure Ctx where
  candidate : ExportedEnv

structure St where
  worklist : Array Name
  checked : Std.HashSet Name
  reached : Std.HashSet Name

abbrev M := ReaderT Ctx <| StateT St <| Except String

partial def loop : M Unit := do
  if (← get).worklist.isEmpty then
    return ()
  let target ← modifyGet fun s => (s.worklist.back!, { s with worklist := s.worklist.pop })
  if (← get).checked.contains target then
    loop
  else
    let some info := (← read).candidate.constMap[target]?
      | throw s!"constant absent from candidate: '{target}'"
    -- deep: mirror the axiom-audit closure so `axioms_reached` reflects proof-side axioms too.
    runForUsedConsts info (deep := true) visit
    modify fun s => { s with checked := s.checked.insert target }
    loop
where
  visit (n : Name) : M Unit := do
    let some info := (← read).candidate.constMap[n]?
      | throw s!"constant absent from candidate: '{n}'"
    if let .axiomInfo ax := info then
      modify fun s => { s with reached := s.reached.insert ax.name }
    if !(← get).checked.contains n then
      modify fun s => { s with worklist := s.worklist.push n }

end CollectAxioms

/-- Every axiom transitively reached from `target`'s FULL dependency graph (type + value +
children), in the candidate environment. Kind-agnostic (finding F4): works for `defnInfo`/
`opaqueInfo` bodies as well as `thmInfo` proofs, matching the generalized `checkAxioms`. Purely
informative — never gates. Returns `none` (with a note) rather than blocking the report if the
traversal itself fails (e.g. a dangling constant reference), since the pass/fail decision comes from
`checkAxioms` regardless. -/
def collectAxioms (candidate : ExportedEnv) (target : Name) : Array Name × Option String :=
  match candidate.constMap[target]? with
  | none => (#[], some s!"target absent from candidate: '{target}'")
  | some _ =>
    let run := CollectAxioms.loop.run { candidate }
      |>.run { worklist := #[target], checked := {}, reached := {} }
    match run with
    | .ok ((), st) => (st.reached.toArray, none)
    | .error e => (#[], some e)

/-! ### Kind + triviality (finding F1/C2/C3 — bind the claim to the type)

The axiom audit proves a target is kernel-clean; it says NOTHING about whether the target's
statement is meaningful. A `theorem T : True := trivial` or a `def Robust := fun _ => True` passes
every mechanical leg honestly while the manifest claims it is a landmark result / a real predicate.
These checks emit a syntactic degeneracy flag (never a gate — a trivial theorem is still VALID) so
the CI can route it to human review instead of publishing it verbatim as "verified". Conservative by
design: only SYNTACTIC vacuity is flagged, so a real-but-simple `2 + 2 = 4` is never caught. -/

def kindString : ConstantInfo → String
  | .axiomInfo _ => "axiom"
  | .thmInfo _ => "theorem"
  | .defnInfo _ => "definition"
  | .opaqueInfo _ => "opaque"
  | .quotInfo _ => "quot"
  | .inductInfo _ => "inductive"
  | .ctorInfo _ => "constructor"
  | .recInfo _ => "recursor"

partial def stripForalls : Expr → Expr
  | .forallE _ _ b _ => stripForalls b
  | e => e

partial def stripLambdas : Expr → Expr
  | .lam _ _ b _ => stripLambdas b
  | e => e

/-- A `Prop` conclusion that is syntactically degenerate: literally `True`, or a reflexive
`a = a` / `a ↔ a` / `HEq a a` (both sides the SAME `Expr`). -/
def degenerateProp (concl : Expr) : Option String :=
  if concl.isConstOf ``True then some "conclusion is `True`"
  else match concl.getAppFnArgs with
    | (``Eq, #[_, a, b]) => if a == b then some "conclusion is a reflexive equality `a = a`" else none
    | (``Iff, #[a, b]) => if a == b then some "conclusion is a reflexive `a ↔ a`" else none
    | (``HEq, #[_, a, _, b]) => if a == b then some "conclusion is a reflexive `HEq a a`" else none
    | _ => none

/-- Syntactic triviality of a target: for a theorem, a degenerate conclusion (after stripping the
`∀`-binders); for a definition, a body that is constantly `True` (a vacuous predicate). -/
def trivialityOf (info : ConstantInfo) : Option String :=
  match info with
  | .thmInfo tv => degenerateProp (stripForalls tv.type)
  | .defnInfo dv =>
      if (stripLambdas dv.value).isConstOf ``True then
        some "definition body is constantly `True` (vacuous predicate)"
      else none
  | _ => none

/-! ### Per-target audit -/

/-- One target's audit result: the gate decision (`checkAxioms`), the informative axiom traversal
(`collectAxioms`), the constant's `kind`, a syntactic `triviality` flag, and the statement the
kernel actually checked. -/
structure TargetAudit where
  decl : Name
  kind : String
  pass : Bool
  illegalAxiom : Option String
  axiomsReached : Array Name
  triviality : Option String
  statement : Option String

/-! ### The statement the kernel checked

WHY THIS IS HERE AND NOT IN THE GRAPH EXPORTER

The record publishes a rendering of each result's statement, and a reader takes that rendering to
be what was proved. Nothing made that true. The digest the record carries is the sha256 of a
string produced by pretty-printing in an environment that IMPORTS the author's own module — so
the author's `notation` and `@[app_unexpander]` declarations are live while their own theorem is
rendered, and they choose the words. `theorem rh : Disguised := trivial` with
`notation "RiemannHypothesis" => Disguised` renders as `RiemannHypothesis`.

This renders from `candidate.constMap[decl].type`: the exact `Expr` the kernel replayed. Two
properties follow, and both matter.

It cannot carry the author's notation, because it does not load the author's module — it renders
in an empty environment, where no delaborator, notation or unexpander has been registered by
anyone. Notation lives in syntax extensions, which a kernel export does not contain.

And it is reproducible by a stranger. `bin/mathesis verify` re-runs this binary over the
published blob, so a record whose statement disagrees with the term is detectable by anybody,
not just by us at publication time. That is the difference between a convention and a check.

The environment is empty on purpose rather than for economy: a constant needs no definition to
be printed (`Nat → Not True` renders fine where `Nat` is undefined), and an empty one is the
only environment whose rendering is a function of the term alone. -/
def canonicalPPOptions : Options :=
  let o := Options.empty
  -- Notation off: this is the field the author would otherwise control.
  let o := o.setBool `pp.notation false
  -- Full names, so `Foo.bar` and a locally-opened `bar` cannot read as the same thing.
  let o := o.setBool `pp.fullNames true
  let o := o.setBool `pp.proofs false
  o.set `format.width (100 : Nat)

/-- The target's type, rendered from the replayed term. `none` when the target is absent from the
candidate (already a rejection) or when the printer fails — never a guess, and never fatal: this
is evidence for the record, not a leg of the gate. -/
def renderStatement (candidate : ExportedEnv) (decl : Name) : IO (Option String) := do
  match candidate.constMap[decl]? with
  | none => return none
  | some info =>
    try
      let env ← mkEmptyEnvironment
      let (fmt, _) ← (Lean.PrettyPrinter.ppExpr info.type).toIO
        { fileName := "<adjudicate>", fileMap := default, options := canonicalPPOptions }
        { env := env }
      return some (toString fmt)
    catch _ =>
      return none

/-- Run the gate decision + informative traversal + kind/triviality for one target against
`candidate`, using the hard-coded `permittedAxioms`. `pass`/`illegalAxiom` are decided SOLELY by
`checkAxioms`; `triviality` is emitted for the CI to route to review but NEVER affects `pass` (a
trivial theorem is valid, just mis-claimed). -/
def auditTarget (candidate : ExportedEnv) (permittedTypes : Std.HashMap Name ConstantInfo)
    (trusted : Name → Option ConstantInfo) (statement : Option String) (decl : Name) : TargetAudit :=
  let info? := candidate.constMap[decl]?
  let (pass, illegalAxiom) :=
    match checkAxioms candidate #[decl] permittedAxioms permittedTypes trusted with
    | .ok () => (true, none)
    | .error e => (false, some e)
  let (reached, _note) := collectAxioms candidate decl
  { decl,
    kind := match info? with | some i => kindString i | none => "absent",
    pass, illegalAxiom, axiomsReached := reached,
    triviality := info?.bind trivialityOf,
    statement }

/-- Extract the illegal-axiom name from a `checkAxioms` error string, if the failure was in fact an
"illegal axiom reached" error (as opposed to some other failure like an absent constant). The error
strings are produced by `CheckProof.Axioms.loop.validateConst` (`s!"illegal axiom reached: '{ax}'"`)
— this parses that exact shape back out for the structured `illegal_axiom` field. -/
def extractIllegalAxiom (msg : String) : Option String :=
  -- Split on `'`: the message is exactly `illegal axiom reached: '<name>'`, so splitting on the
  -- quote yields `["illegal axiom reached: ", "<name>", ""]`. `splitOn` (unlike `take`/`dropRight`
  -- in this Std version) returns a stable `List String`, so this avoids the `String.Slice`
  -- migration entirely.
  match msg.splitOn "'" with
  | [pre, name, _] => if pre == "illegal axiom reached: " then some name else none
  | _ => none

/-- Extract the redefined constant's name from a `checkAxioms` error, if the failure was a trusted
redefinition. Produced by `CheckProof.Axioms.loop.validateConst` as
`s!"trusted constant redefined: '{n}' (candidate's declaration differs ...)"`.

Note the `pre :: name :: _` pattern rather than `extractIllegalAxiom`'s exact three-element match:
the suffix here contains an apostrophe ("candidate's"), so splitting on `'` yields FOUR pieces.
A three-element pattern would silently never match, which is the shape of bug this whole field
exists to fix. -/
def extractRedefined (msg : String) : Option String :=
  match msg.splitOn "'" with
  | pre :: name :: _ => if pre == "trusted constant redefined: " then some name else none
  | _ => none

/-! ### JSON assembly -/

def targetAuditToJson (t : TargetAudit) : Json :=
  Json.mkObj [
    ("decl", Json.str t.decl.toString),
    ("kind", Json.str t.kind),
    ("axiom_audit", Json.str (if t.pass then "pass" else "fail")),
    ("illegal_axiom",
      match t.illegalAxiom.bind extractIllegalAxiom with
      | some ax => Json.str ax
      | none => Json.null),
    -- The constant whose definition diverged from the trusted reference. A redefinition is the
    -- OTHER way `axiom_audit` fails, and it was previously reported as a bare "fail": the exe
    -- knew the name, `extractIllegalAxiom` did not recognise the message, and the diagnosis was
    -- dropped on the floor here. A depositor colliding with `Set` or `mul_one` had nothing to
    -- act on.
    ("redefined_constant",
      match t.illegalAxiom.bind extractRedefined with
      | some n => Json.str n
      | none => Json.null),
    -- The raw failure text, whatever its shape. `illegal_axiom` and `redefined_constant` are
    -- convenience parses of it; this is here so a failure mode neither of them recognises is
    -- still surfaced rather than silently discarded — which is exactly what happened to
    -- redefinitions until now.
    ("failure", match t.illegalAxiom with | some e => Json.str e | none => Json.null),
    ("axioms_reached", Json.arr (t.axiomsReached.map (Json.str ·.toString))),
    ("triviality", match t.triviality with | some r => Json.str r | none => Json.null),
    -- The statement the kernel checked, rendered from the replayed term rather than from the
    -- author's environment. See `renderStatement`.
    ("statement", match t.statement with | some s => Json.str s | none => Json.null)
  ]

/-! ### Argv parsing -/

/-- Split `[--reference <R.export>] <candidate.export> -- <decl1> <decl2> ...` into the optional
reference path, the candidate export path, and the target decl strings. Requires the literal `--`
separator (mirrors `Manifest.freezeExportText`'s own convention). The `--reference <R>` prefix is
optional and, when absent, `reference?` is `none` (self-seeded mode — exactly the legacy behavior the
deployed `verify.yml` depends on). -/
def parseArgs (args : List String) :
    Except String (Option String × String × List String) :=
  let usage :=
    "usage: mathesis-adjudicate [--reference <R.export>] <candidate.export> -- <decl1> <decl2> ..."
  match args with
  | "--reference" :: refPath :: candidate :: rest =>
    match rest with
    | "--" :: decls =>
      if decls.isEmpty then .error "no target declarations given after '--'"
      else .ok (some refPath, candidate, decls)
    | _ => .error s!"{usage} (missing '--')"
  | "--reference" :: _ => .error s!"{usage} (--reference needs <R.export> and a candidate)"
  | path :: rest =>
    match rest with
    | "--" :: decls =>
      if decls.isEmpty then .error "no target declarations given after '--'"
      else .ok (none, path, decls)
    | _ => .error s!"{usage} (missing '--')"
  | [] => .error usage

end MathesisAdjudicate

/-! ### `main`

Kept OUTSIDE `namespace MathesisAdjudicate`: `lean_exe`'s entry point must resolve to the top-level
symbol `main` (as in `MathesisSelfTest.RealReplay`'s `main`, which the linker also expects
unqualified) — a `main` declared inside a namespace compiles as `MathesisAdjudicate.main` and the
executable fails to link with "undefined symbol: main". -/

open MathesisAdjudicate in
/-- **`main`.** Loads the export, re-derives replay + per-target axiom closure from scratch
(NEVER trusts a recorded manifest field), emits the JSON report, and exits 0 IFF replay is accepted
AND every target's axiom audit passes.

Output schema (one line, compact JSON):

```
{"export": <path>,
 "reference": <path|null>,
 "constants": <number of constants in the parsed candidate export>,
 "replay": {"accepted": <bool>, "detail": <string>},
 "permitted": ["propext", "Classical.choice", "Quot.sound"],
 "statement_identity": "pass"|"fail"|"not-applicable"|"<reason string>",
 "kernel_builtins": "pass"|"not-checked"|"<reason string>",
 "targets": [{"decl": <string>, "axiom_audit": "pass"|"fail",
              "illegal_axiom": <string|null>, "axioms_reached": [<string>, ...],
              "statement": <string|null>}, ...],
 "verdict": "ADMITTED"|"REJECTED"}
```

`statement_identity` is `"not-applicable"` in self-seeded mode (no `--reference`). With a reference
it is `"pass"` when the identity leg holds, otherwise the precise Pl-kill reason (which begins with
one of `target absent`/`target kind differs`/`target statement differs`/`constant diverges` — the
smuggle is surfaced as content, not just a boolean). The statement leg is a GATE only in reference
mode: a `fail` forces `verdict` to `REJECTED` and a nonzero exit. -/
def main (args : List String) : IO UInt32 := do
  Lean.initSearchPath (← Lean.findSysroot)
  -- Bind each permitted axiom NAME to its genuine kernel TYPE, read from a TRUSTED base environment
  -- (`Init`, from this exe's own pinned toolchain — never from the deposit). This closes the
  -- name-only-whitelist spoof: a `prelude` deposit declaring `axiom propext : <false>` is rejected
  -- because its type differs from genuine `propext`. FAIL CLOSED: if any permitted axiom cannot be
  -- resolved in the base env we refuse to run rather than silently fall back to name-only.
  let baseEnv ← Lean.importModules #[{ module := `Init }] {}
  let mut permittedTypes : Std.HashMap Name ConstantInfo := {}
  for n in permittedAxioms do
    match baseEnv.find? n with
    | some ci => permittedTypes := permittedTypes.insert n ci
    | none =>
      IO.eprintln s!"FATAL: permitted axiom '{n}' not found in trusted base env; refusing to run (cannot bind name→type)"
      return 1
  -- Bank-owned TRUSTED logical-core reference (init.export), parsed the SAME way as candidates (both
  -- lean4export representation), so genuine constants match exactly and only a real redefinition of a
  -- trusted constant (fake `Iff`/`Eq`/`False`) diverges → rejected. When MATHESIS_INIT_EXPORT is set
  -- the redefinition check is active (production gates set it); when absent it is skipped (the axiom
  -- type-binding stays active, and the deposit build-barrier also blocks the attack structurally).
  let (trusted, trustedActive) : (Name → Option ConstantInfo) × Bool ← do
    match ← IO.getEnv "MATHESIS_INIT_EXPORT" with
    | some p =>
      let tEnv ← loadFrozenText (← IO.FS.readFile p)
      IO.eprintln s!"trusted init.export loaded: {tEnv.constMap.size} constants"
      pure ((fun n => tEnv.constMap[n]?), true)
    | none =>
      IO.eprintln "note: MATHESIS_INIT_EXPORT not set; trusted-redefinition and kernel built-in checks DISABLED (type-binding active)"
      pure ((fun _ => none), false)
  match parseArgs args with
  | .error msg =>
    IO.eprintln msg
    return 1
  | .ok (reference?, path, declStrs) =>
    let targets : Array Name := (declStrs.map (·.toName)).toArray
    let text ← IO.FS.readFile path
    let candidate ← loadFrozenText text
    let (accepted, detail) ← replayLean candidate
    let mut audits : Array TargetAudit := #[]
    for d in targets do
      audits := audits.push (auditTarget candidate permittedTypes trusted (← renderStatement candidate d) d)
    let allPass := audits.all (·.pass)
    -- Kernel built-ins leg, in every mode: each one the candidate carries must be the genuine one.
    -- The kernel uses them by name without checking them, and the axiom walk never reaches them.
    let builtinsResult : Except String Unit :=
      if trustedActive then checkBuiltins candidate trusted else .ok ()
    -- Statement-identity leg (the UK-i definition-smuggling defense): runs ONLY when a reference is
    -- supplied. When present it re-uses the proven-sound `checkProof` primitive over R-vs-candidate.
    -- `primitive := #[]`: the kernel built-ins are checked above, against the trusted copy rather
    -- than against the reference, whose frozen export need not carry them. Its `statement` leg
    -- gates admission here.
    let (statementResult, statementJson) ←
      match reference? with
      | none =>
        pure (LegResult.pass, Json.str "not-applicable")
      | some refPath => do
        let reference ← loadFrozenText (← IO.FS.readFile refPath)
        let report ← checkProof reference candidate targets permittedAxioms #[]
                        (permittedTypes := permittedTypes) (trusted := trusted)
        match report.statement with
        | .pass       => pure (LegResult.pass, Json.str "pass")
        | .fail reason => pure (LegResult.fail reason, Json.str reason)
    let statementOk := statementResult.ok
    let builtinsOk := builtinsResult matches .ok _
    let verdictOk := accepted && allPass && statementOk && builtinsOk
    let json := Json.mkObj [
      ("export", Json.str path),
      ("reference", match reference? with | some r => Json.str r | none => Json.null),
      ("constants", Json.num candidate.constMap.size),
      ("replay", Json.mkObj [("accepted", Json.bool accepted), ("detail", Json.str detail)]),
      ("permitted", Json.arr (permittedAxiomStrings.map Json.str)),
      ("statement_identity", statementJson),
      ("kernel_builtins", Json.str (match builtinsResult with
        | .ok _ => if trustedActive then "pass" else "not-checked"
        | .error e => e)),
      ("targets", Json.arr (audits.map targetAuditToJson)),
      ("verdict", Json.str (if verdictOk then "ADMITTED" else "REJECTED"))
    ]
    IO.println json.compress
    return if verdictOk then 0 else 1
