"""Build a fully offline, blinded A/B listening-review package for local WAV files.

No audio is uploaded. The package contains randomized opaque audio filenames,
a reviewer page, and a separate answer key that must be kept from reviewers.
"""
from __future__ import annotations

import argparse
import html
import json
import secrets
import shutil
import wave
from pathlib import Path, PurePosixPath


MAX_ITEMS = 500
MAX_WAV_BYTES = 100 * 1024 * 1024
MAX_TOTAL_AUDIO_BYTES = 2 * 1024 * 1024 * 1024


class ListeningReviewError(ValueError):
    """Raised when an offline listening review cannot be prepared safely."""


def _safe_source(root: Path, relative: str) -> Path:
    if not isinstance(relative, str) or not relative.strip():
        raise ListeningReviewError("audio path must be a non-empty relative path")
    rel = PurePosixPath(relative)
    if rel.is_absolute() or ".." in rel.parts or "\\" in relative:
        raise ListeningReviewError("unsafe audio path")
    candidate = root
    for part in rel.parts:
        candidate = candidate / part
        if candidate.is_symlink():
            raise ListeningReviewError("audio symlinks are not allowed")
    try:
        resolved = candidate.resolve(strict=True)
        resolved.relative_to(root)
    except (OSError, RuntimeError, ValueError) as exc:
        raise ListeningReviewError("audio file is missing or outside the audio root") from exc
    if not resolved.is_file():
        raise ListeningReviewError("audio input must be a regular file")
    if resolved.stat().st_size <= 0 or resolved.stat().st_size > MAX_WAV_BYTES:
        raise ListeningReviewError("audio file size is outside the permitted limit")
    try:
        with wave.open(str(resolved), "rb") as wav:
            if wav.getnchannels() != 1 or wav.getsampwidth() not in (2, 3, 4):
                raise ListeningReviewError("audio must be mono PCM WAV (16, 24, or 32 bit)")
            if wav.getframerate() < 8000 or wav.getframerate() > 192000 or wav.getnframes() <= 0:
                raise ListeningReviewError("audio sample rate or duration is invalid")
    except (wave.Error, EOFError) as exc:
        raise ListeningReviewError("audio input is not a readable PCM WAV") from exc
    return resolved


def _review_html(items: list[dict]) -> str:
    cards = []
    for item in items:
        cards.append(
            '<section class="item"><h2>Sample ' + str(item["index"]) + '</h2>'
            '<p>Listen to both versions, then rate each one independently.</p>'
            '<div class="players">'
            '<div><h3>Version A</h3><audio controls preload="none" src="' + item["a_src"] + '"></audio></div>'
            '<div><h3>Version B</h3><audio controls preload="none" src="' + item["b_src"] + '"></audio></div>'
            '</div>'
            '<fieldset><legend>Which version sounds more natural?</legend>'
            '<label><input type="radio" name="natural-' + str(item["index"]) + '" value="A"> A</label>'
            '<label><input type="radio" name="natural-' + str(item["index"]) + '" value="B"> B</label>'
            '<label><input type="radio" name="natural-' + str(item["index"]) + '" value="tie"> Tie</label>'
            '</fieldset>'
            '<fieldset><legend>Which version has clearer Persian pronunciation?</legend>'
            '<label><input type="radio" name="pronunciation-' + str(item["index"]) + '" value="A"> A</label>'
            '<label><input type="radio" name="pronunciation-' + str(item["index"]) + '" value="B"> B</label>'
            '<label><input type="radio" name="pronunciation-' + str(item["index"]) + '" value="tie"> Tie</label>'
            '</fieldset>'
            '<label class="notes">Notes (optional)<textarea name="notes-' + str(item["index"]) + '" rows="2"></textarea></label>'
            '</section>'
        )
    body = "\n".join(cards)
    return """<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="no-referrer"><title>Offline blind listening review</title>
<style>
:root{color-scheme:dark}body{font:16px system-ui,sans-serif;background:#101722;color:#edf4ff;max-width:900px;margin:2rem auto;padding:0 1rem}
h1{color:#8edcff}.item{background:#192536;border:1px solid #30445d;border-radius:14px;padding:1.2rem;margin:1.2rem 0}
.players{display:grid;grid-template-columns:1fr 1fr;gap:1rem}.players>div{background:#101a28;padding:1rem;border-radius:10px}
audio{width:100%;max-width:100%}fieldset{border:1px solid #40536b;border-radius:8px;margin:1rem 0;padding:.8rem}
label{margin-right:1rem}textarea{display:block;width:100%;box-sizing:border-box;background:#101a28;color:white;border:1px solid #52657d;border-radius:6px;padding:.6rem}
button{background:#1687bd;color:white;border:0;border-radius:8px;padding:.8rem 1.2rem;font-weight:700;cursor:pointer}
small{color:#b8c8da}.notes{display:block} @media(max-width:600px){.players{grid-template-columns:1fr}}
</style></head><body><h1>Blind listening review</h1>
<p>Review each pair without trying to identify the model. Use headphones if possible. Your answers are downloaded only when you press the export button.</p>
""" + body + """
<button id="export">Export review answers (JSON)</button> <small id="status" role="status"></small>
<script>
document.getElementById('export').addEventListener('click',()=>{
 const answers=[];
 document.querySelectorAll('.item').forEach((section)=>{
  const index=Number(section.querySelector('h2').textContent.replace('Sample ',''));
  const get=(name)=>{const node=document.querySelector('input[name="'+name+'-'+index+'"]:checked');return node?node.value:null};
  const notes=section.querySelector('textarea').value;
  answers.push({sample:index,naturalness:get('natural'),pronunciation:get('pronunciation'),notes});
 });
 const payload={schema_version:'mehran.svs.listening-review-response.v1',completed_at:new Date().toISOString(),answers};
 const blob=new Blob([JSON.stringify(payload,null,2)],{type:'application/json'});
 const url=URL.createObjectURL(blob);const link=document.createElement('a');link.href=url;link.download='listening-review-answers.json';link.click();URL.revokeObjectURL(url);
 document.getElementById('status').textContent='Answers exported. Send the JSON to the review owner separately.';
});
</script></body></html>"""


def build_listening_review(
    pairs: list[dict],
    audio_root: str | Path,
    output_dir: str | Path,
    *,
    rng=None,
) -> dict:
    """Create offline reviewer HTML and a separate model-identity answer key."""
    if not isinstance(pairs, list) or not pairs or len(pairs) > MAX_ITEMS:
        raise ListeningReviewError("provide between 1 and 500 audio pairs")
    root_requested = Path(audio_root).expanduser()
    if root_requested.is_symlink():
        raise ListeningReviewError("audio root symlink is not allowed")
    try:
        root = root_requested.resolve(strict=True)
    except (OSError, RuntimeError) as exc:
        raise ListeningReviewError("audio root is unavailable") from exc
    if not root.is_dir():
        raise ListeningReviewError("audio root must be a directory")

    output = Path(output_dir).expanduser()
    if output.exists() or output.is_symlink():
        raise ListeningReviewError("output directory must not already exist")
    parent = output.parent.resolve(strict=True)
    if output.parent.is_symlink() or not parent.is_dir():
        raise ListeningReviewError("output parent must be a real directory")

    prepared = []
    answer_key = {
        "schema_version": "mehran.svs.listening-review-key.v1",
        "warning": "PRIVATE: do not give this file to blind reviewers.",
        "pairs": [],
    }
    total_bytes = 0
    chooser = rng or secrets.SystemRandom()
    for index, pair in enumerate(pairs, start=1):
        if not isinstance(pair, dict) or set(pair) != {"item_id", "baseline_wav", "candidate_wav"}:
            raise ListeningReviewError("each pair must contain item_id, baseline_wav, candidate_wav")
        item_id = pair["item_id"]
        if not isinstance(item_id, str) or not item_id.strip() or len(item_id) > 128:
            raise ListeningReviewError("item_id must be a non-empty string of at most 128 characters")
        baseline = _safe_source(root, pair["baseline_wav"])
        candidate = _safe_source(root, pair["candidate_wav"])
        total_bytes += baseline.stat().st_size + candidate.stat().st_size
        if total_bytes > MAX_TOTAL_AUDIO_BYTES:
            raise ListeningReviewError("total audio size exceeds the package limit")
        baseline_label = chooser.choice(("A", "B"))
        mapping = {"A": "baseline", "B": "candidate"} if baseline_label == "A" else {"A": "candidate", "B": "baseline"}
        prepared.append({
            "index": index,
            "baseline": baseline,
            "candidate": candidate,
            "mapping": mapping,
        })
        answer_key["pairs"].append({
            "sample": index,
            "item_id": item_id,
            "A": mapping["A"],
            "B": mapping["B"],
        })

    output.mkdir(mode=0o700, parents=False)
    media = output / "media"
    media.mkdir(mode=0o700)
    reviewer_items = []
    try:
        for item in prepared:
            a_source = item[item["mapping"]["A"]]
            b_source = item[item["mapping"]["B"]]
            a_name = secrets.token_hex(16) + ".wav"
            b_name = secrets.token_hex(16) + ".wav"
            shutil.copyfile(a_source, media / a_name)
            shutil.copyfile(b_source, media / b_name)
            reviewer_items.append({
                "index": item["index"],
                "a_src": "media/" + a_name,
                "b_src": "media/" + b_name,
            })
        (output / "review.html").write_text(_review_html(reviewer_items), encoding="utf-8")
        key_path = output / "PRIVATE-answer-key.json"
        key_path.write_text(json.dumps(answer_key, ensure_ascii=False, indent=2), encoding="utf-8")
        key_path.chmod(0o600)
    except Exception:
        shutil.rmtree(output, ignore_errors=True)
        raise

    return {
        "review_html": str(output / "review.html"),
        "private_answer_key": str(key_path),
        "pairs_prepared": len(prepared),
        "audio_files_copied": len(prepared) * 2,
        "audio_uploaded": False,
        "model_quality_approved": False,
    }


def _read_pairs(path: str | Path) -> list[dict]:
    pairs = []
    try:
        with Path(path).open("r", encoding="utf-8") as stream:
            for line_number, line in enumerate(stream, start=1):
                if not line.strip():
                    continue
                try:
                    value = json.loads(line)
                except json.JSONDecodeError as exc:
                    raise ListeningReviewError(f"invalid JSON on line {line_number}") from exc
                pairs.append(value)
    except OSError as exc:
        raise ListeningReviewError("pair manifest could not be read") from exc
    return pairs


def main() -> int:
    parser = argparse.ArgumentParser(description="Build a local, offline blind A/B listening-review package.")
    parser.add_argument("pairs_jsonl", help="JSONL with item_id, baseline_wav, candidate_wav")
    parser.add_argument("--audio-root", required=True, help="Root directory containing local PCM WAV files")
    parser.add_argument("--output-dir", required=True, help="New directory for the offline review package")
    args = parser.parse_args()
    try:
        result = build_listening_review(_read_pairs(args.pairs_jsonl), args.audio_root, args.output_dir)
    except (ListeningReviewError, OSError, ValueError) as exc:
        parser.exit(2, f"LISTENING REVIEW NOT CREATED: {exc}\n")
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
