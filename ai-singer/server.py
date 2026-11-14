"""MEHRAN SVS job intake and MIDI analysis API. No vocal synthesis is deployed."""
from __future__ import annotations

import base64
import os

from fastapi import FastAPI, HTTPException
from pydantic import ValidationError

from job_schema import SingingJob
from midi_parser import MidiParseError, parse_standard_midi\nfrom persian_lyrics import analyze_persian_lyrics

app = FastAPI(
    title="MEHRAN Self-Hosted Singing Engine",
    version="0.2.0",
    description="Private job validation and melody analysis. Singing inference is not deployed.",
)

MODEL_READY = os.getenv("MEHRAN_SVS_MODEL_READY", "false").lower() == "true"


@app.get("/health")
def health() -> dict:
    return {
        "service": "mehran-svs-intake",
        "service_ready": True,
        "generation_ready": False,
        "model_weights_present": MODEL_READY,
        "generation_implemented": False,
        "midi_analysis_available": True,\n        "persian_lyrics_analysis_available": True,
        "third_party_generation_api": False,
        "message": "Job intake and MIDI analysis are available; no singing audio can be generated yet.",
    }


def _validated_job(payload: dict) -> SingingJob:
    try:
        return SingingJob.model_validate(payload)
    except ValidationError as exc:
        raise HTTPException(status_code=422, detail=exc.errors(include_url=False)) from exc


@app.post("/v1/jobs/validate")
def validate_job(payload: dict) -> dict:
    job = _validated_job(payload)
    return {
        "valid": True,
        "accepted": False,
        "job_schema": job.schema,
        "project_id": job.project.id,
        "language": job.project.language,
        "lyrics_characters": len(job.project.lyrics),
        "melody_source": job.melody.source,
        "note_event_count": len(job.melody.noteEvents),
        "midi_bytes": job.melody.midi.size if job.melody.midi else 0,
        "requested_sample_rate": job.render.sampleRate,
        "generation_ready": False,
        "message": "Job structure validated only. No vocal was rendered or queued.",
    }


@app.post("/v1/lyrics/analyze")
def analyze_lyrics(payload: dict) -> dict:
    text_value = payload.get("text")
    if not isinstance(text_value, str) or not text_value.strip() or len(text_value) > 20000:
        raise HTTPException(status_code=422, detail="Provide non-empty Persian lyrics up to 20,000 characters.")
    overrides = payload.get("pronunciation_overrides", {})
    if not isinstance(overrides, dict) or len(overrides) > 500:
        raise HTTPException(status_code=422, detail="pronunciation_overrides must be an object with at most 500 entries.")
    if any(not isinstance(k, str) or not isinstance(v, str) for k, v in overrides.items()):
        raise HTTPException(status_code=422, detail="Every pronunciation override must map a word to a syllable-separated string.")
    return analyze_persian_lyrics(text_value, overrides)


@app.post("/v1/jobs/analyze")
def analyze_job(payload: dict) -> dict:
    job = _validated_job(payload)
    if not job.melody.midi:
        raise HTTPException(
            status_code=422,
            detail="MIDI analysis currently requires a MIDI file. Piano Roll timing analysis is a separate step.",
        )
    midi_bytes = base64.b64decode(job.melody.midi.data, validate=True)
    try:
        melody = parse_standard_midi(midi_bytes)
    except MidiParseError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    return {
        "analysis_version": "mehran.melody-analysis.v1",
        "project_id": job.project.id,
        "language": job.project.language,
        "lyrics": {
            "text": job.project.lyrics,
            "wordCount": len(job.project.lyrics.split()),
            "phonemeAlignment": "not_implemented",
        },
        "melody": melody,
        "alignment_ready": False,
        "generation_ready": False,
        "message": "MIDI notes and tempo timeline analyzed. Lyrics have not been aligned to phonemes and no vocal audio was generated.",
    }
