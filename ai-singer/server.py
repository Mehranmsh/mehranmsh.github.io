"""MEHRAN SVS job intake and MIDI analysis API. No vocal synthesis is deployed."""
from __future__ import annotations

import base64
import os

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import ValidationError

from job_schema import SingingJob
from midi_parser import MidiParseError, parse_standard_midi
from persian_lyrics import analyze_persian_lyrics
from lyric_alignment import AlignmentError, align_lyrics_to_midi

app = FastAPI(
    title="MEHRAN Self-Hosted Singing Engine",
    version="0.2.0",
    description="Private job validation and melody analysis. Singing inference is not deployed.",
)

allowed_origins = [
    origin.strip().rstrip("/")
    for origin in os.getenv(
        "MEHRAN_SVS_ALLOWED_ORIGINS",
        "https://mehranmsh.github.io,https://ecosystem.pinet.com",
    ).split(",")
    if origin.strip()
]
app.add_middleware(
    CORSMiddleware,
    allow_origins=allowed_origins,
    allow_credentials=False,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["Content-Type"],
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
        "midi_analysis_available": True,
        "persian_lyrics_analysis_available": True,
        "lyric_note_alignment_available": True,
        "third_party_generation_api": False,
        "message": "Job intake and MIDI analysis are available; no singing audio can be generated yet.",
    }


def piano_roll_to_melody(note_events: list, bpm: float) -> dict:
    """Convert four-subdivision-per-beat Piano Roll steps into seconds."""
    if not 40 <= bpm <= 220:
        raise ValueError("Piano Roll tempo must be between 40 and 220 BPM.")
    ordered = sorted(note_events, key=lambda event: (event.startStep, event.note))
    seconds_per_step = 60.0 / bpm / 4.0
    notes = []
    for index, event in enumerate(ordered):
        start_seconds = float(event.startStep) * seconds_per_step
        duration_seconds = float(event.lengthSteps) * seconds_per_step
        notes.append({
            "note": event.note,
            "startSeconds": round(start_seconds, 6),
            "durationSeconds": round(duration_seconds, 6),
            "velocity": event.velocity,
            "source": "piano_roll",
            "sourceIndex": index,
        })
    return {
        "notes": notes,
        "noteCount": len(notes),
        "durationSeconds": max(
            (note["startSeconds"] + note["durationSeconds"] for note in notes),
            default=0.0,
        ),
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


@app.post("/v1/jobs/align")
def align_job(payload: dict) -> dict:
    raw_job = payload.get("job")
    if not isinstance(raw_job, dict):
        raise HTTPException(status_code=422, detail="Provide the validated singing job under the 'job' field.")
    job = _validated_job(raw_job)
    overrides = payload.get("pronunciation_overrides", {})
    if not isinstance(overrides, dict) or len(overrides) > 500:
        raise HTTPException(status_code=422, detail="pronunciation_overrides must be an object with at most 500 entries.")
    if any(not isinstance(k, str) or not isinstance(v, str) for k, v in overrides.items()):
        raise HTTPException(status_code=422, detail="Every pronunciation override must map a word to a syllable-separated string.")
    if job.melody.midi:
        midi_bytes = base64.b64decode(job.melody.midi.data, validate=True)
        try:
            melody = parse_standard_midi(midi_bytes)
        except MidiParseError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        if melody.get("truncated"):
            raise HTTPException(status_code=422, detail="MIDI note limit was reached; alignment requires a complete note list.")
        melody_source = "midi_file"
    elif job.melody.noteEvents:
        bpm = job.project.tempo
        if bpm is None or bpm <= 0:
            raise HTTPException(status_code=422, detail="A valid project tempo is required to align Piano Roll notes.")
        try:
            melody = piano_roll_to_melody(job.melody.noteEvents, bpm)
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        melody_source = "project_pattern"
    else:
        raise HTTPException(status_code=422, detail="Attach a MIDI file or add notes in the Piano Roll.")
    lyrics = analyze_persian_lyrics(job.project.lyrics, overrides)
    manual_groups = payload.get("manual_note_groups")
    try:
        result = align_lyrics_to_midi(lyrics, melody, manual_groups)
    except AlignmentError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return {
        **result,
        "project_id": job.project.id,
        "melody_source": melody_source,
        "generation_ready": False,
        "third_party_generation_api": False,
    }
