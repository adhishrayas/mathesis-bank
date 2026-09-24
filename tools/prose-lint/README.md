# prose-lint

Mechanical enforcement of Rule 1 (no non-functional prose) and of the
internal-corpus firewall, over the generated record tree **and** over the
committed DOM snapshots of every dynamic surface. SPEC.md §8, §9, §13.

```
prose-lint <record-dir> [--dom <snapshot-dir>] [--labels crates/record/labels.json]
           [--fields crates/record/fields.json] [--about about/body.html]
           [--allowlist shared/html-allowlist.v1.json] [--terms .firewall-terms]
           [--reasons shared/reasons.v1.json] [--report .prose-lint.json] [--fresh]
prose-lint --print-allowlist
reason-lint shared/reasons.v1.json [--terms .firewall-terms]
```

Exit `0` clean, `1` violations, `2` usage. Both inputs may be given in one
invocation. Findings are printed as `file:offset: kind: selector: value` and
written to `.prose-lint.json`:

```json
{"violations":[{"file":"","selector":"","kind":"","value":"","offset":0}],
 "checked_files":0,"labels":0,"fields":0,
 "rendered":[],"roots":[],"labels_sha256":""}
```

`rendered`, `roots` and `labels_sha256` carry coverage between the release
gate's two invocations: `prose-lint dist` records the entries the generated
tree renders, and the following `prose-lint --dom test/e2e/dom-snapshots`
unions them before deciding which catalogue entries are dead. Pass `--fresh`
to ignore an earlier run's coverage. A run that includes no `--dom` input does
not decide deadness at all.

## Kinds

| kind | fails on |
|---|---|
| `unknown_string` | visible text that is not a catalogue entry, a value, a reason message or author-written text in a carved-out region |
| `bad_label` | a catalogue entry over four words, ending in `.`/`!`/`?`, or matching the vocabulary regex |
| `dead_label` | a catalogue entry no captured surface renders (appearances inside a carved-out region count as rendered) |
| `attribute` | a `title`/`aria-label`/`aria-description`/`alt` that is neither a catalogue entry nor a declared value; a `data-attr-value` naming an attribute no ancestor carries, or one outside the three declared carriers; an attribute outside an authored region's allowlist profile |
| `placeholder_present` | any `placeholder` attribute at all |
| `missing_data_field` | `[data-value="true"]` or `data-attr-value` with no `data-field` |
| `unknown_field` | a `data-field` absent from `fields.json`, or a field whose declared shape is not in the shape vocabulary |
| `unknown_role` | a `<pre>` whose `data-role` is absent or not one of `lean-statement`/`log`/`report`; a `<pre data-role="lean-statement">` that declares no `lean-statement` value, or a `lean-statement` value that does not carry the role; an element outside an authored region's allowlist profile |
| `value_mismatch` | a value that disagrees with its page's `values.json` entry (by count, by field or byte for byte), a page that renders a value and has no `values.json`, or a snapshot value that violates its field's declared shape |
| `value_is_prose` | a value over four words or matching the vocabulary regex, outside the two exempt shapes |
| `value_laundering` | a value element wrapping a catalogue entry, or whose own text is a catalogue label the catalogue does not also declare as a value |
| `banned_token` | `lorem`, `TODO`, `FIXME`, `coming soon`, `placeholder` in visible text, a reader attribute or a comment |
| `firewall` | `WMSpec`, `Eidometry`, `TLT_Proofs`, `MTH.[CRD]-20NN-1NNN`, a legacy export-blob digest prefix, `/Users/`, or a term from `.firewall-terms` |
| `about_shell` | the About page's one `<main>` is not exactly `<h1>About</h1>`, `#dictionary-slot`, `#about-body`-as-the-parse-of-`about/body.html`; or the two allowlist profiles disagree |

## The exemptions, stated exactly

* Role-exempt: `<pre data-role="lean-statement">`, `<pre data-role="log">`,
  `<pre data-role="report">`, and `<code>` inside a carved-out author region.
  A `pre` with any other role is `unknown_role`; an ordinary `<code>` is
  linted like any other element.
* Carved-out regions: `[data-region="author"]` and `#about-body`. Exempt from
  the catalogue rule and the four-word rule; subject to the banned-token scan,
  the firewall scan, the allowlist profile (`note` for `[data-note-body]`,
  `about` for `#about-body`) and the coverage bookkeeping.
* Shape-exempt: `lean-statement` and `citation`, and nothing else. The
  `lean-statement` shape and the `lean-statement` role are bound to each other
  in both directions (SPEC §8.3, §8.6): the role is what lets the element's text
  skip the catalogue rule and the shape is what lets it skip the four-word and
  vocabulary rules, so either one alone is a region of unchecked text and is
  `unknown_role`.
* Attribute scope: `placeholder`, `title`, `aria-label`, `aria-description`,
  `alt`. `href`, `class`, `id` and every `data-*` are out of scope by name.
* A value may be carried inside exactly three attributes (DESIGN §6): `alt`,
  `data-citation-text`, `data-citation-bibtex`. A `data-attr-value` naming any
  other attribute is `attribute`.
* `[aria-hidden="true"]` (the DAG's SVG layer) may restate a string the same
  document already carries as a catalogue entry or as a non-statement,
  non-citation value, and may render nothing else.

## Snapshot input

`--dom` reads every `*.html` under the directory, each file the
`document.documentElement.outerHTML` of one captured surface, at any nesting.
The capture is `make dom-snapshots`; the committed set is
`test/e2e/dom-snapshots/`, which is why the release gate needs no cluster and
no credential. Coverage of the enumerated surface set is what `dead_label`
decides here: a surface that was never captured shows up as its labels going
dead.

## Tests

`npm test` (also `make test-tools`). The suite runs the real catalogue, field
table, reason table, allowlist and `about/body.html` through their own rules,
a clean generated-tree fixture, and one fixture per violation kind.
