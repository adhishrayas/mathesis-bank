# `init.export` — the trusted reference

`init.export` is a bank-owned, version-controlled reference environment holding the genuine
definitions of the logical-core constants (`Iff`, `Eq`, `False`, `And`, `Or`, `Not`, `Exists`,
`HEq`, `propext`, `Classical.choice`, `Decidable`, `Bool`, quotient primitives, …). The gate
(`mathesis-adjudicate`) loads it when `MATHESIS_INIT_EXPORT` points here and **rejects any candidate
that redefines one of these constants** — the "fake-connective" soundness attack, where a `prelude`
deposit keeps a genuine-typed `propext` but fakes the connectives its type names (`Iff`/`Eq`) to
derive `True = False`. The name-only axiom whitelist and the axiom type-binding do not catch that;
comparing every reached constant that also exists here does (`CheckProof.trustedMatches`).

It also holds the **kernel built-ins**: the constants the v4.31 kernel handles by name
(`CheckProof.kernelBuiltins`: `Nat` and its natively computed operations, `String.ofList`,
`Char.ofNat`, `List`, `Bool.true`, `eagerReduce`, `Lean.reduceBool`, `Lean.reduceNat`, the quotient
primitives). The kernel uses whatever declaration of these names a candidate carries without
checking it: it computes `Nat.gcd` on literals natively whatever the definition says, and expands a
string literal into `String.ofList`/`List.cons`/`Char.ofNat` terms that appear nowhere in the
candidate, so the reached-constant check above never sees them. A `prelude` candidate that imports
only `Init.Prelude` and `Init.Core` can therefore redefine `Nat.gcd` and prove `2 + 2 = 5` with
every other leg passing. The gate's kernel built-ins leg (`CheckProof.checkBuiltins`) compares each
built-in a candidate carries, and every constant reached from its type or definition, against this
file.

## Why it works (and why the obvious alternative does not)

Both sides of the comparison are **lean4export representation, parsed the same way** (`loadFrozenText`).
lean4export is deterministic: the same genuine constant exports to a byte-identical parsed
`ConstantInfo` in any run, so a genuine deposit's `Iff` matches this file's `Iff` exactly, and only a
*real* redefinition diverges. Comparing against a freshly `importModules`-loaded `Init` env does **not**
work — that representation differs from lean4export's, so it falsely rejected ~90% of the genuine
corpus. This like-with-like comparison keeps the full corpus clean while rejecting the fakes.

## How it was generated (reproducible / auditable)

The multi-decl `Init` export panics in this lean4export, so the closure is pulled through a single
anchor declaration whose type + proof reach every logical-core constant and kernel built-in. See
[`init.export.anchor.lean`](init.export.anchor.lean). To regenerate:

```
# the anchor needs only Init; use leanprover/lean4:v4.31.0 and the gate's own pinned lean4export
cp init.export.anchor.lean <dir>/TrustAnchor.lean
(cd <dir> && lean --root=. TrustAnchor.lean -o TrustAnchor.olean)
env LEAN_PATH=<dir> lean4export TrustAnchor -- Mathesis.trustAnchor > init.export
```

Content is 563 constants (`python3 ci/export_stats.py --self-test`). Audit it by parsing and
checking the genuine primitives are present with their expected types (`Iff`, `Eq`, `False`,
`propext`, `Nat.gcd`, `Char.ofNat`, …).

The closure includes the axiom `Lean.trustCompiler`, which `Lean.reduceBool`'s body reaches. It is
here only as a constant to compare against; the gate never permits it.

Note: `Quot.sound` is not in this file's closure; it is an axiom already covered by the gate's axiom
name→type binding, so a spoofed `Quot.sound` is rejected there.
