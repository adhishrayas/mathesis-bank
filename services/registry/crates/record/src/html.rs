//! The HTML builder every generated page is written through.
//!
//! Two rules are structural rather than reviewed: a visible string enters the
//! document either as a catalogue label or as a data value, and every data value
//! is recorded in document order as it is emitted, so the sibling `values.json`
//! cannot drift from the page (SPEC.md §8, R40).

use std::collections::BTreeMap;
use std::sync::OnceLock;

#[derive(serde::Deserialize)]
struct Catalogue {
    labels: BTreeMap<String, String>,
    values: Vec<String>,
}

fn catalogue() -> &'static Catalogue {
    static C: OnceLock<Catalogue> = OnceLock::new();
    C.get_or_init(|| serde_json::from_str(include_str!("../labels.json")).expect("labels.json"))
}

#[derive(serde::Deserialize)]
pub struct FieldDef {
    pub field: String,
    pub shape: String,
    pub source: String,
}

pub fn fields() -> &'static Vec<FieldDef> {
    static F: OnceLock<Vec<FieldDef>> = OnceLock::new();
    F.get_or_init(|| serde_json::from_str(include_str!("../fields.json")).expect("fields.json"))
}

/// A catalogue label, by its authored key. An unknown key is a build failure:
/// a visible string cannot reach a page without an entry.
pub fn label(key: &str) -> &'static str {
    catalogue()
        .labels
        .get(key)
        .map(String::as_str)
        .unwrap_or_else(|| panic!("no catalogue label `{key}`"))
}

pub fn label_keys() -> Vec<&'static str> {
    catalogue().labels.keys().map(String::as_str).collect()
}

pub fn catalogue_values() -> &'static [String] {
    &catalogue().values
}

pub fn escape(s: &str) -> String {
    let mut o = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '&' => o.push_str("&amp;"),
            '<' => o.push_str("&lt;"),
            '>' => o.push_str("&gt;"),
            '"' => o.push_str("&quot;"),
            '\'' => o.push_str("&#39;"),
            _ => o.push(c),
        }
    }
    o
}

pub struct B {
    pub s: String,
    pub values: Vec<(String, String)>,
}

impl B {
    pub fn new() -> B {
        B {
            s: String::with_capacity(8192),
            values: Vec::new(),
        }
    }

    pub fn raw(&mut self, s: &str) -> &mut B {
        self.s.push_str(s);
        self
    }

    pub fn text(&mut self, s: &str) -> &mut B {
        self.s.push_str(&escape(s));
        self
    }

    /// A catalogue label rendered as element text.
    pub fn lab(&mut self, tag: &str, class: &str, key: &str) -> &mut B {
        self.s.push('<');
        self.s.push_str(tag);
        if !class.is_empty() {
            self.s.push_str(&format!(" class=\"{class}\""));
        }
        self.s.push('>');
        self.s.push_str(&escape(label(key)));
        self.s.push_str(&format!("</{tag}>"));
        self
    }

    /// A data value. Recorded in document order for the sibling `values.json`.
    ///
    /// The field must be in the catalogue. This is an `assert!` and not a
    /// `debug_assert!` deliberately: `recordgen` runs as a release build in the
    /// distroless pod, and a value naming a field `prose-lint` does not know is
    /// a page the release gate rejects. Failing here names the field; failing in
    /// the linter names a byte offset in generated HTML.
    pub fn val(&mut self, tag: &str, field: &str, v: &str, extra: &str) -> &mut B {
        assert!(
            fields().iter().any(|f| f.field == field),
            "no catalogue field `{field}`"
        );
        self.values.push((field.to_string(), v.to_string()));
        self.s.push('<');
        self.s.push_str(tag);
        self.s.push_str(" data-value=\"true\" data-field=\"");
        self.s.push_str(field);
        self.s.push('"');
        if !extra.is_empty() {
            self.s.push(' ');
            self.s.push_str(extra);
        }
        self.s.push('>');
        self.s.push_str(&escape(v));
        self.s.push_str(&format!("</{tag}>"));
        self
    }

    /// A kernel-pretty-printed Lean statement: the platform's primary content.
    /// Monospace, `white-space: pre`, never rewrapped and never substituted.
    pub fn statement(&mut self, field: &str, pretty: &str, class: &str) -> &mut B {
        let def = fields()
            .iter()
            .find(|f| f.field == field)
            .unwrap_or_else(|| panic!("no catalogue field `{field}`"));
        // `lean-statement` is the one shape exempt from the four-word and
        // explanatory-vocabulary rules, and the exemption is granted by the
        // shape rather than by the tag, so a statement rendered under any other
        // field would be linted as ordinary prose (SPEC.md §8).
        assert_eq!(
            def.shape, "lean-statement",
            "field `{field}` is not of shape lean-statement"
        );
        self.values.push((field.to_string(), pretty.to_string()));
        let class = if class.is_empty() {
            String::new()
        } else {
            format!(" {class}")
        };
        self.s.push_str(&format!(
            "<pre class=\"mth-lean{class}\" data-role=\"lean-statement\" data-value=\"true\" data-field=\"{field}\">"
        ));
        self.s.push_str(&escape(pretty));
        self.s.push_str("</pre>");
        self
    }

    /// A docstring: the author's own words, rendered by `doc::render`. Its field
    /// must be of shape `docstring` — exempt from the prose rules because the
    /// words are the author's, attributed to them, not the platform's.
    pub fn doc(&mut self, field: &str, md: &str, class: &str) -> &mut B {
        let def = fields()
            .iter()
            .find(|f| f.field == field)
            .unwrap_or_else(|| panic!("no catalogue field `{field}`"));
        assert_eq!(
            def.shape, "docstring",
            "field `{field}` is not of shape docstring"
        );
        let (html, text) = crate::doc::render(md);
        self.values.push((field.to_string(), text));
        let class = if class.is_empty() {
            String::new()
        } else {
            format!(" {class}")
        };
        self.s.push_str(&format!(
            "<div class=\"mth-docstring{class}\" data-value=\"true\" data-field=\"{field}\">"
        ));
        self.s.push_str(&html);
        self.s.push_str("</div>");
        self
    }

    /// A `<dt>` label with a `<dd>` value: the shape every verification row has,
    /// so no compound string is ever a single label.
    pub fn row(&mut self, key: &str, field: &str, v: &str) -> &mut B {
        self.lab("dt", "", key);
        self.val("dd", field, v, "")
    }

    pub fn open(&mut self, tag: &str, attrs: &str) -> &mut B {
        self.s.push('<');
        self.s.push_str(tag);
        if !attrs.is_empty() {
            self.s.push(' ');
            self.s.push_str(attrs);
        }
        self.s.push('>');
        self
    }

    pub fn close(&mut self, tag: &str) -> &mut B {
        self.s.push_str(&format!("</{tag}>"));
        self
    }

    pub fn values_json(&self) -> String {
        let arr: Vec<serde_json::Value> = self
            .values
            .iter()
            .map(|(f, v)| serde_json::json!({ "field": f, "value": v }))
            .collect();
        serde_json::to_string_pretty(&arr).unwrap_or_default() + "\n"
    }
}

impl Default for B {
    fn default() -> Self {
        B::new()
    }
}

/// The null rendering. The single permitted em dash, allowed by name.
pub const EM_DASH: &str = "—";
