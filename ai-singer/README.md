# MEHRAN Self-Hosted Singing Engine

This directory contains the first backend foundation for MEHRAN's own singing-voice system. It is deliberately honest about the current capability boundary.

## Current status

- Job intake and structural validation: implemented.
- Standard MIDI format 0/1 parsing: implemented for PPQ timing, note events, and tempo maps.
- MIDI analysis endpoint: implemented; returns note names, pitch, beat positions, seconds, tempo map, and duration.
- Persian text normalization and word extraction: implemented.
- `POST /v1/lyrics/analyze`: returns normalized words, optional human-confirmed syllable splits, and conservative grapheme annotations.
- Words without pronunciation overrides are explicitly flagged for review; no guessed syllable boundaries are returned.
- Human-confirmed syllable overrides and conservative grapheme annotation: implemented.
- Unvowelled Persian remains flagged for manual review; automatic phoneme alignment is not claimed.
- Lyric-syllable to MIDI-note alignment: implemented as a conservative proposal or human-directed mapping, including melisma groups.
- Automatic Persian phoneme conversion and acoustic phoneme timing: **not implemented**.
- Singing inference / WAV generation: **not implemented**.
- No third-party generation API is called.
- No model weights or GPU deployment are included.

The API reports `generation_ready: false`. Successful validation or MIDI analysis is not a generated vocal.

## Run locally

Python 3.10+ is recommended.

```bash
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
uvicorn server:app --host 0.0.0.0 --port 8787
```

Open `/docs` for API documentation and `/health` for capability status.

## API

- `GET /health`: service and model readiness.
- `POST /v1/jobs/validate`: validates a `mehran.svs.job.v1` job; does not synthesize.
- `POST /v1/jobs/analyze`: parses an attached MIDI file and returns a tempo-aware note timeline; does not synthesize.
- `POST /v1/jobs/align`: aligns reviewed Persian syllables to either Standard MIDI or Piano Roll note events. Equal counts create a review-required proposal; mismatches are not guessed. Supply `manual_note_groups` for confirmed mappings and melisma.

Piano Roll timing currently assumes four subdivisions per beat and uses the project BPM. This convention is explicit so timing is not silently inferred from a variable grid.

## Browser deployment

A Dockerfile is provided for self-hosted deployment. Set `MEHRAN_SVS_ALLOWED_ORIGINS` to the exact HTTPS origin(s) serving the studio, separated by commas. CORS is not authentication; do not expose this early-stage analysis API to untrusted traffic without adding an access-control layer and request throttling. Set the platform's `PORT` variable when required.

## MIDI parser limits

Supports Standard MIDI File format 0 and 1, PPQ timing, channel note-on/note-off events, running status, and tempo meta-events. SMPTE division, format 2, and unsupported system-common events are rejected. Unmatched note-ons are not treated as completed notes. The parser caps output at 4096 note events.

## Next engineering milestones

1. Add deterministic Persian text normalization and tested syllable/phoneme segmentation.
2. Build and evaluate Persian phoneme timing and acoustic alignment on verified singing data.
3. Define the internal acoustic model interface and training-data manifest.
4. Train/evaluate a Persian-capable singing model.
5. Implement inference, vocal stem rendering, deterministic job tracking and audio quality tests.
6. Deploy on MEHRAN-controlled compute, then connect the studio UI.

Do not label this scaffold as an AI singer or use it to claim that a vocal WAV can already be generated.


### Browser connection and CORS
- Set `MEHRAN_SVS_ALLOWED_ORIGINS` to a comma-separated allowlist of exact HTTPS origins for the deployed studio. The default allows the GitHub Pages origin and the currently used Pi ecosystem origin.
- The API exposes only GET/POST/OPTIONS for browser access; credentials are not enabled.
- `POST /v1/jobs/align` accepts either an attached Standard MIDI file or Piano Roll note events. Piano Roll timing currently assumes four steps per beat and requires project tempo.
- Browser alignment is available only after this self-hosted API is deployed and its base URL is configured in the studio. No third-party vocal generation service is used.
