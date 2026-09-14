# The vocabulary the Mathlib trusted reference protects.
#
# `deploy/builder/make-mathlib-export.sh` exports the closure of these constants from the bank's
# own trusted Mathlib build. `CheckProof.trustedMatches` then compares every constant a deposit
# reaches that ALSO appears here — so this file is, literally, the list of names a deposit
# cannot redefine.
#
# WHY A CURATED LIST AND NOT THE WHOLE ENVIRONMENT
# ------------------------------------------------
# lean4export takes no `--` separator to mean "every non-internal constant in the environment",
# which would be the obvious choice for a reference. Measured, it is not usable:
#
#   whole Mathlib environment   >= 2.77 GB emitted, then no output for 35 min at ~5 GB RSS;
#                                  killed at 62 min, never completed
#   51 constants below            45.6 MB, 12,683 constants, 11.5 s
#   6 of them                     13.9 MB,  4,603 constants,  8.5 s
#
# Even had it completed, the adjudicator parses the reference with `loadFrozenText` on EVERY
# adjudication; a multi-GB parse per deposit is not viable. The curated closure is smaller than
# the 74 MB blob already in the corpus.
#
# Note how little the list costs as it grows: 6 names to 51 names is 4,603 to 12,683 constants
# for 3.2x the bytes, because definitional closures overlap heavily. Adding a name is cheap, so
# the bar for including one should be low.
#
# WHAT THIS DOES NOT COVER — read before trusting it
# ---------------------------------------------------
# Mathlib has of order 200,000 constants and this closure reaches ~12,700 of them. A deposit CAN
# still redefine a Mathlib name outside the closure. The reference is a defence for the
# *self-audit* path only (a deposit with no `@discharges`, which has no reference environment
# and so no statement-identity leg); a discharging deposit is held to the far stronger
# statement-identity check against the claim's frozen R.
#
# The selection principle is therefore: **the vocabulary a claim is STATED in**. The attack is a
# deposit that proves something true of its own `Real` and reads to a human as a theorem about
# the reals, so what matters is the names a reader would take at face value when judging what
# was proved. Obscure lemma names carry no such weight and a spoof of one proves nothing a
# reader would misread.
#
# THIS IS A JUDGEMENT CALL, AND IT IS THE BANK'S TO MAKE. The list below is a starting point
# chosen on that principle, not a derived or complete answer. Extend it.
#
# ORDER IS PART OF THE ARTIFACT
# -----------------------------
# The export is deterministic — the same list in the same order produced a byte-identical
# 47,779,522-byte file across runs — but it is ORDER-SENSITIVE: the same 51 names in a
# different order differed by 5 bytes, because lean4export emits its interning tables in
# encounter order. `environments.mathlib_reference_sha256` pins bytes, so REORDERING THIS FILE
# CHANGES THE SHA even when the set of names is identical. Append rather than rearrange, unless
# you mean to regenerate and re-pin the reference.
#
# Format: one constant per line; `#` comments and blank lines ignored.

# ── number systems ───────────────────────────────────────────────────────────
Real
Complex
NNReal
ENNReal
Cardinal
Ordinal
ZMod

# ── topology and analysis ────────────────────────────────────────────────────
TopologicalSpace
MetricSpace
UniformSpace
Continuous
ContinuousAt
IsCompact
IsOpen
IsClosed
Dense
Homeomorph
Isometry
NormedSpace
NormedAddCommGroup
InnerProductSpace
Differentiable
deriv
Summable
HasSum

# ── measure theory ───────────────────────────────────────────────────────────
Measurable
MeasurableSpace

# ── algebra ──────────────────────────────────────────────────────────────────
Group
AddGroup
Ring
CommRing
Field
Module
Algebra
Ideal
Subgroup
Submodule
LinearMap
ContinuousLinearMap
Polynomial
Matrix

# ── order and combinatorics ──────────────────────────────────────────────────
Monotone
StrictMono
Convex

# ── foundations a statement leans on ─────────────────────────────────────────
Set
Finset
Filter
Equiv
Function.Injective
Function.Surjective
Nat.Prime
