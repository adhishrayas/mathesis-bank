-- Genuine proofs touching the kernel built-ins: native Nat arithmetic and gcd, a string
-- literal, a quotient, and the permitted axioms. Must stay admitted.
theorem Honest.all :
    Nat.gcd 12 18 = 6 ∧ "ab".length = 2 ∧ (2 : Nat) ^ 10 = 1024 ∧
    (∀ (s : Setoid Nat) (a : Nat), Quotient.mk s a = Quotient.mk s a) ∧
    (∀ a b : Prop, (a ↔ b) → a = b) ∧ Nonempty Nat :=
  ⟨by decide, by decide, by decide, fun _ _ => rfl, fun _ _ h => propext h, ⟨Classical.choice ⟨0⟩⟩⟩
