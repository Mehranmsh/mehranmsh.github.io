import unittest

from lyric_alignment import AlignmentError, align_lyrics_to_midi


def lyrics(words):
    return {"words": words}


def word(text, index, syllables, needs_review=False):
    return {"text": text, "index": index, "syllables": syllables, "needs_review": needs_review}


def melody(count):
    return {"notes": [
        {"note": f"C{4 + i}", "startSeconds": float(i), "durationSeconds": 0.5}
        for i in range(count)
    ]}


class LyricAlignmentTests(unittest.TestCase):
    def test_equal_counts_make_reviewable_structural_proposal(self):
        result = align_lyrics_to_midi(
            lyrics([word("سلام", 0, ["سَ", "لام"])]), melody(2)
        )
        self.assertTrue(result["proposal_ready"])
        self.assertFalse(result["alignment_ready"])
        self.assertEqual([item["note_indices"] for item in result["alignment"]], [[0], [1]])

    def test_manual_groups_support_melisma(self):
        result = align_lyrics_to_midi(
            lyrics([word("سلام", 0, ["سَ", "لام"])]), melody(3), [[0, 1], [2]]
        )
        self.assertTrue(result["alignment_ready"])
        self.assertTrue(result["alignment"][0]["melisma"])
        self.assertEqual(result["alignment"][0]["notes"], ["C4", "C5"])
        self.assertEqual(result["unassigned_notes"], [])

    def test_mismatch_does_not_guess(self):
        result = align_lyrics_to_midi(
            lyrics([word("سلام", 0, ["سَ", "لام"])]), melody(3)
        )
        self.assertFalse(result["proposal_ready"])
        self.assertEqual(result["alignment"], [])
        self.assertEqual(result["unassigned_syllables"], [0, 1])

    def test_rejects_overlapping_groups(self):
        with self.assertRaises(AlignmentError):
            align_lyrics_to_midi(
                lyrics([word("سلام", 0, ["سَ", "لام"])]), melody(3), [[0, 1], [1, 2]]
            )

    def test_rejects_out_of_order_groups(self):
        with self.assertRaises(AlignmentError):
            align_lyrics_to_midi(
                lyrics([word("سلام", 0, ["سَ", "لام"])]), melody(3), [[1], [0]]
            )

    def test_rejects_out_of_range_note(self):
        with self.assertRaises(AlignmentError):
            align_lyrics_to_midi(
                lyrics([word("سلام", 0, ["سَ", "لام"])]), melody(2), [[0], [2]]
            )

    def test_unresolved_word_blocks_alignment(self):
        result = align_lyrics_to_midi(
            lyrics([word("دنیا", 0, [], needs_review=True)]), melody(2)
        )
        self.assertFalse(result["alignment_ready"])
        self.assertEqual(result["unresolved_words"], ["دنیا"])


if __name__ == "__main__":
    unittest.main()
