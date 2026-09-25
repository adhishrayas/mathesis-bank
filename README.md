# Mathesis

A record of machine-checked theorems, and the program that checks it.

Each record names a Lean 4 declaration, the axioms its proof reaches, and the sha256 of a frozen
export of the environment that built it. `bin/mathesis verify` fetches those exports, replays
each one through the Lean kernel, and requires that the axioms it finds are exactly the axioms
the record claims. Nothing here is taken on trust from a server, a build log, or this README.

The repository is deliberately dull. It stores the record and nothing else: no site, no build
system, no deployment configuration, no intake. Those live in the system that publishes the
record, which is a separate thing. If the code that *renders* a record could also decide what
a record says, "open" would not mean very much.

## Check it yourself

```sh
git clone https://github.com/noumenal-ai/mathesis-bank && cd mathesis-bank
pip install jsonschema
bin/mathesis verify
```

That builds the gate, downloads the evidence, and re-derives all 32 records. It is honest about
what it costs the first time:

- **A Lean toolchain.** `elan`, `leanprover/lean4:v4.31.0`, and the two dependencies pinned in
  `backend-gate/lake-manifest.json` (`lean4export`, `Lean4Checker`). `.lake/` is not committed.
  No prebuilt binary is shipped on purpose — an opaque blob nobody can rebuild and compare
  would undercut the only claim this repository makes.
- **About 645 MB of downloads.** The frozen exports are 4.2 GB uncompressed across 32 records,
  which is not something git should carry. They live on the
  [`bank-exports-v1`](https://github.com/noumenal-ai/mathesis-bank/releases/tag/bank-exports-v1)
  release, named by their own sha256.

Fetching evidence from a release is safe because the blobs are content-addressed: the
decompressed bytes are re-hashed and compared to the manifest before the kernel is started, so a
substituted or corrupted export fails immediately rather than being replayed. Once they are
cached, point `BANK_EXPORT_STORE` at a local directory and the whole check runs with no network.

## Read it

`list`, `show` and `search` read the JSON off disk and compute the answer each time. They need
no toolchain, no network and no evidence — they work on a fresh clone with nothing built. That
is why there is no index, no generated catalogue and no committed report to fall out of step
with the data.

```sh
bin/mathesis list                    # every record: handle, declaration, axioms
bin/mathesis show MTH.R-2026-6001    # one record in full, and the claim it discharges
bin/mathesis search shatter          # over declaration names, statements and docstrings
```

For any other shape, the manifests are plain JSON — pipe them.

## What `verify` checks

In order, and a failure of any one is a failure overall. Nothing is skipped silently: a leg that
cannot run is an error, not a pass.

| | |
|---|---|
| **schema** | every manifest matches `schema/bank-manifest.v1.schema.json` |
| **crosslinks** | every argument names a claim that exists, and every claim its argument |
| **coverage** | the number re-derived equals the number present — "31 of 32 clean" must not print as "clean" |
| **re-derivation** | fetch `<export_sha256>.export.gz`, check the decompressed bytes against that sha256, replay through `mathesis-adjudicate`, and require ADMITTED, an accepted replay, no triviality flag, and **exactly** the axioms the manifest claims |

The last is the one that matters, and `backend-gate/` is the source to read. The first three
catch a manifest that lies about its own shape or about what else exists; the last catches one
that lies about mathematics.

**What it does not check.** That the prose describes the theorem. That the person credited
proved it. That the statement is interesting, or true of anything outside Lean.
`curation.json`, `posts.json`, `profiles.json`, `people.json` and `dictionary.json` record who
published what; nothing here re-derives them.

## Layout

| Path | Contents |
|---|---|
| `bank/claims/`, `bank/arguments/` | the record: 32 claims and the 32 arguments that discharge them |
| `bank/curation.json`, `dictionary.json`, `posts.json`, `profiles.json`, `people.json` | the rest of the record, and its authorship |
| `bank/avatars/` | committed, so no page has to make a third-party request |
| `bank/tools/verify-bank.sh` | the re-derivation leg on its own, if you would rather run it directly |
| `backend-gate/` | the Lean adjudicator, and `init.export`, the trusted logical core every replay is checked against |
| `backend-gate/init.export.anchor.lean`, `.README.md` | how to rebuild that reference and compare it, rather than trusting it |
| `bin/mathesis` | the program above |
| `ci/test_gate_builtins.sh`, `ci/fixtures/` | the regression test below |
| `ci/export_stats.py` | how `init.export`'s constant count is checked (`--self-test`) |
| `schema/bank-manifest.v1.schema.json` | the schema for the manifests in `bank/` |
| `shared/reasons.v1.json` | the verdict vocabulary, for reading a rejection |

## Why the gate ships with a test that tries to break it

A candidate that redefined `Nat.gcd` once proved `2 + 2 = 5` and was **admitted**, with the
trusted export loaded. `ci/test_gate_builtins.sh` is the regression test for that, and it runs
before the record is checked in CI — a verifier that had stopped verifying would otherwise
report 32 clean re-derivations. A repository whose pitch is "read the verifier" should ship the
test that shows it catches the thing it was written for.

Breaking it deliberately is the honest way to trust it. Flip a byte in a cached `.export.gz`
(the sha256 check fires before the kernel runs), edit one `axioms_reached` (the replay's exact-set
comparison), delete one file from `bank/arguments/` (coverage), or point a claim at an accession
that does not exist (crosslinks).

## Adding a record

Not through this repository. Records arrive from the deposit system, which builds a submission
in a confined container, adjudicates it with the same gate committed here, and writes the result
in. What lands here is the outcome, and the point of `bin/mathesis verify` is that you do not
have to believe any of that to check it.

## Licence

See [LICENSE](LICENSE).
