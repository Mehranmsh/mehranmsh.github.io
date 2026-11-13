                else:
                    add("contrabass", bass_root, bar_start, PPQ + PPQ // 2,
                        _scaled_velocity(62, bass_scale), -0.08,
                        articulation="pizzicato", articulation_source="instrument_default")
                    add("contrabass", bass_fifth, bar_start + 2 * PPQ,
                        PPQ + PPQ // 2, _scaled_velocity(54, bass_scale), -0.08,
                        articulation="pizzicato", articulation_source="instrument_default")
                    if section in ("pre_chorus", "chorus", "final_chorus"):
                        add("contrabass", bass_root, bar_start + int(1.5 * PPQ),
                            PPQ // 2 - 24, _scaled_velocity(46, bass_scale), -0.08,
                            articulation="pizzicato", articulation_source="instrument_default")
                        # Leave the late 3.5-beat cajon accent clear; the
                        # contrabass anticipates it on beat 3 instead.
                        add("contrabass", bass_fifth, bar_start + 3 * PPQ,
                            PPQ // 2 - 24, _scaled_velocity(42, bass_scale), -0.08,
                            articulation="pizzicato", articulation_source="instrument_default")
            if names["cajon"] is not None:
                # VCSL one-shots are restricted to their three recorded strokes:
                # bass=60, slap=61, tone=62. Only the rhythm/velocity varies.
                if section == "bridge":
                    cajon_pattern = (
                        (0.0, 60, 74, "bass"),
                        (2.0, 61, 56, "slap"),
                    )
                elif section == "verse":
                    cajon_pattern = (
                        (0.0, 60, 88, "bass"),
                        (1.0, 61, 82, "slap"),
                        (3.0, 62, 72, "tone"),
                    )
                elif section == "pre_chorus":
                    cajon_pattern = (
                        (0.0, 60, 88, "bass"),
                        (1.0, 61, 78, "slap"),
                        (2.5, 62, 64, "tone"),
                        (3.5, 61, 70, "slap"),
                    )
                else:
                    cajon_pattern = (
                        (0.0, 60, 96, "bass"),
                        (1.0, 61, 88, "slap"),
                        (2.0, 60, 84, "bass"),
                        (2.5, 62, 72, "tone"),
                        (3.5, 61, 80, "slap"),
                    )
                for beat, note, velocity, articulation in cajon_pattern:
                    add("cajon", note, bar_start + int(beat * PPQ), 48,
                        _scaled_velocity(velocity, drum_scale),
                        articulation=articulation,
                        articulation_source="percussion_default")
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