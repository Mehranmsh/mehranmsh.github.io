"""Versioned phoneme inventory for reviewed Persian acoustic conditioning.

Symbols are canonical IPA-like labels. This inventory is not a G2P model:
ambiguous spellings must be resolved by a human or a separately evaluated model.
"""
from __future__ import annotations

INVENTORY_VERSION = "mehran.fa.phonemes.v1"

PHONEME_FEATURES = {
    "p": {"kind": "consonant", "place": "bilabial", "manner": "stop", "voiced": False},
    "b": {"kind": "consonant", "place": "bilabial", "manner": "stop", "voiced": True},
    "t": {"kind": "consonant", "place": "alveolar", "manner": "stop", "voiced": False},
    "d": {"kind": "consonant", "place": "alveolar", "manner": "stop", "voiced": True},
    "k": {"kind": "consonant", "place": "velar", "manner": "stop", "voiced": False},
    "g": {"kind": "consonant", "place": "velar", "manner": "stop", "voiced": True},
    "q": {"kind": "consonant", "place": "uvular", "manner": "stop", "voiced": False},
    "ʔ": {"kind": "consonant", "place": "glottal", "manner": "stop", "voiced": False},
    "f": {"kind": "consonant", "place": "labiodental", "manner": "fricative", "voiced": False},
    "v": {"kind": "consonant", "place": "labiodental", "manner": "fricative", "voiced": True},
    "s": {"kind": "consonant", "place": "alveolar", "manner": "fricative", "voiced": False},
    "z": {"kind": "consonant", "place": "alveolar", "manner": "fricative", "voiced": True},
    "ʃ": {"kind": "consonant", "place": "postalveolar", "manner": "fricative", "voiced": False},
    "ʒ": {"kind": "consonant", "place": "postalveolar", "manner": "fricative", "voiced": True},
    "x": {"kind": "consonant", "place": "velar", "manner": "fricative", "voiced": False},
    "ɣ": {"kind": "consonant", "place": "velar", "manner": "fricative", "voiced": True},
    "h": {"kind": "consonant", "place": "glottal", "manner": "fricative", "voiced": False},
    "tʃ": {"kind": "consonant", "place": "postalveolar", "manner": "affricate", "voiced": False},
    "dʒ": {"kind": "consonant", "place": "postalveolar", "manner": "affricate", "voiced": True},
    "m": {"kind": "consonant", "place": "bilabial", "manner": "nasal", "voiced": True},
    "n": {"kind": "consonant", "place": "alveolar", "manner": "nasal", "voiced": True},
    "l": {"kind": "consonant", "place": "alveolar", "manner": "lateral", "voiced": True},
    "ɾ": {"kind": "consonant", "place": "alveolar", "manner": "tap", "voiced": True},
    "r": {"kind": "consonant", "place": "alveolar", "manner": "trill", "voiced": True},
    "j": {"kind": "consonant", "place": "palatal", "manner": "approximant", "voiced": True},
    "æ": {"kind": "vowel", "height": "near_open", "backness": "front", "rounded": False},
    "e": {"kind": "vowel", "height": "close_mid", "backness": "front", "rounded": False},
    "o": {"kind": "vowel", "height": "close_mid", "backness": "back", "rounded": True},
    "ɒː": {"kind": "vowel", "height": "open", "backness": "back", "rounded": True, "length": "long"},
    "iː": {"kind": "vowel", "height": "close", "backness": "front", "rounded": False, "length": "long"},
    "uː": {"kind": "vowel", "height": "close", "backness": "back", "rounded": True, "length": "long"},
}

ALIASES = {"g": "g", "ɡ": "g", "ʤ": "dʒ", "ʧ": "tʃ"}


def canonicalize_phoneme(symbol: str) -> str:
    value = str(symbol).strip()
    return ALIASES.get(value, value)


def validate_phoneme_sequence(symbols: list[str]) -> list[str]:
    if not isinstance(symbols, list) or not symbols:
        raise ValueError("phoneme sequence must be a non-empty list")
    result = [canonicalize_phoneme(item) for item in symbols]
    unknown = sorted(set(result) - set(PHONEME_FEATURES))
    if unknown:
        raise ValueError("unsupported phoneme symbols: " + ", ".join(unknown))
    return result
