"""Offline PCM sample playback and WAV mixing for MEHRAN.

This renderer plays only recorded samples from a validated sample bank. It
does not synthesize oscillator tones or claim to provide instrument recordings.
"""
from __future__ import annotations

import array
import math
import struct
import wave
from pathlib import Path
from typing import Any

from sample_bank import (
    SampleBank,
    analyze_sample_bank_quality,
    rank_sample_candidates,
    select_sample,
)
from midi_renderer import PPQ, _parse_chord, _voice_lead_chord
from expression_planner import plan_part_expression
from arrangement_planner import plan_part_arrangement
from vocal_space_planner import plan_vocal_space
from fill_planner import plan_melody_fill
from persian_modal_planner import resolve_persian_modal_profile
from velocity_layer_planner import plan_velocity_layers
from guitar_string_planner import plan_guitar_string, string_for_sample

MAX_EVENTS = 20000
MAX_DURATION_SECONDS = 120.0
MAX_OUTPUT_RATE = 48000
MAX_PEAK = 0.92


def _read_sample(path: Path) -> tuple[array.array, int, int]:
    with wave.open(str(path), "rb") as wav:
        if wav.getcomptype() != "NONE" or wav.getsampwidth() != 2:
            raise ValueError("Only uncompressed 16-bit PCM samples are supported")
        channels = wav.getnchannels()
        rate = wav.getframerate()
        frames = wav.getnframes()
        raw = wav.readframes(frames)
    pcm = array.array("h")
    pcm.frombytes(raw)
    if struct.pack("=H", 1) != struct.pack("<H", 1):
        pcm.byteswap()
    if channels not in (1, 2) or not pcm:
        raise ValueError("Sample must contain mono or stereo PCM frames")
    return pcm, channels, rate


def render_sample_events(
    events: list[dict[str, Any]],
    bank: SampleBank | dict[str, SampleBank],
    output_path: str | Path,
    *,
    sample_rate: int = 44100,
) -> dict[str, Any]:
    """Render recorded sample events into a stereo 16-bit PCM WAV file.

    Each event contains instrument, midi_note, start_seconds, duration_seconds,
    and optional velocity. Pitch shifting is simple sample-rate transposition;
    no time-stretching or artificial instrument synthesis is performed.
    """
    if isinstance(bank, SampleBank):
        bank_map = None
    elif (isinstance(bank, dict) and bank and
          all(isinstance(key, str) and key and isinstance(value, SampleBank)
              for key, value in bank.items())):
        bank_map = bank
    else:
        raise ValueError("A validated SampleBank or non-empty instrument-to-bank mapping is required")
    if not isinstance(events, list) or not events or len(events) > MAX_EVENTS:
        raise ValueError(f"events must contain 1 to {MAX_EVENTS} entries")
    if isinstance(sample_rate, bool) or not isinstance(sample_rate, int) or not 8000 <= sample_rate <= MAX_OUTPUT_RATE:
        raise ValueError("sample_rate must be an integer from 8000 to 48000")

    checked = []
    end_time = 0.0
    round_robin_counters: dict[tuple[str, int, str, int, int], int] = {}
    def rank_candidates(
        selected_bank: SampleBank,
        selected_instrument: str,
        selected_note: int,
        selected_velocity: int,
        selected_articulation: str,
    ) -> dict[str, Any]:
        # Candidate-only quality analysis is performed by rank_sample_candidates.
        # Avoid a full-bank WAV scan for a short multi-instrument preview.
        return rank_sample_candidates(
            selected_bank,
            selected_instrument,
            selected_note,
            selected_velocity,
            selected_articulation,
        )

    for event in events:
        if not isinstance(event, dict):
            raise ValueError("Each sample event must be an object")
        instrument = event.get("instrument")
        note = event.get("midi_note")
        start = event.get("start_seconds")
        duration = event.get("duration_seconds")
        velocity = event.get("velocity", 90)
        articulation = event.get("articulation", "sustain")
        pitch_cents = event.get("pitch_cents", 0.0)
        release_seconds = event.get("release_seconds", 0.025)
        if (isinstance(release_seconds, bool) or not isinstance(release_seconds, (int, float))
                or not math.isfinite(release_seconds) or not 0.0 <= release_seconds <= 1.0):
            raise ValueError("event release_seconds must be between 0 and 1.0")
        if not isinstance(instrument, str) or not instrument:
            raise ValueError("event instrument must be a non-empty string")
        if isinstance(note, bool) or not isinstance(note, int) or not 0 <= note <= 127:
            raise ValueError("event midi_note must be an integer from 0 to 127")
        if (isinstance(pitch_cents, bool) or not isinstance(pitch_cents, (int, float))
                or not math.isfinite(pitch_cents) or not -200.0 <= pitch_cents <= 200.0):
            raise ValueError("event pitch_cents must be finite and between -200 and 200")
        if isinstance(start, bool) or not isinstance(start, (int, float)) or not math.isfinite(start) or start < 0:
            raise ValueError("event start_seconds must be finite and non-negative")
        if isinstance(duration, bool) or not isinstance(duration, (int, float)) or not math.isfinite(duration) or not 0 < duration <= MAX_DURATION_SECONDS:
            raise ValueError("event duration_seconds must be finite and positive")
        if isinstance(velocity, bool) or not isinstance(velocity, int) or not 1 <= velocity <= 127:
            raise ValueError("event velocity must be an integer from 1 to 127")
        event_bank = bank if bank_map is None else bank_map.get(instrument)
        if not isinstance(event_bank, SampleBank):
            raise ValueError(f"No validated sample bank supplied for instrument: {instrument}")
        selection_bank = event_bank
        selected_guitar_string = None
        guitar_candidates = [
            sample for sample in event_bank.samples
            if sample.instrument == instrument and string_for_sample(sample) is not None
        ]
        if guitar_candidates:
            string_plan = plan_guitar_string(
                event_bank, instrument, note, velocity, articulation,
                preferred_string=event.get("guitar_string", "auto"),
                max_fret=event.get("guitar_max_fret", 4),
            )
            if string_plan["status"] != "exact_recorded_string":
                raise ValueError(
                    f"Guitar string selection blocked: instrument={instrument}, note={note}, "
                    f"status={string_plan['status']}, available_strings={string_plan['available_strings']}"
                )
            selected_guitar_string = string_plan["selected_string"]
            selection_bank = SampleBank(event_bank.root, tuple(
                sample for sample in event_bank.samples
                if sample.instrument == instrument
                and string_for_sample(sample) == selected_guitar_string
            ))
        has_recorded_one_shots = any(
            sample.instrument == instrument and sample.one_shot
            for sample in selection_bank.samples
        )
        if (event.get("articulation_source") == "percussion_default"
                and not has_recorded_one_shots):
            # Keep older sustain-only percussion banks playable until migration.
            articulation = "sustain"
        elif event.get("articulation_source") == "instrument_default":
            has_default_articulation = any(
                sample.instrument == instrument and sample.articulation == articulation
                for sample in selection_bank.samples
            )
            has_legacy_sustain = any(
                sample.instrument == instrument and sample.articulation == "sustain"
                for sample in selection_bank.samples
            )
            if not has_default_articulation and has_legacy_sustain:
                # Older electric-bass banks may only contain a generic sustain layer.
                articulation = "sustain"
        one_shot_candidates = [
            sample for sample in selection_bank.samples
            if sample.instrument == instrument and sample.one_shot
        ]
        is_one_shot = bool(one_shot_candidates)
        if is_one_shot:
            exact = [
                sample for sample in one_shot_candidates
                if sample.midi_note == note
                and sample.articulation == articulation
                and sample.velocity_min <= velocity <= sample.velocity_max
            ]
            if not exact:
                raise ValueError(
                    f"One-shot percussion requires an exact recorded key, articulation, "
                    f"and velocity layer: instrument={instrument}, note={note}, "
                    f"articulation={articulation}, velocity={velocity}"
                )
            zones = sorted({(sample.velocity_min, sample.velocity_max) for sample in exact})
            zone = zones[0]
            zone_candidates = sorted(
                (sample for sample in exact
                 if (sample.velocity_min, sample.velocity_max) == zone),
                key=lambda sample: (sample.round_robin_index, sample.path.as_posix()),
            )
            indices = [sample.round_robin_index for sample in zone_candidates]
            if len(indices) != len(set(indices)):
                raise ValueError("One-shot round-robin indices must be unique within a velocity zone")
            rr_key = (instrument, note, articulation, zone[0], zone[1])
            rr_position = round_robin_counters.get(rr_key, 0)
            selected_sample = zone_candidates[rr_position % len(zone_candidates)]
            round_robin_counters[rr_key] = rr_position + 1
            sample_layers = ((selected_sample, 1.0),)
            sample_selection_mode = "one_shot_round_robin"
            duration = selected_sample.frames / selected_sample.sample_rate
        else:
            velocity_plan = plan_velocity_layers(
                selection_bank, instrument, note, velocity, articulation
            )
        if is_one_shot:
            pass
        elif velocity_plan["layers"]:
            planned_layers = velocity_plan["layers"]
            if len(planned_layers) > 1:
                # Preserve the existing technical quality gate: do not blend a
                # layer flagged as silent or digitally clipped into a clean take.
                candidate_report = rank_candidates(
                    selection_bank, instrument, note, velocity, articulation
                )
                fatal_paths = {
                    candidate["path"] for candidate in candidate_report["candidates"]
                    if {"silent_sample", "digital_clipping"}.intersection(candidate["warnings"])
                }
                if any(
                    layer["sample"].path.relative_to(event_bank.root).as_posix() in fatal_paths
                    for layer in planned_layers
                ):
                    selected_path = candidate_report["selected_sample"]
                    selected_sample = next(
                        item for item in event_bank.samples
                        if item.path.relative_to(event_bank.root).as_posix() == selected_path
                    )
                    sample_layers = ((selected_sample, 1.0),)
                    sample_selection_mode = "exact_note_quality_ranked"
                else:
                    sample_layers = tuple(
                        (layer["sample"], layer["gain"])
                        for layer in planned_layers
                    )
                    sample_selection_mode = velocity_plan["selection_mode"]
            else:
                sample_layers = tuple(
                    (layer["sample"], layer["gain"])
                    for layer in planned_layers
                )
                sample_selection_mode = velocity_plan["selection_mode"]
        else:
            candidate_report = rank_candidates(
                selection_bank, instrument, note, velocity, articulation
            )
            if candidate_report["candidate_count"]:
                selected_path = candidate_report["selected_sample"]
                sample = next(
                    item for item in event_bank.samples
                    if item.path.relative_to(event_bank.root).as_posix() == selected_path
                )
                sample_selection_mode = "exact_note_quality_ranked"
            else:
                try:
                    sample = select_sample(selection_bank, instrument, note, velocity, articulation)
                except ValueError as exc:
                    raise ValueError(
                        f"Articulation blocked: instrument={instrument}, note={note}, "
                        f"planner_selected={articulation}, sample_exact_articulation_velocity_match=False"
                    ) from exc
                sample_selection_mode = (
                    "pitch_shifted_nearest_note"
                    if sample.midi_note != note else "exact_note"
                )
            sample_layers = ((sample, 1.0),)
        pitched_rr_selected = False
        pitched_rr_for_event: list[dict[str, Any]] = []
        if not is_one_shot and sample_layers:
            rotated_layers = []
            for selected, layer_gain in sample_layers:
                candidates = sorted(
                    (
                        candidate for candidate in selection_bank.samples
                        if not candidate.one_shot
                        and candidate.instrument == selected.instrument
                        and candidate.midi_note == selected.midi_note
                        and candidate.articulation == selected.articulation
                        and candidate.velocity_min == selected.velocity_min
                        and candidate.velocity_max == selected.velocity_max
                        and candidate.string_name == selected.string_name
                    ),
                    key=lambda candidate: (candidate.round_robin_index, candidate.path.as_posix()),
                )
                if len(candidates) > 1:
                    indices = [candidate.round_robin_index for candidate in candidates]
                    if len(indices) != len(set(indices)):
                        raise ValueError("Pitched round-robin indices must be unique within a recorded layer")
                    rr_key = (
                        selected.instrument, selected.midi_note, selected.articulation,
                        selected.velocity_min, selected.velocity_max,
                    )
                    rr_position = round_robin_counters.get(rr_key, 0)
                    selected = candidates[rr_position % len(candidates)]
                    round_robin_counters[rr_key] = rr_position + 1
                    pitched_rr_selected = True
                    pitched_rr_for_event.append({
                        "instrument": selected.instrument,
                        "midi_note": selected.midi_note,
                        "round_robin_index": selected.round_robin_index,
                    })
                rotated_layers.append((selected, layer_gain))
            sample_layers = tuple(rotated_layers)
        end_time = max(end_time, float(start) + float(duration))
        pan = event.get("pan", 0.0)
        if isinstance(pan, bool) or not isinstance(pan, (int, float)) or not math.isfinite(pan) or not -1.0 <= pan <= 1.0:
            raise ValueError("event pan must be between -1.0 and 1.0")
        event_gain = event.get("gain", 1.0)
        if (isinstance(event_gain, bool) or not isinstance(event_gain, (int, float))
                or not math.isfinite(event_gain) or not 0.0 <= event_gain <= 2.0):
            raise ValueError("event gain must be between 0.0 and 2.0")
        checked.append((sample_layers, note, float(start), float(duration), velocity,
                        float(pan), float(event_gain), articulation,
                        event.get("articulation_source", "legacy_default"),
                        float(release_seconds), float(pitch_cents), sample_selection_mode,
                        selected_guitar_string, is_one_shot, pitched_rr_selected,
                        pitched_rr_for_event))
    if end_time > MAX_DURATION_SECONDS:
        raise ValueError("Rendered audio may not exceed 120 seconds")

    frame_count = max(1, math.ceil(end_time * sample_rate))
    mix = array.array("f", [0.0]) * (frame_count * 2)
    rendered_events = 0
    velocity_crossfade_events = 0
    velocity_crossfade_layers_rendered = 0
    for sample_layers, target_note, start, duration, velocity, pan, event_gain, articulation, articulation_source, release_seconds, pitch_cents, sample_selection_mode, selected_guitar_string, is_one_shot, pitched_rr_selected, pitched_rr_for_event in checked:
        if len(sample_layers) > 1:
            velocity_crossfade_events += 1
        for sample, layer_gain in sample_layers:
            velocity_crossfade_layers_rendered += 1
            pcm, source_channels, source_rate = _read_sample(sample.path)
            source_frames = len(pcm) // source_channels
            semitone_ratio = 1.0 if is_one_shot else 2.0 ** (((target_note - sample.midi_note) * 100.0 + pitch_cents + sample.tuning_cents) / 1200.0)
            source_step = source_rate / sample_rate * semitone_ratio
            start_frame = round(start * sample_rate)
            if sample.loop_start_frame is not None and sample.loop_end_frame is not None:
                requested_frames = round(duration * sample_rate)
                loop_start = sample.loop_start_frame
                loop_end = sample.loop_end_frame
                loop_length = loop_end - loop_start
                crossfade_frames = min(max(1, round(source_rate * 0.008)), loop_length // 4)
            else:
                requested_frames = min(round(duration * sample_rate),
                                       math.ceil(source_frames / source_step))
                loop_start = loop_end = loop_length = crossfade_frames = None
            if requested_frames <= 0:
                continue
            gain = (velocity / 127.0) ** 1.6 * 0.72 * event_gain * layer_gain * (10.0 ** (sample.gain_db / 20.0))
            pan_gains = (math.sqrt(1.0 - pan), math.sqrt(1.0 + pan))
            attack_frames = max(1, round(sample_rate * (0.001 if is_one_shot else 0.004)))
            effective_release = min(release_seconds, 0.012) if is_one_shot else release_seconds
            release_frames = min(requested_frames, max(1, round(sample_rate * effective_release))) if effective_release else 1
            for out_index in range(requested_frames):
                source_position = out_index * source_step
                if loop_start is not None and loop_end is not None and source_position >= loop_end:
                    source_position = loop_start + ((source_position - loop_end) % loop_length)
                source_index = int(source_position)
                if source_index >= source_frames:
                    break
                fraction = source_position - source_index
                next_index = min(source_index + 1, source_frames - 1)
                if out_index < attack_frames:
                    envelope = out_index / attack_frames
                elif requested_frames - out_index <= release_frames:
                    envelope = max(0.0, (requested_frames - out_index) / release_frames)
                else:
                    envelope = 1.0
                frame_gain = gain * envelope
                for channel in range(2):
                    source_channel = 0 if source_channels == 1 else channel
                    a = pcm[source_index * source_channels + source_channel]
                    b = pcm[next_index * source_channels + source_channel]
                    sample_value = a + (b - a) * fraction
                    if (loop_start is not None and loop_end is not None and
                            crossfade_frames and source_position >= loop_end - crossfade_frames):
                        blend = (source_position - (loop_end - crossfade_frames)) / crossfade_frames
                        head_position = loop_start + (source_position - (loop_end - crossfade_frames))
                        head_index = min(int(head_position), loop_end - 1)
                        head_next = min(head_index + 1, loop_end - 1)
                        head_fraction = head_position - head_index
                        head_a = pcm[head_index * source_channels + source_channel]
                        head_b = pcm[head_next * source_channels + source_channel]
                        head_value = head_a + (head_b - head_a) * head_fraction
                        sample_value = sample_value * (1.0 - blend) + head_value * blend
                    value = sample_value * frame_gain * pan_gains[channel]
                    destination = (start_frame + out_index) * 2 + channel
                    mix[destination] += value
        rendered_events += 1

    peak = max((abs(value) for value in mix), default=0.0)
    normalization = min(1.0, (32767.0 * MAX_PEAK / peak)) if peak > 0 else 1.0
    output = array.array("h")
    clipping_samples = 0
    for value in mix:
        scaled = round(value * normalization)
        if scaled < -32768 or scaled > 32767:
            clipping_samples += 1
        clipped = max(-32768, min(32767, scaled))
        output.append(clipped)
    peak_after_normalization = max((abs(value) for value in output), default=0)
    if struct.pack("=H", 1) != struct.pack("<H", 1):
        output.byteswap()

    target = Path(output_path)
    target.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(target), "wb") as wav:
        wav.setnchannels(2)
        wav.setsampwidth(2)
        wav.setframerate(sample_rate)
        wav.writeframes(output.tobytes())

    return {
        "path": str(target),
        "format": "WAV PCM 16-bit",
        "sample_rate": sample_rate,
        "channels": 2,
        "duration_seconds": round(frame_count / sample_rate, 3),
        "events_requested": len(checked),
        "events_rendered": rendered_events,
        "sample_selection": {
            "exact_note_quality_ranked_events": sum(
                1 for item in checked if item[11] == "exact_note_quality_ranked"
            ),
            "exact_note_events": sum(
                1 for item in checked if item[11] == "exact_note"
            ),
            "single_recorded_velocity_layer_events": sum(
                1 for item in checked if item[11] == "single_recorded_layer"
            ),
            "pitch_shifted_nearest_note_events": sum(
                1 for item in checked if item[11] == "pitch_shifted_nearest_note"
            ),
            "one_shot_round_robin_events": sum(1 for item in checked if item[13]),
            "pitched_round_robin_events": sum(1 for item in checked if item[14]),
            "pitched_round_robin_selections": [
                selection for item in checked for selection in item[15]
            ],
            "one_shot_round_robin_selections": [
                {
                    "instrument": sample.instrument,
                    "midi_note": item[1],
                    "round_robin_index": sample.round_robin_index,
                }
                for item in checked if item[13]
                for sample, _layer_gain in item[0]
            ],
            "equal_power_velocity_crossfade_events": velocity_crossfade_events,
            "velocity_layers_rendered": velocity_crossfade_layers_rendered,
            "quality_ranking": "technical_screening_only",
        },
        "guitar_string_selections": [
            {"midi_note": item[1], "string": item[12]}
            for item in checked if item[12] is not None
        ],
        "pitch_cents_applied_events": sum(1 for item in checked if item[10] != 0.0),
        "sample_tuning_cents_applied_events": sum(
            1 for item in checked
            if any(sample.tuning_cents != 0.0 for sample, _gain in item[0])
        ),
        "microtonal_pitch_offsets_rendered": rendered_events > 0 and (
            any(item[10] != 0.0 for item in checked)
            or any(sample.tuning_cents != 0.0 for item in checked for sample, _gain in item[0])
        ),
        "articulations_rendered": sorted({item[7] for item in checked}),
        "articulation_diagnostics": {
            "planner_selected": sorted({item[7] for item in checked if item[8] == "planner"}),
            "legacy_defaulted": sorted({item[7] for item in checked if item[8] == "legacy_default"}),
            "renderer_supports_exact_match": True,
            "sample_exact_match": True,
            "performance_shaping_applied": True,
            "release_profiles_ms": sorted({round(item[9] * 1000) for item in checked}),
            "audio_rendered": rendered_events > 0,
        },
        "peak_before_normalization": round(peak / 32768.0, 5),
        "normalization_applied": round(normalization, 5),
        "peak_after_normalization": round(peak_after_normalization / 32768.0, 5),
        "clipping_samples": clipping_samples,
        "source": "recorded_sample_bank",
    }


def _section_kind(section: str) -> str:
    """Normalize descriptive section labels to the renderer's arrangement profiles."""
    name = section.lower().replace("-", "_").replace(" ", "_")
    if "bridge" in name:
        return "bridge"
    if "final" in name and "chorus" in name:
        return "final_chorus"
    if "pre_chorus" in name:
        return "pre_chorus"
    if "chorus" in name:
        return "chorus"
    return "verse"


def _section_sample_dynamics(section: str) -> dict[str, float]:
    """Sample-layer velocity profile for the song's arrangement sections."""
    profiles = {
        "bridge": {"melody": 0.88, "chords": 0.72, "bass": 0.78, "drums": 0.62},
        "verse": {"melody": 0.88, "chords": 0.82, "bass": 0.86, "drums": 0.88},
        "pre_chorus": {"melody": 1.02, "chords": 0.96, "bass": 0.96, "drums": 0.92},
        "chorus": {"melody": 1.08, "chords": 1.12, "bass": 1.10, "drums": 1.08},
        "final_chorus": {"melody": 1.12, "chords": 1.18, "bass": 1.16, "drums": 1.12},
    }
    return profiles.get(section, profiles["verse"])


# Conservative per-part gain staging before the final linked-stereo peak pass.
# These are mix-balance multipliers, independent of musical velocity and section dynamics.
_DEFAULT_PART_GAINS = {
    "melody": 1.0, "chords": 0.82, "bass": 0.90, "contrabass": 0.48,
    "kick": 0.92, "snare": 0.84, "closed_hat": 0.58,
    "open_hat": 0.62, "cajon": 0.64, "kalimba": 0.46, "guitar": 0.76, "strings": 0.70,
    "electric_guitar": 0.76,
}


def _validated_part_gains(overrides: dict[str, float] | None) -> dict[str, float]:
    gains = dict(_DEFAULT_PART_GAINS)
    if overrides is None:
        return gains
    if not isinstance(overrides, dict):
        raise ValueError("mix_gains must be a mapping of part names to gain multipliers")
    for part, gain in overrides.items():
        if (part not in gains or isinstance(gain, bool)
                or not isinstance(gain, (int, float)) or not math.isfinite(gain)
                or not 0.0 <= gain <= 2.0):
            raise ValueError("mix_gains contains an unknown part or invalid gain")
        gains[part] = float(gain)
    return gains


def _scaled_velocity(base: int, scale: float) -> int:
    return max(1, min(127, int(round(base * scale))))


def _melody_sample_velocity(base: int, tick_in_bar: int, *,
                             section_scale: float = 1.0,
                             is_peak: bool = False,
                             is_cadence: bool = False) -> int:
    """Mirror MIDI melody accents in the recorded-sample playback path."""
    beat = (tick_in_bar % (PPQ * 4)) // PPQ
    beat_scale = {0: 1.08, 1: 0.96, 2: 1.03, 3: 0.97}[beat]
    phrase_scale = (1.05 if is_peak else 1.0) * (1.03 if is_cadence else 1.0)
    return _scaled_velocity(base, section_scale * beat_scale * phrase_scale)


def _resolve_part_articulation(
    part: str, articulation: str, articulation_source: str
) -> tuple[str, str]:
    """Map generic drum hits to the exact articulations exposed by the CC0 kit."""
    if articulation != "sustain":
        return articulation, articulation_source
    part_defaults = {
        "bass": ("fingerstyle", "instrument_default"),
        "kick": ("snares_on", "percussion_default"),
        "snare": ("center", "percussion_default"),
        "closed_hat": ("closed", "percussion_default"),
        "open_hat": ("open", "percussion_default"),
    }
    if part in part_defaults:
        return part_defaults[part]
    return articulation, articulation_source


def build_composition_events(
    plan: dict[str, Any],
    *,
    instruments: dict[str, str] | None = None,
    mix_gains: dict[str, float] | None = None,
    response_fill_part: str | None = "guitar",
    instrument_tuning_cents: dict[str, dict[int, float]] | None = None,
) -> list[dict[str, Any]]:
    """Translate the current MEHRAN plan into sample-playback events.

    Instrument names are bank slugs. Melody/chords use piano, bass uses
    electric_bass, and kick, snare, closed_hat, and open_hat use separate
    recorded-sample instruments. Guitar, strings, and electric guitar are
    opt-in layers until explicitly mapped by the caller.
    """
    if not isinstance(plan, dict) or not isinstance(plan.get("composition"), dict):
        raise ValueError("A valid MEHRAN composition plan is required")
    composition = plan["composition"]
    bpm = composition.get("tempo_bpm")
    melody = composition.get("melody")
    chords = composition.get("chord_progression")
    if isinstance(bpm, bool) or not isinstance(bpm, int) or not 50 <= bpm <= 200:
        raise ValueError("Plan tempo must be an integer from 50 to 200 BPM")
    if not isinstance(melody, list) or not melody or not isinstance(chords, list) or not chords:
        raise ValueError("Plan must include melody phrases and a chord progression")
    names = {
        "melody": "piano", "chords": "piano", "bass": "electric_bass",
        "kick": "kick", "snare": "snare", "closed_hat": "closed_hat",
        "open_hat": "open_hat", "contrabass": "contrabass", "cajon": None, "kalimba": None, "guitar": None, "strings": None,
        "electric_guitar": None,
    }
    if instruments is not None:
        if not isinstance(instruments, dict):
            raise ValueError("instruments must be a mapping of part names to bank slugs")
        for part, name in instruments.items():
            if part not in names or not isinstance(name, str) or not name:
                raise ValueError("Unknown part or invalid instrument-bank name")
            names[part] = name

    if instrument_tuning_cents is None:
        instrument_tuning_cents = {}
    if not isinstance(instrument_tuning_cents, dict):
        raise ValueError("instrument_tuning_cents must map instrument slugs to MIDI-note offsets")
    normalized_instrument_tuning: dict[str, dict[int, float]] = {}
    for instrument_slug, note_offsets in instrument_tuning_cents.items():
        if not isinstance(instrument_slug, str) or not instrument_slug or not isinstance(note_offsets, dict):
            raise ValueError("instrument tuning entries must map non-empty instrument slugs to note offsets")
        normalized_offsets: dict[int, float] = {}
        for midi_note, cents in note_offsets.items():
            if (isinstance(midi_note, bool) or not isinstance(midi_note, int)
                    or not 0 <= midi_note <= 127
                    or isinstance(cents, bool) or not isinstance(cents, (int, float))
                    or not math.isfinite(cents) or not -100.0 <= cents <= 100.0):
                raise ValueError("instrument tuning offsets require MIDI notes 0-127 and finite cents from -100 to 100")
            normalized_offsets[midi_note] = float(cents)
        normalized_instrument_tuning[instrument_slug] = normalized_offsets

    if response_fill_part is not None and response_fill_part not in ("guitar", "electric_guitar", "strings", "melody"):
        raise ValueError("response_fill_part must be guitar, electric_guitar, strings, melody or None")
    part_gains = _validated_part_gains(mix_gains)
    explicit_mix_overrides = set(mix_gains or {})
    seconds_per_tick = 60.0 / bpm / PPQ
    events: list[dict[str, Any]] = []
    phrase_tick = 0
    chord_index = 0
    previous_voicing = None
    current_section = "verse"
    part_event_counts = {part: 0 for part in names}
    current_vocal_intervals: list[tuple[int, int]] = []

    def add(part: str, note: int, start_tick: int, duration_ticks: int,
            velocity: int, pan: float = 0.0, *,
            articulation: str = "sustain",
            articulation_source: str = "legacy_default",
            release_seconds: float = 0.025, pitch_cents: float = 0.0) -> None:
        instrument_slug = names[part]
        if part == "bass" and instrument_slug == "contrabass" and articulation == "sustain":
            articulation, articulation_source = "pizzicato", "instrument_default"
        else:
            articulation, articulation_source = _resolve_part_articulation(
                part, articulation, articulation_source
            )
        tuning_offset = normalized_instrument_tuning.get(instrument_slug, {}).get(note, 0.0)
        combined_pitch_cents = float(pitch_cents) + tuning_offset
        if not -200.0 <= combined_pitch_cents <= 200.0:
            raise ValueError("combined modal and instrument pitch_cents must be between -200 and 200")
        event_index = part_event_counts[part]
        part_event_counts[part] += 1
        arrangement = plan_part_arrangement(part, current_section, event_index)
        if not arrangement["active"]:
            return
        expression = plan_part_expression(
            part, current_section, pan, event_index
        )
        vocal_space = plan_vocal_space(
            part, start_tick, duration_ticks, current_vocal_intervals
        )
        events.append({
            "part": part,
            "instrument": names[part],
            "articulation": articulation,
            "articulation_source": articulation_source,
            "release_seconds": release_seconds,
            "midi_note": note,
            "pitch_cents": combined_pitch_cents,
            "instrument_tuning_offset_cents": tuning_offset,
            "start_seconds": round(start_tick * seconds_per_tick, 6),
            "duration_seconds": round(duration_ticks * seconds_per_tick, 6),
            "velocity": velocity,
            "pan": expression["pan"],
            "stereo_width": expression["stereo_width"],
            "expression_profile": expression["profile"],
            "expression_planner": expression["planner"],
            "arrangement_role": arrangement["role"],
            "arrangement_density": arrangement["density"],
            "arrangement_section": arrangement["section"],
            "arrangement_planner": arrangement["planner"],
            "vocal_space_gain": vocal_space["gain"],
            "vocal_space_mode": vocal_space["mode"],
            "vocal_overlap_ratio": vocal_space["overlap_ratio"],
            "vocal_space_planner": vocal_space["planner"],
            "gain": ((part_gains[part] if part in explicit_mix_overrides
                      else part_gains[part] * arrangement["gain"])
                     * vocal_space["gain"]),
        })

    for phrase in melody:
        if not isinstance(phrase, dict):
            raise ValueError("Every melody phrase must be an object")
        notes = phrase.get("midi_notes")
        durations = phrase.get("note_durations_ticks")
        bars = phrase.get("bar_count")
        if (not isinstance(notes, list) or not notes or
                any(isinstance(note, bool) or not isinstance(note, int) or not 48 <= note <= 96 for note in notes)):
            raise ValueError("Every phrase needs MIDI notes from 48 to 96")
        if (not isinstance(durations, list) or len(durations) != len(notes) or
                any(isinstance(value, bool) or not isinstance(value, int) or value <= 0 for value in durations)):
            raise ValueError("Every phrase needs positive note durations")
        if isinstance(bars, bool) or not isinstance(bars, int) or not 1 <= bars <= 3:
            raise ValueError("Phrase bar_count must be from 1 to 3")
        phrase_ticks = bars * 4 * PPQ
        if sum(durations) != phrase_ticks:
            raise ValueError("Phrase note durations must exactly fill its bars")
        pause_ticks = phrase.get("phrase_pause_ticks", 0)
        if (isinstance(pause_ticks, bool) or not isinstance(pause_ticks, int)
                or not 0 <= pause_ticks <= 960):
            raise ValueError("phrase_pause_ticks must be an integer from 0 to 960")
        section = _section_kind(phrase.get("section", "verse"))
        current_section = section
        dynamics = _section_sample_dynamics(section)
        vocal_cursor = phrase_tick
        current_vocal_intervals = []
        for vocal_duration in durations:
            current_vocal_intervals.append(
                (vocal_cursor, vocal_cursor + vocal_duration)
            )
            vocal_cursor += vocal_duration
        transition = phrase.get("phrase_energy", {}).get("section_transition")
        cursor = phrase_tick
        peak_index = phrase.get("peak_note_index")
        lyric_map = phrase.get("note_lyric_map", [])
        if not isinstance(lyric_map, list):
            raise ValueError("note_lyric_map must be a list when provided")
        for note_index, (note, duration) in enumerate(zip(notes, durations)):
            velocity = _melody_sample_velocity(
                88, cursor, section_scale=dynamics["melody"],
                is_peak=(isinstance(peak_index, int) and not isinstance(peak_index, bool)
                         and note_index == peak_index),
                is_cadence=(note_index == len(notes) - 1),
            )
            lyric_item = lyric_map[note_index] if note_index < len(lyric_map) else {}
            pitch_cents = lyric_item.get("pitch_cents", 0.0) if isinstance(lyric_item, dict) else 0.0
            if (isinstance(pitch_cents, bool) or not isinstance(pitch_cents, (int, float))
                    or not math.isfinite(pitch_cents) or not -200.0 <= pitch_cents <= 200.0):
                raise ValueError("Melody pitch_cents must be finite and between -200 and 200")
            dynamics_velocity = lyric_item.get("dynamics_velocity", 84) if isinstance(lyric_item, dict) else 84
            if isinstance(dynamics_velocity, bool) or not isinstance(dynamics_velocity, int) or not 1 <= dynamics_velocity <= 127:
                raise ValueError("Melody dynamics_velocity must be an integer from 1 to 127")
            velocity = _scaled_velocity(velocity, dynamics_velocity / 84.0)
            articulation = lyric_item.get("articulation", "sustain") if isinstance(lyric_item, dict) else "sustain"
            gate_ratio = lyric_item.get("gate_ratio", 0.88) if isinstance(lyric_item, dict) else 0.88
            release_ms = lyric_item.get("release_ms", 25) if isinstance(lyric_item, dict) else 25
            if not isinstance(articulation, str) or not articulation:
                raise ValueError("Planned melody articulation must be a non-empty string")
            if isinstance(gate_ratio, bool) or not isinstance(gate_ratio, (int, float)) or not 0.1 <= gate_ratio <= 1.0:
                raise ValueError("Planned melody gate_ratio must be between 0.1 and 1.0")
            if isinstance(release_ms, bool) or not isinstance(release_ms, int) or not 0 <= release_ms <= 1000:
                raise ValueError("Planned melody release_ms must be an integer from 0 to 1000")
            add("melody", note, cursor, max(1, int(duration * gate_ratio)), velocity,
                articulation=articulation,
                articulation_source="planner" if isinstance(lyric_item, dict) and "articulation" in lyric_item else "legacy_default",
                release_seconds=release_ms / 1000.0,
                pitch_cents=float(pitch_cents))
            cursor += duration

        for bar in range(bars):
            bar_start = phrase_tick + bar * 4 * PPQ
            bar_dynamics = dict(dynamics)
            if bar == bars - 1 and isinstance(transition, dict):
                change = transition.get("energy_change")
                if (not isinstance(change, bool)
                        and isinstance(change, (int, float))):
                    anticipation = max(0.96, min(1.04, 1.0 + float(change) * 0.20))
                    for track in ("chords", "bass", "drums"):
                        bar_dynamics[track] *= anticipation
            phrase_chord = phrase.get("chord")
            symbol = (phrase_chord if bar == 0 and isinstance(phrase_chord, str)
                      else chords[chord_index % len(chords)])
            root_pc, chord_intervals = _parse_chord(symbol)
            voicing = _voice_lead_chord(symbol, previous_voicing)
            previous_voicing = voicing
            voice_pans = (-0.22, 0.0, 0.22) if len(voicing) == 3 else (-0.24, -0.08, 0.08, 0.24)
            if section == "bridge":
                # Let the harmony breathe: long, quiet chord tones.
                for voice_index, note in enumerate(voicing):
                    add("chords", note, bar_start, 4 * PPQ - 48,
                        _scaled_velocity(48, bar_dynamics["chords"]),
                        voice_pans[voice_index])
            elif section == "verse":
                # Gentle eighth-note arpeggio, cycling through the voicing.
                for step in range(8):
                    voice_index = ((0, 1, 2, 1, 0, 1, 2, 1) if len(voicing) == 3 else (0, 1, 2, 3, 2, 1, 0, 1))[step]
                    add("chords", voicing[voice_index],
                        bar_start + step * (PPQ // 2), (PPQ // 2) - 18,
                        _scaled_velocity(54 if step % 2 == 0 else 46,
                                         bar_dynamics["chords"]),
                        voice_pans[voice_index])
            elif section == "pre_chorus":
                # Quarter-note broken chords build forward motion.
                pattern = (0, 1, 2, 1) if len(voicing) == 3 else (0, 1, 2, 3)
                for beat, voice_index in enumerate(pattern):
                    add("chords", voicing[voice_index], bar_start + beat * PPQ,
                        PPQ - 24, _scaled_velocity(56, bar_dynamics["chords"]),
                        voice_pans[voice_index])
            else:
                # Choruses use fuller chord punches on the main beats.
                for beat in (0, 2):
                    for voice_index, note in enumerate(voicing):
                        add("chords", note, bar_start + beat * PPQ,
                            PPQ - 24, _scaled_velocity(64, bar_dynamics["chords"]),
                            voice_pans[voice_index])
            if names["guitar"]:
                # Alternate down/up strums: downbeats sweep low-to-high,
                # offbeats reverse the sweep and sit lighter in the groove.
                strum_velocities = (60, 45, 55, 47)
                for beat, base_velocity in enumerate(strum_velocities):
                    upstroke = beat in (1, 3)
                    voice_order = range(len(voicing) - 1, -1, -1) if upstroke else range(len(voicing))
                    for strum_step, voice_index in enumerate(voice_order):
                        note = voicing[voice_index]
                        add("guitar", note,
                            bar_start + beat * PPQ + strum_step * 12,
                            PPQ // 2 - 12,
                            _scaled_velocity(base_velocity, bar_dynamics["chords"]),
                            voice_pans[voice_index])
            if names["strings"] and section in ("chorus", "final_chorus"):
                for voice_index, note in enumerate(voicing):
                    add("strings", note, bar_start, 4 * PPQ - 24,
                        _scaled_velocity(42, bar_dynamics["chords"]),
                        voice_pans[voice_index])
            if names["electric_guitar"] and section in ("chorus", "final_chorus"):
                add("electric_guitar", voicing[-1], bar_start + PPQ,
                    PPQ // 2, _scaled_velocity(68, bar_dynamics["chords"]), 0.38)
                add("electric_guitar", voicing[-1] + 12, bar_start + 3 * PPQ,
                    PPQ // 2, _scaled_velocity(72, bar_dynamics["chords"]), 0.42)
            bass_root_pc = voicing[0] % 12
            bass_root = 36 + bass_root_pc
            bass_intervals = sorted(
                (root_pc + interval - bass_root_pc) % 12
                for interval in chord_intervals
                if (root_pc + interval - bass_root_pc) % 12
            )
            bass_third = bass_root + bass_intervals[0]
            bass_fifth = bass_root + bass_intervals[-1]
            bass_scale = bar_dynamics["bass"]
            drum_scale = bar_dynamics["drums"]
            if section == "bridge":
                add("bass", bass_root, bar_start, 2 * PPQ - 36, _scaled_velocity(76, bass_scale))
                add("bass", bass_fifth, bar_start + 2 * PPQ, 2 * PPQ - 36,
                    _scaled_velocity(66, bass_scale))
                add("kick", 36, bar_start, 48, _scaled_velocity(88, drum_scale))
                add("snare", 38, bar_start + 2 * PPQ, 48, _scaled_velocity(62, drum_scale))
                for eighth in (0, 4):
                    add("closed_hat", 42, bar_start + eighth * (PPQ // 2), 48,
                        _scaled_velocity(52, drum_scale))
            else:
                add("bass", bass_root, bar_start, 2 * PPQ - 36, _scaled_velocity(82, bass_scale))
                add("bass", bass_third, bar_start + 2 * PPQ, PPQ - 36, _scaled_velocity(82, bass_scale))
                add("bass", bass_fifth, bar_start + 3 * PPQ, PPQ - 36, _scaled_velocity(82, bass_scale))
                add("kick", 36, bar_start, 48, _scaled_velocity(112, drum_scale))
                add("kick", 36, bar_start + 2 * PPQ, 48, _scaled_velocity(104, drum_scale))
                add("snare", 38, bar_start + PPQ, 48, _scaled_velocity(94, drum_scale))
                add("snare", 38, bar_start + 3 * PPQ, 48, _scaled_velocity(100, drum_scale))
                for eighth in range(8):
                    is_open_hat = section in ("chorus", "final_chorus") and eighth == 7
                    part = "open_hat" if is_open_hat else "closed_hat"
                    note = 46 if is_open_hat else 42
                    velocity = 82 if is_open_hat else 72
                    add(part, note, bar_start + eighth * (PPQ // 2), 48,
                        _scaled_velocity(velocity, drum_scale))
                if section in ("chorus", "final_chorus") and bar == bars - 1:
                    # Short snare pickup into the next lyric phrase.
                    add("snare", 38, bar_start + 2 * PPQ + PPQ // 2,
                        48, _scaled_velocity(78, drum_scale))
                    add("snare", 38, bar_start + 3 * PPQ + PPQ // 2,
                        48, _scaled_velocity(90, drum_scale))
            if names["contrabass"] is not None:
                # Slower pizzicato support beneath the electric-bass groove.
                if section == "bridge":
                    add("contrabass", bass_root, bar_start, 2 * PPQ - 48,
                        _scaled_velocity(58, bass_scale), -0.08,
                        articulation="pizzicato", articulation_source="instrument_default")
                else:
                    add("contrabass", bass_root, bar_start, PPQ + PPQ // 2,
                        _scaled_velocity(62, bass_scale), -0.08,
                        articulation="pizzicato", articulation_source="instrument_default")
                    add("contrabass", bass_fifth, bar_start + 2 * PPQ,
                        PPQ + PPQ // 2, _scaled_velocity(54, bass_scale), -0.08,
                        articulation="pizzicato", articulation_source="instrument_default")
            if names["cajon"] is not None:
                if section == "bridge":
                    add("cajon", 60, bar_start, 48,
                        _scaled_velocity(74, drum_scale),
                        articulation="bass", articulation_source="percussion_default")
                    add("cajon", 61, bar_start + 2 * PPQ, 48,
                        _scaled_velocity(56, drum_scale),
                        articulation="slap", articulation_source="percussion_default")
                else:
                    add("cajon", 60, bar_start, 48,
                        _scaled_velocity(88, drum_scale),
                        articulation="bass", articulation_source="percussion_default")
                    add("cajon", 61, bar_start + PPQ, 48,
                        _scaled_velocity(82, drum_scale),
                        articulation="slap", articulation_source="percussion_default")
                    add("cajon", 62, bar_start + 3 * PPQ, 48,
                        _scaled_velocity(72, drum_scale),
                        articulation="tone", articulation_source="percussion_default")
            if names["kalimba"] is not None and section in ("pre_chorus", "chorus", "final_chorus", "bridge"):
                kalimba_notes = [min(81, max(59, int(note) + 12)) for note in voicing[:3]]
                if section == "bridge":
                    kalimba_notes = kalimba_notes[:1]
                elif section == "pre_chorus":
                    kalimba_notes = kalimba_notes[:2]
                for note_index, note in enumerate(kalimba_notes):
                    add("kalimba", note, bar_start + note_index * PPQ,
                        PPQ // 2, _scaled_velocity(68 + note_index * 5, bar_dynamics["melody"]),
                        0.16, articulation="pluck", articulation_source="planner")
            chord_index += 1
        # One explicitly selected part may answer in the written vocal-rest window.
        # No alternate instrument is silently substituted when that part is unmapped.
        if response_fill_part is not None and names[response_fill_part] and pause_ticks >= 120:
            key_roots = {"C": 0, "D": 2, "E": 4, "F": 5, "G": 7, "A": 9, "B": 11}
            mode_intervals = {
                "major": (0, 2, 4, 5, 7, 9, 11),
                "minor": (0, 2, 3, 5, 7, 8, 10),
            }
            key_name = composition.get("key")
            mode_name = composition.get("mode")
            persian_dastgah = composition.get("persian_dastgah")
            tonic_pc = key_roots.get(key_name, 0)
            modal_context = (resolve_persian_modal_profile(persian_dastgah, tonic_pc, composition.get("persian_degree_cents"))
                             if persian_dastgah is not None else None)
            if modal_context is not None or (key_name in key_roots and mode_name in mode_intervals):
                scale_pcs = (list(modal_context["scale_pitch_classes"]) if modal_context
                             else [(tonic_pc + interval) % 12
                                   for interval in mode_intervals[mode_name]])
                fill_chord = phrase.get("chord", chords[chord_index % len(chords)])
                fill_root, fill_intervals = _parse_chord(fill_chord)
                chord_pcs = [(fill_root + interval) % 12 for interval in fill_intervals]
                fill_slug = names[response_fill_part]
                fill_style = (fill_slug if fill_slug in ("tar", "setar", "santur", "kamancheh")
                              else "strings" if response_fill_part == "strings"
                              else "piano" if response_fill_part == "melody" or fill_slug == "piano"
                              else "guitar")
                fill_plan = plan_melody_fill(
                    gap_start_tick=phrase_tick + phrase_ticks,
                    gap_duration_ticks=pause_ticks,
                    scale_pitch_classes=scale_pcs,
                    chord_pitch_classes=chord_pcs,
                    reference_note=notes[-1],
                    max_notes=5 if fill_style in ("piano", "santur") else 4,
                    base_velocity={
                        "verse": 54, "pre_chorus": 62, "chorus": 70,
                        "bridge": 48, "final_chorus": 76,
                    }.get(section, 60),
                    fill_style=fill_style,
                    modal_profile=persian_dastgah,
                    modal_tonic_pc=tonic_pc,
                    modal_degree_cents=composition.get("persian_degree_cents"),
                )
                for fill in fill_plan["events"]:
                    before_count = len(events)
                    fill_articulation = {
                        "acoustic_guitar": "fingerstyle",
                        "classical_guitar": "fingerstyle",
                        "electric_guitar": "sustain",
                    }.get(fill_slug, fill["articulation"])
                    add(response_fill_part, fill["midi_note"], fill["start_tick"],
                        fill["duration_ticks"], fill["velocity"], 0.18,
                        articulation=fill_articulation,
                        articulation_source="planner",
                        release_seconds=fill["release_ms"] / 1000.0,
                        pitch_cents=fill.get("pitch_cents", 0.0))
                    if len(events) > before_count:
                        events[-1]["event_role"] = fill["role"]
                        events[-1]["fill_planner"] = fill_plan["planner"]
                        events[-1]["fill_reason"] = fill_plan["reason"]
                        if fill_plan.get("modal_profile"):
                            events[-1]["modal_profile"] = fill_plan["modal_profile"]
                            events[-1]["modal_tuning"] = fill_plan["modal_tuning"]
                            events[-1]["microtonal_audio_rendered"] = False
        phrase_tick += phrase_ticks + pause_ticks
    if len(events) > MAX_EVENTS:
        raise ValueError("Composition exceeds the sample renderer event limit")
    if phrase_tick * seconds_per_tick > MAX_DURATION_SECONDS:
        raise ValueError("Composition exceeds the 120-second sample renderer limit")
    return events


def render_composition_to_wav(
    plan: dict[str, Any],
    bank: SampleBank | dict[str, SampleBank],
    output_path: str | Path,
    *,
    instruments: dict[str, str] | None = None,
    mix_gains: dict[str, float] | None = None,
    parts: list[str] | None = None,
    sample_rate: int = 44100,
) -> dict[str, Any]:
    """Render a full composition or selected arrangement parts from recorded samples."""
    events = build_composition_events(plan, instruments=instruments, mix_gains=mix_gains)
    if parts is not None:
        allowed_parts = {
            "melody", "chords", "bass", "kick", "snare", "closed_hat",
            "open_hat", "contrabass", "cajon", "kalimba", "guitar", "strings", "electric_guitar",
        }
        if (not isinstance(parts, list) or not parts
                or any(not isinstance(part, str) or part not in allowed_parts for part in parts)
                or len(set(parts)) != len(parts)):
            raise ValueError("parts must be a non-empty list of unique composition part names")
        selected = set(parts)
        events = [event for event in events if event.get("part") in selected]
        if not events:
            raise ValueError("Selected composition parts produced no renderable events")
    return render_sample_events(events, bank, output_path, sample_rate=sample_rate)
