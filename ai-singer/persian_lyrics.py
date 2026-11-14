"""Conservative Persian lyric normalization and pronunciation annotation.

This module intentionally avoids pretending unvowelled Persian spelling has one
unambiguous pronunciation. Human-confirmed syllable overrides take precedence.
"""
from __future__ import annotations

import re
import unicodedata

CHAR_MAP = str.maketrans({
    "ي": "ی", "ى": "ی", "ك": "ک", "ۀ": "ه", "ة": "ه",
    "أ": "ا", "إ": "ا", "ٱ": "ا", "ـ": "",
    "ؤ": "و", "ئ": "ی",
})
DIACRITICS = {"َ": "a", "ِ": "e", "ُ": "o", "ً": "an", "ٍ": "en", "ٌ": "on", "ّ": "gemination", "ْ": ""}
CONSONANTS = {
    "ب":"b","پ":"p","ت":"t","ث":"s","ج":"dʒ","چ":"tʃ","ح":"h","خ":"x",
    "د":"d","ذ":"z","ر":"ɾ","ز":"z","ژ":"ʒ","س":"s","ش":"ʃ","ص":"s",
    "ض":"z","ط":"t","ظ":"z","ع":"ʔ","غ":"ɣ","ف":"f","ق":"ɣ","ک":"k",
    "گ":"ɡ","ل":"l","م":"m","ن":"n","ه":"h","و":"v/uː/oː","ی":"j/iː",
    "ء":"ʔ","ا":"ɒː/æ","آ":"ɒː",
}
WORD_RE = re.compile(r"[ء-يپچژگک‌یۀآأإؤئًٌٍَُِّْٰ]+(?:‌[ء-يپچژگک‌یۀآأإؤئًٌٍَُِّْٰ]+)*")


def normalize_persian_text(text: str) -> str:
    value = unicodedata.normalize("NFC", str(text or "")).translate(CHAR_MAP)
    value = value.replace("\u200f", "").replace("\u200e", "").replace("\ufeff", "")
    value = re.sub(r"[\t\r\n]+", " ", value)
    value = re.sub(r"\s+", " ", value).strip()
    return value


def _grapheme_phonemes(syllable: str) -> tuple[list[str], bool]:
    phones: list[str] = []
    ambiguous = False
    for char in syllable:
        if char in DIACRITICS:
            phone = DIACRITICS[char]
            if phone:
                phones.append(phone)
        elif char in CONSONANTS:
            phones.append(CONSONANTS[char])
            if "/" in CONSONANTS[char]:
                ambiguous = True
        elif char == "\u200c":
            continue
    return phones, ambiguous


def analyze_persian_lyrics(text: str, pronunciation_overrides: dict[str, str] | None = None) -> dict:
    normalized = normalize_persian_text(text)
    overrides = {
        normalize_persian_text(key): normalize_persian_text(value)
        for key, value in (pronunciation_overrides or {}).items()
        if str(key).strip() and str(value).strip()
    }
    words = []
    for index, match in enumerate(WORD_RE.finditer(normalized)):
        word = match.group(0)
        override = overrides.get(word)
        if override:
            syllables = [part for part in re.split(r"[-‐‑–—\s]+", override) if part]
            source = "human_override"
            needs_review = False
        else:
            # Without short-vowel marks, orthography alone cannot guarantee Persian syllable boundaries.
            syllables = []
            source = "unresolved"
            needs_review = True
        phonemes = []
        ambiguous = False
        for syllable in syllables:
            phones, uncertain = _grapheme_phonemes(syllable)
            phonemes.append({"text": syllable, "symbols": phones, "ambiguous_graphemes": uncertain})
            ambiguous = ambiguous or uncertain
        words.append({
            "index": index,
            "text": word,
            "start": match.start(),
            "end": match.end(),
            "syllables": syllables,
            "syllable_count": len(syllables),
            "phonemes": phonemes,
            "pronunciation_source": source,
            "needs_review": needs_review,\n            "phoneme_ambiguity": ambiguous,
        })
    return {
        "normalization": "mehran.fa.normalize.v1",
        "text": normalized,
        "word_count": len(words),
        "syllable_count": sum(item["syllable_count"] for item in words),
        "words": words,
        "review_required": any(item["needs_review"] for item in words),
        "limitations": [
            "Unvowelled Persian spelling is often pronunciation-ambiguous.",
            "Automatic syllable segmentation and full Persian phoneme conversion are not claimed.",
            "Add human-confirmed syllable overrides using hyphens, for example a word pronunciation written as بخش-ها.",
        ],
    }
