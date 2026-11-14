import unittest

from persian_lyrics import analyze_persian_lyrics, normalize_persian_text


class PersianLyricsTests(unittest.TestCase):
    def test_normalizes_arabic_variants_and_spacing(self):
        self.assertEqual(normalize_persian_text("  كِتاب\nي "), "کِتاب ی")

    def test_unvowelled_words_are_flagged_for_review(self):
        result = analyze_persian_lyrics("سلام دنیا")
        self.assertEqual(result["word_count"], 2)
        self.assertTrue(result["review_required"])
        self.assertEqual(result["words"][0]["pronunciation_source"], "unresolved")
        self.assertEqual(result["syllable_count"], 0)

    def test_human_override_splits_syllables(self):
        result = analyze_persian_lyrics("سلام", {"سلام": "سَ-لام"})
        word = result["words"][0]
        self.assertEqual(word["syllables"], ["سَ", "لام"])
        self.assertEqual(word["syllable_count"], 2)
        self.assertFalse(word["needs_review"])

    def test_punctuation_does_not_join_words(self):
        result = analyze_persian_lyrics("سلام، دنیا!")
        self.assertEqual([item["text"] for item in result["words"]], ["سلام", "دنیا"])


if __name__ == "__main__":
    unittest.main()
