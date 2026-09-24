//! The Rust binding of `shared/reasons.v1.json`. One file is the source of
//! truth for every language; `reason_taxonomy_agreement` asserts the sets agree.

use std::collections::BTreeMap;
use std::sync::OnceLock;

#[derive(Debug, Clone, serde::Deserialize)]
pub struct Reason {
    pub code: String,
    pub stage: String,
    pub terminal_state: Option<String>,
    pub retryable: bool,
    pub producer: Option<String>,
    pub params: Vec<String>,
    pub message_template: String,
}

#[derive(Debug, Clone, serde::Deserialize)]
pub struct Reasons {
    pub version: u32,
    pub stages: Vec<String>,
    pub precedence: Vec<String>,
    pub reasons: Vec<Reason>,
}

pub fn table() -> &'static Reasons {
    static R: OnceLock<Reasons> = OnceLock::new();
    R.get_or_init(|| {
        serde_json::from_str(include_str!("../../../../../shared/reasons.v1.json"))
            .expect("reasons.v1.json")
    })
}

pub fn reason(code: &str) -> Option<&'static Reason> {
    table().reasons.iter().find(|r| r.code == code)
}

pub fn codes() -> Vec<&'static str> {
    table().reasons.iter().map(|r| r.code.as_str()).collect()
}

/// Render a deterministic reason. Reason messages are error messages and are the
/// one class of visible string outside the label catalogue.
pub fn message(code: &str, params: &serde_json::Map<String, serde_json::Value>) -> String {
    let Some(r) = reason(code) else {
        return code.to_string();
    };
    let mut out = String::with_capacity(r.message_template.len());
    let mut rest = r.message_template.as_str();
    while let Some(i) = rest.find('{') {
        out.push_str(&rest[..i]);
        rest = &rest[i + 1..];
        match rest.find('}') {
            Some(j) => {
                let key = &rest[..j];
                let v = params
                    .get(key)
                    .map(render_param)
                    .unwrap_or_else(|| "—".to_string());
                out.push_str(&v);
                rest = &rest[j + 1..];
            }
            None => {
                out.push('{');
                break;
            }
        }
    }
    out.push_str(rest);
    out
}

fn render_param(v: &serde_json::Value) -> String {
    match v {
        serde_json::Value::String(s) => s.clone(),
        serde_json::Value::Null => "—".to_string(),
        other => other.to_string(),
    }
}

/// Precedence, fixed so the same input always yields the same code
/// (`infra > replay > axioms > statement > triviality > closure > assemble`).
pub fn worst<'a>(
    codes: &'a [(&'a str, serde_json::Map<String, serde_json::Value>)],
) -> Option<&'a (&'a str, serde_json::Map<String, serde_json::Value>)> {
    let order: BTreeMap<&str, usize> = table()
        .precedence
        .iter()
        .enumerate()
        .map(|(i, s)| (s.as_str(), i))
        .collect();
    codes.iter().min_by_key(|(c, _)| {
        reason(c)
            .and_then(|r| order.get(r.stage.as_str()).copied())
            .unwrap_or(usize::MAX)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_code_has_a_stage_a_producer_and_a_template() {
        for r in &table().reasons {
            assert!(
                table().stages.contains(&r.stage),
                "{} has stage {}",
                r.code,
                r.stage
            );
            assert!(!r.message_template.is_empty(), "{} has no template", r.code);
            if r.stage != "degraded" {
                assert!(r.producer.is_some(), "{} has no producer", r.code);
            }
        }
    }

    #[test]
    fn templates_obey_the_reason_lint() {
        let banned = [
            "this", "here", "we", "our", "you", "your", "welcome", "platform",
        ];
        for r in &table().reasons {
            let t = &r.message_template;
            assert!(t.len() <= 120, "{} template is {} chars", r.code, t.len());
            assert!(!t.ends_with('!'), "{} ends in an exclamation", r.code);
            let lower = t.to_lowercase();
            for w in banned {
                let bad = lower
                    .split(|c: char| !c.is_ascii_alphabetic())
                    .any(|tok| tok == w);
                assert!(!bad, "{} uses the banned token `{}`", r.code, w);
            }
            if !r.params.is_empty() {
                assert!(
                    r.params.iter().any(|p| t.contains(&format!("{{{p}}}"))),
                    "{} names no param",
                    r.code
                );
            }
        }
    }

    #[test]
    fn precedence_picks_the_kernel_leg_over_the_closure_leg() {
        let v = vec![
            ("CONSTANT_NOT_IN_DICTIONARY", serde_json::Map::new()),
            ("ILLEGAL_AXIOM", serde_json::Map::new()),
        ];
        assert_eq!(worst(&v).unwrap().0, "ILLEGAL_AXIOM");
    }

    #[test]
    fn a_message_renders_its_params() {
        let mut p = serde_json::Map::new();
        p.insert("axiom".into(), serde_json::Value::String("sorryAx".into()));
        assert!(message("ILLEGAL_AXIOM", &p).contains("sorryAx"));
        assert_eq!(
            message("REGISTRY_UNAVAILABLE", &serde_json::Map::new()),
            "The registry did not answer."
        );
    }
}
