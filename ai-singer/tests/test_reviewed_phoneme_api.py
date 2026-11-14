import unittest

from fastapi import HTTPException

from server import analyze_lyrics


class ReviewedPhonemeApiTests(unittest.TestCase):
    def test_api_accepts_explicit_reviewed_phonemes(self):
        result = analyze_lyrics({
            "text": "سلام",
            "reviewed_phoneme_overrides": {"سلام": ["s", "æ", "l", "ɒː", "m"]},
        })
        self.assertFalse(result["review_required"])
        self.assertEqual(result["words"][0]["pronunciation_source"], "human_phoneme_override")

    def test_api_rejects_unknown_phoneme(self):
        with self.assertRaises(HTTPException) as error:
            analyze_lyrics({
                "text": "سلام",
                "reviewed_phoneme_overrides": {"سلام": ["v/uː/oː"]},
            })
        self.assertEqual(error.exception.status_code, 422)

    def test_api_rejects_non_list_phoneme_override(self):
        with self.assertRaises(HTTPException) as error:
            analyze_lyrics({
                "text": "سلام",
                "reviewed_phoneme_overrides": {"سلام": "s æ l"},
            })
        self.assertEqual(error.exception.status_code, 422)


if __name__ == "__main__":
    unittest.main()
