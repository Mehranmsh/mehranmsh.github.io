# MEHRAN recorded instrument library

This directory is the self-hosted audio asset location for MEHRAN MUSIC STUDIO.

## Rules
- Audio is served from this repository/site only. The sampler rejects cross-origin sample URLs.
- A playable instrument must have actual recorded audio files listed in `manifest.json`.
- Do not add oscillator/algorithmic substitutes and label them as real instruments.
- Keep original source recordings, license/permission records, and edited WAV assets together in the project archive.
- Recommended sample format: WAV, mono or stereo, 24-bit PCM, 44.1 kHz or 48 kHz.
- Each sample entry uses `rootNote` (MIDI note), `url` (same-origin relative path), optional `velocityMin`/`velocityMax`, and optional `loopStart`/`loopEnd` in seconds for sustained instruments.

## Current status
The sampler runtime and manifest schema are installed, but no recorded instrument assets have been added yet. The app intentionally reports this as unavailable rather than silently substituting synthetic tones.

## Suggested capture coverage
Start with piano and steel-string guitar, then violin and the Persian instruments. Capture multiple pitches across the playable range and at least soft/medium/strong dynamics. Bowed instruments need clean sustained recordings and loop points; plucked and struck instruments need clean note attacks and natural decays.
