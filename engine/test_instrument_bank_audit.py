import unittest
from pathlib import Path

from sample_bank import Sample, SampleBank
from instrument_bank_audit import build_instrument_bank_audit


class InstrumentBankAuditTests(unittest.TestCase):
    def sample(self, note, velocity_min, velocity_max, rr, articulation="pick",
               zone=(35, 47), one_shot=False, string_name=None):
        return Sample(
            instrument="electric_bass", midi_note=note,
            path=Path(f"/unused/{note}-{velocity_min}-{rr}.wav"),
            velocity_min=velocity_min, velocity_max=velocity_max,
            sample_rate=44100, channels=1, frames=44100,
            articulation=articulation, round_robin_index=rr,
            one_shot=one_shot, playable_key_min=zone[0],
            playable_key_max=zone[1], string_name=string_name,
        )

    def test_reports_real_roots_layers_zones_articulations_and_rr(self):
        bank = SampleBank(Path("/unused"), (
            self.sample(35, 1, 63, 0),
            self.sample(35, 1, 63, 1),
            self.sample(35, 64, 127, 0),
            self.sample(47, 1, 63, 0, zone=(47, 59)),
            self.sample(47, 1, 63, 1, zone=(47, 59)),
            self.sample(47, 64, 127, 0, zone=(47, 59)),
        ))
        report = build_instrument_bank_audit(bank)
        item = report["instruments"]["electric_bass"]
        self.assertEqual(report["bank_sample_entries"], 6)
        self.assertEqual(item["recorded_pitch_centers"], 2)
        self.assertEqual(item["recorded_midi_notes"], [35, 47])
        self.assertEqual(item["articulations"], ["pick"])
        self.assertEqual(item["velocity_intervals"], [
            {"min": 1, "max": 63}, {"min": 64, "max": 127}
        ])
        self.assertEqual(item["velocity_gaps_by_recorded_note_and_articulation"], [])
        self.assertEqual(item["round_robin"]["depth_distribution"], {"1": 2, "2": 2})
        self.assertEqual(item["declared_playable_key_zones"], [
            {"min": 35, "max": 47}, {"min": 47, "max": 59}
        ])
        self.assertTrue(report["read_only"])

    def test_reports_velocity_gaps_and_round_robin_start_gaps(self):
        bank = SampleBank(Path("/unused"), (
            self.sample(40, 1, 50, 1),
            self.sample(40, 70, 127, 2),
        ))
        item = build_instrument_bank_audit(bank)["instruments"]["electric_bass"]
        self.assertEqual(
            item["velocity_gaps_by_recorded_note_and_articulation"][0]["uncovered_ranges"],
            [{"min": 51, "max": 69}],
        )
        self.assertEqual(
            item["round_robin"]["groups_with_non_contiguous_indices"][0]["expected_indices"],
            [0],
        )

    def test_does_not_hide_non_contiguous_round_robin_indices(self):
        bank = SampleBank(Path("/unused"), (
            self.sample(40, 1, 127, 0),
            self.sample(40, 1, 127, 2),
        ))
        item = build_instrument_bank_audit(bank)["instruments"]["electric_bass"]
        self.assertEqual(
            item["round_robin"]["groups_with_non_contiguous_indices"][0]["indices"],
            [0, 2],
        )


if __name__ == "__main__":
    unittest.main()
