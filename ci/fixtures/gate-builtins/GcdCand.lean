prelude
import Init.Prelude
import Init.Core

-- Init.Data.Nat.Gcd is not imported, so `Nat.gcd` is free to redefine.
def Nat.gcd (_ _ : Nat) : Nat := 0

theorem thm1 a b : Nat.gcd a b = 0 := by
  unfold Nat.gcd
  rfl

-- The kernel computes `Nat.gcd` on literals natively, by name, ignoring the definition above.
theorem thm2 : Nat.gcd 1 1 = 1 := rfl

theorem boom : False :=
  Nat.noConfusion <| Eq.trans (thm1 1 1).symm thm2

theorem t : 2 + 2 = 5 := boom.elim
