# MEHRAN Self-Hosted Singing Engine

This directory is the first backend foundation for MEHRAN's own singing-voice system. It is deliberately honest about the current capability boundary.

## Current status

- Job intake and structural validation: implemented.
- Persian lyrics are preserved as Unicode; this service does not claim to perform Persian phoneme alignment yet.
- MIDI payloads and native Piano Roll note events are validated as conditioning inputs.
- Audio generation / singing inference: **not implemented**.
- No third-party generation API is called.
- No model weights or GPU deployment are included.

The API reports `generation_ready: false` until a real MEHRAN model runtime is implemented and explicitly configured. A successful validation is not a generated vocal.

## Run locally

Python 3.10+ is recommended.

```bash
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
uvicorn server:app --host 127.0.0.1 --port 8787
```

Open `/docs` for the local API documentation and `/health` for capability status.

## API

- `GET /health`: reports service and model readiness separately.
- `POST /v1/jobs/validate`: validates a `mehran.svs.job.v1` job and returns a normalized, safe-to-queue summary. It does not synthesize audio.

The browser studio currently exports the job JSON. Connecting it to this service is a later deployment step and requires a reachable server controlled by MEHRAN.

## Next engineering milestones

1. Parse Standard MIDI Files into a canonical tempo-aware event timeline.
2. Build Persian text normalization, syllable segmentation and phoneme alignment with test fixtures and human-review hooks.
3. Define the internal acoustic model interface and training-data manifest.
4. Train/evaluate a Persian-capable singing model.
5. Implement inference, vocal stem rendering, deterministic job tracking and audio quality tests.
6. Deploy on MEHRAN-controlled compute, then connect the studio UI.

Do not label this scaffold as an AI singer or use it to claim that a vocal WAV can already be generated.
