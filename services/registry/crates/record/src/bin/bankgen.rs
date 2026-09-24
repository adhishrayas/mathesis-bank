//! `bankgen --curation bank/curation.json --graphs DIR --verdicts DIR --out bank/`
//!
//! Assembles the bank manifests the generator renders, from three inputs:
//! the committed curation list; one solution graph per headline, exported from
//! the Lean environment (`bank/tools/ExportGraph.lean`); and one gate verdict per
//! headline, written by `mathesis-adjudicate` over that headline's frozen export
//! (`<decl>.verdict.json`, `<decl>.export.sha256`, `<decl>.export.bytes`).
//!
//! A post's argument is the headline's own theorems, reached from the headline
//! through theorems only. Definitions, and premises another author wrote, are
//! the leaves a node stands on; Mathlib is the substrate and appears nowhere.

use chrono::{DateTime, Utc};
use record::model::{Argument, Claim, EdgeRow, NodeRow, Post, Profile};
use serde::Deserialize;
use serde_json::json;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet, VecDeque};
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use uuid::Uuid;

#[derive(Deserialize)]
struct Curation {
    year: u32,
    published_at: DateTime<Utc>,
    profile: ProfileIn,
    dictionary: DictionaryIn,
    substrate: String,
    premise_authors: Vec<PremiseAuthor>,
    posts: Vec<PostIn>,
}

/// One curated post. The serial is explicit so an accession never moves when
/// the list is edited: a published DOI is permanent.
#[derive(Deserialize)]
struct PostIn {
    decl: String,
    serial: u32,
    /// Authors of premises outside the curated libraries the argument rests on.
    #[serde(default)]
    cites: Vec<String>,
}

#[derive(Deserialize)]
struct ProfileIn {
    login: String,
    citation_name: String,
    display_name: String,
    github_user_id: i64,
    github_type: String,
    kind: String,
}

#[derive(Deserialize)]
struct DictionaryIn {
    label: String,
    toolchain: String,
    mathlib_rev: String,
    source_rev: String,
    module_roots: Vec<String>,
    blueprint_url: String,
    curation: String,
}

#[derive(Deserialize)]
struct PremiseAuthor {
    author: String,
    modules: Vec<String>,
    decls: Vec<String>,
}

#[derive(Deserialize)]
struct Graph {
    root: String,
    root_module: String,
    axioms: Vec<String>,
    nodes: Vec<GNode>,
}

#[derive(Deserialize, Clone)]
struct GNode {
    decl: String,
    kind: String,
    private: bool,
    module: String,
    pretty: String,
    uses: Vec<String>,
}

#[derive(Deserialize)]
struct Verdict {
    constants: i64,
    replay: Replay,
    statement_identity: String,
    targets: Vec<Target>,
    verdict: String,
}

#[derive(Deserialize)]
struct Replay {
    accepted: bool,
    detail: String,
}

#[derive(Deserialize)]
struct Target {
    decl: String,
    axioms_reached: Vec<String>,
    triviality: Option<String>,
}

fn sha256_hex(s: &str) -> String {
    let mut h = Sha256::new();
    h.update(s.as_bytes());
    format!("{:x}", h.finalize())
}

fn read_json<T: for<'de> Deserialize<'de>>(p: &Path) -> Result<T, String> {
    let bytes = std::fs::read(p).map_err(|e| format!("{}: {e}", p.display()))?;
    serde_json::from_slice(&bytes).map_err(|e| format!("{}: {e}", p.display()))
}

fn write_json(p: &Path, v: &serde_json::Value) -> Result<(), String> {
    if let Some(d) = p.parent() {
        std::fs::create_dir_all(d).map_err(|e| e.to_string())?;
    }
    let mut s = serde_json::to_string_pretty(v).map_err(|e| e.to_string())?;
    s.push('\n');
    std::fs::write(p, s).map_err(|e| format!("{}: {e}", p.display()))
}

/// The argument DAG of one headline: its own theorems reached through theorems.
fn argument_dag(
    g: &Graph,
    premise_of: &dyn Fn(&GNode) -> Option<String>,
) -> (Vec<NodeRow>, Vec<EdgeRow>, BTreeSet<String>) {
    let by_name: BTreeMap<&str, &GNode> = g.nodes.iter().map(|n| (n.decl.as_str(), n)).collect();
    let is_node = |n: &GNode| n.kind == "theorem" && premise_of(n).is_none();
    let leaf_kind = |n: &GNode| {
        !matches!(
            n.kind.as_str(),
            "constructor" | "recursor" | "quot" | "axiom"
        )
    };

    // reachability from the root over theorem nodes only
    let mut keep: BTreeSet<&str> = BTreeSet::new();
    let mut queue: VecDeque<&str> = VecDeque::from([g.root.as_str()]);
    while let Some(n) = queue.pop_front() {
        if !keep.insert(n) {
            continue;
        }
        let Some(gn) = by_name.get(n) else { continue };
        for u in &gn.uses {
            if let Some(un) = by_name.get(u.as_str()) {
                if is_node(un) && !keep.contains(u.as_str()) {
                    queue.push_back(u.as_str());
                }
            }
        }
    }

    // edges between kept nodes, and each node's leaves
    let mut edges: Vec<EdgeRow> = Vec::new();
    let mut succ: BTreeMap<&str, Vec<&str>> = BTreeMap::new();
    let mut cites: BTreeSet<String> = BTreeSet::new();
    let mut leaves_of: BTreeMap<&str, Vec<String>> = BTreeMap::new();
    for &n in &keep {
        let gn = by_name[n];
        let mut leaves: BTreeSet<String> = BTreeSet::new();
        for u in &gn.uses {
            let Some(un) = by_name.get(u.as_str()) else {
                continue;
            };
            if keep.contains(u.as_str()) {
                edges.push(EdgeRow {
                    used_by: n.to_string(),
                    uses: u.clone(),
                    via: "direct".into(),
                });
                succ.entry(n).or_default().push(u.as_str());
            } else if leaf_kind(un) && (un.kind != "theorem" || premise_of(un).is_some()) {
                if let Some(author) = premise_of(un) {
                    cites.insert(author);
                }
                leaves.insert(u.clone());
            }
        }
        leaves_of.insert(n, leaves.into_iter().collect());
    }

    // depth = longest path from the root; topo = a deterministic topological index
    let mut depth: BTreeMap<&str, i32> = keep.iter().map(|&n| (n, 0)).collect();
    let mut order: Vec<&str> = Vec::new();
    let mut state: BTreeMap<&str, u8> = BTreeMap::new();
    fn visit<'a>(
        n: &'a str,
        succ: &BTreeMap<&'a str, Vec<&'a str>>,
        state: &mut BTreeMap<&'a str, u8>,
        out: &mut Vec<&'a str>,
    ) {
        if state.get(n).copied().unwrap_or(0) != 0 {
            return;
        }
        state.insert(n, 1);
        let mut next: Vec<&str> = succ.get(n).cloned().unwrap_or_default();
        next.sort();
        for m in next {
            visit(m, succ, state, out);
        }
        state.insert(n, 2);
        out.push(n);
    }
    visit(g.root.as_str(), &succ, &mut state, &mut order);
    order.reverse(); // root first, every user before what it uses
    for &n in &order {
        let d = depth[n];
        for &m in succ.get(n).map(|v| v.as_slice()).unwrap_or(&[]) {
            if depth[m] < d + 1 {
                depth.insert(m, d + 1);
            }
        }
    }
    let topo: BTreeMap<&str, i32> = order
        .iter()
        .enumerate()
        .map(|(i, &n)| (n, i as i32))
        .collect();

    let nodes: Vec<NodeRow> = order
        .iter()
        .map(|&n| {
            let gn = by_name[n];
            NodeRow {
                decl_name: n.to_string(),
                kind: gn.kind.clone(),
                pretty: gn.pretty.clone(),
                type_sha256: sha256_hex(&gn.pretty),
                is_root: n == g.root,
                citable: !gn.private,
                depth: depth[n],
                topo: topo[n],
                dictionary_leaves: leaves_of.get(n).cloned().unwrap_or_default(),
            }
        })
        .collect();
    edges.sort_by(|x, y| (&x.used_by, &x.uses).cmp(&(&y.used_by, &y.uses)));
    (nodes, edges, cites)
}

/// The committed avatar of a profile (`bank/avatars/<login>.<ext>`), as the
/// record-relative path the pages reference.
fn avatar_of(bank: &Path, login: &str) -> Option<String> {
    ["jpg", "png", "gif", "webp"]
        .iter()
        .map(|ext| format!("avatars/{login}.{ext}"))
        .find(|rel| bank.join(rel).is_file())
        .map(|rel| format!("/{rel}"))
}

fn run(curation: &Path, graphs: &Path, verdicts: &Path, out: &Path) -> Result<(), String> {
    let c: Curation = read_json(curation)?;
    let ns = Uuid::NAMESPACE_URL;
    let profile_id = Uuid::new_v5(
        &ns,
        format!("mathesis:profile:{}", c.profile.login).as_bytes(),
    );
    let dictionary_id = Uuid::new_v5(
        &ns,
        format!("mathesis:dictionary:{}", c.dictionary.label).as_bytes(),
    );

    let premise_of = |n: &GNode| -> Option<String> {
        c.premise_authors
            .iter()
            .find(|p| {
                p.modules.iter().any(|m| m == &n.module) || p.decls.iter().any(|d| d == &n.decl)
            })
            .map(|p| p.author.clone())
    };

    let profile = Profile {
        id: profile_id,
        github_user_id: c.profile.github_user_id,
        login: c.profile.login.clone(),
        citation_name: c.profile.citation_name.clone(),
        display_name: Some(c.profile.display_name.clone()),
        github_type: c.profile.github_type.clone(),
        kind: Some(c.profile.kind.clone()),
        is_owner: true,
        created_at: c.published_at,
        avatar: avatar_of(out, &c.profile.login),
    };
    write_json(&out.join("profiles.json"), &json!([profile]))?;

    let gate_bin = std::env::var("MATHESIS_ADJUDICATE_SHA256").unwrap_or_default();
    write_json(
        &out.join("dictionary.json"),
        &json!({
            "id": dictionary_id,
            "label": c.dictionary.label,
            "toolchain": c.dictionary.toolchain,
            "mathlib_rev": c.dictionary.mathlib_rev,
            "flt_rev": c.dictionary.source_rev,
            "export_sha256": "",
            "export_bytes": 0,
            "export_constants": 0,
            "base_names_sha256": "",
            "module_roots": c.dictionary.module_roots,
            "blueprint_url": c.dictionary.blueprint_url,
            "curation": c.dictionary.curation,
            "max_source_bytes": 0,
            "max_export_bytes": 0,
            "adjudicate_image": format!("mathesis-adjudicate@{}", &gate_bin[..gate_bin.len().min(12)]),
            "builder_image": "lean4export v3.1.0",
            "blueprint_labels": {},
        }),
    )?;

    let total = c.posts.len() as i64;
    let mut posts: Vec<Post> = Vec::new();
    let mut seen_serials = BTreeSet::new();
    for (i, post) in c.posts.iter().enumerate() {
        let decl = &post.decl;
        let serial = post.serial;
        if !seen_serials.insert(serial) {
            return Err(format!("{decl}: serial {serial} is used twice"));
        }
        let claim_acc = format!("MTH.C-{}-{serial:04}", c.year);
        let arg_acc = format!("MTH.R-{}-{serial:04}", c.year);
        let g: Graph = read_json(&graphs.join(format!("{decl}.json")))?;
        let v: Verdict = read_json(&verdicts.join(format!("{decl}.verdict.json")))?;
        let t = v
            .targets
            .iter()
            .find(|t| &t.decl == decl)
            .ok_or(format!("{decl}: verdict names no such target"))?;
        if v.verdict != "ADMITTED" || !v.replay.accepted || t.triviality.is_some() {
            return Err(format!("{decl}: the gate did not admit it ({})", v.verdict));
        }
        let sha = std::fs::read_to_string(verdicts.join(format!("{decl}.export.sha256")))
            .map_err(|e| format!("{decl}.export.sha256: {e}"))?
            .trim()
            .to_string();
        let bytes: i64 = std::fs::read_to_string(verdicts.join(format!("{decl}.export.bytes")))
            .map_err(|e| format!("{decl}.export.bytes: {e}"))?
            .trim()
            .parse()
            .map_err(|e| format!("{decl}.export.bytes: {e}"))?;
        let mut axioms = t.axioms_reached.clone();
        axioms.sort();
        let mut kernel_axioms = g.axioms.clone();
        kernel_axioms.sort();
        if axioms != kernel_axioms {
            return Err(format!(
                "{decl}: gate axioms {axioms:?} differ from the environment's {kernel_axioms:?}"
            ));
        }

        let (nodes, edges, mut cites) = argument_dag(&g, &premise_of);
        cites.extend(post.cites.iter().cloned());
        let root = nodes
            .iter()
            .find(|n| n.is_root)
            .ok_or(format!("{decl}: no root"))?;
        let mut libraries: BTreeSet<String> = BTreeSet::new();
        for n in &g.nodes {
            if premise_of(n).is_none() {
                libraries.insert(n.module.split('.').next().unwrap_or("").to_string());
            }
        }

        let claim = Claim {
            accession: claim_acc.clone(),
            dictionary_id,
            decl_name: decl.clone(),
            module: g.root_module.clone(),
            pretty: root.pretty.clone(),
            statement_digest: root.type_sha256.clone(),
            reference_sha256: sha.clone(),
            origin: "curated".into(),
            profile_id,
            created_at: c.published_at,
            citation_name: c.profile.citation_name.clone(),
            login: c.profile.login.clone(),
            arguments_count: 1,
        };
        let argument = Argument {
            accession: arg_acc.clone(),
            claim_accession: claim_acc.clone(),
            submission_id: Uuid::new_v5(&ns, format!("mathesis:submission:{arg_acc}").as_bytes()),
            profile_id,
            dictionary_id,
            export_sha256: sha,
            export_bytes: bytes,
            export_constants: v.constants as i32,
            replay_detail: v.replay.detail.clone(),
            axioms_reached: axioms.clone(),
            axiom_free: axioms.is_empty(),
            statement_identity: v.statement_identity.clone(),
            substrate: c.substrate.clone(),
            libraries_used: libraries.into_iter().collect(),
            private_helpers: nodes
                .iter()
                .filter(|n| !n.citable)
                .map(|n| n.decl_name.clone())
                .collect(),
            root_decl_name: decl.clone(),
            root_pretty: root.pretty.clone(),
            root_module: g.root_module.clone(),
            node_count: nodes.len() as i32,
            edge_count: edges.len() as i32,
            created_at: c.published_at,
            citation_name: c.profile.citation_name.clone(),
            login: c.profile.login.clone(),
            cites: cites.into_iter().collect(),
            source_url: None,
        };
        write_json(
            &out.join("claims").join(format!("{claim_acc}.json")),
            &json!(claim),
        )?;
        write_json(
            &out.join("arguments").join(format!("{arg_acc}.json")),
            &json!({ "argument": argument, "nodes": nodes, "edges": edges }),
        )?;
        posts.push(Post {
            post_number: total - i as i64,
            claim_accession: claim_acc,
            argument_accession: arg_acc,
            profile_id,
            published_at: c.published_at,
        });
        println!(
            "bankgen: {decl}: {} nodes, {} edges",
            argument.node_count, argument.edge_count
        );
    }
    write_json(&out.join("posts.json"), &json!(posts))?;
    Ok(())
}

fn main() -> ExitCode {
    let mut a: BTreeMap<String, PathBuf> = BTreeMap::new();
    let mut args = std::env::args().skip(1);
    while let Some(k) = args.next() {
        match args.next() {
            Some(v) => {
                a.insert(k, v.into());
            }
            None => {
                eprintln!("bankgen: {k} needs a value");
                return ExitCode::from(2);
            }
        }
    }
    let get = |k: &str| a.get(k).cloned();
    let (Some(c), Some(g), Some(v), Some(o)) = (
        get("--curation"),
        get("--graphs"),
        get("--verdicts"),
        get("--out"),
    ) else {
        eprintln!("usage: bankgen --curation FILE --graphs DIR --verdicts DIR --out DIR");
        return ExitCode::from(2);
    };
    match run(&c, &g, &v, &o) {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("bankgen: {e}");
            ExitCode::from(1)
        }
    }
}
