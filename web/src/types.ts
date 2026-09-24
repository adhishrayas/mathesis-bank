// The record shapes the client reads.
//
// One shape is shared by three producers, so the client never has two decoders
// for the same object: the v3 manifest written beside every landing page
// (`a/<accession>/index.json`), the rows of the generated stream pages
// (`posts-NNNN.json`, `posts/by-profile/<login>.json`) and the body of
// `GET /api/v1/posts/{accession}`. The React post renderer takes exactly this,
// and `renderer_parity` (SPEC.md §13) compares its output with the Rust
// generator's `#record` for the same object.

export type NodeKind =
  | "theorem"
  | "definition"
  | "axiom"
  | "opaque"
  | "inductive"
  | "constructor"
  | "recursor"
  | "quot";

export interface DagNode {
  decl_name: string;
  kind: NodeKind;
  pretty: string;
  type_sha256: string;
  is_root: boolean;
  citable: boolean;
  depth: number;
  topo: number;
  dictionary_leaves: string[];
}

export interface DagEdge {
  used_by: string;
  uses: string;
  via: "type" | "value" | "both";
}

export interface ClaimRecord {
  accession: string;
  decl_name: string;
  module: string;
  pretty: string;
  statement_digest: string;
  arguments_count: number;
  is_open: boolean;
  first_verified: string;
  attribution: Attribution;
}

export interface Attribution {
  citation_name: string;
  profile_id: string;
}

export interface Verification {
  replay: string;
  axioms_reached: string[];
  axiom_free: boolean;
  statement_identity: string;
  substrate: string;
  export_sha256: string;
  export_bytes: number;
  export_constants: number;
}

export interface Citation {
  text: string;
  bibtex: string;
}

export interface DictionaryPin {
  label: string;
  curation: string;
  blueprint_url: string;
  toolchain?: string;
  export_sha256?: string;
}

export interface ArgumentRecord {
  accession: string;
  claim: string;
  root_decl_name: string;
  root_module: string;
  statement: { decl_names: string[]; pretty: string; type_sha256: string };
  verification: Verification;
  dag: { node_count: number; edge_count: number; nodes: DagNode[]; edges: DagEdge[] };
  attribution: Attribution;
  libraries_used: string[];
  created: string;
}

/** One post: the claim it establishes, the argument that establishes it, the
 * pin the record was verified against and the two baked citation strings. */
export interface PostRecord {
  post_number: number;
  published_at: string;
  claim: ClaimRecord;
  argument: ArgumentRecord;
  dictionary: DictionaryPin;
  citation: Citation;
  /** Curated entry name → blueprint anchor, baked at generation time so the
   * client never reads `dictionary.index.json` (SPEC.md §10). */
  blueprint_anchors: Record<string, string>;
}

export interface PostPage {
  rows: PostRecord[];
  next_page: string | null;
}

export interface SearchRow {
  bank: "claims" | "arguments";
  accession: string;
  claim_accession: string | null;
  decl_name: string;
  pretty: string;
  module: string;
  libraries: string[];
  author: string;
  author_login: string;
  axioms: string[];
  axiom_free: boolean;
  arguments: number;
  nodes: number;
  constants: number;
  created_at: string;
}

export interface Facet {
  parameter: string;
  value: string;
}

export interface SearchPage {
  bank: "claims" | "arguments";
  page?: number;
  rows: SearchRow[];
  total: number;
  next_cursor: string | null;
}

export interface InvalidFilter {
  code: string;
  parameter: string;
  bank: string;
  message: string;
}

export interface Me {
  id: string;
  login: string;
  citation_name: string;
  kind: "person" | "agent" | null;
}

export interface Note {
  accession: string;
  revision: number;
  body_md: string;
  body_html: string;
  updated_at: string;
  owner_profile_id: string;
}

export interface SiteInfo {
  generated_from: string;
  dictionary_pin: string;
  doi_prefix: string;
  counts: { claims: number; arguments: number; posts: number; profiles: number };
}

export interface ProfileRow {
  login: string;
  citation_name: string;
}

export interface SubmissionCreated {
  submission_id: string;
  verification_id: string;
  verification_key: string;
  state: VerificationState;
  idempotent_replay: boolean;
  events_url: string;
}

export const VERIFICATION_STATES = [
  "received",
  "queued",
  "building",
  "exporting",
  "adjudicating",
  "assembling",
  "admitted",
  "rejected",
  "failed",
] as const;

export type VerificationState = (typeof VERIFICATION_STATES)[number];

export interface VerificationEvent {
  state: VerificationState;
  verdict?: "ADMITTED" | "REJECTED" | null;
  stage?: string | null;
  reason_code?: string | null;
  reason_params?: Record<string, unknown> | null;
  claim_accession?: string | null;
  argument_accession?: string | null;
  post_url?: string | null;
}

export interface ReasonBody {
  stage: string;
  reason_code: string;
  reason_params: Record<string, unknown>;
}

export interface ClaimInfo {
  accession: string;
  decl_name: string;
  required_decl_name: string;
  statement_digest: string;
  pretty: string;
  module: string;
  arguments_count: number;
  is_open: boolean;
}
