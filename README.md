# Mathesis

The verified record served at <https://noumenal-ai.github.io/mathesis-bank/>.

## Layout

| Path | Contents |
|---|---|
| `bank/` | The published record's source: `curation.json` (the curated results, their accession serials and credits), and the manifests `bankgen` writes from it (`dictionary.json`, `profiles.json`, `posts.json`, `claims/`, `arguments/`). |
| `bank/tools/` | `ExportGraph.lean` (a result's solution graph, read from the Lean environment), `gate.sh` (lean4export + `mathesis-adjudicate` over one result), `build-site.sh` (build, test and render). |
| `docs/` | The rendered record, served by GitHub Pages. Generated; do not edit by hand. |
| `services/registry/` | Rust: the `record` crate (the static generator, `recordgen`, and `bankgen`) and the `accession` crate (the `MTH.C` / `MTH.R` scheme and citations). |
| `web/` | The stylesheet (Tailwind v4 tokens in `tailwind.css`, the component layer in `src/styles/components.css`) and the client (graph layout toggle, clipboard, collection search, posts filter). |
| `tools/prose-lint/` | The check that every visible string is a catalogue label, a data value or a reason message. |
| `DESIGN.md` | The design specification the stylesheet and pages implement. |
| `backend-gate/` | The Lean gate (`mathesis-adjudicate`) and its trusted `init.export`. |
| `registry/`, `ci/`, `bin/`, `schema/` | The earlier internal registry and its re-derivation check, still run by CI. Not published. |

## Adding a result

1. Add `{ "decl": …, "serial": … }` to `bank/curation.json`. A serial is permanent once published.
2. Export its solution graph from the environment that builds it: a file of `import` lines for the result's modules, then `bank/tools/ExportGraph.lean`, then `#eval exportGraph #[`Scope] `Decl "<graphs>/<Decl>.json"`; run it with `lake env lean`.
3. Run the gate: `bank/tools/gate.sh <Module> <Decl>` writes the frozen export, its sha256 and byte count, and the adjudicator's verdict.
4. `bankgen --curation bank/curation.json --graphs <graphs> --verdicts <exports> --out bank` refuses any result the gate did not admit, or whose axioms differ from the environment's.
5. `bank/tools/build-site.sh` rebuilds `docs/` and runs every check.

## Checks

`bank/tools/build-site.sh` runs the Rust tests, the client typecheck and tests, the no-arbitrary-values lint, the generator, and the prose lint over the rendered tree. CI (`.github/workflows/verify.yml`) runs the same script, re-derives the internal registry through the gate, and deploys the rebuilt `docs/` to Pages from `main`.
