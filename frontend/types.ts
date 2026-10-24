// Mirror of backend/models.py (docs/md/10-api-contract.md). Documentation only:
// the browser runs app.js directly, no build step. Change both together.

export type Mode = "auto" | "minimal" | "natural" | "presenter";
export type Rung = "full" | "retry" | "minimal" | "original";
export type StageName = "convert" | "asr" | "decide" | "rewrite" | "guard";
export type StageStatus = "start" | "done" | "error" | "fallback";

export interface StageEvent { stage: StageName; status: StageStatus; ms?: number; preview?: string }

export interface Decisions {
  predicates: Record<string, number>;
  register: string;
  recommended_mode: Mode;
  per_sentence: unknown[];
}

export interface Edit { from: string; to: string; reason: string }

export interface Violation {
  rule: string;
  original_span?: string;
  rewrite_span?: string;
  message: string;
}

export interface Guard {
  pass: boolean;
  violations: Violation[];
  decisions_probs: Record<string, number>;
  verifier: "online" | "offline";
}

export interface TraceEntry {
  stage: string; ok: boolean; ms: number; model?: string; preview?: string; error?: string;
}

export interface Job {
  id: string;
  status: "running" | "ready" | "failed";
  mode_used: Mode;
  rung: Rung;
  verbatim: string;
  sentences: string[];
  decisions: Decisions;
  rewrite: string;
  edits: Edit[];
  guard: Guard;
  trace: TraceEntry[];
  timings: { total_ms: number };
  notes?: string[]; // e.g. "Self-corrections fixed by rules (AI editor unavailable)"
  protected_terms?: string[];
  error?: { code: string; message: string; hint: string } | null;
  fast?: boolean;          // stage-mode fast path (POST /api/process fast=1)
  session?: string | null; // stage mode: echoed from POST /api/process
  segment?: number | null;
}

// Accounts (AUTH_ENABLED=1 only; docs/md/10 "Accounts"). GET/PUT /api/me/voice; PUT body {twinly_key, label?}.
export interface MeVoice { has_key: boolean; label: string; online: boolean; voice_ready: boolean }

// Stage mode (docs/md/10). POST /api/process also takes fast=1, session, segment.
export interface ProcessAccepted { job_id: string; session: string | null; segment: number | null }
export interface SessionJob {
  job_id: string; segment: number | null; status: "running" | "ready" | "failed"; rung: Rung;
  rewrite: string; guard_pass: boolean | null; total_ms: number;
}
export interface SessionResult { session: string; jobs: SessionJob[] }
export type SpeakState = "queued" | "rendering" | "done" | "failed";
export interface SpeakAccepted { speak_id: string; queue_position: number; status: SpeakState }
export interface SpeakStatus {
  speak_id: string; job_id: string; status: SpeakState;
  chunks: SpeakChunk[]; // grows in order; on "failed" the listed chunks still play
  total_chunks: number; queue_position: number;
  error: { code: string; message: string; hint: string } | null; ms: number; synthetic: true;
  // ms from enqueue. null until that moment (still queued / not rendered yet).
  render_started_ms: number | null;
  first_chunk_ms: number | null; // first chunk playable
}

// POST /api/stage/segment (multipart: audio, session, segment, protected_terms?, consent=1).
// Synchronous. speak_id is set only when the guard passes and consent=1; otherwise null.
// held=true means the guard failed and nothing was queued; POST /api/speak/async to speak it.
export interface StageSegmentResponse {
  job_id: string;
  session: string;
  segment: number;
  verbatim: string;
  rewrite: string;
  guard: { pass: boolean; violations: Violation[] };
  speak_id: string | null;
  held: boolean;
  timings: { convert_ms: number; asr_ms: number; rewrite_ms: number; guard_ms: number; total_ms: number };
}

// POST /api/live (multipart: audio = cumulative recording so far, seq). 429 {error:{code:"busy"}} = skip this tick.
export interface LiveResult { seq: number; text: string; ms: number; final: false }

export interface SpeakChunk { url: string; seconds: number; cached: boolean }
export interface SpeakResult { chunks: SpeakChunk[]; total_seconds: number; ms: number }

export interface ApiError { error: { code: string; message: string; hint: string } }

export interface Health {
  asr_loaded: boolean;
  decisions: "ok" | "off" | "error" | "no_credits" | "auth_error";
  gemma: "ok" | "error" | "no_credits" | "auth_error";
  twinly: { online: boolean; voice_ready: boolean };
  mock: boolean;
}
