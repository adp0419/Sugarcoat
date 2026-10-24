# VoiceFlow

VoiceFlow lets someone record natural speech, review a clearer version, then explicitly approve playback in their own cloned voice. It is an optional assist for presenters, students, non-native speakers, and people with disfluencies.

The core workflow is Speak → Review → Hear it. Recordings last up to 45 seconds. Live drafts are provisional; the review exposes the original transcript, word-level edits, reasons, and a meaning check. The text remains editable. Nothing is spoken before approval. Generated playback is labeled synthetic. Errors and service limitations must include clear recovery options.

The frontend is static HTML, CSS, and vanilla JavaScript, served by FastAPI. Keep existing API contracts and keyboard controls. English is the supported language. Demo data is explicitly labeled. Do not add unsupported upload, history, account, or voice-selection controls.

The user requested a dark, technical frontend inspired by Vercel's website and design language: near-black surfaces, fine rules, restrained type, and high-contrast primary actions. Product operation takes priority over decorative effects.
