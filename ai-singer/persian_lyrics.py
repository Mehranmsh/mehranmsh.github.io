"""Conservative Persian lyric normalization and human-reviewed phoneme annotation."""
from __future__ import annotations

import re
import unicodedata
from phoneme_inventory import validate_phoneme_sequence

CHAR_MAP = str.maketrans({
    "ي": "ی", "ى": "ی", "ك": "ک", "ۀ": "ه", "ة": "ه",
    "أ": "ا", "إ": "ا", "ٱ": "ا", "ـ": "",
    "ؤ": "و", "ئ": "ی",
})
DIACRITICS = {"َ": "æ", "ِ": "e", "ُ": "o", "ً": "an", "ٍ": "en", "ٌ": "on", "ّ": "gemination", "ْ": ""}
CONSONANTS = {
    "ب":"b","پ":"p","ت":"t","ث":"s","ج":"dʒ","چ":"tʃ","ح":"h","خ":"x",
    "د":"d","ذ":"z","ر":"ɾ","ز":"z","ژ":"ʒ","س":"s","ش":"ʃ","ص":"s",
    "ض":"z","ط":"t","ظ":"z","ع":"ʔ","غ":"ɣ","ف":"f","ق":"ɣ","ک":"k",
    "گ":"g","ل":"l","م":"m","ن":"n","ه":"h","و":None,"ی":None,
    "ء":"ʔ","ا":None,"آ":"ɒː",
}
WORD_RE = re.compile(r"[ء-يپچژگک‌یۀآأإؤئًٌٍَُِّْٰ]+(?:‌[ء-يپچژگک‌یۀآأإؤئًٌٍَُِّْٰ]+)*")


def normalize_persian_text(text: str) -> str:
    value = unicodedata.normalize("NFC", str(text or "")).translate(CHAR_MAP)
    value = value.replace("\u200f", "").replace("\u200e", "").replace("\ufeff", "")
    value = re.sub(r"[\t\r\n]+", " ", value)
    return re.sub(r"\s+", " ", value).strip()


def _grapheme_phonemes(syllable: str) -> tuple[list[str], bool]:
    phones: list[str] = []
    ambiguous = False
    for char in syllable:
        if char in DIACRITICS:
            phone = DIACRITICS[char]
            if phone and phone != "gemination":
                phones.append(phone)
            elif phone == "gemination":
                ambiguous = True
        elif char in CONSONANTS:
            phone = CONSONANTS[char]
            if phone is None:
                ambiguous = True
            else:
                phones.append(phone)
        elif char == "\u200c":
            continue
    return phones, ambiguous


def analyze_persian_lyrics(
    text: str,
    pronunciation_overrides: dict[str, str] | None = None,
    reviewed_phoneme_overrides: dict[str, list[str]] | None = None,
) -> dict:
    normalized = normalize_persian_text(text)
    overrides = {
        normalize_persian_text(key): normalize_persian_text(value)
        for key, value in (pronunciation_overrides or {}).items()
        if str(key).strip() and str(value).strip()
    }
    phone_overrides = {
        normalize_persian_text(key): validate_phoneme_sequence(value)
        for key, value in (reviewed_phoneme_overrides or {}).items()
        if str(key).strip()
    }
    words = []
    for index, match in enumerate(WORD_RE.finditer(normalized)):
        word = match.group(0)
        override = overrides.get(word)
        syllables = [part for part in re.split(r"[-‐‑–—\s]+", override) if part] if override else []
        source = "human_override" if override else "unresolved"
        needs_review = not bool(override)
        phonemes = []
        ambiguous = False
        for syllable in syllables:
            phones, uncertain = _grapheme_phonemes(syllable)
            phonemes.append({"text": syllable, "symbols": phones, "ambiguous_graphemes": uncertain})
            ambiguous = ambiguous or uncertain
        reviewed = phone_overrides.get(word)
        if reviewed:
            phonemes = [{"text": word, "symbols": reviewed, "ambiguous_graphemes": False}]
            source = "human_phoneme_override"
            needs_review = False
            ambiguous = False
        elif ambiguous:
            needs_review = True
        words.append({
            "index": index, "text": word, "start": match.start(), "end": match.end(),
            "syllables": syllables, "syllable_count": len(syllables), "phonemes": phonemes,
            "pronunciation_source": source, "needs_review": needs_review,
            "phoneme_ambiguity": ambiguous,
        })
    return {
        "normalization": "mehran.fa.normalize.v1",
        "phoneme_inventory": "mehran.fa.phonemes.v1",
        "text": normalized,
        "word_count": len(words),
        "syllable_count": sum(item["syllable_count"] for item in words),
        "words": words,
        "review_required": any(item["needs_review"] for item in words),
        "limitations": [
            "Unvowelled Persian spelling is often pronunciation-ambiguous.",
            "Syllable overrides do not guarantee resolved phonemes; use reviewed_phoneme_overrides for explicit canonical symbols.",
            "No automatic grapheme-to-phoneme model is claimed.",
        ],
    }
