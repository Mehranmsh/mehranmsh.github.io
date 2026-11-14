import unittest

from persian_lyrics import analyze_persian_lyrics


class ReviewedPersianPhonemeTests(unittest.TestCase):
    def test_unreviewed_word_stays_unresolved(self):
        result = analyze_persian_lyrics("سلام")
        self.assertTrue(result["review_required"])
        self.assertEqual(result["words"][0]["pronunciation_source"], "unresolved")

    def test_human_phoneme_override_is_canonical(self):
        result = analyze_persian_lyrics("سلام", reviewed_phoneme_overrides={"سلام": ["s", "æ", "l", "ɒː", "m"]})
        word = result["words"][0]
        self.assertFalse(word["needs_review"])
        self.assertEqual(word["pronunciation_source"], "human_phoneme_override")
        self.assertEqual(word["phonemes"][0]["symbols"], ["s", "æ", "l", "ɒː", "m"])

    def test_invalid_phoneme_override_rejected(self):
        with self.assertRaisesRegex(ValueError, "unsupported"):
            analyze_persian_lyrics("سلام", reviewed_phoneme_overrides={"سلام": ["v/uː/oː"]})

    def test_legacy_syllable_override_does_not_claim_resolved_phones(self):
        result = analyze_persian_lyrics("سلام", pronunciation_overrides={"سلام": "سَ-لام"})
        self.assertFalse(result["words"][0]["needs_review"])
        self.assertTrue(result["words"][0]["phoneme_ambiguity"])


if __name__ == "__main__":
    unittest.main()
