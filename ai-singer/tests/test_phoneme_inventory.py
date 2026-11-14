import unittest

from phoneme_inventory import (
    INVENTORY_VERSION,
    PHONEME_FEATURES,
    canonicalize_phoneme,
    validate_phoneme_sequence,
)


class PersianPhonemeInventoryTests(unittest.TestCase):
    def test_inventory_is_versioned(self):
        self.assertEqual(INVENTORY_VERSION, "mehran.fa.phonemes.v1")

    def test_contains_consonants_and_vowels(self):
        self.assertEqual(PHONEME_FEATURES["ʃ"]["kind"], "consonant")
        self.assertEqual(PHONEME_FEATURES["æ"]["kind"], "vowel")

    def test_canonicalizes_g_alias(self):
        self.assertEqual(canonicalize_phoneme("ɡ"), "g")

    def test_accepts_valid_sequence(self):
        self.assertEqual(validate_phoneme_sequence(["s", "æ", "l"]), ["s", "æ", "l"])

    def test_rejects_ambiguous_slash_alternatives(self):
        with self.assertRaisesRegex(ValueError, "unsupported"):
            validate_phoneme_sequence(["v/uː/oː"])

    def test_rejects_unknown_symbol(self):
        with self.assertRaisesRegex(ValueError, "unsupported"):
            validate_phoneme_sequence(["not-a-phone"])

    def test_rejects_empty_sequence(self):
        with self.assertRaisesRegex(ValueError, "non-empty"):
            validate_phoneme_sequence([])


if __name__ == "__main__":
    unittest.main()
