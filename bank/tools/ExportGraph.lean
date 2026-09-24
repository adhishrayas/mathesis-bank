/-
The solution-graph exporter. Not a module on its own: a file of `import` lines for
the result's modules, followed by this file's contents, followed by

  #eval exportGraph #[`FLT_Proofs, `ZPM] `Some.decl "<out>/Some.decl.json"

and run with `lake env lean <file>` in the environment that builds the result.
The first argument is the scope: the modules whose declarations are the argument's
own. Everything outside it (Mathlib, Init, other libraries) is substrate and is
counted, not listed. The JSON carries every in-scope declaration reachable from the
root, its kind, module, source line, kernel-pretty-printed type and the in-scope
declarations it uses, plus the root's axioms (`collectAxioms`).
-/
open Lean Elab Command Meta

namespace GraphExport

def modOf (env : Environment) (n : Name) : Option Name :=
  (env.getModuleIdxFor? n).map fun idx => env.header.moduleNames[idx.toNat]!

def inScope (env : Environment) (pfx : Array Name) (n : Name) : Bool :=
  match modOf env n with
  | some m => pfx.any (·.isPrefixOf m)
  | none => false

def auxSuffixes : List String :=
  ["rec", "recOn", "casesOn", "below", "brecOn", "binductionOn", "noConfusion",
   "noConfusionType", "ibelow", "injEq", "inj", "sizeOf_spec", "eq_def", "ctorIdx",
   "toCtorIdx", "ofNat", "ctorElim", "ctorElimType"]

def isUserFacing (n : Name) : Bool :=
  let base := (privateToUserName? n).getD n
  let comps := base.components.map toString
  !(comps.any fun c => c.startsWith "_" || c.startsWith "match_" || c.startsWith "proof_"
      || c.startsWith "eq_" || c.startsWith "fun_")
  && !(auxSuffixes.contains (comps.getLastD ""))

def usedOf (ci : ConstantInfo) : Array Name :=
  let t := ci.type.getUsedConstants
  let v := match ci.value? (allowOpaque := true) with
    | some e => e.getUsedConstants
    | none => #[]
  let extra := match ci with
    | .inductInfo i => i.ctors.toArray
    | _ => #[]
  t ++ v ++ extra

def kindOf : ConstantInfo → String
  | .thmInfo _ => "theorem"
  | .defnInfo _ => "def"
  | .inductInfo i => if i.isRec then "inductive" else "structure"
  | .ctorInfo _ => "constructor"
  | .opaqueInfo _ => "opaque"
  | .axiomInfo _ => "axiom"
  | .quotInfo _ => "quot"
  | .recInfo _ => "recursor"

/-- In-scope constants reachable from `u` through auxiliary in-scope constants only:
    returns (user-facing in-scope targets, out-of-scope library constants). -/
def visibleUses (env : Environment) (pfx : Array Name) (u : Name) :
    Std.HashSet Name × Std.HashSet Name := Id.run do
  let some ci := env.find? u | return ({}, {})
  let mut vis : Std.HashSet Name := {}
  let mut lib : Std.HashSet Name := {}
  let mut st : Array Name := usedOf ci
  let mut sn : Std.HashSet Name := {}
  while h : st.size > 0 do
    let v := st.back
    st := st.pop
    if sn.contains v then continue
    sn := sn.insert v
    if !inScope env pfx v then
      lib := lib.insert v
      continue
    if isUserFacing v then
      if v != u then vis := vis.insert v
    else
      match env.find? v with
      | some cv => st := st ++ usedOf cv
      | none => pure ()
  return (vis, lib)

def displayName (n : Name) : String := toString ((privateToUserName? n).getD n)

def ppType (n : Name) : MetaM String := do
  let some ci := (← getEnv).find? n | return ""
  let fmt ← withOptions (fun o => (o.setBool `pp.proofs false).set `format.width (100 : Nat)) <|
    PrettyPrinter.ppExpr ci.type
  return toString fmt

end GraphExport

open GraphExport in
def exportGraph (pfx : Array Name) (root : Name) (outPath : String) : CommandElabM Unit := do
  let env ← getEnv
  let some _ := env.find? root | IO.println s!"MISSING {root}"
  -- closure over user-facing in-scope constants
  let mut seen : Std.HashSet Name := {}
  let mut stack : Array Name := #[root]
  let mut order : Array Name := #[]
  while h : stack.size > 0 do
    let n := stack.back
    stack := stack.pop
    if seen.contains n then continue
    seen := seen.insert n
    order := order.push n
    let (vis, _) := visibleUses env pfx n
    for v in vis do
      if !seen.contains v then stack := stack.push v
  let axs ← liftCoreM (Lean.collectAxioms root)
  let mut nodes : Array Json := #[]
  for n in order do
    let some ci := env.find? n | continue
    let (vis, lib) := visibleUses env pfx n
    let pretty ← liftTermElabM (ppType n)
    let ranges ← liftCoreM (findDeclarationRanges? n)
    let line := match ranges with | some r => r.range.pos.line | none => 0
    let mut usesArr : Array Json := #[]
    for v in vis.toArray.qsort (·.toString < ·.toString) do usesArr := usesArr.push (Json.str (displayName v))
    nodes := nodes.push <| Json.mkObj [
      ("decl", Json.str (displayName n)),
      ("kernel_name", Json.str n.toString),
      ("kind", Json.str (kindOf ci)),
      ("private", Json.bool (isPrivateName n)),
      ("module", Json.str ((modOf env n).getD `none).toString),
      ("line", Json.num line),
      ("pretty", Json.str pretty),
      ("uses", Json.arr usesArr),
      ("library_uses", Json.num lib.size)]
  let doc := Json.mkObj [
    ("root", Json.str (displayName root)),
    ("root_module", Json.str ((modOf env root).getD `none).toString),
    ("axioms", Json.arr (axs.map (Json.str ·.toString))),
    ("nodes", Json.arr nodes)]
  IO.FS.writeFile outPath (doc.pretty 120)
  IO.println s!"WROTE {root} nodes={order.size} axioms={axs.toList} -> {outPath}"
