# Sugarcoat Lite

<!-- impeccable:product-schema 1 -->

## Platform

web

## Product Purpose

Hold to record speech, release to clean the transcript, and automatically hear the final text. The current output remains available for local replay, seeking, and volume adjustment.

## Users

The user prioritizes recording, the cleaned transcript, and replay. No additional audience or usage context is assumed.

## Operating Context

A single Node.js server serves vanilla HTML, CSS, and JavaScript. There is no framework, build step, database, account system, or recording history. Localhost or HTTPS and a modern browser are required for microphone capture.

## Capabilities and Constraints

- Preserve the existing API contracts and provider configuration. Live processing uses Groq, Google, and Twinly; mock mode produces an example transcript and a test tone.
- Hold the recording button or focus it and hold Space. Release to process. Cancel / Stop and Escape cancel processing or stop playback.
- Preserve microphone permission handling, timeouts, cancellation, errors, optional VAD, autoplay recovery, native audio controls, and latency measurements.
- The transcript is read-only. There is no approval, editing, download, history, or voice-selection workflow.
- Only the current generated clip is kept in the browser. Starting another recording replaces it. Source audio is processed in memory.

## Brand Commitments

Retain the Sugarcoat Lite name and meaningful existing content. The user requests a dark, technical aesthetic inspired by Vercel: near-black surfaces, restrained typography, fine borders, high-contrast actions, and one unified ruled workspace. No decorative gradients, glass effects, excessive shadows, or unnecessary motion.

## Product Principles

- Recording, transcript, and replay form the primary workflow.
- Keep the recording action obvious and related content together.
- Expose errors with recovery instructions and retain keyboard access.
- Present actual provider and application states without invented capabilities or measurements.

## Accessibility & Inclusion

Visible keyboard focus, reduced-motion support, responsive layouts, usable 200% zoom, text contrast of at least 4.5:1, and control/focus contrast of at least 3:1 are explicit requirements.

## Evidence on Hand

The existing implementation, README, and automated tests document the supported workflow and limits. The user's design brief supplies the visual constraints and palette.
