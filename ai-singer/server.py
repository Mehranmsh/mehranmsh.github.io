"""MEHRAN self-hosted job analysis API. No vocal synthesis is deployed."""
from __future__ import annotations

import base64
import os
import time
from collections import deque

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse
from fastapi.middleware.cors import CORSMiddleware
from pydantic import ValidationError

from job_schema import SingingJob
from midi_parser import MidiParseError, parse_standard_midi
from persian_lyrics import analyze_persian_lyrics
from lyric_alignment import AlignmentError, align_lyrics_to_midi
from model_artifact import inspect_model_artifact
from acoustic_contract import validate_acoustic_conditioning

app = FastAPI(
    title="MEHRAN Self-Hosted Singing Engine Analysis API",
    version="0.2.0",
    description="Self-hosted job validation and melody analysis. Singing inference is not deployed.",
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


RATE_WINDOW_SECONDS = 60.0
MAX_REQUEST_BYTES = 8 * 1024 * 1024
RATE_LIMITS = {
    "/v1/jobs/align": 10,
    "/v1/jobs/analyze": 20,
    "/v1/jobs/validate": 30,
    "/v1/lyrics/analyze": 30,
    "/v1/model/conditioning/validate": 20,
}
_request_times: dict[tuple[str, str], deque[float]] = {}


def _allow_request(client_ip: str, path: str, now: float) -> bool:
    limit = RATE_LIMITS.get(path)
    if limit is None:
        return True
    if len(_request_times) >= 10000 and (client_ip, path) not in _request_times:
        oldest_key = next(iter(_request_times))
        _request_times.pop(oldest_key, None)
    key = (client_ip, path)
    recent = _request_times.setdefault(key, deque())
    while recent and recent[0] <= now - RATE_WINDOW_SECONDS:
        recent.popleft()
    if len(recent) >= limit:
        return False
    recent.append(now)
    return True


MODEL_STATUS = inspect_model_artifact()



@app.middleware("http")
async def enforce_api_limits(request: Request, call_next):
    if request.method == "POST" and request.url.path in RATE_LIMITS:
        raw_length = request.headers.get("content-length")
        if raw_length:
            try:
                if int(raw_length) > MAX_REQUEST_BYTES:
                    response = JSONResponse(
                        status_code=413,
                        content={"detail": "Request body exceeds the 8 MiB limit."},
                    )
                    response.headers["X-Content-Type-Options"] = "nosniff"
                    response.headers["Cache-Control"] = "no-store"
                    response.headers["Referrer-Policy"] = "no-referrer"
                    return response
            except ValueError:
                response = JSONResponse(status_code=400, content={"detail": "Invalid Content-Length header."})
                response.headers["X-Content-Type-Options"] = "nosniff"
                response.headers["Cache-Control"] = "no-store"
                response.headers["Referrer-Policy"] = "no-referrer"
                return response
        client_ip = request.client.host if request.client else "unknown"
        if not _allow_request(client_ip, request.url.path, time.monotonic()):
            response = JSONResponse(
                status_code=429,
                headers={"Retry-After": str(int(RATE_WINDOW_SECONDS))},
                content={"detail": "Request rate limit reached. Try again in one minute."},
            )
            response.headers["X-Content-Type-Options"] = "nosniff"
            response.headers["Cache-Control"] = "no-store"
            response.headers["Referrer-Policy"] = "no-referrer"
            return response
    response = await call_next(request)
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["Cache-Control"] = "no-store"
    response.headers["Referrer-Policy"] = "no-referrer"
    return response


@app.get("/health")
def health() -> dict:
    return {
        "service": "mehran-svs-intake",
        "service_ready": True,
        "generation_ready": False,
        "model_weights_present": MODEL_STATUS["artifact_verified"],
        "model_artifact": MODEL_STATUS,
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
    reviewed_phones = payload.get("reviewed_phoneme_overrides", {})
    if not isinstance(reviewed_phones, dict) or len(reviewed_phones) > 500:
        raise HTTPException(status_code=422, detail="reviewed_phoneme_overrides must be an object with at most 500 entries.")
    if any(not isinstance(k, str) or not isinstance(v, list) or any(not isinstance(item, str) for item in v) for k, v in reviewed_phones.items()):
        raise HTTPException(status_code=422, detail="Every reviewed phoneme override must map a word to a list of canonical phoneme symbols.")
    try:
        return analyze_persian_lyrics(text_value, overrides, reviewed_phones)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


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
    reviewed_phones = payload.get("reviewed_phoneme_overrides", {})
    if not isinstance(reviewed_phones, dict) or len(reviewed_phones) > 500:
        raise HTTPException(status_code=422, detail="reviewed_phoneme_overrides must be an object with at most 500 entries.")
    if any(not isinstance(k, str) or not isinstance(v, list) or any(not isinstance(item, str) for item in v) for k, v in reviewed_phones.items()):
        raise HTTPException(status_code=422, detail="Every reviewed phoneme override must map a word to a list of canonical phoneme symbols.")
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
    try:\n        lyrics = analyze_persian_lyrics(job.project.lyrics, overrides, reviewed_phones)\n    except ValueError as exc:\n        raise HTTPException(status_code=422, detail=str(exc)) from exc
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



@app.post("/v1/model/conditioning/validate")
def validate_model_conditioning(payload: dict) -> dict:
    """Validate future acoustic-model inputs; this endpoint does not run inference."""
    try:
        conditioning = validate_acoustic_conditioning(payload)
    except ValidationError as exc:
        raise HTTPException(status_code=422, detail=exc.errors(include_url=False)) from exc
    return {
        "valid": True,
        "accepted_for_inference": False,
        "conditioning_schema": conditioning.schema_version,
        "project_id": conditioning.project_id,
        "language": conditioning.language,
        "phoneme_count": len(conditioning.phonemes),
        "note_count": len(conditioning.notes),
        "duration_seconds": conditioning.duration_seconds,
        "sample_rate": conditioning.sample_rate,
        "model_loaded": MODEL_STATUS["model_loaded"],
        "inference_ready": False,
        "audio_generated": False,
        "message": "Acoustic conditioning validated only. No model inference or audio rendering occurred.",
    }
