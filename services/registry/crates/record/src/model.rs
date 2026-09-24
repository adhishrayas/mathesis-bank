//! The record's row types: the shape the generator reads from `bank/` and renders.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Profile {
    pub id: Uuid,
    pub github_user_id: i64,
    pub login: String,
    pub citation_name: String,
    pub display_name: Option<String>,
    pub github_type: String,
    pub kind: Option<String>,
    pub is_owner: bool,
    pub created_at: DateTime<Utc>,
    /// The record-relative path of the profile's avatar, when the record holds one.
    #[serde(default)]
    pub avatar: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Dictionary {
    pub id: Uuid,
    pub label: String,
    pub toolchain: String,
    pub mathlib_rev: String,
    pub flt_rev: String,
    pub export_sha256: String,
    pub export_bytes: i64,
    pub export_constants: i32,
    pub base_names_sha256: String,
    pub module_roots: Vec<String>,
    pub blueprint_url: String,
    pub curation: String,
    pub max_source_bytes: i32,
    pub max_export_bytes: i64,
    pub adjudicate_image: String,
    pub builder_image: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Claim {
    pub accession: String,
    pub dictionary_id: Uuid,
    pub decl_name: String,
    pub module: String,
    pub pretty: String,
    pub statement_digest: String,
    pub reference_sha256: String,
    pub origin: String,
    pub profile_id: Uuid,
    pub created_at: DateTime<Utc>,
    pub citation_name: String,
    pub login: String,
    pub arguments_count: i32,
}

/// An argument has no statement of its own: `root_*` is the DAG's single root.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Argument {
    pub accession: String,
    pub claim_accession: String,
    pub submission_id: Uuid,
    pub profile_id: Uuid,
    pub dictionary_id: Uuid,
    pub export_sha256: String,
    pub export_bytes: i64,
    pub export_constants: i32,
    pub replay_detail: String,
    pub axioms_reached: Vec<String>,
    pub axiom_free: bool,
    pub statement_identity: String,
    pub substrate: String,
    pub libraries_used: Vec<String>,
    pub private_helpers: Vec<String>,
    pub root_decl_name: String,
    pub root_pretty: String,
    pub root_module: String,
    pub node_count: i32,
    pub edge_count: i32,
    pub created_at: DateTime<Utc>,
    pub citation_name: String,
    pub login: String,
    /// Authors of premises the argument cites but did not write.
    #[serde(default)]
    pub cites: Vec<String>,
    /// Source location of the root declaration, when public.
    #[serde(default)]
    pub source_url: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NodeRow {
    pub decl_name: String,
    pub kind: String,
    pub pretty: String,
    pub type_sha256: String,
    pub is_root: bool,
    pub citable: bool,
    pub depth: i32,
    pub topo: i32,
    pub dictionary_leaves: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EdgeRow {
    pub used_by: String,
    pub uses: String,
    pub via: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Post {
    pub post_number: i64,
    pub claim_accession: String,
    pub argument_accession: String,
    pub profile_id: Uuid,
    pub published_at: DateTime<Utc>,
}
