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
