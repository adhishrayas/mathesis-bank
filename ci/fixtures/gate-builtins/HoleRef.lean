-- Two targets, where the second's statement reaches the first through a definition.
theorem hex : ∃ x : Nat, x = 0 := sorry
noncomputable def w : Nat := Classical.choose hex
theorem hw : w = 0 := sorry
