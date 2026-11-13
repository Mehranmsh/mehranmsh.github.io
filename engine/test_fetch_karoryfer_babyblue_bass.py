"""Tests for pinned Babyblue SFZ velocity and round-robin mapping."""
from __future__ import annotations

import unittest

from fetch_karoryfer_babyblue_bass import parse_babyblue_map


def fixture(layer: str) -> str:
    rr_count = 4 if layer == "f" else 8
    regions = []
    for position in range(1, 9):
        rr = ((position - 1) % rr_count) + 1
        regions.append(
            f"<region>\nsample=..\\Samples\\babyblue\\reg\\babyblue_b1_{layer}_rr{rr}.wav\n"
            f"lokey=35\nhikey=35\nseq_length=8\nseq_position={position}\npitch_keycenter=35\n"
        )
    return "\n".join(regions)


class BabyblueSFZTests(unittest.TestCase):
    def test_low_velocity_layer_collapses_four_unique_takes(self):
        samples = parse_babyblue_map(fixture("f"), "f", require_complete=False)
        self.assertEqual(len(samples), 4)
        self.assertEqual({x["round_robin_index"] for x in samples}, {0, 1, 2, 3})

    def test_high_velocity_layer_preserves_eight_unique_takes(self):
        samples = parse_babyblue_map(fixture("ff"), "ff", require_complete=False)
        self.assertEqual(len(samples), 8)
        self.assertEqual({x["round_robin_index"] for x in samples}, set(range(8)))

    def test_rejects_pitch_keycenter_mismatch(self):
        sfz = fixture("f").replace("pitch_keycenter=35", "pitch_keycenter=36")
        with self.assertRaisesRegex(ValueError, "exact recorded pitch"):
            parse_babyblue_map(sfz, "f", require_complete=False)

    def test_rejects_missing_round_robin_take(self):
        sfz = fixture("ff").replace("_rr8.wav", "_rr7.wav")
        with self.assertRaisesRegex(ValueError, "incomplete recorded round-robin takes"):
            parse_babyblue_map(sfz, "ff", require_complete=False)

    def test_rejects_unknown_layer(self):
        with self.assertRaisesRegex(ValueError, "Unsupported"):
            parse_babyblue_map(fixture("f"), "mf", require_complete=False)


if __name__ == "__main__":
    unittest.main()
