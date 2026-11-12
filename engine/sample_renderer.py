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

from sample_bank import SampleBank, select_sample
from midi_renderer import PPQ, _parse_chord, _voice_lead_chord

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
    bank: SampleBank,
    output_path: str | Path,
    *,
    sample_rate: int = 44100,
) -> dict[str, Any]:
    """Render recorded sample events into a stereo 16-bit PCM WAV file.

    Each event contains instrument, midi_note, start_seconds, duration_seconds,
    and optional velocity. Pitch shifting is simple sample-rate transposition;
    no time-stretching or artificial instrument synthesis is performed.
    """
    if not isinstance(bank, SampleBank):
        raise ValueError("A validated SampleBank is required")
    if not isinstance(events, list) or not events or len(events) > MAX_EVENTS:
        raise ValueError(f"events must contain 1 to {MAX_EVENTS} entries")
    if isinstance(sample_rate, bool) or not isinstance(sample_rate, int) or not 8000 <= sample_rate <= MAX_OUTPUT_RATE:
        raise ValueError("sample_rate must be an integer from 8000 to 48000")

    checked = []
    end_time = 0.0
    for event in events:
        if not isinstance(event, dict):
            raise ValueError("Each sample event must be an object")
        instrument = event.get("instrument")
        note = event.get("midi_note")
        start = event.get("start_seconds")
        duration = event.get("duration_seconds")
        velocity = event.get("velocity", 90)
        if not isinstance(instrument, str) or not instrument:
            raise ValueError("event instrument must be a non-empty string")
        if isinstance(note, bool) or not isinstance(note, int) or not 0 <= note <= 127:
            raise ValueError("event midi_note must be an integer from 0 to 127")
        if isinstance(start, bool) or not isinstance(start, (int, float)) or not math.isfinite(start) or start < 0:
            raise ValueError("event start_seconds must be finite and non-negative")
        if isinstance(duration, bool) or not isinstance(duration, (int, float)) or not math.isfinite(duration) or not 0 < duration <= MAX_DURATION_SECONDS:
            raise ValueError("event duration_seconds must be finite and positive")
        if isinstance(velocity, bool) or not isinstance(velocity, int) or not 1 <= velocity <= 127:
            raise ValueError("event velocity must be an integer from 1 to 127")
        sample = select_sample(bank, instrument, note, velocity)
        end_time = max(end_time, float(start) + float(duration))
        pan = event.get("pan", 0.0)
        if isinstance(pan, bool) or not isinstance(pan, (int, float)) or not math.isfinite(pan) or not -1.0 <= pan <= 1.0:
            raise ValueError("event pan must be between -1.0 and 1.0")
        checked.append((sample, note, float(start), float(duration), velocity, float(pan)))
    if end_time > MAX_DURATION_SECONDS:
        raise ValueError("Rendered audio may not exceed 120 seconds")

    frame_count = max(1, math.ceil(end_time * sample_rate))
    mix = array.array("f", [0.0]) * (frame_count * 2)
    rendered_events = 0
    for sample, target_note, start, duration, velocity, pan in checked:
        pcm, source_channels, source_rate = _read_sample(sample.path)
        source_frames = len(pcm) // source_channels
        semitone_ratio = 2.0 ** ((target_note - sample.midi_note) / 12.0)
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
        gain = (velocity / 127.0) ** 1.6 * 0.72
        pan_gains = (math.sqrt(1.0 - pan), math.sqrt(1.0 + pan))
        attack_frames = max(1, round(sample_rate * 0.004))
        release_frames = max(1, round(sample_rate * 0.025))
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
    for value in mix:
        clipped = max(-32768, min(32767, round(value * normalization)))
        output.append(clipped)
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
        "peak_before_normalization": round(peak / 32768.0, 5),
        "normalization_applied": round(normalization, 5),
        "source": "recorded_sample_bank",
    }


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


def build_composition_events(
    plan: dict[str, Any],
    *,
    instruments: dict[str, str] | None = None,
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
        "open_hat": "open_hat", "guitar": None, "strings": None,
        "electric_guitar": None,
    }
    if instruments is not None:
        if not isinstance(instruments, dict):
            raise ValueError("instruments must be a mapping of part names to bank slugs")
        for part, name in instruments.items():
            if part not in names or not isinstance(name, str) or not name:
                raise ValueError("Unknown part or invalid instrument-bank name")
            names[part] = name

    seconds_per_tick = 60.0 / bpm / PPQ
    events: list[dict[str, Any]] = []
    phrase_tick = 0
    chord_index = 0
    previous_voicing = None

    def add(part: str, note: int, start_tick: int, duration_ticks: int, velocity: int, pan: float = 0.0) -> None:
        events.append({
            "instrument": names[part],
            "midi_note": note,
            "start_seconds": round(start_tick * seconds_per_tick, 6),
            "duration_seconds": round(duration_ticks * seconds_per_tick, 6),
            "velocity": velocity,
            "pan": pan,
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
        section = phrase.get("section", "verse")
        dynamics = _section_sample_dynamics(section)
        cursor = phrase_tick
        peak_index = phrase.get("peak_note_index")
        for note_index, (note, duration) in enumerate(zip(notes, durations)):
            velocity = _melody_sample_velocity(
                88, cursor, section_scale=dynamics["melody"],
                is_peak=(isinstance(peak_index, int) and not isinstance(peak_index, bool)
                         and note_index == peak_index),
                is_cadence=(note_index == len(notes) - 1),
            )
            add("melody", note, cursor, max(1, int(duration * 0.88)), velocity)
            cursor += duration

        for bar in range(bars):
            bar_start = phrase_tick + bar * 4 * PPQ
            symbol = chords[chord_index % len(chords)]
            root_pc, _ = _parse_chord(symbol)
            voicing = _voice_lead_chord(symbol, previous_voicing)
            previous_voicing = voicing
            for voice_index, note in enumerate(voicing):
                add("chords", note, bar_start, 4 * PPQ - 24,
                    _scaled_velocity(58, dynamics["chords"]),
                    (-0.22, 0.0, 0.22)[voice_index])
            if names["guitar"]:
                for beat in range(4):
                    for voice_index, note in enumerate(voicing):
                        add("guitar", note, bar_start + beat * PPQ + voice_index * 18,
                            PPQ // 2, _scaled_velocity(54, dynamics["chords"]),
                            (-0.35, 0.0, 0.35)[voice_index])
            if names["strings"] and phrase.get("section") == "chorus":
                for voice_index, note in enumerate(voicing):
                    add("strings", note, bar_start, 4 * PPQ - 24,
                        _scaled_velocity(42, dynamics["chords"]),
                        (-0.3, 0.0, 0.3)[voice_index])
            if names["electric_guitar"] and phrase.get("section") == "chorus":
                add("electric_guitar", voicing[-1], bar_start + PPQ,
                    PPQ // 2, _scaled_velocity(68, dynamics["chords"]), 0.38)
                add("electric_guitar", voicing[-1] + 12, bar_start + 3 * PPQ,
                    PPQ // 2, _scaled_velocity(72, dynamics["chords"]), 0.42)
            root = 36 + root_pc
            bass_scale = dynamics["bass"]
            drum_scale = dynamics["drums"]
            if section == "bridge":
                add("bass", root, bar_start, 2 * PPQ - 36, _scaled_velocity(76, bass_scale))
                add("bass", root + 7, bar_start + 2 * PPQ, 2 * PPQ - 36,
                    _scaled_velocity(66, bass_scale))
                add("kick", 36, bar_start, 48, _scaled_velocity(88, drum_scale))
                add("snare", 38, bar_start + 2 * PPQ, 48, _scaled_velocity(62, drum_scale))
                for eighth in (0, 4):
                    add("closed_hat", 42, bar_start + eighth * (PPQ // 2), 48,
                        _scaled_velocity(52, drum_scale))
            else:
                add("bass", root, bar_start, 2 * PPQ - 36, _scaled_velocity(82, bass_scale))
                add("bass", root + 7, bar_start + 2 * PPQ, PPQ - 36, _scaled_velocity(82, bass_scale))
                add("bass", root, bar_start + 3 * PPQ, PPQ - 36, _scaled_velocity(82, bass_scale))
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
            chord_index += 1
        phrase_tick += phrase_ticks + pause_ticks
    if len(events) > MAX_EVENTS:
        raise ValueError("Composition exceeds the sample renderer event limit")
    if phrase_tick * seconds_per_tick > MAX_DURATION_SECONDS:
        raise ValueError("Composition exceeds the 120-second sample renderer limit")
    return events


def render_composition_to_wav(
    plan: dict[str, Any],
    bank: SampleBank,
    output_path: str | Path,
    *,
    instruments: dict[str, str] | None = None,
    sample_rate: int = 44100,
) -> dict[str, Any]:
    """Render the current composition plan using only its recorded bank samples."""
    events = build_composition_events(plan, instruments=instruments)
    return render_sample_events(events, bank, output_path, sample_rate=sample_rate)
