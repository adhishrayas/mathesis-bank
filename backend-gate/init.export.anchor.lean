-- A single decl whose type + proof reach the trusted constants, so that
-- exporting it yields their genuine closure in ONE lean4export run
-- (multi-decl Init export panics; single-decl does not).
-- The logical core, in the TYPE:
--   Iff, Eq, And, Or, Not(→False), Exists, HEq, Bool, Decidable, Quotient, Setoid, Nat, True
-- and in the PROOF: propext, Classical.choice, Quot.sound.
-- The kernel built-ins (`CheckProof.kernelBuiltins`), in the TYPE, one hypothesis per group.
theorem Mathesis.trustAnchor
    (a b : Prop) (hiff : a ↔ b)
    (_hand : a ∧ b) (_hor : a ∨ b) (_hnot : ¬ a)
    (_hex : ∃ _ : Bool, True) (_hheq : HEq a b) [_dec : Decidable a]
    (_s : Setoid Nat) (_q : Quotient _s) (_hq : Quot.mk _s.r 0 = Quot.mk _s.r 0)
    (_natOps : [Nat.add, Nat.sub, Nat.mul, Nat.pow, Nat.gcd, Nat.div, Nat.mod,
      Nat.land, Nat.lor, Nat.xor, Nat.shiftLeft, Nat.shiftRight] = [])
    (_natCmp : [Nat.beq, Nat.ble] = [])
    (_natCtors : [Nat.zero, Nat.succ Nat.zero] = [])
    (_string : String.ofList [Char.ofNat 0] = "")
    (_reduce : (Lean.reduceBool Bool.true, Lean.reduceNat 0, eagerReduce 0) = (Bool.true, 0, 0))
    (_quotLift : @Quot.lift Nat _s.r Nat id = @Quot.lift Nat _s.r Nat id)
    (_quotInd : @Quot.ind Nat _s.r (fun _ => True) = @Quot.ind Nat _s.r (fun _ => True)) :
    (a = b) ∧ True ∧ Nonempty Nat :=
  ⟨propext hiff, trivial, ⟨Classical.choice ⟨0⟩⟩⟩
