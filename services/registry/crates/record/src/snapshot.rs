//! The generator's input: the immutable registry rows, the pin, the profile
//! identity rows and the one committed file the About page splices.
//!
//! Everything the tree can contain is read here, once, and validated here, so a
//! page renderer never has a missing row to decide about. `#record`'s bytes are
//! a pure function of (immutable rows, pin, generator version); the tree's one
//! further input class is the profile identity rows, which is why a rename
//! enqueues a regeneration (SPEC.md §10).

use crate::model::{Argument, Claim, Dictionary, EdgeRow, LeafRow, NodeRow, Person, Post, Profile};
use crate::{GenError, GenOpts};
use accession::Accession;
use serde::Deserialize;
use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;
use uuid::Uuid;

pub struct ArgumentView {
    pub argument: Argument,
    pub nodes: Vec<NodeRow>,
    pub edges: Vec<EdgeRow>,
    /// The definitions and cited results the argument rests on, by name.
    pub leaves: Vec<LeafRow>,
}

/// A login this record used to serve, and what it serves now.
#[derive(Debug, Clone, serde::Serialize, PartialEq, Eq, PartialOrd, Ord)]
pub struct Redirect {
    pub from: String,
    pub to: String,
    pub status: u16,
}

pub struct Snapshot {
    pub dictionary: Dictionary,
    pub profiles: Vec<Profile>,
    /// The people arguments cite who are not profiles here, by cited name.
    pub people: Vec<Person>,
    pub claims: Vec<Claim>,
    pub arguments: Vec<ArgumentView>,
    pub posts: Vec<Post>,
    pub blueprint_labels: BTreeMap<String, String>,
    pub redirects: Vec<Redirect>,
    /// The verbatim bytes of the git-tracked `about/body.html`, already scanned.
    pub about_body: String,
    pub site_base: String,
    /// Where each post's discussion page lives (`GenOpts::forum_base`).
    pub forum_base: Option<String>,
}

fn invalid(file: &str, pointer: String) -> GenError {
    GenError::RegistryInvalid {
        file: file.to_string(),
        pointer,
    }
}

impl Snapshot {
    /// Read the whole record from the committed bank: `dictionary.json`,
    /// `profiles.json`, `posts.json`, `claims/*.json` and `arguments/*.json`.
    pub fn from_dir(bank: &Path, opts: &GenOpts) -> Result<Snapshot, GenError> {
        #[derive(Deserialize)]
        struct DictionaryFile {
            #[serde(flatten)]
            dictionary: Dictionary,
            #[serde(default)]
            blueprint_labels: BTreeMap<String, String>,
        }
        #[derive(Deserialize)]
        struct ArgumentFile {
            argument: Argument,
            nodes: Vec<NodeRow>,
            edges: Vec<EdgeRow>,
            #[serde(default)]
            leaves: Vec<LeafRow>,
        }
        fn read<T: for<'de> Deserialize<'de>>(p: &Path) -> Result<T, GenError> {
            let bytes = std::fs::read(p)?;
            serde_json::from_slice(&bytes).map_err(|e| GenError::RegistryInvalid {
                file: p.display().to_string(),
                pointer: format!(" ({e})"),
            })
        }
        fn each(dir: &Path) -> Result<Vec<std::path::PathBuf>, GenError> {
            let mut v: Vec<_> = match std::fs::read_dir(dir) {
                Ok(rd) => rd
                    .filter_map(|e| e.ok().map(|e| e.path()))
                    .filter(|p| p.extension().is_some_and(|x| x == "json"))
                    .collect(),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => Vec::new(),
                Err(e) => return Err(e.into()),
            };
            v.sort();
            Ok(v)
        }

        let DictionaryFile {
            dictionary,
            blueprint_labels,
        } = read(&bank.join("dictionary.json"))?;
        let mut profiles: Vec<Profile> = read(&bank.join("profiles.json"))?;
        profiles.sort_by(|a, b| a.login.cmp(&b.login));
        // A bank that cites nobody has no people file.
        let people_path = bank.join("people.json");
        let mut people: Vec<Person> = if people_path.exists() {
            read(&people_path)?
        } else {
            Vec::new()
        };
        people.sort_by(|a, b| a.name.cmp(&b.name));

        let mut claims: Vec<Claim> = Vec::new();
        for p in each(&bank.join("claims"))? {
            claims.push(read(&p)?);
        }
        claims.sort_by(|a, b| a.accession.cmp(&b.accession));

        let mut arguments = Vec::new();
        for p in each(&bank.join("arguments"))? {
            let ArgumentFile {
                argument,
                mut nodes,
                mut edges,
                mut leaves,
            } = read(&p)?;
            nodes.sort_by(|x, y| x.topo.cmp(&y.topo).then(x.decl_name.cmp(&y.decl_name)));
            edges.sort_by(|x, y| (&x.used_by, &x.uses).cmp(&(&y.used_by, &y.uses)));
            leaves.sort_by(|x, y| x.decl_name.cmp(&y.decl_name));
            arguments.push(ArgumentView {
                argument,
                nodes,
                edges,
                leaves,
            });
        }
        arguments.sort_by(|a, b| a.argument.accession.cmp(&b.argument.accession));

        let mut posts: Vec<Post> = read(&bank.join("posts.json"))?;
        posts.sort_by_key(|p| std::cmp::Reverse(p.post_number));

        let about_body = crate::about::read_and_check(opts)?;

        let s = Snapshot {
            dictionary,
            profiles,
            people,
            claims,
            arguments,
            posts,
            blueprint_labels,
            redirects: Vec::new(),
            about_body,
            site_base: opts.site_base.clone(),
            forum_base: opts.forum_base.clone(),
        };
        s.validate()?;
        Ok(s)
    }

    /// Every cross-reference a page renders is resolved here, so a template
    /// never renders a hole and `RegistryInvalid` names the row rather than a
    /// panic naming a line of Rust.
    pub fn validate(&self) -> Result<(), GenError> {
        let logins: BTreeSet<Uuid> = self.profiles.iter().map(|p| p.id).collect();
        for c in &self.claims {
            let acc: Accession = c
                .accession
                .parse()
                .map_err(|_| invalid("claim", format!("/{}/accession", c.accession)))?;
            if acc.kind != accession::Kind::Claim {
                return Err(invalid("claim", format!("/{}/accession", c.accession)));
            }
            if !logins.contains(&c.profile_id) {
                return Err(invalid("claim", format!("/{}/profile_id", c.accession)));
            }
        }
        let claim_set: BTreeSet<&str> = self.claims.iter().map(|c| c.accession.as_str()).collect();
        for a in &self.arguments {
            let acc = &a.argument.accession;
            let parsed: Accession = acc
                .parse()
                .map_err(|_| invalid("argument", format!("/{acc}/accession")))?;
            if parsed.kind != accession::Kind::Argument {
                return Err(invalid("argument", format!("/{acc}/accession")));
            }
            if !claim_set.contains(a.argument.claim_accession.as_str()) {
                return Err(invalid("argument", format!("/{acc}/claim_accession")));
            }
            if !logins.contains(&a.argument.profile_id) {
                return Err(invalid("argument", format!("/{acc}/profile_id")));
            }
            if a.nodes.len() != a.argument.node_count as usize {
                return Err(invalid("argument", format!("/{acc}/node_count")));
            }
            if a.edges.len() != a.argument.edge_count as usize {
                return Err(invalid("argument", format!("/{acc}/edge_count")));
            }
            let roots: Vec<&NodeRow> = a.nodes.iter().filter(|n| n.is_root).collect();
            if roots.len() != 1 {
                return Err(invalid("argument_node", format!("/{acc}/is_root")));
            }
            if roots[0].decl_name != a.argument.root_decl_name {
                return Err(invalid("argument", format!("/{acc}/root_decl_name")));
            }
            let names: BTreeSet<&str> = a.nodes.iter().map(|n| n.decl_name.as_str()).collect();
            for e in &a.edges {
                if !names.contains(e.used_by.as_str()) {
                    return Err(invalid(
                        "argument_edge",
                        format!("/{acc}/{}/used_by", e.used_by),
                    ));
                }
                if !names.contains(e.uses.as_str()) {
                    return Err(invalid("argument_edge", format!("/{acc}/{}/uses", e.uses)));
                }
            }
        }
        let arg_set: BTreeSet<&str> = self
            .arguments
            .iter()
            .map(|a| a.argument.accession.as_str())
            .collect();
        for p in &self.posts {
            if !arg_set.contains(p.argument_accession.as_str()) {
                return Err(invalid(
                    "post",
                    format!("/{}/argument_accession", p.post_number),
                ));
            }
            if !claim_set.contains(p.claim_accession.as_str()) {
                return Err(invalid(
                    "post",
                    format!("/{}/claim_accession", p.post_number),
                ));
            }
        }
        Ok(())
    }

    pub fn pin_label(&self) -> String {
        format!("{} · {}", self.dictionary.label, self.dictionary.curation)
    }

    pub fn claim(&self, acc: &str) -> Option<&Claim> {
        self.claims.iter().find(|c| c.accession == acc)
    }

    pub fn argument(&self, acc: &str) -> Option<&ArgumentView> {
        self.arguments.iter().find(|a| a.argument.accession == acc)
    }

    /// The cited person a name refers to, when the bank records one.
    pub fn person(&self, name: &str) -> Option<&Person> {
        self.people.iter().find(|p| p.name == name)
    }

    pub fn profile(&self, id: Uuid) -> Option<&Profile> {
        self.profiles.iter().find(|p| p.id == id)
    }

    pub fn arguments_of(&self, claim: &str) -> Vec<&ArgumentView> {
        self.arguments
            .iter()
            .filter(|a| a.argument.claim_accession == claim)
            .collect()
    }

    /// The union of the axiom manifests of a claim's arguments. A claim with no
    /// argument has none, which is how `Arguments 0` renders its axiom column
    /// and why such a claim matches no axiom filter (SPEC.md §8.3).
    pub fn claim_axioms(&self, acc: &str) -> Vec<String> {
        let mut v: Vec<String> = self
            .arguments_of(acc)
            .iter()
            .flat_map(|a| a.argument.axioms_reached.clone())
            .collect();
        v.sort();
        v.dedup();
        v
    }

    /// The blueprint anchor of a curated definition, when the blueprint carries one.
    pub fn blueprint_anchor(&self, name: &str) -> Option<String> {
        self.blueprint_labels
            .get(name)
            .map(|l| format!("{}#{}", self.dictionary.blueprint_url, l))
    }

    /// The dictionary leaves of one argument, deduplicated across its nodes:
    /// `|⋃ᵥ dictionary_leaves(v)|` is the count the DAG renders.
    pub fn dictionary_leaves(&self, a: &ArgumentView) -> BTreeSet<String> {
        a.nodes
            .iter()
            .flat_map(|n| n.dictionary_leaves.iter().cloned())
            .collect()
    }
}
