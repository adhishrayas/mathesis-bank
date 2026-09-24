//! The canonical serializer. Every JSON file in the tree goes through it, so
//! two runs over an unchanged registry produce byte-identical bytes (SPEC.md
//! §10): keys sorted lexicographically, two-space indent, LF, trailing newline.
//!
//! Sorting is a property of `serde_json::Map`, which is a `BTreeMap` unless the
//! `preserve_order` feature is on; serializing through `Value` therefore sorts
//! a struct's fields as well as a map's keys, which serializing the struct
//! directly would not.

use serde::Serialize;

pub fn canonical<T: Serialize>(v: &T) -> Result<String, serde_json::Error> {
    let value: serde_json::Value = serde_json::to_value(v)?;
    Ok(serde_json::to_string_pretty(&value)? + "\n")
}

/// One JSON Lines record, canonical in the same sense: sorted keys, no indent,
/// one LF. A `.jsonl` file is the concatenation of these.
pub fn canonical_line<T: Serialize>(v: &T) -> Result<String, serde_json::Error> {
    let value: serde_json::Value = serde_json::to_value(v)?;
    Ok(serde_json::to_string(&value)? + "\n")
}

/// RFC 3339 UTC at second precision, from a stored value. No clock is read
/// anywhere in this crate; a timestamp on a page is always a column.
pub fn ts(t: &chrono::DateTime<chrono::Utc>) -> String {
    t.to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(serde::Serialize)]
    struct Unsorted {
        zeta: u8,
        alpha: u8,
    }

    #[test]
    fn struct_fields_are_sorted_not_declaration_ordered() {
        assert_eq!(
            canonical(&Unsorted { zeta: 1, alpha: 2 }).unwrap(),
            "{\n  \"alpha\": 2,\n  \"zeta\": 1\n}\n"
        );
    }

    #[test]
    fn timestamps_are_second_precision_utc() {
        let t: chrono::DateTime<chrono::Utc> = "2026-09-23T10:11:12.987654Z".parse().unwrap();
        assert_eq!(ts(&t), "2026-09-23T10:11:12Z");
    }
}
