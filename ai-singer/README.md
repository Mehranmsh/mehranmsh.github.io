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

A Dockerfile is provided for self-hosted deployment. Set `MEHRAN_SVS_ALLOWED_ORIGINS` to the exact HTTPS origin(s) serving the studio, separated by commas. CORS is not authentication. The API enforces an 8 MiB request Content-Length ceiling, no-store/security headers, and in-memory per-process rate limits (10 alignment, 20 MIDI analysis, 30 validation/lyrics requests per IP per minute). These limits are best-effort and reset on restart; production multi-instance deployments still need edge-level rate limiting and an access-control strategy appropriate for public users. Set the platform's `PORT` variable when required.

## MIDI parser limits

Supports Standard MIDI File format 0 and 1, PPQ timing, channel note-on/note-off events, running status, and tempo meta-events. SMPTE division, format 2, and unsupported system-common events are rejected. Unmatched note-ons are not treated as completed notes. The parser caps output at 4096 note events.

## Acoustic model artifact gate

The API inspects an optional local `models/model-manifest.json` (or the directory set by `MEHRAN_SVS_MODEL_DIR`). The manifest schema is `mehran.svs.model.v1` and declares model identity, architecture, framework, task, sample rate, supported languages, checkpoint path, and SHA-256. The service rejects unsafe paths, unsupported metadata, missing files, and hash mismatches. Checkpoints are streamed through SHA-256 in bounded chunks and are never deserialized.

A verified checkpoint is only an integrity-checked file. The API intentionally reports `model_loaded: false` and `inference_ready: false` until a reviewed architecture-specific loader, inference implementation, and audio-quality tests exist. Do not set an environment flag to pretend a model is ready.

Example manifest (replace the digest and checkpoint only with a real, reviewed artifact):

```json
{
  "schema_version": "mehran.svs.model.v1",
  "model_id": "mehran-persian-svs-001",
  "architecture": "mehran-acoustic-v1",
  "framework": "pytorch",
  "checkpoint": "weights/model.bin",
  "sha256": "REPLACE_WITH_64_CHARACTER_SHA256",
  "sample_rate": 48000,
  "languages": ["fa"],
  "task": "singing_voice_synthesis"
}
```

## Next engineering milestones

1. Add deterministic Persian text normalization and tested syllable/phoneme segmentation.
2. Build and evaluate Persian phoneme timing and acoustic alignment on verified singing data.
3. Define the internal acoustic model interface and training-data manifest.
4. Train/evaluate a Persian-capable singing model.
5. Implement inference, vocal stem rendering, deterministic job tracking and audio quality tests.
6. Deploy on MEHRAN-controlled compute, then connect the studio UI.

Do not label this scaffold as an AI singer or use it to claim that a vocal WAV can already be generated.



## Training dataset manifest gate

Before collecting or training on singing recordings, validate a JSONL manifest with:

```bash
python dataset_manifest.py /path/to/manifest.jsonl --audio-root /path/to/dataset
```

Each JSONL record declares `recording_id`, a relative `audio_path`, `language`, pseudonymous `speaker_id`, `split` (`train`, `validation`, or `test`), transcript, WAV format metadata, duration, `consent_confirmed: true`, a non-empty `rights_basis`, and `alignment_status`. Reviewed phoneme timing must include ordered, non-overlapping spans within the recording. The validator checks real PCM WAV headers, prevents path traversal, rejects duplicate recording IDs, and prevents the same speaker appearing across different splits to reduce identity leakage. It does not upload audio, collect consent, verify a legal claim, or start training. A human must retain the underlying consent and rights records securely.

No training recordings or model weights are included in this repository. Do not add private voice recordings, consent forms, access tokens, or other personal data to Git.

### Browser connection and CORS
- Set `MEHRAN_SVS_ALLOWED_ORIGINS` to a comma-separated allowlist of exact HTTPS origins for the deployed studio. The default allows the GitHub Pages origin and the currently used Pi ecosystem origin.
- The API exposes only GET/POST/OPTIONS for browser access; credentials are not enabled.
- `POST /v1/jobs/align` accepts either an attached Standard MIDI file or Piano Roll note events. Piano Roll timing currently assumes four steps per beat and requires project tempo.
- Browser alignment is available only after this self-hosted API is deployed and its base URL is configured in the studio. No third-party vocal generation service is used.
