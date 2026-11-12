"""Dependency-free Standard MIDI File renderer for MEHRAN composition plans."""
from __future__ import annotations

import math
import struct
from itertools import combinations, permutations
from pathlib import Path
from typing import Any

PPQ = 480
MAX_NOTES = 4096
ROOTS = {"C": 0, "D": 2, "E": 4, "F": 5, "G": 7, "A": 9, "B": 11}


def _vlq(value: int) -> bytes:
    if value < 0:
        raise ValueError("MIDI delta time cannot be negative")
    buffer = value & 0x7F
    output = bytearray()
    while (value := value >> 7):
        buffer <<= 8
        buffer |= (value & 0x7F) | 0x80
    while True:
        output.append(buffer & 0xFF)
        if buffer & 0x80:
            buffer >>= 8
        else:
            break
    return bytes(output)


def _track(events: list[tuple[int, int, bytes]], name: str) -> bytes:
    encoded_name = name.encode("ascii")
    payload = bytearray(b"\\x00\\xff\\x03" + bytes([len(encoded_name)]) + encoded_name)
    previous = 0
    for tick, priority, message in sorted(events, key=lambda item: (item[0], item[1])):
        payload.extend(_vlq(tick - previous))
        payload.extend(message)
        previous = tick
    payload.extend(b"\\x00\\xff\\x2f\\x00")
    return b"MTrk" + struct.pack(">I", len(payload)) + payload


def _parse_chord(symbol: str) -> tuple[int, tuple[int, ...]]:
    if not isinstance(symbol, str) or not symbol or symbol[0] not in ROOTS:
        raise ValueError("Unsupported chord symbol in composition plan")
    root = ROOTS[symbol[0]]
    suffix = symbol[1:]
    if suffix.startswith("b"):
        root -= 1
        suffix = suffix[1:]
    elif suffix.startswith("#"):
        root += 1
        suffix = suffix[1:]
    if suffix.startswith("maj7") or suffix.startswith("M7"):
        intervals = (0, 4, 7, 11)
    elif suffix.startswith("m7"):
        intervals = (0, 3, 7, 10)
    elif suffix.startswith("dim7"):
        intervals = (0, 3, 6, 9)
    elif suffix.startswith("m"):
        intervals = (0, 3, 7)
        if "7" in suffix:
            intervals += (10,)
    else:
        intervals = (0, 4, 7)
        if "7" in suffix:
            intervals += (10,)
    return root % 12, intervals


def _chord_notes(symbol: str) -> tuple[int, ...]:
    root, intervals = _parse_chord(symbol)
    return tuple(60 + ((root + interval) % 12) for interval in intervals)


def _voice_lead_chord(symbol: str, previous: tuple[int, ...] | None = None) -> tuple[int, ...]:
    """Choose a close-position triad or seventh chord with minimum voice movement."""
    pitch_classes = tuple(dict.fromkeys(note % 12 for note in _chord_notes(symbol)))
    voice_count = len(pitch_classes)
    candidates = [note for note in range(48, 77) if note % 12 in pitch_classes]
    voicings = [combo for combo in combinations(candidates, voice_count)
                if len({note % 12 for note in combo}) == voice_count]
    if not voicings:
        raise ValueError("Could not construct a chord voicing")
    if previous is None or len(previous) != voice_count:
        return min(voicings, key=lambda combo: (sum(abs(note - 60) for note in combo),
                                                combo[-1] - combo[0]))
    return min(
        voicings,
        key=lambda combo: (
            min(sum(abs(a - b) for a, b in zip(order, combo))
                for order in permutations(previous)),
            sum(abs(note - 60) for note in combo),
        ),
    )


def _chord_inversion(symbol: str, voicing: tuple[int, ...]) -> str:
    """Describe root, first, second, or third inversion from the lowest chord tone."""
    root, intervals = _parse_chord(symbol)
    bass_pitch = voicing[0] % 12
    chord_tones = [(root + interval) % 12 for interval in intervals]
    names = ("root", "first", "second", "third")
    if bass_pitch in chord_tones:
        return names[chord_tones.index(bass_pitch)]
    raise ValueError("Voicing bass note is not a chord tone")


def _note_on(channel: int, note: int, velocity: int) -> bytes:
    return bytes((0x90 | channel, note, velocity))


def _note_off(channel: int, note: int) -> bytes:
    return bytes((0x80 | channel, note, 0))


def _pitch_bend(channel: int, cents: float, *, bend_range_cents: int = 200) -> bytes:
    """Encode pitch bend for a configured +/-2-semitone channel range."""
    if (isinstance(cents, bool) or not isinstance(cents, (int, float))
            or not math.isfinite(cents) or not -bend_range_cents <= cents <= bend_range_cents):
        raise ValueError("pitch_cents must be finite and between -200 and 200")
    value = max(0, min(16383, round(8192 + cents / bend_range_cents * 8192)))
    return bytes((0xE0 | channel, value & 0x7F, (value >> 7) & 0x7F))


def _melody_pitch_bend_setup() -> list[tuple[int, int, bytes]]:
    """Set channel 1 pitch-bend sensitivity to +/-2 semitones using MIDI RPN 0."""
    controls = ((101, 0), (100, 0), (6, 2), (38, 0), (101, 127), (100, 127))
    return [(0, 0, bytes((0xB0, controller, value)))
            for controller, value in controls]


def _scale_velocity(velocity: int, scale: float) -> int:
    """Apply a bounded section-dynamics multiplier to a MIDI velocity."""
    return max(1, min(127, round(velocity * scale)))


def _groove_velocity(base_velocity: int, beat: int, *, subdivision: int = 0,
                    section_scale: float = 1.0) -> int:
    """Deterministic groove accents for bass and percussion."""
    beat_scale = {0: 1.08, 1: 0.94, 2: 1.02, 3: 0.96}.get(beat % 4, 1.0)
    subdivision_scale = 0.94 if subdivision % 2 else 1.0
    return _scale_velocity(base_velocity, section_scale * beat_scale * subdivision_scale)


def _melody_velocity(base_velocity: int, tick_in_bar: int, *,
                     section_scale: float = 1.0,
                     is_peak: bool = False,
                     is_cadence: bool = False,
                     lexical_stress: bool = False,
                     stress_beat_aligned: bool = False,
                     cadence_release_scale: float = 1.0) -> int:
    """Shape melody velocity with meter, phrase and curated lexical-stress accents."""
    beat = (tick_in_bar % (PPQ * 4)) // PPQ
    beat_scale = {0: 1.08, 1: 0.96, 2: 1.03, 3: 0.97}[beat]
    phrase_scale = (1.05 if is_peak else 1.0) * (1.03 if is_cadence else 1.0)
    stress_scale = (1.10 if stress_beat_aligned else
                    1.07 if lexical_stress else 1.0)
    return _scale_velocity(base_velocity, section_scale * beat_scale * phrase_scale * stress_scale * max(0.75, min(1.0, cadence_release_scale)))


def _section_dynamics(section: str) -> dict[str, float]:
    """Return track-level velocity multipliers for the named song section."""
    name = section.lower()
    if "bridge" in name:
        return {"melody": 0.88, "chords": 0.72, "bass": 0.78, "drums": 0.62}
    if "final" in name and "chorus" in name:
        return {"melody": 1.12, "chords": 1.18, "bass": 1.16, "drums": 1.12}
    if "chorus" in name:
        return {"melody": 1.08, "chords": 1.12, "bass": 1.10, "drums": 1.08}
    if "pre_chorus" in name or "pre-chorus" in name:
        return {"melody": 1.02, "chords": 0.96, "bass": 0.96, "drums": 0.92}
    return {"melody": 0.88, "chords": 0.82, "bass": 0.86, "drums": 0.88}


def _transition_dynamics(dynamics: dict[str, float],
                          transition: dict[str, Any] | None,
                          *, is_transition_bar: bool) -> dict[str, float]:
    """Apply a subtle, bounded accompaniment lift or easing before a new section."""
    shaped = dict(dynamics)
    if not is_transition_bar or not isinstance(transition, dict):
        return shaped
    change = transition.get("energy_change")
    if isinstance(change, bool) or not isinstance(change, (int, float)):
        return shaped
    anticipation = max(0.96, min(1.04, 1.0 + float(change) * 0.20))
    for track in ("chords", "bass", "drums"):
        shaped[track] *= anticipation
    return shaped


def _bass_pattern(root_pc: int, bar_start: int,
                  events: list[tuple[int, int, bytes]], *,
                  chorus: bool = False, bridge: bool = False,
                  bar_index: int = 0, third_interval: int = 4,
                  velocity_scale: float = 1.0,
                  bass_root_pc: int | None = None,
                  bass_third_interval: int | None = None,
                  bass_fifth_interval: int | None = None) -> int:
    """Outline chord quality and inversion with root, third and fifth in the groove."""
    if third_interval not in (3, 4):
        raise ValueError("third_interval must be 3 (minor) or 4 (major)")
    root = 36 + root_pc
    bass_root = 36 + (root_pc if bass_root_pc is None else bass_root_pc)
    third = bass_root + (third_interval if bass_third_interval is None else bass_third_interval)
    fifth = bass_root + (7 if bass_fifth_interval is None else bass_fifth_interval)
    octave = root + 12
    if bridge:
        # Leave air in the bridge: root anchor, then a soft fifth response.
        pattern = [(0, bass_root, PPQ * 2 - 36, 62),
                   (PPQ * 2, fifth, PPQ * 2 - 36, 54)]
    elif chorus:
        # Beat 1 and beat 3 reinforce the kick; the offbeat fifth adds forward motion.
        pattern = [(0, bass_root, PPQ - 36, 88),
                   (PPQ + PPQ // 2, fifth, PPQ // 2 - 24, 72),
                   (PPQ * 2, bass_root + 12, PPQ - 36, 84),
                   (PPQ * 3, third if bar_index % 2 == 0 else fifth,
                    PPQ - 36, 78)]
    else:
        pattern = [(0, bass_root, PPQ * 2 - 36, 78),
                   (PPQ * 2, third, PPQ - 36, 68),
                   (PPQ * 3, fifth, PPQ - 36, 72)]
    for offset, note, gate, velocity in pattern:
        start = bar_start + offset
        beat = (offset // PPQ) % 4
        subdivision = (offset % PPQ) // (PPQ // 2)
        shaped_velocity = _groove_velocity(
            velocity, beat, subdivision=subdivision,
            section_scale=velocity_scale)
        events.append((start, 2, _note_on(2, note, shaped_velocity)))
        events.append((start + gate, 1, _note_off(2, note)))
    return len(pattern)


def _drum_bar(bar_start: int, events: list[tuple[int, int, bytes]], *,
              chorus: bool = False, bridge: bool = False,
              bar_index: int = 0, phrase_bars: int = 1,
              velocity_scale: float = 1.0) -> int:
    """Add distinct verse, chorus and bridge grooves plus a short phrase-end fill."""
    if bridge:
        hits = [(0, 36, 78), (PPQ * 2, 38, 68)]
        hat_steps = (0, 2, 4, 6)
    elif chorus:
        hits = [(0, 36, 112), (PPQ + PPQ // 2, 36, 88),
                (PPQ * 2, 36, 104), (PPQ, 38, 98),
                (PPQ * 3, 38, 104)]
        hat_steps = tuple(range(8))
    else:
        hits = [(0, 36, 96), (PPQ * 2, 36, 82),
                (PPQ, 38, 82), (PPQ * 3, 38, 90)]
        hat_steps = (0, 2, 4, 6)
    for eighth in hat_steps:
        is_open = chorus and eighth == 7
        hits.append((eighth * (PPQ // 2), 46 if is_open else 42,
                     78 if is_open else (68 if bridge else 72)))
    # A compact snare/tom pickup on the final bar of a multi-bar phrase.
    if chorus and phrase_bars > 1 and bar_index == phrase_bars - 1:
        hits.extend([(PPQ * 3 + PPQ // 2, 45, 76),
                     (PPQ * 3 + PPQ * 3 // 4, 47, 84)])
    for offset, note, velocity in hits:
        start = bar_start + offset
        events.append((start, 2, _note_on(9, note, _groove_velocity(velocity, offset // PPQ, subdivision=(offset % PPQ) // (PPQ // 2), section_scale=velocity_scale))))
        events.append((start + 48, 1, _note_off(9, note)))
    return len(hits)


def _guitar_bar(chord: tuple[int, ...], bar_start: int,
                events: list[tuple[int, int, bytes]], *,
                section: str = "verse", velocity_scale: float = 1.0) -> int:
    """Add a restrained picked verse, strummed chorus, or sparse bridge guitar."""
    name = section.lower()
    count = 0
    if "bridge" in name:
        pattern = [(0, 0), (PPQ * 2, 1)]
        gate, base_velocity = PPQ - 36, 48
    elif "chorus" in name:
        # Four compact down-strums, with a small natural string-to-string rake.
        pattern = [(beat * PPQ, voice)
                   for beat in range(4) for voice in range(len(chord))]
        gate, base_velocity = PPQ * 3 // 4, 66
    else:
        # Eight-note arpeggio, alternating root, fifth and inner chord tones.
        order = (0, 2, 1, 3, 0, 2, 1, 3) if len(chord) > 3 else (0, 2, 1, 2, 0, 2, 1, 2)
        pattern = [(step * (PPQ // 2), order[step]) for step in range(8)]
        gate, base_velocity = PPQ // 2 - 36, 54
    for offset, voice_index in pattern:
        note = chord[voice_index % len(chord)]
        velocity = _groove_velocity(
            base_velocity, offset // PPQ,
            subdivision=(offset % PPQ) // (PPQ // 2),
            section_scale=velocity_scale)
        start = bar_start + offset + (voice_index * 12 if "chorus" in name else 0)
        events.append((start, 2, _note_on(3, note, velocity)))
        events.append((start + gate, 1, _note_off(3, note)))
        count += 1
    return count


def _string_pad_bar(chord: tuple[int, ...], bar_start: int,
                    events: list[tuple[int, int, bytes]], *,
                    section: str = "verse", velocity_scale: float = 1.0) -> int:
    """Shape the string bed by section instead of repeating static piano-like chords."""
    name = section.lower()
    if "bridge" in name:
        voices = (0, 2)
        gate = PPQ * 4 - 36
        velocity = 38
    elif "chorus" in name:
        voices = tuple(range(len(chord))) if len(chord) > 3 else (0, 1, 2)
        gate = PPQ * 4 - 48
        velocity = 54
    else:
        voices = tuple(range(len(chord))) if len(chord) > 3 else (0, 1, 2)
        gate = PPQ * 4 - 24
        velocity = 43
    for voice_index in voices:
        note = chord[voice_index]
        events.append((bar_start, 2, _note_on(1, note,
                                              _scale_velocity(velocity, velocity_scale))))
        events.append((bar_start + gate, 1, _note_off(1, note)))
    if "chorus" in name:
        # A restrained upper octave adds lift without changing the chord identity.
        note = chord[0] + 12
        events.append((bar_start, 2, _note_on(1, note,
                                              _scale_velocity(velocity - 8, velocity_scale))))
        events.append((bar_start + gate, 1, _note_off(1, note)))
    return len(voices) + (1 if "chorus" in name else 0)


def _piano_bar(chord: tuple[int, ...], bar_start: int,
               events: list[tuple[int, int, bytes]], *,
               section: str = "verse", velocity_scale: float = 1.0) -> int:
    """Add flowing verse, wider chorus and sparse bridge piano patterns."""
    name = section.lower()
    if "bridge" in name:
        pattern = [(0, 0, PPQ * 2), (PPQ * 2, 2, PPQ * 2)]
        base_velocity = 42
    elif "chorus" in name:
        pattern = [(step * (PPQ // 2), (step // 2) % len(chord), PPQ // 2 - 24)
                   for step in range(8)]
        pattern.extend([(0, 0, PPQ - 36), (PPQ * 2, 2, PPQ - 36)])
        base_velocity = 58
    else:
        pattern = [(step * PPQ, step % len(chord), PPQ - 36) for step in range(4)]
        base_velocity = 46
    for offset, voice_index, gate in pattern:
        note = chord[voice_index] + (12 if "chorus" in name and offset in (0, PPQ * 2) and len(pattern) > 8 else 0)
        velocity = _groove_velocity(base_velocity, offset // PPQ,
                                    subdivision=(offset % PPQ) // (PPQ // 2),
                                    section_scale=velocity_scale)
        start = bar_start + offset
        events.append((start, 2, _note_on(4, note, velocity)))
        events.append((start + gate, 1, _note_off(4, note)))
    return len(pattern)


def render_midi(plan: dict[str, Any], output_path: str | Path) -> dict[str, Any]:
    """Render melody, chords, bass and percussion to a Standard MIDI file."""
    try:
        composition = plan["composition"]
        bpm, melody, chords = (composition["tempo_bpm"],
                               composition["melody"],
                               composition["chord_progression"])
    except (KeyError, TypeError) as exc:
        raise ValueError("Invalid MEHRAN composition plan") from exc
    if isinstance(bpm, bool) or not isinstance(bpm, int) or not 50 <= bpm <= 200:
        raise ValueError("Plan tempo must be an integer between 50 and 200 BPM")
    if not isinstance(melody, list) or not melody or len(melody) > 160:
        raise ValueError("Plan melody must contain 1 to 160 lyric lines")
    if not isinstance(chords, list) or not chords:
        raise ValueError("Plan must contain a chord progression")
    tempo_us = round(60_000_000 / bpm)
    melody_events: list[tuple[int, int, bytes]] = []
    chord_events: list[tuple[int, int, bytes]] = []
    bass_events: list[tuple[int, int, bytes]] = []
    drum_events: list[tuple[int, int, bytes]] = []
    guitar_events: list[tuple[int, int, bytes]] = []
    piano_events: list[tuple[int, int, bytes]] = []
    note_count, phrase_start, chord_bar_index = 0, 0, 0
    previous_voicing = None
    chord_voicings = []
    bass_note_count = drum_hit_count = guitar_note_count = piano_note_count = 0
    for phrase in melody:
        if not isinstance(phrase, dict):
            raise ValueError("Each melody phrase must be an object")
        notes = phrase.get("midi_notes")
        bars = phrase.get("bar_count", 1)
        durations = phrase.get("note_durations_ticks")
        if (not isinstance(notes, list) or not notes or
                any(isinstance(n, bool) or not isinstance(n, int) or not 48 <= n <= 96 for n in notes)):
            raise ValueError("Each phrase needs MIDI notes in the supported range (48-96)")
        if isinstance(bars, bool) or not isinstance(bars, int) or not 1 <= bars <= 3:
            raise ValueError("Phrase bar_count must be between 1 and 3")
        phrase_ticks = bars * PPQ * 4
        if durations is None:
            step = phrase_ticks // len(notes)
            durations = [step] * len(notes)
            durations[-1] += phrase_ticks - sum(durations)
        if (not isinstance(durations, list) or len(durations) != len(notes) or
                any(isinstance(d, bool) or not isinstance(d, int) or d <= 0 for d in durations) or
                sum(durations) != phrase_ticks):
            raise ValueError("Note durations must be positive and exactly fill the phrase")
        section = str(phrase.get("section", "verse"))
        dynamics = _section_dynamics(section)
        cursor = phrase_start
        peak_index = phrase.get("peak_note_index")
        lyric_map = phrase.get("note_lyric_map", [])
        stressed_note_indices = {
            item.get("note_index") for item in lyric_map
            if isinstance(item, dict)
            and item.get("is_lexically_stressed") is True
            and item.get("stress_confidence") == "curated"
        }
        beat_aligned_stress_indices = {
            item.get("note_index") for item in lyric_map
            if isinstance(item, dict)
            and item.get("is_lexically_stressed") is True
            and item.get("stress_confidence") == "curated"
            and item.get("stress_beat_alignment") == "aligned"
        }
        for note_index, (note, duration) in enumerate(zip(notes, durations)):
            lyric_map_item = lyric_map[note_index] if note_index < len(lyric_map) else {}
            gate_ratio = lyric_map_item.get("gate_ratio", 0.88) if isinstance(lyric_map_item, dict) else 0.88
            if (isinstance(gate_ratio, bool) or not isinstance(gate_ratio, (int, float))
                    or not 0.1 <= gate_ratio <= 1.0):
                raise ValueError("Melody gate_ratio must be between 0.1 and 1.0")
            gate = max(1, int(duration * gate_ratio))
            velocity = _melody_velocity(
                88, cursor, section_scale=dynamics["melody"],
                is_peak=(isinstance(peak_index, int) and note_index == peak_index),
                is_cadence=(note_index == len(notes) - 1),
                lexical_stress=note_index in stressed_note_indices,
                stress_beat_aligned=note_index in beat_aligned_stress_indices,
                cadence_release_scale=(phrase.get("phrase_energy", {}).get("cadence_release_scale", 1.0)
                                      if note_index == len(notes) - 1 else 1.0))
            dynamics_velocity = lyric_map_item.get("dynamics_velocity", 84) if isinstance(lyric_map_item, dict) else 84
            if isinstance(dynamics_velocity, bool) or not isinstance(dynamics_velocity, int) or not 1 <= dynamics_velocity <= 127:
                raise ValueError("Melody dynamics_velocity must be an integer from 1 to 127")
            velocity = _scale_velocity(velocity, dynamics_velocity / 84.0)
            pitch_cents = lyric_map_item.get("pitch_cents", 0.0) if isinstance(lyric_map_item, dict) else 0.0
            if (isinstance(pitch_cents, bool) or not isinstance(pitch_cents, (int, float))
                    or not math.isfinite(pitch_cents) or not -200.0 <= pitch_cents <= 200.0):
                raise ValueError("Melody pitch_cents must be finite and between -200 and 200")
            if pitch_cents:
                melody_events.append((cursor, 2, _pitch_bend(0, pitch_cents)))
            melody_events.append((cursor, 2, _note_on(0, note, velocity)))
            melody_events.append((cursor + gate, 1, _note_off(0, note)))
            if pitch_cents:
                melody_events.append((cursor + gate, 1, _pitch_bend(0, 0.0)))
            articulation = lyric_map_item.get("articulation") if isinstance(lyric_map_item, dict) else None
            release_ms = lyric_map_item.get("release_ms", 25) if isinstance(lyric_map_item, dict) else 25
            if isinstance(release_ms, bool) or not isinstance(release_ms, int) or not 0 <= release_ms <= 1000:
                raise ValueError("Melody release_ms must be an integer from 0 to 1000")
            if isinstance(articulation, str) and articulation:
                marker = (f"articulation={articulation};note={note};index={note_index};"
                          f"gate_ratio={gate_ratio:.2f};release_ms={release_ms};"
                          f"dynamics_velocity={dynamics_velocity};"
                          f"dynamic_mark={lyric_map_item.get('dynamic_mark', 'mf')}").encode("ascii", "strict")
                melody_events.append((cursor, 3, b"\xff\x06" + _vlq(len(marker)) + marker))
            cursor += duration
            note_count += 1
        transition = phrase.get("phrase_energy", {}).get("section_transition")
        for bar in range(bars):
            bar_start = phrase_start + bar * PPQ * 4
            bar_dynamics = _transition_dynamics(
                dynamics, transition, is_transition_bar=(bar == bars - 1))
            phrase_chord = phrase.get("chord")
            symbol = (phrase_chord if bar == 0 and isinstance(phrase_chord, str)
                      else chords[chord_bar_index % len(chords)])
            root_pc, chord_intervals = _parse_chord(symbol)
            chord = _voice_lead_chord(symbol, previous_voicing)
            chord_voicings.append({
                "symbol": symbol,
                "midi_notes": list(chord),
                "inversion": _chord_inversion(symbol, chord),
            })
            previous_voicing = chord
            note_count += _string_pad_bar(
                chord, bar_start, chord_events, section=section,
                velocity_scale=bar_dynamics["chords"])
            is_chorus = "chorus" in section.lower()
            is_bridge = "bridge" in section.lower()
            bass_root_pc = chord[0] % 12
            bass_intervals = sorted(
                (root_pc + interval - bass_root_pc) % 12
                for interval in chord_intervals
                if (root_pc + interval - bass_root_pc) % 12
            )
            bass_note_count += _bass_pattern(
                root_pc, bar_start, bass_events,
                chorus=is_chorus, bridge=is_bridge, bar_index=bar,
                third_interval=chord_intervals[1],
                velocity_scale=bar_dynamics["bass"],
                bass_root_pc=bass_root_pc,
                bass_third_interval=bass_intervals[0],
                bass_fifth_interval=bass_intervals[-1])
            drum_hit_count += _drum_bar(
                bar_start, drum_events, chorus=is_chorus, bridge=is_bridge,
                bar_index=bar, phrase_bars=bars,
                velocity_scale=bar_dynamics["drums"])
            guitar_note_count += _guitar_bar(
                chord, bar_start, guitar_events, section=section,
                velocity_scale=bar_dynamics["chords"])
            piano_note_count += _piano_bar(
                chord, bar_start, piano_events, section=section,
                velocity_scale=bar_dynamics["chords"])
            chord_bar_index += 1
        pause_ticks = phrase.get("phrase_pause_ticks", 0)
        if (isinstance(pause_ticks, bool) or not isinstance(pause_ticks, int)
                or pause_ticks < 0 or pause_ticks > PPQ * 2):
            raise ValueError("phrase_pause_ticks must be an integer between 0 and 960")
        phrase_start += phrase_ticks + pause_ticks
    note_count += bass_note_count + drum_hit_count + guitar_note_count + piano_note_count
    if note_count > MAX_NOTES:
        raise ValueError("Composition exceeds the 4096-note safety limit")
    conductor = _track([
        (0, 0, b"\\xff\\x51\\x03" + tempo_us.to_bytes(3, "big")),
        (0, 1, b"\\xff\\x58\\x04\\x04\\x02\\x18\\x08"),
    ], "MEHRAN Tempo")
    melody_events[0:0] = _melody_pitch_bend_setup()
    melody_events.insert(0, (0, 0, bytes((0xC0, 80))))  # Lead 1 square: melody guide
    chord_events.insert(0, (0, 0, bytes((0xC1, 48))))  # String Ensemble 1
    bass_events.insert(0, (0, 0, bytes((0xC2, 33))))  # Fingered electric bass
    guitar_events.insert(0, (0, 0, bytes((0xC3, 25))))  # Steel-string acoustic guitar
    piano_events.insert(0, (0, 0, bytes((0xC4, 0))))  # Acoustic Grand Piano
    tracks = [conductor, _track(melody_events, "MEHRAN Melody Guide"),
              _track(chord_events, "MEHRAN Strings"),
              _track(bass_events, "MEHRAN Bass"),
              _track(drum_events, "MEHRAN Drums"),
              _track(guitar_events, "MEHRAN Guitar"),
              _track(piano_events, "MEHRAN Piano")]
    midi = b"MThd" + struct.pack(">IHHH", 6, 1, len(tracks), PPQ) + b"".join(tracks)
    target = Path(output_path)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(midi)
    articulation_marker_count = sum(
        1 for _, _, message in melody_events
        if message.startswith(b"\xff\x06")
    )
    return {
        "path": str(target), "format": "Standard MIDI File", "tracks": len(tracks),
        "articulation_markers": articulation_marker_count,
        "articulation_rendering": "MIDI marker metadata only; playback timbre depends on the instrument and player",
        "pitch_bend_support": "per-note melody pitch_cents, +/-200 cents via MIDI channel pitch bend",
        "tempo_bpm": bpm, "note_events": note_count, "duration_ticks": phrase_start,
        "bass_note_events": bass_note_count, "drum_hits": drum_hit_count,
        "guitar_note_events": guitar_note_count, "piano_note_events": piano_note_count,
        "drum_channel": 10, "chord_voicings": chord_voicings,
        "duration_seconds": round(phrase_start / PPQ * 60 / bpm, 2),
        "bytes": len(midi),
    }
