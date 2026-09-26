/-
Targets for ci/test_gate_triviality.sh. Init only, no Mathlib.

The triviality flag exists to route a vacuous statement to human review rather than publish it
as a verified result. It tested the conclusion exactly as written, so a NAME was enough to hide
behind — every `hidden*` target below passed as clean before the head-unfolding change.

The `honest*` targets are the other half of the test: unfolding must not start flagging real
results. `2 + 2 = 4` is the case the gate's own documentation commits to leaving alone.
-/

/-! ### Vacuous, and named -/

def Disguised : Prop := True

/-- `True` with a name on it. -/
theorem hiddenOnce : Disguised := trivial

def AliasA : Prop := True
def AliasB : Prop := AliasA
def AliasC : Prop := AliasB

/-- The same, three aliases deep — the flag must follow the chain, not one link of it. -/
theorem hiddenChain : AliasC := trivial

/-- A vacuous predicate behind a name, reached only by applying it and beta-reducing. -/
def Robust : Nat → Prop := fun _ => AliasA

theorem hiddenQuantified : ∀ n : Nat, Robust n := fun _ => trivial

/-! ### Vacuous, and obvious — these were already caught and must stay caught -/

theorem plainTrue : True := trivial

theorem plainRefl : ∀ n : Nat, n = n := fun _ => rfl

/-! ### Honest, and must not be flagged -/

/-- The case the gate's documentation promises to leave alone: real, simple, not vacuous. -/
theorem honestArith : 2 + 2 = 4 := by rfl

def twice (n : Nat) : Nat := n + n

/-- A real statement about a real function, whose head IS one of the submission's own
definitions — so head-unfolding runs here and must still conclude nothing. -/
theorem honestTwice : twice 0 = 0 := by rfl
