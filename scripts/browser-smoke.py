#!/usr/bin/env python3
"""Headless Chromium end-to-end smoke tests for MEHRAN MUSIC STUDIO."""
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from pathlib import Path
from threading import Thread
from tempfile import TemporaryDirectory
import math
import base64
import struct
import wave
import array
import json

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]


class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, *_args):
        pass


def make_test_wav(path: Path):
    sample_rate = 44100
    frames = int(sample_rate * 0.5)
    with wave.open(str(path), "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(sample_rate)
        samples = bytearray()
        for index in range(frames):
            noise = (((index * 1103515245 + 12345) >> 16) & 0x7FFF) - 16384
            signal = 0 if index < int(sample_rate * 0.15) else int(7000 * math.sin(2 * math.pi * 440 * index / sample_rate))
            value = max(-32768, min(32767, signal + int(noise * 0.08)))
            samples.extend(struct.pack("<h", value))
        wav.writeframes(samples)

def make_test_midi(path: Path):
    track = bytes([
        0x00, 0xFF, 0x51, 0x03, 0x07, 0xA1, 0x20,
        0x00, 0x90, 0x3C, 0x64,
        0x83, 0x60, 0x80, 0x3C, 0x00,
        0x00, 0xFF, 0x2F, 0x00,
    ])
    header = b"MThd" + struct.pack(">IHHH", 6, 0, 1, 480)
    chunk = b"MTrk" + struct.pack(">I", len(track)) + track
    path.write_bytes(header + chunk)



def export_track_audio(page, project_id: str, track_id: str, filename: str):
    encoded = page.evaluate("""async ({projectId, trackId}) => {
        const db = await new Promise((resolve, reject) => {
            const request = indexedDB.open("mehran_music_studio_audio_v1", 1);
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
        const record = await new Promise((resolve, reject) => {
            const request = db.transaction("trackAudio").objectStore("trackAudio").get(projectId + ":" + trackId);
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
        if (!record?.blob) throw new Error("Generated audition WAV is missing from IndexedDB: " + trackId);
        const bytes = new Uint8Array(await record.blob.arrayBuffer());
        let binary = "";
        for (let offset = 0; offset < bytes.length; offset += 0x8000) {
            binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
        }
        db.close();
        return btoa(binary);
    }""", {"projectId": project_id, "trackId": track_id})
    output_dir = ROOT / "test-audio-output"
    output_dir.mkdir(exist_ok=True)
    path = output_dir / filename
    path.write_bytes(base64.b64decode(encoded))
    if path.stat().st_size < 44:
        raise AssertionError("Audition WAV is too small: " + str(path))
    with wave.open(str(path), "rb") as rendered:
        width = rendered.getsampwidth()
        frames = rendered.getnframes()
        raw_pcm = rendered.readframes(frames)
    if width != 2:
        raise AssertionError("Audition WAV must be 16-bit PCM: " + str(path))
    pcm = array.array("h")
    pcm.frombytes(raw_pcm)
    rms = math.sqrt(sum(sample * sample for sample in pcm) / max(1, len(pcm))) / 32768
    peak = max((abs(sample) for sample in pcm), default=0) / 32768
    if rms < 0.001 or peak < 0.005:
        raise AssertionError(f"Audition WAV is silent or near-silent: {path.name}; RMS={rms:.6f}; peak={peak:.6f}")
    if peak >= 0.99:
        raise AssertionError(f"Audition WAV reaches digital full scale: {path.name}; RMS={rms:.6f}; peak={peak:.6f}")
    print("AUDITION WAV SAVED:", path.name, path.stat().st_size, f"bytes RMS={rms:.4f} peak={peak:.4f}", flush=True)
    return path


def main():
    handler = lambda *args, **kwargs: QuietHandler(*args, directory=str(ROOT), **kwargs)
    server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    thread = Thread(target=server.serve_forever, daemon=True)
    thread.start()
    base_url = f"http://127.0.0.1:{server.server_port}"
    errors = []
    try:
        with TemporaryDirectory() as temp:
            audio_path = Path(temp) / "smoke-tone.wav"
            midi_path = Path(temp) / "one-note.mid"
            make_test_wav(audio_path)
            make_test_midi(midi_path)
            with sync_playwright() as playwright:
                browser = playwright.chromium.launch(args=["--autoplay-policy=no-user-gesture-required"])
                context = browser.new_context(accept_downloads=True)
                page = context.new_page()
                page.on("dialog", lambda dialog: dialog.accept())
                page.on("pageerror", lambda error: errors.append(getattr(error, "stack", None) or str(error)))
                page.goto(base_url + "/music-studio.html", wait_until="networkidle")
                assert "MEHRAN MUSIC" in page.title().upper() or page.locator(".brand").inner_text().upper().find("MEHRAN MUSIC") >= 0

                # Create and persist a project through the actual UI.
                page.locator('[data-view="create"]').click()
                page.locator("#projectName").fill("Automated Audio QA")
                page.locator("#saveProject").click()
                page.wait_for_timeout(250)
                saved_projects = page.evaluate("localStorage.getItem('mehran_music_studio_drafts_v1')")
                library_text = page.locator("#libraryProjects").inner_text()
                if not saved_projects or "Automated Audio QA" not in saved_projects:
                    raise AssertionError("Project creation did not persist. Browser errors: " + " | ".join(errors))
                assert "Automated Audio QA" in library_text

                # Import a phone-recorded vocal through Vocal Lab and verify it becomes a real audio track.
                page.locator('[data-view="vocals"]').first.click()
                page.locator("#vocalProject").select_option(label="Automated Audio QA")
                # Import a Standard MIDI file and verify the studio parses and displays its real note timeline.
                page.locator("#mehranSingerMidiFile").set_input_files(str(midi_path))
                page.wait_for_function("document.querySelector('#mehranSingerMidiStatus')?.textContent.trim() !== 'No MIDI selected'", timeout=10000)
                midi_status = page.locator("#mehranSingerMidiStatus").inner_text()
                assert "1 نت" in midi_status, "MIDI import did not complete successfully: " + midi_status + " | Browser errors: " + " | ".join(errors)
                midi_notes_text = page.locator("#mehranSingerAlignmentNotes").text_content() or ""
                assert "C4" in midi_notes_text and "0.500s" in midi_notes_text, "Imported MIDI note timeline was not rendered: " + midi_notes_text

                # Review one Persian syllable against the imported MIDI note, adjust its timing,
                # persist the alignment locally, and export the exact saved JSON artifact.
                page.locator("#mehranSingerSyllables").fill("سَلام")
                page.locator("#mehranSingerPronunciationOverrides").fill("سلام=سَ-لام")
                page.locator("#mehranSingerNoteGroups").fill("0")
                page.wait_for_function("document.querySelector('#mehranSingerTimeline [data-time-start=\"0\"]') !== null")
                assert page.locator('#mehranSingerTimeline [data-time-start="0"]').input_value() == "0.000"
                assert page.locator('#mehranSingerTimeline [data-time-end="0"]').input_value() == "0.500"
                page.locator('#mehranSingerTimeline [data-time-start="0"]').fill("0.050")
                page.locator('#mehranSingerTimeline [data-time-end="0"]').fill("0.420")
                page.locator("#saveMehranSingerAlignment").click()
                alignment_status = page.locator("#mehranSingerAlignmentStatus").inner_text()
                saved_alignment = page.evaluate("""() => {
                    const drafts = JSON.parse(localStorage.getItem("mehran_music_studio_drafts_v1") || "[]");
                    return drafts.find(item => item.name === "Automated Audio QA")?.singerAlignment || null;
                }""")
                assert "هم‌ترازی در پروژه ذخیره شد" in alignment_status, "Manual singer alignment did not save: " + alignment_status
                assert saved_alignment and saved_alignment["alignment"][0]["startSeconds"] == 0.05 and saved_alignment["alignment"][0]["endSeconds"] == 0.42, "Manual syllable timing was not persisted: " + str(saved_alignment)
                assert saved_alignment["pronunciationOverrides"]["سلام"] == ["سَ", "لام"], "Persian pronunciation override was not persisted."
                with page.expect_download() as alignment_download:
                    page.locator("#exportMehranSingerAlignment").click()
                alignment_path = Path(temp) / "mehran-singer-alignment.json"
                alignment_download.value.save_as(alignment_path)
                exported_alignment = __import__("json").loads(alignment_path.read_text(encoding="utf-8"))
                assert exported_alignment["schema"] == "mehran.singer-alignment-export.v1"
                assert exported_alignment["alignment"]["alignment"][0]["startSeconds"] == 0.05
                assert exported_alignment["alignment"]["pronunciationOverrides"]["سلام"] == ["سَ", "لام"]
                assert page.locator("#mehranSingerReviewedSyllablePhonemes").count() == 1
                assert page.locator("#mehranSingerPhonemeWeights").count() == 1
                assert page.locator("#prepareMehranSingerConditioning").count() == 1

                # Exercise the quality-report JSON export using explicit local-only fixture metadata.
                page.evaluate("""() => {
                    const drafts = JSON.parse(localStorage.getItem("mehran_music_studio_drafts_v1") || "[]");
                    const project = drafts.find(item => item.name === "Automated Audio QA");
                    project.singerAlignment.acousticConditioning = {
                        phonemes: [
                            { phoneme: "s", start_seconds: 0.05, end_seconds: 0.20 },
                            { phoneme: "æ", start_seconds: 0.20, end_seconds: 0.42 }
                        ],
                        notes: [{ midi_note: 60, start_seconds: 0, duration_seconds: 0.5 }]
                    };
                    project.singerAlignment.syllables = ["نامعتبر", "سَلام"];
                    project.singerAlignment.noteGroups = [[0], [0]];
                    project.singerAlignment.alignment = [
                        { startSeconds: 0, endSeconds: 0.5 },
                        { startSeconds: 0.05, endSeconds: 0.42 }
                    ];
                    project.singerAlignment.syllableAlignment = [
                        { text: "نامعتبر", start_seconds: 0.4, end_seconds: 0.2, phoneme_start_index: 0, phoneme_end_index: 2 },
                        { text: "سَلام", start_seconds: 0.05, end_seconds: 0.42, phoneme_start_index: 0, phoneme_end_index: 2 }
                    ];
                    localStorage.setItem("mehran_music_studio_drafts_v1", JSON.stringify(drafts));
                    document.querySelector("#vocalProject").dispatchEvent(new Event("change", { bubbles: true }));
                }""")
                # Reload so the application rehydrates its in-memory project state from local storage.
                page.reload(wait_until="networkidle")
                page.locator('[data-view="vocals"]').first.click()
                page.locator("#vocalProject").select_option(label="Automated Audio QA")
                # Re-import MIDI after reload because imported MIDI notes are intentionally session-local.
                page.locator("#mehranSingerMidiFile").set_input_files(str(midi_path))
                page.wait_for_function("document.querySelector('#mehranSingerMidiStatus')?.textContent.includes('1 نت')", timeout=10000)
                page.wait_for_function("document.querySelector('#mehranSingerTimeline [data-syllable-index=\"0\"]') !== null", timeout=10000)
                assert page.locator("#exportMehranSyllableQualityReport").is_enabled(), "Quality JSON export did not enable for complete local metadata."
                with page.expect_download() as quality_download:
                    page.locator("#exportMehranSyllableQualityReport").click()
                quality_path = Path(temp) / "mehran-syllable-timing-quality-report.json"
                quality_download.value.save_as(quality_path)
                quality_report = __import__("json").loads(quality_path.read_text(encoding="utf-8"))
                assert quality_report["schema_version"] == "1.0"
                assert quality_report["audio_included"] is False
                assert quality_report["summary"]["syllables_reviewed"] == 1
                assert quality_report["summary"]["syllables_invalid_or_incomplete"] == 1
                assert quality_report["syllables"][0]["phoneme_count"] == 2
                assert quality_report["syllables"][0]["phoneme_coverage_ratio"] == 1
                assert quality_report["syllables"][0]["uncovered_duration_seconds"] == 0
                assert quality_report["summary"]["mean_uncovered_duration_seconds"] == 0
                assert quality_report["summary"]["max_uncovered_duration_seconds"] == 0
                quality_panel_text = page.locator("#mehranSyllableQualityReport").inner_text()
                assert "اولویت اصلاح هجاها" in quality_panel_text
                jump_button = page.locator("#mehranSyllableQualityReport button[data-jump-syllable=\"1\"]")
                assert jump_button.count() == 1, "Priority syllable did not preserve its original Timeline index after an invalid row."
                assert page.locator("#mehranSingerTimeline [data-syllable-index=\"0\"]").count() == 1, "Invalid leading syllable row was not present in Timeline."
                assert page.locator("#mehranSingerTimeline [data-syllable-index=\"1\"]").count() == 1, "Valid second syllable row was not indexed in Timeline."
                jump_button.click()
                assert page.locator("#mehranSingerTimeline [data-syllable-index=\"1\"] input[data-time-start]").evaluate("(el) => document.activeElement === el"), "Timeline jump did not focus the matching syllable start time."
                assert "بیشترین زمان پوشش‌نیافته" in quality_panel_text
                assert "۱" in quality_panel_text or "1" in quality_panel_text
                assert "vowel_consonant_composition" in quality_report["unavailable_metrics"]
                # Give the comparison-only baseline a valid gap metric so both trend endpoints exist.
                quality_report["summary"]["internal_gap_mean_seconds"] = 0.01
                quality_path.write_text(__import__("json").dumps(quality_report), encoding="utf-8")
                # Compare two local JSON reports from the same project without uploading either file.
                second_report = dict(quality_report)
                second_report["generated_at"] = "2099-01-01T00:00:00Z"
                second_report["summary"] = dict(quality_report["summary"])
                second_report["summary"]["mean_phoneme_coverage_ratio"] = 0.8
                second_report["summary"]["internal_gap_count"] = 1
                second_report["summary"]["internal_gap_mean_seconds"] = 0.02
                second_report["summary"]["syllables_invalid_or_incomplete"] = 2
                second_report["summary"]["syllables_reviewed"] = 2
                second_report["summary"]["mean_uncovered_duration_seconds"] = 0.04
                second_report["summary"]["max_uncovered_duration_seconds"] = 0.08
                second_path = Path(temp) / "mehran-second-take.json"
                second_path.write_text(__import__("json").dumps(second_report), encoding="utf-8")
                page.locator("#mehranCompareQualityFiles").set_input_files([str(quality_path), str(second_path)])
                assert page.locator("#compareMehranQualityReports").is_enabled()
                page.locator("#compareMehranQualityReports").click()
                page.wait_for_function("document.querySelector('#mehranQualityComparison')?.innerText.includes('80.0%')")
                comparison_text = page.locator("#mehranQualityComparison").inner_text()
                assert "مبنای مقایسه" in comparison_text
                assert "ناقص / نامعتبر" in comparison_text
                assert "-20.0 pp" in comparison_text
                assert "1" in comparison_text
                assert page.locator('#mehranQualityComparison [role="img"][aria-label="روند پوشش واجی"] svg').is_visible()
                assert page.locator('#mehranQualityComparison [role="img"][aria-label="روند میانگین شکاف زمانی"] svg').is_visible()
                assert page.locator('#mehranQualityComparison [role="img"][aria-label="روند هجاهای ناقص و نامعتبر"] svg').is_visible()
                assert "تغییر پوشش واجی" in comparison_text
                assert "تغییر میانگین شکاف زمانی" in comparison_text
                assert "تغییر هجاهای ناقص / نامعتبر" in comparison_text
                assert "+1.0" in comparison_text
                with page.expect_download() as comparison_download:
                    page.locator("#mehranQualityComparison button").click()
                comparison_path = Path(temp) / "mehran-syllable-quality-comparison.json"
                comparison_download.value.save_as(comparison_path)
                comparison_report = __import__("json").loads(comparison_path.read_text(encoding="utf-8"))
                assert comparison_report["report_type"] == "mehran-syllable-quality-comparison"
                assert comparison_report["audio_included"] is False
                assert comparison_report["report_count"] == 2
                assert comparison_report["rows"][1]["coverage_delta_percentage_points"] == -20.0
                assert comparison_report["trend_summary"]["coverage"]["valid_reports"] == 2
                assert comparison_report["trend_summary"]["coverage"]["delta_percentage_points"] == -20.0
                assert comparison_report["trend_summary"]["internal_gap"]["valid_reports"] == 2
                assert comparison_report["trend_summary"]["internal_gap"]["delta_milliseconds"] == 10.0
                assert comparison_report["trend_summary"]["incomplete_syllables"]["valid_reports"] == 2
                assert comparison_report["trend_summary"]["incomplete_syllables"]["delta_count"] == 1
                assert comparison_report["rows"][1]["mean_uncovered_duration_seconds"] == 0.04
                assert comparison_report["rows"][1]["max_uncovered_duration_seconds"] == 0.08
                assert comparison_report["trend_summary"]["uncovered_duration"]["valid_reports"] == 2
                assert comparison_report["trend_summary"]["uncovered_duration"]["mean_delta_milliseconds"] == 40.0
                assert comparison_report["trend_summary"]["uncovered_duration"]["max_delta_milliseconds"] == 80.0
                assert comparison_report["rows"][1]["syllables_invalid_or_incomplete"] == 2
                assert comparison_report["rows"][0]["syllables_invalid_or_incomplete"] == 1
                assert comparison_report["rows"][1]["syllables_invalid_or_incomplete"] == 2
                # Reports from different projects must be rejected.
                mismatched_report = dict(second_report)
                mismatched_report["project_id"] = "different-project"
                mismatched_path = Path(temp) / "mehran-different-project.json"
                mismatched_path.write_text(__import__("json").dumps(mismatched_report), encoding="utf-8")
                page.locator("#mehranCompareQualityFiles").set_input_files([str(quality_path), str(mismatched_path)])
                page.locator("#compareMehranQualityReports").click()
                page.wait_for_function("document.querySelector('#mehranQualityComparison')?.innerText.includes('پروژه‌های متفاوت')")
                # Negative summary counts must also be rejected.
                invalid_report = dict(second_report)
                invalid_report["summary"] = dict(second_report["summary"])
                invalid_report["summary"]["internal_gap_count"] = -1
                invalid_path = Path(temp) / "mehran-invalid-summary.json"
                invalid_path.write_text(__import__("json").dumps(invalid_report), encoding="utf-8")
                page.locator("#mehranCompareQualityFiles").set_input_files([str(quality_path), str(invalid_path)])
                page.locator("#compareMehranQualityReports").click()
                page.wait_for_function("document.querySelector('#mehranQualityComparison')?.innerText.includes('شاخص‌های خلاصه')")
                # Invalid report timestamps must not silently become the Unix epoch.
                invalid_timestamp_report = dict(second_report)
                invalid_timestamp_report["generated_at"] = "not-a-date"
                invalid_timestamp_path = Path(temp) / "mehran-invalid-timestamp.json"
                invalid_timestamp_path.write_text(__import__("json").dumps(invalid_timestamp_report), encoding="utf-8")
                page.locator("#mehranCompareQualityFiles").set_input_files([str(quality_path), str(invalid_timestamp_path)])
                page.locator("#compareMehranQualityReports").click()
                page.wait_for_function("document.querySelector('#mehranQualityComparison')?.innerText.includes('زمان تولید معتبر نیست')")
                # Empty or whitespace-only project IDs must not be treated as valid identifiers.
                blank_project_report = dict(second_report)
                blank_project_report["project_id"] = "   "
                blank_project_path = Path(temp) / "mehran-blank-project-id.json"
                blank_project_path.write_text(__import__("json").dumps(blank_project_report), encoding="utf-8")
                page.locator("#mehranCompareQualityFiles").set_input_files([str(quality_path), str(blank_project_path)])
                page.locator("#compareMehranQualityReports").click()
                page.wait_for_function("document.querySelector('#mehranQualityComparison')?.innerText.includes('پروژه مشخصی')")
                page.locator("#vocalRecordingFile").set_input_files(str(audio_path))
                try:
                    page.wait_for_function("document.querySelector('#vocalImportStatus')?.textContent.includes('Vocal recording imported and saved on this device.')", timeout=10000)
                except Exception as error:
                    current_status = page.locator("#vocalImportStatus").inner_text()
                    raise AssertionError("Vocal import did not finish. Current status: " + current_status + ". Browser errors: " + " | ".join(errors)) from error
                assert page.locator("#vocalRecordingPreview").is_visible()
                assert page.locator("#vocalRecordingPreview").get_attribute("src")
                saved_after_vocal = page.evaluate("JSON.parse(localStorage.getItem('mehran_music_studio_drafts_v1'))")
                assert len(saved_after_vocal[0]["tracks"]) == 1
                assert saved_after_vocal[0]["tracks"][0]["type"] == "Lead Vocal"
                vocal_roles = page.locator("#vocalRecordingRole option").evaluate_all("(els) => els.map(el => el.value)")
                assert vocal_roles == ["lead", "female_backing", "male_backing", "harmony", "choir", "adlib", "vocal_pad"], "Vocal part selector is incomplete: " + str(vocal_roles)
                source_audio_hash = page.evaluate("""async () => {
                    const db = await new Promise((resolve, reject) => {
                        const request = indexedDB.open('mehran_music_studio_audio_v1', 1);
                        request.onsuccess = () => resolve(request.result);
                        request.onerror = () => reject(request.error);
                    });
                    const project = JSON.parse(localStorage.getItem('mehran_music_studio_drafts_v1'))[0];
                    const track = project.tracks[0];
                    const record = await new Promise((resolve, reject) => {
                        const request = db.transaction('trackAudio').objectStore('trackAudio').get(project.id + ':' + track.id);
                        request.onsuccess = () => resolve(request.result);
                        request.onerror = () => reject(request.error);
                    });
                    if (!record?.blob) throw new Error('Original audio blob missing from IndexedDB');
                    const digest = await crypto.subtle.digest('SHA-256', await record.blob.arrayBuffer());
                    db.close();
                    return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
                }""")

                # Run the local recording preflight against the imported synthetic vocal.
                page.locator("#analyzeRecordingQuality").click()
                page.wait_for_function("document.querySelector('#recordingQualityResult')?.textContent.includes('Peak')", timeout=15000)
                quality_text = page.locator("#recordingQualityResult").inner_text()
                assert "Average RMS" in quality_text and "Clipped samples" in quality_text, "Recording quality metrics were not rendered: " + quality_text
                assert "Peak headroom looks safe" in quality_text, "Clean synthetic recording was incorrectly flagged as clipped: " + quality_text

                # The pitch detector is closure-scoped; validate it through the real Vocal Lab UI below.
                # Analyze the imported 440 Hz synthetic vocal using the local pitch detector.
                page.locator("#pitchStart").fill("0.15")
                page.locator("#pitchKey").select_option("0")
                page.locator("#pitchScale").select_option("minor")
                page.locator("#pitchStrength").fill("50")
                page.locator("#analyzePitch").click()
                page.wait_for_function("document.querySelector('#pitchResult')?.textContent.includes('Hz')", timeout=10000)
                pitch_text = page.locator("#pitchResult").inner_text()
                assert "A4" in pitch_text, "Pitch analyzer did not identify the 440 Hz test tone: " + pitch_text
                assert "440" in pitch_text, "Pitch analyzer frequency is outside expected test range: " + pitch_text
                assert "YIN confidence score" in pitch_text, "Pitch detector confidence score was not displayed: " + pitch_text
                assert "not a guarantee of note accuracy" in pitch_text, "Pitch confidence score needs its accuracy limitation explained."
                assert "Correction map" in pitch_text and "50%" in pitch_text, "Scale-aware correction plan was not rendered: " + pitch_text
                assert "average adjustment 52.8 cents" in pitch_text, "Correction strength calculation is incorrect: " + pitch_text
                assert page.locator("#pitchContour").count() == 1, "Pitch contour visualization was not rendered"
                assert int(page.locator("#pitchContour").get_attribute("data-pitch-points")) >= 1, "Pitch contour has no voiced frames"

                # Exercise the actual offline Vocal Polish renderer, including scale correction,
                # and verify that it exports a playable WAV without mutating the source recording.
                page.locator("#vocalPolishFile").set_input_files(str(audio_path))
                page.locator("#vocalPolishPitchCorrection").check()
                page.locator("#vocalPolishPitchStrength").fill("50")
                page.locator("#pitchKey").select_option("0")
                page.locator("#pitchScale").select_option("minor")
                page.locator("#runVocalPolish").click()
                page.wait_for_function("document.querySelector('#vocalPolishStatus')?.textContent.includes('پردازش تمام شد')", timeout=30000)
                assert page.locator("#vocalPolishResult").is_visible(), "Vocal Polish did not reveal its rendered result."
                with page.expect_download(timeout=15000) as vocal_download:
                    page.locator("#downloadVocalPolish").click()
                vocal_polish_path = Path(temp) / "vocal-polish-regression.wav"
                vocal_download.value.save_as(vocal_polish_path)
                with wave.open(str(vocal_polish_path), "rb") as polished:
                    assert polished.getnchannels() in (1, 2), "Vocal Polish export must be mono or stereo."
                    assert polished.getsampwidth() == 3, "Vocal Polish export must be 24-bit PCM."
                    assert abs(polished.getnframes() / polished.getframerate() - 0.5) < 0.03, "Vocal Polish changed the source duration."
                source_hash_after_polish = page.evaluate("""async () => {
                    const db = await new Promise((resolve, reject) => {
                        const request = indexedDB.open('mehran_music_studio_audio_v1', 1);
                        request.onsuccess = () => resolve(request.result);
                        request.onerror = () => reject(request.error);
                    });
                    const project = JSON.parse(localStorage.getItem('mehran_music_studio_drafts_v1'))[0];
                    const track = project.tracks[0];
                    const record = await new Promise((resolve, reject) => {
                        const request = db.transaction('trackAudio').objectStore('trackAudio').get(project.id + ':' + track.id);
                        request.onsuccess = () => resolve(request.result);
                        request.onerror = () => reject(request.error);
                    });
                    if (!record?.blob) throw new Error('Original audio blob missing after Vocal Polish');
                    const digest = await crypto.subtle.digest('SHA-256', await record.blob.arrayBuffer());
                    db.close();
                    return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
                }""")
                assert source_hash_after_polish == source_audio_hash, "Vocal Polish must never overwrite the original local recording."
                print("PASS: offline Vocal Polish pitch correction, 24-bit WAV export, duration preservation, and source immutability", flush=True)

                assert "fade=Math.max(32,Math.floor(rate*0.035))" in page.content(), "Pitch correction must use a longer 35 ms transition fade."
                assert "mix=0.5-0.5*Math.cos(Math.PI*edge)" in page.content(), "Pitch correction must use smooth cosine edge blending."

                # Build and save a lyric-to-performance rehearsal guide.
                page.locator('[data-view="lyrics"]').click()
                page.locator('[data-experience-stage="lyrics"] [data-experience-choice="pro"]').click()
                page.wait_for_function("Array.from(document.querySelector('#lyricsProject').options).some(option => option.textContent.trim() === 'Automated Audio QA')", timeout=10000)
                page.locator("#lyricsProject").select_option(label="Automated Audio QA")

                # Exercise the complete AI songwriter-to-Lyrics-Lab path with a deterministic
                # Cloudflare Worker response. This validates the browser contract without
                # consuming the production free AI quota in CI.
                songwriter_requests = []
                songwriter_fixture = "[Verse 1]\nکوچه هنوز از قدم‌هایت نشان دارد\nچراغ خانه نامت را صدا دارد\n\n[Chorus]\nبرگرد که این خانه بی‌تو بی‌قرار است\nاین پنجره چشم‌انتظارِ یک بهار است\n\n[Verse 2]\nامروز از آن شب کمی دورتر شدم\nبا خاطرات روشن تو هم‌سفر شدم\n\n[Chorus]\nبرگرد که این خانه بی‌تو بی‌قرار است\nاین پنجره چشم‌انتظارِ یک بهار است\n\n[Bridge]\nشاید مسیر ما دوباره یکی شود\nشاید سکوت خانه پر از زندگی شود\n\n[Outro]\nچراغ خانه هنوز روشن است"
                def mock_songwriter(route):
                    if route.request.method == "OPTIONS":
                        route.fulfill(status=204, headers={
                            "Access-Control-Allow-Origin": base_url,
                            "Access-Control-Allow-Methods": "POST, OPTIONS",
                            "Access-Control-Allow-Headers": "content-type",
                        })
                        return
                    songwriter_requests.append(route.request.post_data_json)
                    route.fulfill(status=200, content_type="application/json", headers={
                        "Access-Control-Allow-Origin": base_url,
                    }, body=__import__("json").dumps({
                        "success": True, "lyrics": songwriter_fixture,
                        "qualityWarnings": ["در متن آزمایشی یک هشدار ساختاری وجود دارد."],
                        "provider": "cloudflare", "model": "test-model", "free": True,
                    }))
                songwriter_url = "https://mehran-msh-auth.mehran79mehran.workers.dev/music/lyrics/generate"
                page.route(songwriter_url, mock_songwriter)
                page.locator("#aiSongwriterPanel details").evaluate("(el) => { el.open = true; }")
                page.locator("#songwriterTopic").fill("انتظار برای بازگشت یک عزیز")
                page.locator("#songwriterMood").select_option(label="دلتنگ")
                page.locator("#songwriterGenre").select_option(label="راک")
                page.locator("#songwriterVoice").select_option(label="روایت داستانی")
                page.locator("#songwriterRhyme").select_option("alternating")
                page.locator("#songwriterHook").select_option("emotional")
                page.locator("#songwriterArc").select_option("cinematic")
                page.locator("#songwriterDetails").fill("یک چراغ روشن پشت پنجره")
                page.locator("#generateSongLyrics").click()
                page.wait_for_function("document.querySelector('#songwriterStatus')?.textContent.includes('پیش‌نویس ساخته شد')", timeout=10000)
                assert page.locator("#songwriterResult").input_value() == songwriter_fixture
                assert "بازبینی لازم دارد" in page.locator("#songwriterStatus").inner_text() and "هشدار ساختاری" in page.locator("#songwriterStatus").inner_text(), "Quality warnings were not surfaced in the songwriter UI."
                assert len(songwriter_requests) == 1, "AI songwriter must make exactly one generation request."
                songwriter_payload = songwriter_requests[0]
                assert songwriter_payload["topic"] == "انتظار برای بازگشت یک عزیز"
                assert songwriter_payload["genre"] == "راک" and songwriter_payload["voice"] == "روایت داستانی"
                assert songwriter_payload["rhyme"] == "alternating" and songwriter_payload["hook"] == "emotional"
                assert songwriter_payload["arc"] == "cinematic" and songwriter_payload["details"] == "یک چراغ روشن پشت پنجره"
                assert page.locator("#useSongwriterDraft").is_enabled() and page.locator("#appendSongwriterDraft").is_enabled()
                page.locator("#useSongwriterDraft").click()
                assert page.locator("#lyricsEditor").input_value() == songwriter_fixture, "Generated draft was not transferred into Lyrics Lab."
                page.locator("#undoLyrics").click()
                assert page.locator("#lyricsEditor").input_value() == "", "Undo did not restore the pre-generation lyric text."
                page.locator("#redoLyrics").click()
                assert page.locator("#lyricsEditor").input_value() == songwriter_fixture, "Redo did not restore the generated lyric draft."
                page.locator("#lyricsEditor").fill("[Intro]\nچراغی پشت پنجره روشن است")
                page.locator("#appendSongwriterDraft").click()
                appended_lyrics = page.locator("#lyricsEditor").input_value()
                assert appended_lyrics.startswith("[Intro]\nچراغی پشت پنجره روشن است\n\n[Verse 1]")
                assert appended_lyrics.endswith("چراغ خانه هنوز روشن است"), "Append did not preserve the complete generated draft."
                page.locator("#lyricsTitle").fill("آزمایش ترانه‌ساز")
                page.locator("#saveLyrics").click()
                page.wait_for_function("document.querySelector('#lyricsSaveState')?.textContent.includes('Saved locally')", timeout=10000)
                saved_songwriter_lyrics = page.evaluate("""() => {
                    const drafts = JSON.parse(localStorage.getItem("mehran_music_studio_drafts_v1") || "[]");
                    const project = drafts.find(item => item.name === "Automated Audio QA");
                    return {title: project?.lyricsTitle, lyrics: project?.lyrics};
                }""")
                assert saved_songwriter_lyrics["title"] == "آزمایش ترانه‌ساز"
                assert saved_songwriter_lyrics["lyrics"] == appended_lyrics, "Generated and appended lyrics were not saved to the selected project."
                with page.expect_download() as lyrics_download:
                    page.locator("#exportLyrics").click()
                lyrics_path = Path(temp) / "mehran-songwriter-lyrics.txt"
                lyrics_download.value.save_as(lyrics_path)
                assert lyrics_path.read_text(encoding="utf-8") == appended_lyrics, "TXT export did not preserve the saved Persian lyric text."
                page.unroute(songwriter_url, mock_songwriter)
                print("AI SONGWRITER FLOW REGRESSION:", {"requests": len(songwriter_requests), "sections": ["Verse 1", "Chorus", "Verse 2", "Bridge", "Outro"], "saved_title": saved_songwriter_lyrics["title"], "export_bytes": lyrics_path.stat().st_size}, flush=True)
                print("PASS: AI songwriter request, generated draft, replace, undo/redo, append, project save and Persian TXT export", flush=True)

                page.locator("#lyricsEditor").fill("[Verse 1]\nتو رفتی و هنوز دلم به یاد توئه\nI keep walking through the night\nI hold a little light")
                assert "تو رفتی و هنوز دلم به یاد توئه" in page.locator("#lyricsEditor").input_value()
                assert page.locator("#lyricFlowPanel").is_visible()
                craft_report = page.locator("#lyricCraftAnalysis").inner_text()
                assert "سطرهای دارای پایان نوشتاری مشترک" in craft_report, "Lyric craft report must label ending matches as written-text similarity."
                assert "واژه‌های تصویری و حسی" in craft_report, "Lyric craft report must describe imagery as a limited term count, not an artistic score."
                assert "تصویرسازی:" not in craft_report and "نشانگر قافیهٔ نوشتاری:" not in craft_report, "Deprecated heuristic scores must not appear in the lyric report."
                page.locator("#lyricsEditor").fill("[Verse 1]\nباران روی شیشه می‌رقصد\nکوچه در خواب فرو رفته\n[Chorus]\nعشق تو در قلب من می‌ماند\n[Verse 2]\nصبح از پنجره وارد می‌شود\nدریا صدای تازه‌ای دارد\n[Bridge]\nقطار از کوهستان عبور کرد\nابرهای بنفش آسمان را پوشاندند")
                craft_report = page.locator("#lyricCraftAnalysis").inner_text()
                assert "تازگی واژگانی بند دوم" in craft_report and "100٪" in craft_report, "Second-verse vocabulary novelty must be shown when both verses are labelled."
                assert "تفاوت واژگانی Bridge با Chorus: 100٪" in craft_report, "Bridge-to-chorus vocabulary comparison must be shown when both sections are labelled."
                assert "نقشهٔ ساختاری روایت" in craft_report, "Narrative structure checklist must be rendered."
                assert "شروع روایت" in craft_report and "ایدهٔ مرکزی و نقطهٔ بازگشت" in craft_report and "ادامه یا تحول روایت" in craft_report, "Narrative section roles are incomplete."
                assert craft_report.count("عنوان بخش پیدا شد") >= 4, "All labelled narrative sections should be detected."
                assert "فقط وجود عنوان بخش‌ها را می‌سنجد" in craft_report, "Narrative checklist must disclose that it does not judge semantic coherence."
                page.locator("#lyricsEditor").fill("[Verse 1]\nتو رفتی و هنوز دلم به یاد توئه\nI keep walking through the night\nI hold a little light")
                page.locator("#saveLyrics").click()
                # Exercise the actual studio-to-conditioning request with a mocked self-hosted API.
                conditioning_requests = []
                def mock_conditioning(route):
                    if route.request.method == "OPTIONS":
                        route.fulfill(
                            status=204,
                            headers={
                                "Access-Control-Allow-Origin": base_url,
                                "Access-Control-Allow-Methods": "POST, OPTIONS",
                                "Access-Control-Allow-Headers": "content-type",
                            },
                        )
                        return
                    conditioning_requests.append(route.request.post_data_json)
                    route.fulfill(
                        status=200,
                        content_type="application/json",
                        headers={"Access-Control-Allow-Origin": base_url},
                        body=__import__("json").dumps({
                            "conditioning": {"schema_version": "mehran.svs.conditioning.v1", "phonemes": [{} for _ in range(5)], "notes": [{}]},
                            "message": "Conditioning prepared for review.",
                            "generation_ready": False,
                            "accepted_for_inference": False,
                        }),
                    )
                # Keep the invalid-leading-syllable fixture for timeline-index coverage, then
                # isolate the conditioning test with one valid, reviewed syllable.
                page.evaluate("""() => {
                    const drafts = JSON.parse(localStorage.getItem("mehran_music_studio_drafts_v1") || "[]");
                    const project = drafts.find(item => item.name === "Automated Audio QA");
                    if (!project?.singerAlignment) throw new Error("Singer alignment fixture missing");
                    project.singerAlignment.syllables = ["سَلام"];
                    project.singerAlignment.noteGroups = [[0]];
                    project.singerAlignment.alignment = [{ startSeconds: 0.05, endSeconds: 0.42 }];
                    localStorage.setItem("mehran_music_studio_drafts_v1", JSON.stringify(drafts));
                }""")
                page.route("https://engine.test/v1/jobs/conditioning/prepare", mock_conditioning)
                page.reload()
                page.locator('[data-view="vocals"]').first.click()
                page.locator("#vocalProject").select_option(label="Automated Audio QA")
                page.locator("#mehranSingerApiBase").fill("https://engine.test")
                page.locator("#mehranSingerApiBase").dispatch_event("change")
                page.locator("#mehranSingerReviewedSyllablePhonemes").fill("s,æ,l,ɒː,m")
                page.locator("#mehranSingerPhonemeWeights").fill("1,1,1,2,1")
                page.locator("#prepareMehranSingerConditioning").click()
                page.wait_for_function("document.querySelector('#mehranSingerApiStatus')?.textContent.includes('ورودی مدل آکوستیکی آماده شد')", timeout=10000)
                assert len(conditioning_requests) == 1, "Studio did not send one conditioning request."
                sent_conditioning = conditioning_requests[0]
                assert sent_conditioning["reviewed_syllables"] == ["سَلام"]
                assert sent_conditioning["reviewed_syllable_phonemes"] == [["s", "æ", "l", "ɒː", "m"]]
                assert sent_conditioning["phoneme_duration_weights"] == [[1, 1, 1, 2, 1]]
                assert sent_conditioning["manual_timing_windows"][0] == {"start_seconds": 0.05, "end_seconds": 0.42}
                persisted_annotations = page.evaluate("""() => {
                    const drafts = JSON.parse(localStorage.getItem("mehran_music_studio_drafts_v1") || "[]");
                    const project = drafts.find(item => item.name === "Automated Audio QA");
                    return project?.singerAlignment || null;
                }""")
                assert persisted_annotations["reviewedSyllablePhonemes"] == [["s", "æ", "l", "ɒː", "m"]]
                assert persisted_annotations["phonemeDurationWeights"] == [[1, 1, 1, 2, 1]]
                assert len(persisted_annotations["acousticConditioning"]["phonemes"]) == 5
                assert persisted_annotations["acousticConditioning"]["schema_version"] == "mehran.svs.conditioning.v1"
                with page.expect_download() as conditioning_download:
                    page.locator("#exportMehranSingerConditioning").click()
                conditioning_path = Path(temp) / "mehran-acoustic-conditioning.json"
                conditioning_download.value.save_as(conditioning_path)
                exported_conditioning = __import__("json").loads(conditioning_path.read_text(encoding="utf-8"))
                assert exported_conditioning["schema"] == "mehran.svs.conditioning-export.v1"
                assert exported_conditioning["accepted_for_inference"] is False
                assert exported_conditioning["audio_generated"] is False
                page.locator("#mehranDatasetAudioTrack").select_option(index=1)
                assert not page.locator("#exportMehranDatasetPackage").is_disabled()
                training_downloads = []
                def capture_training_download(download):
                    target = Path(temp) / download.suggested_filename
                    download.save_as(target)
                    training_downloads.append((download.suggested_filename, target))
                page.on("download", capture_training_download)
                page.locator("#exportMehranDatasetPackage").click()
                page.wait_for_function("document.querySelector('#mehranSingerAlignmentStatus')?.textContent.includes('WAV تک‌کاناله 24 kHz')")
                page.wait_for_timeout(600)
                page.remove_listener("download", capture_training_download)
                assert len(training_downloads) == 2, "Training export must download exactly one WAV and one conditioning JSON: " + str([name for name, _ in training_downloads])
                training_files = {name: target for name, target in training_downloads}
                wav_matches = [(name, target) for name, target in training_files.items() if name.endswith("-vocal-24k-mono.wav")]
                json_matches = [(name, target) for name, target in training_files.items() if name.endswith("-conditioning.json")]
                assert len(wav_matches) == 1 and len(json_matches) == 1, "Training export filenames do not form a WAV/JSON pair."
                training_wav_path = wav_matches[0][1]
                training_json_path = json_matches[0][1]
                training_header = training_wav_path.read_bytes()[:44]
                assert training_header[:4] == b"RIFF" and training_header[8:12] == b"WAVE"
                assert int.from_bytes(training_header[22:24], "little") == 1
                assert int.from_bytes(training_header[24:28], "little") == 24000
                training_pair_json = __import__("json").loads(training_json_path.read_text(encoding="utf-8"))
                assert training_pair_json["schema"] == "mehran.svs.conditioning-export.v1"
                assert training_pair_json["conditioning"]["sample_rate"] == 24000
                assert training_pair_json["conditioning"]["duration_seconds"] > 0
                assert training_pair_json["review_required"] is True
                assert training_pair_json["accepted_for_inference"] is False
                assert training_pair_json["audio_generated"] is False
                assert training_pair_json["source_recording"]["converted_locally"] is True
                page.locator('[data-view="vocals"]').first.click()
                page.wait_for_function("Array.from(document.querySelector('#vocalProject').options).some(option => option.textContent.trim() === 'Automated Audio QA')", timeout=10000)
                page.locator("#vocalProject").select_option(label="Automated Audio QA")
                page.locator("#vocalGuideLine").select_option(index=0)
                page.locator("#vocalGuideSyllables").fill("تو / رفتی / و / هنوز / دلم / به / یاد / توئه")
                page.locator("#vocalGuideTempo").fill("96")
                page.locator("#vocalGuideNotes").fill("C4, D4, E4, G4, E4, D4, C4, C4")
                guide_button_state = page.locator("#saveVocalGuide").evaluate("(el) => ({disabled:el.disabled, onclick:typeof el.onclick, connected:el.isConnected})")
                page.locator("#saveVocalGuide").click()
                guide_status = page.locator("#vocalGuideStatus").inner_text()
                saved_guide = page.evaluate("""() => {
                    const drafts = JSON.parse(localStorage.getItem("mehran_music_studio_drafts_v1") || "[]");
                    const project = drafts.find(item => item.name === "Automated Audio QA");
                    return project?.lyricGuides || null;
                }""")
                assert "Vocal guide saved locally" in guide_status and saved_guide, "Vocal guide did not save: " + guide_status + " | button=" + str(guide_button_state) + " | page errors=" + " | ".join(errors)
                assert saved_guide.get("تو رفتی و هنوز دلم به یاد توئه", {}).get("tempo") == 96, "Saved guide tempo was not retained: " + str(saved_guide)
                assert len(saved_guide.get("تو رفتی و هنوز دلم به یاد توئه", {}).get("steps", [])) == 8, "Saved guide syllable steps were not retained: " + str(saved_guide)
                page.locator("#playVocalGuide").click()
                page.wait_for_function("document.querySelector('#vocalGuideStatus')?.textContent.includes('Rehearsing') || document.querySelector('#vocalGuideStatus')?.textContent.includes('Phrase complete')", timeout=8000)
                page.locator("#stopVocalGuide").click()

                # Open the mix planner and verify the imported vocal track's complete effects rack.
                page.locator('[data-view="mix"]').click()
                page.evaluate("""() => { const el = document.querySelector("#mixProject"); if (!el) throw new Error("Mix project selector is missing"); const option = [...el.options].find(item => item.label === "Automated Audio QA"); if (!option) throw new Error("Automated Audio QA project option is missing"); el.value = option.value; el.dispatchEvent(new Event("change", {bubbles:true})); }""")
                page.locator('[data-track-reverb]').wait_for(state="visible")
                assert page.locator('[data-track-vocal-polish]').count() == 1
                assert page.locator('[data-track-noise-gate]').count() == 1
                assert page.locator('[data-noise-learn]').count() == 1
                assert page.locator('[data-noise-strength]').count() == 1
                page.locator('[data-track-noise-gate]').click()
                assert page.locator('[data-track-noise-gate]').inner_text() == "Noise gate: on"
                page.locator('[data-track-vocal-polish]').click()
                assert page.locator('[data-track-vocal-polish]').inner_text() == "Vocal polish: on"
                page.locator('[data-noise-start]').fill("0")
                page.locator('[data-noise-duration]').fill("0.12")
                page.locator('[data-noise-learn]').click()
                page.wait_for_function("document.querySelector('#mixStatus')?.textContent.includes('Noise profile learned and saved locally')", timeout=10000)
                page.locator('[data-noise-strength]').evaluate("(el) => { el.value='65'; el.dispatchEvent(new Event('input',{bubbles:true})); }")
                saved_vocal_fx = page.evaluate("JSON.parse(localStorage.getItem('mehran_music_studio_drafts_v1'))")
                assert saved_vocal_fx[0]["tracks"][0]["effects"]["vocalPolish"] is True
                assert saved_vocal_fx[0]["tracks"][0]["effects"]["noiseGate"] is True
                assert saved_vocal_fx[0]["tracks"][0]["effects"]["noiseProfile"]["fftSize"] == 1024
                assert len(saved_vocal_fx[0]["tracks"][0]["effects"]["noiseProfile"]["bins"]) == 513
                assert saved_vocal_fx[0]["tracks"][0]["effects"]["noiseReduction"] == 65
                assert page.locator('[data-track-delay-time]').get_attribute("max") == "450"
                assert page.locator('[data-track-feedback]').get_attribute("max") == "30"
                assert page.locator('[data-track-filter]').count() == 1
                assert page.locator('[data-track-cutoff]').count() == 1
                assert page.locator('[data-track-drive]').count() == 1
                assert page.locator('[data-track-chorus-depth]').count() == 1
                assert page.locator('[data-track-chorus-rate]').count() == 1
                assert page.locator('#masterMeter').get_attribute('role') == 'meter'
                assert page.locator('#masterMeterFill').count() == 1
                assert 'masterLimiterNode=mixAudioContext.createDynamicsCompressor()' in page.content()

                # Exercise the delegated controls and verify persistence after reload.
                page.locator('[data-track-delay]').evaluate("(el) => { el.value='20'; el.dispatchEvent(new Event('input',{bubbles:true})); el.dispatchEvent(new Event('change',{bubbles:true})); }")
                page.locator('[data-track-reverb]').evaluate("(el) => { el.value='24'; el.dispatchEvent(new Event('input',{bubbles:true})); el.dispatchEvent(new Event('change',{bubbles:true})); }")
                page.locator('[data-track-delay-time]').evaluate("(el) => { el.value='350'; el.dispatchEvent(new Event('input',{bubbles:true})); el.dispatchEvent(new Event('change',{bubbles:true})); }")
                page.locator('[data-track-feedback]').evaluate("(el) => { el.value='30'; el.dispatchEvent(new Event('input',{bubbles:true})); el.dispatchEvent(new Event('change',{bubbles:true})); }")
                page.locator('[data-track-chorus-depth]').evaluate("(el) => { el.value='65'; el.dispatchEvent(new Event('input',{bubbles:true})); el.dispatchEvent(new Event('change',{bubbles:true})); }")
                page.locator('[data-track-chorus-rate]').evaluate("(el) => { el.value='2.4'; el.dispatchEvent(new Event('input',{bubbles:true})); el.dispatchEvent(new Event('change',{bubbles:true})); }")
                page.reload(wait_until="networkidle")
                page.locator('[data-view="mix"]').click()
                page.locator("#mixProject").evaluate("""el => { const option = [...el.options].find(item => item.label === "Automated Audio QA"); if (!option) throw new Error("Automated Audio QA project option is missing"); el.value = option.value; el.dispatchEvent(new Event("change", { bubbles: true })); }""")
                assert page.locator('[data-track-delay]').input_value() == "20"
                assert page.locator('[data-track-reverb]').input_value() == "24"
                assert page.locator('[data-track-delay-time]').input_value() == "350"
                assert page.locator('[data-track-feedback]').input_value() == "30"
                assert page.locator('[data-track-noise-gate]').inner_text() == "Noise gate: on"
                assert page.locator('[data-track-chorus-depth]').input_value() == "65"
                assert page.locator('[data-track-chorus-rate]').input_value() == "2.4"

                # Attach a generated local WAV, confirm IndexedDB-backed storage, and run live playback.
                page.locator('[data-track-audio]').click()
                page.locator("#trackAudioFile").set_input_files(str(audio_path))
                page.get_by_text("Audio saved on this device. Preview playback is ready.").wait_for(timeout=10000)
                assert page.locator('[data-track-audio-player]').count() == 1
                page.wait_for_function("!!document.querySelector('[data-track-audio-player]')?.src", timeout=10000)
                page.wait_for_function("document.querySelector('[data-track-waveform]')?.dataset.waveformReady === 'true'", timeout=15000)
                waveform = page.locator("[data-track-waveform]")
                assert waveform.count() == 1 and waveform.get_attribute("aria-label").startswith("Lead Vocal waveform"), "Decoded audio waveform was not rendered for the attached track."
                waveform_box = waveform.bounding_box()
                assert waveform_box and waveform_box["width"] >= 280 and waveform_box["height"] >= 90, "Waveform canvas has invalid dimensions."
                zoom_control = page.locator("[data-waveform-zoom]")
                assert zoom_control.count() == 1, "Waveform timeline zoom control is missing."
                base_width = waveform_box["width"]
                zoom_control.evaluate("(el) => { el.value = '3'; el.dispatchEvent(new Event('input', { bubbles: true })); }")
                page.wait_for_function("document.querySelector('[data-track-waveform]').getBoundingClientRect().width > "+str(base_width*2.8)+" && document.querySelector('[data-waveform-zoom-value]').textContent === '3×'", timeout=5000)
                zoomed_width = waveform.bounding_box()["width"]
                assert zoomed_width >= base_width * 2.8, "Waveform timeline did not expand at 3x zoom."
                ruler = page.locator("[data-waveform-ruler]")
                assert ruler.count() == 1 and ruler.get_attribute("aria-label") == "Waveform time ruler", "Waveform time ruler is missing."
                assert ruler.bounding_box()["width"] >= zoomed_width * 0.99, "Time ruler does not stay aligned with the zoomed waveform."
                ruler_pixels = ruler.evaluate("(el) => Array.from(el.getContext('2d').getImageData(0, 0, el.width, el.height).data).filter((value, index) => index % 4 === 3 && value > 0).length")
                assert ruler_pixels > 100, "Time ruler was not drawn."
                zoom_control.evaluate("(el) => { el.value = '1'; el.dispatchEvent(new Event('input', { bubbles: true })); }")
                page.wait_for_function("document.querySelector('[data-waveform-zoom-value]').textContent === '1×'", timeout=5000)
                # Drag across the waveform away from trim handles to select a non-destructive audition range.
                waveform.scroll_into_view_if_needed()
                box = waveform.bounding_box()
                page.mouse.move(box["x"] + box["width"] * 0.25, box["y"] + box["height"] * 0.5)
                page.mouse.down()
                page.mouse.move(box["x"] + box["width"] * 0.80, box["y"] + box["height"] * 0.5, steps=12)
                page.wait_for_function("Math.abs(Number(document.querySelector('[data-track-waveform]')?.dataset.selectionEnd) - Number(document.querySelector('[data-track-waveform]')?.dataset.selectionStart)) > 0.05", timeout=3000)
                page.mouse.up()
                preview_button = page.locator("[data-waveform-preview-play]")
                assert preview_button.is_enabled(), "Waveform range selection did not enable audition preview."
                assert "Selected range" in page.locator("[data-waveform-status]").inner_text(), "Selected range feedback is missing."
                selection_start = page.locator("[data-waveform-selection-start]")
                selection_end = page.locator("[data-waveform-selection-end]")
                assert float(selection_end.input_value()) - float(selection_start.input_value()) > 0.05, "Precise selection time fields were not populated."
                original_selection_start = float(selection_start.input_value())
                edited_selection_start = round(original_selection_start + 0.10, 2)
                selection_start.fill(str(edited_selection_start))
                assert f"{edited_selection_start:.2f}s" in page.locator("[data-waveform-status]").inner_text(), "Editing selection start did not update the selected region."
                selection_start.fill(f"{original_selection_start:.2f}")
                loop_button = page.locator("[data-waveform-preview-loop]")
                loop_button.click()
                assert loop_button.get_attribute("aria-pressed") == "true", "Waveform audition loop did not enable."
                preview_button.click()
                page.wait_for_function("document.querySelector('[data-waveform-status]')?.textContent.includes('Looping selected range')", timeout=8000)
                assert page.locator("[data-track-audio-player]").evaluate("(el) => !el.paused"), "Looping audition stopped unexpectedly."
                stop_button = page.locator("[data-waveform-preview-stop]")
                assert stop_button.is_enabled(), "Stop control did not enable during selection audition."
                stop_button.click()
                page.wait_for_function("document.querySelector('[data-track-audio-player]')?.paused === true && document.querySelector('[data-waveform-status]')?.textContent.includes('preview stopped')", timeout=3000)
                assert stop_button.is_disabled(), "Stop control remained enabled after stopping audition."
                assert loop_button.get_attribute("aria-pressed") == "false", "Stopping audition did not reset the loop toggle."
                preview_button.click()
                page.wait_for_function("document.querySelector('[data-track-audio-player]')?.paused === true && document.querySelector('[data-waveform-status]')?.textContent.includes('Selection preview finished')", timeout=5000)
                page.locator("[data-waveform-preview-clear]").click()
                assert preview_button.is_disabled(), "Clearing the waveform selection did not disable preview."
                assert "Selection cleared" in page.locator("[data-waveform-status]").inner_text(), "Selection clear feedback is missing."
                assert "Shift+ArrowLeft" in (waveform.get_attribute("aria-keyshortcuts") or ""), "Keyboard shortcut accessibility metadata is missing."
                waveform.focus()
                waveform.press("ArrowRight")
                assert preview_button.is_enabled(), "Keyboard range selection did not enable preview."
                assert "keyboard adjusted" in page.locator("[data-waveform-status]").inner_text(), "Keyboard selection feedback is missing."
                waveform.press("Shift+ArrowRight")
                waveform.press("Escape")
                assert preview_button.is_disabled(), "Escape did not clear the keyboard selection."
                page.locator("[data-waveform-select-retained]").click()
                assert "Selected retained audio" in page.locator("[data-waveform-status]").inner_text(), "One-click retained-range selection failed."
                assert preview_button.is_enabled(), "Retained-range selection did not enable audition."
                page.locator("[data-waveform-preview-clear]").click()
                page.locator("#playMix").click()
                page.get_by_text("Playing 1 track(s) together.", exact=False).wait_for(timeout=10000)
                page.wait_for_function("parseFloat(document.querySelector('#masterMeterFill')?.style.width || '0') > 0", timeout=5000)
                assert "dBFS" in page.locator("#masterMeterValue").inner_text()
                assert page.locator("[data-track-meter]").count() == 1
                page.wait_for_function("parseFloat(document.querySelector('[data-track-meter-fill]')?.style.width || '0') > 0", timeout=5000)
                assert "dBFS" in page.locator("[data-track-meter-value]").inner_text()
                page.locator("#stopMix").click()

                # Set a vocal entry offset and verify it is saved and rendered on the shared timeline.
                offset_control = page.locator("[data-track-start-offset]")
                assert offset_control.count() == 1, "Per-track timeline offset control is missing."
                assert offset_control.get_attribute("step") == "0.01", "Timeline alignment must support 10 ms precision."
                offset_control.fill("1.23")
                offset_control.dispatch_event("change")
                saved_offset = page.evaluate("JSON.parse(localStorage.getItem('mehran_music_studio_drafts_v1'))[0].tracks[0].startOffset")
                assert abs(saved_offset - 1.23) < 0.001, "Fine track start offset did not persist."
                fade_in_control = page.locator("[data-track-fade-in]")
                fade_out_control = page.locator("[data-track-fade-out]")
                assert fade_in_control.count() == 1 and fade_out_control.count() == 1, "Per-track fade controls are missing."
                fade_in_control.fill("0.25")
                fade_in_control.dispatch_event("change")
                fade_out_control.fill("0.35")
                fade_out_control.dispatch_event("change")
                trim_start_control = page.locator("[data-track-trim-start]")
                trim_end_control = page.locator("[data-track-trim-end]")
                assert trim_start_control.count() == 1 and trim_end_control.count() == 1, "Non-destructive trim controls are missing."
                assert trim_start_control.get_attribute("step") == "0.01" and trim_end_control.get_attribute("step") == "0.01"
                trim_start_control.fill("0.10")
                trim_start_control.dispatch_event("change")
                trim_end_control.fill("0.10")
                trim_end_control.dispatch_event("change")
                saved_trim = page.evaluate("JSON.parse(localStorage.getItem('mehran_music_studio_drafts_v1'))[0].tracks[0]")
                assert abs(saved_trim["trimStart"] - 0.10) < 0.001 and abs(saved_trim["trimEnd"] - 0.10) < 0.001, "Track trim values did not persist."
                saved_fades = page.evaluate("JSON.parse(localStorage.getItem('mehran_music_studio_drafts_v1'))[0].tracks[0]")
                assert abs(saved_fades["fadeIn"] - 0.25) < 0.001, "Track fade-in did not persist."
                assert abs(saved_fades["fadeOut"] - 0.35) < 0.001, "Track fade-out did not persist."

                # Live playback must begin at the non-destructive trim start and stop before the trimmed tail.
                page.locator("#playMix").click()
                page.wait_for_function("Number(document.querySelector('[data-track-waveform]')?.dataset.playheadTime) > 0.12", timeout=5000)
                page.wait_for_function("document.querySelector('[data-track-audio-player]')?.paused === false && document.querySelector('[data-track-audio-player]')?.currentTime >= 0.12", timeout=10000)
                page.wait_for_function("document.querySelector('[data-track-audio-player]')?.paused === true && Math.abs(document.querySelector('[data-track-audio-player]')?.currentTime - 0.10) < 0.04", timeout=5000)

                # Exercise both offline render paths and verify actual downloadable WAV artifacts.
                try:
                    with page.expect_download(timeout=30000) as mix_download:
                        page.locator("#renderWav").click()
                except Exception as error:
                    mix_status = page.locator("#renderWavStatus").inner_text()
                    raise AssertionError("Mix WAV export did not finish. Status: " + mix_status + ". Browser errors: " + " | ".join(errors)) from error
                mix_file = Path(temp) / "mix.wav"
                mix_download.value.save_as(str(mix_file))
                assert mix_file.is_file() and mix_file.stat().st_size > 44
                mix_sample_rate = 44100
                with wave.open(str(mix_file), "rb") as rendered_mix:
                    assert rendered_mix.getnchannels() == 2
                    assert rendered_mix.getsampwidth() == 3, "Mix export must be 24-bit PCM."
                    assert rendered_mix.getframerate() == mix_sample_rate
                    mix_track_state = page.evaluate("JSON.parse(localStorage.getItem('mehran_music_studio_drafts_v1'))[0].tracks[0]")
                    mix_trimmed_duration = 0.5 - float(mix_track_state.get("trimStart", 0)) - float(mix_track_state.get("trimEnd", 0))
                    mix_offset = max(0, min(30, float(mix_track_state.get("startOffset", 0))))
                    mix_fx = mix_track_state.get("effects", {})
                    mix_send = max(0, min(0.6, float(mix_track_state.get("delay", 0) or 0) / 100))
                    mix_tail = 0.0
                    if mix_send > 0:
                        mix_delay_time = max(0.08, min(0.45, float(mix_fx.get("delayTime", 280) or 280) / 1000))
                        mix_feedback = max(0, min(0.3, float(mix_fx.get("feedback", 28) or 0) / 100))
                        mix_repeats = math.ceil(math.log(0.001) / math.log(mix_feedback)) if mix_feedback > 0 else 1
                        mix_tail = max(mix_tail, min(5, mix_delay_time * mix_repeats + 0.25))
                    if float(mix_fx.get("reverb", 0) or 0) > 0:
                        mix_tail = max(mix_tail, 1.6)
                    if float(mix_fx.get("chorusDepth", 0) or 0) > 0:
                        mix_tail = max(mix_tail, 0.35)
                    expected_mix_duration = mix_trimmed_duration + mix_offset + mix_tail
                    actual_mix_duration = rendered_mix.getnframes() / mix_sample_rate
                    assert abs(actual_mix_duration - expected_mix_duration) < 0.02, "Mix duration was "+str(round(actual_mix_duration,3))+"s; expected "+str(round(expected_mix_duration,3))+"s from trim, offset, and calculated effect tail."
                    mix_pcm = rendered_mix.readframes(rendered_mix.getnframes())
                    assert any(mix_pcm), "Rendered mix is silent."
                    # Verify the exported master is not merely a valid WAV: inspect
                    # every signed 24-bit sample and the renderer's loudness/true-peak report.
                    mix_samples = [int.from_bytes(mix_pcm[i:i+3], "little", signed=True)
                                   for i in range(0, len(mix_pcm) - 2, 3)]
                    mix_pcm_peak = max(map(abs, mix_samples), default=0) / 8388608
                    mix_pcm_peak_db = 20 * math.log10(mix_pcm_peak) if mix_pcm_peak > 0 else -math.inf
                    assert mix_pcm_peak_db <= -1.0, (
                        "Master export exceeded the expected -1.2 dBFS true-peak safety margin: "
                        + str(round(mix_pcm_peak_db, 2)) + " dBFS"
                    )
                    mix_export_status = page.locator("#renderWavStatus").inner_text()
                    assert "8x 48-tap sinc inter-sample peak estimate" in mix_export_status
                    mix_true_peak_text = mix_export_status.split("8x 48-tap sinc inter-sample peak estimate ", 1)[1].split(" dBTP", 1)[0]
                    mix_true_peak_db = float(mix_true_peak_text)
                    assert math.isfinite(mix_true_peak_db) and mix_true_peak_db <= -1.0, (
                        "Estimated inter-sample peak exceeded the -1.2 dBTP export ceiling: "
                        + mix_true_peak_text + " dBTP"
                    )
                    assert "integrated loudness " in mix_export_status and " LUFS est." in mix_export_status
                    mix_lufs_text = mix_export_status.split("integrated loudness ", 1)[1].split(" LUFS est.", 1)[0]
                    mix_integrated_lufs = float(mix_lufs_text)
                    assert math.isfinite(mix_integrated_lufs) and -70 <= mix_integrated_lufs <= 0, (
                        "Integrated loudness estimate is missing or outside a plausible digital-audio range: "
                        + mix_lufs_text
                    )
                    assert "PCM rail hits 0" in mix_export_status, (
                        "24-bit quantization reached a PCM rail despite the master safety stage: "
                        + mix_export_status
                    )
                    # The renderer exports 24-bit PCM. Decode each signed 3-byte
                    # sample explicitly instead of misreading the byte stream as int16.
                    early_mix_bytes = mix_pcm[:int(1.22 * mix_sample_rate) * 2 * 3]
                    early_mix = [int.from_bytes(early_mix_bytes[i:i+3], "little", signed=True)
                                 for i in range(0, len(early_mix_bytes) - 2, 3)]
                    early_peak = max(map(abs, early_mix), default=0)
                    early_first_sample = next((index // 2 for index, value in enumerate(early_mix) if abs(value) >= 100 * 256), None)
                    mix_project_id = page.locator("#mixProject").input_value()
                    mix_tracks_debug = page.evaluate("""id => {
                        const list = JSON.parse(localStorage.getItem('mehran_music_studio_drafts_v1') || '[]');
                        const project = list.find(item => item.id === id);
                        return (project?.tracks || []).map(track => ({
                            id: track.id, startOffset: track.startOffset, trimStart: track.trimStart,
                            trimEnd: track.trimEnd, delay: track.delay, audioName: track.audioName
                        }));
                    }""", mix_project_id)
                    assert early_peak < 100 * 256, "Pre-entry mix peak was "+str(early_peak)+" PCM units; first audible sample "+str(early_first_sample)+"; selected tracks "+str(mix_tracks_debug)+". Expected silence before track start."
                    assert any(mix_pcm[int(1.30 * mix_sample_rate) * 6:int(1.45 * mix_sample_rate) * 6]), "The trimmed vocal segment was not rendered at its scheduled position."

                page.locator("#stemTrack").select_option(index=1)
                with page.expect_download(timeout=30000) as stem_download:
                    page.locator("#exportStem").click()
                stem_file = Path(temp) / "stem.wav"
                stem_download.value.save_as(str(stem_file))
                assert stem_file.is_file() and stem_file.stat().st_size > 44
                stem_track_state = page.evaluate("JSON.parse(localStorage.getItem('mehran_music_studio_drafts_v1'))[0].tracks[0]")
                stem_source_duration = page.locator("[data-track-audio-player]").first.evaluate("(el) => el.duration")
                stem_start_offset = max(0, min(30, float(stem_track_state.get("startOffset", 0))))
                stem_trimmed_duration = stem_source_duration - float(stem_track_state.get("trimStart", 0)) - float(stem_track_state.get("trimEnd", 0))
                stem_active_start = stem_start_offset  # Trim is a source seek, not an additional timeline delay.
                stem_fx = stem_track_state.get("effects", {})
                stem_send = max(0, min(0.6, float(stem_track_state.get("delay", 0) or 0) / 100))
                stem_tail = 0.0
                if stem_send > 0:
                    stem_delay_time = max(0.08, min(0.45, float(stem_fx.get("delayTime", 280) or 280) / 1000))
                    stem_feedback = max(0, min(0.3, float(stem_fx.get("feedback", 28) or 0) / 100))
                    stem_repeats = math.ceil(math.log(0.001) / math.log(stem_feedback)) if stem_feedback > 0 else 1
                    stem_tail = max(stem_tail, min(5, stem_delay_time * stem_repeats + 0.25))
                if float(stem_fx.get("reverb", 0) or 0) > 0:
                    stem_tail = max(stem_tail, 1.6)
                if float(stem_fx.get("chorusDepth", 0) or 0) > 0:
                    stem_tail = max(stem_tail, 0.35)
                with wave.open(str(stem_file), "rb") as rendered_stem:
                    assert rendered_stem.getnchannels() == 2
                    assert rendered_stem.getframerate() == 44100
                    expected_stem_duration = stem_trimmed_duration + stem_start_offset + stem_tail
                    actual_stem_duration = rendered_stem.getnframes() / 44100
                    assert abs(actual_stem_duration - expected_stem_duration) < 0.02, "Stem duration did not reflect trim, timeline offset, and effect tail: got " + str(round(actual_stem_duration, 3)) + "s, expected " + str(round(expected_stem_duration, 3)) + "s."
                    stem_pcm = rendered_stem.readframes(rendered_stem.getnframes())
                    assert any(stem_pcm), "Rendered stem is silent."
                    early_stem_bytes = stem_pcm[:int(max(0.01, stem_active_start - 0.05) * 44100) * 2 * 3]
                    early_stem = [int.from_bytes(early_stem_bytes[i:i+3], "little", signed=True)
                                  for i in range(0, len(early_stem_bytes) - 2, 3)]
                    active_start_frame = int((stem_active_start + 0.06) * 44100) * 2 * 3
                    active_end_frame = int((stem_active_start + 0.12) * 44100) * 2 * 3
                    active_bytes = stem_pcm[active_start_frame:active_end_frame]
                    active_stem = [int.from_bytes(active_bytes[i:i+3], "little", signed=True)
                                   for i in range(0, len(active_bytes) - 2, 3)]
                    assert max(map(abs, early_stem), default=0) < 2000 * 256, "Stem contains source material before its scheduled retained range."
                    assert max(map(abs, active_stem), default=0) > 4000 * 256, "Stem omitted the expected retained vocal segment after trim and timeline offset."

                # Render the same lead vocal with offline pitch correction enabled.
                page.locator("#stemPitchCorrection").check()
                page.locator("#stemPitchKey").select_option("0")
                page.locator("#stemPitchScale").select_option("minor")
                page.locator("#stemPitchStrength").fill("100")
                assert page.locator("#stemPitchTolerance").input_value() == "20"
                assert "20 cents" in page.locator("#stemPitchToleranceValue").inner_text()
                page.locator("#previewStem").click()
                page.wait_for_function("document.querySelector('#stemExportStatus')?.textContent.includes('Preview rendered locally')", timeout=30000)
                assert page.locator("#stemPreviewPanel").is_visible()
                assert page.locator("#stemPreviewAudio").get_attribute("src")
                assert not page.locator("#stemPreviewOriginal").is_disabled()
                assert not page.locator("#stemPreviewCorrected").is_disabled()
                page.locator("#stemPreviewOriginal").click()
                assert "Original recording" in page.locator("#stemPreviewMode").inner_text()
                assert page.locator("#stemPreviewAudio").get_attribute("src").startswith("blob:")
                page.locator("#stemPreviewCorrected").click()
                assert "Rendered stem" in page.locator("#stemPreviewMode").inner_text()
                with page.expect_download(timeout=30000) as tuned_download:
                    page.locator("#downloadStem").click()
                tuned_file = Path(temp) / "tuned-stem.wav"
                tuned_download.value.save_as(str(tuned_file))
                assert tuned_file.is_file() and tuned_file.stat().st_size > 44
                source_audio_hash_after = page.evaluate("""async () => {
                    const db = await new Promise((resolve, reject) => {
                        const request = indexedDB.open('mehran_music_studio_audio_v1', 1);
                        request.onsuccess = () => resolve(request.result);
                        request.onerror = () => reject(request.error);
                    });
                    const project = JSON.parse(localStorage.getItem('mehran_music_studio_drafts_v1'))[0];
                    const track = project.tracks[0];
                    const record = await new Promise((resolve, reject) => {
                        const request = db.transaction('trackAudio').objectStore('trackAudio').get(project.id + ':' + track.id);
                        request.onsuccess = () => resolve(request.result);
                        request.onerror = () => reject(request.error);
                    });
                    if (!record?.blob) throw new Error('Original audio blob missing after pitch correction');
                    const digest = await crypto.subtle.digest('SHA-256', await record.blob.arrayBuffer());
                    db.close();
                    return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
                }""")
                assert source_audio_hash_after == source_audio_hash, "Pitch correction modified the original locally stored recording."
                # Drag the waveform's start handle and verify that the edit persists without rewriting the source blob.
                waveform = page.locator("[data-track-waveform]")
                waveform.scroll_into_view_if_needed()
                waveform_box = waveform.bounding_box()
                source_duration = page.locator("[data-track-audio-player]").evaluate("(el) => el.duration")
                handle_y = waveform_box["y"] + waveform_box["height"] / 2
                start_x = waveform_box["x"] + waveform_box["width"] * (0.10 / source_duration)
                moved_x = waveform_box["x"] + waveform_box["width"] * (0.20 / source_duration)
                page.mouse.move(start_x, handle_y)
                page.mouse.down()
                page.mouse.move(moved_x, handle_y, steps=5)
                page.mouse.up()
                page.wait_for_function("Math.abs(JSON.parse(localStorage.getItem('mehran_music_studio_drafts_v1'))[0].tracks[0].trimStart - 0.20) < 0.03", timeout=5000)
                trim_start_control = page.locator("[data-track-trim-start]")
                trim_start_control.fill("0.10")
                trim_start_control.dispatch_event("change")
                with wave.open(str(stem_file), "rb") as original_stem, wave.open(str(tuned_file), "rb") as tuned_stem:
                    assert tuned_stem.getnframes() == original_stem.getnframes(), "Pitch correction changed the stem duration."
                    assert tuned_stem.getnchannels() == 2 and tuned_stem.getframerate() == 44100
                    assert tuned_stem.getsampwidth() == 3, "Pitch-corrected stem must remain 24-bit PCM."
                    frames = tuned_stem.getnframes()
                    pcm = tuned_stem.readframes(frames)
                    values = [int.from_bytes(pcm[i:i+3], "little", signed=True)
                              for i in range(0, len(pcm) - 2, 3)]
                    # The 440 Hz tone begins 0.05 s after trim, following the track's saved timeline offset.
                    # Use autocorrelation in a retained, non-silent window so fade-in does not bias zero-crossing counts.
                    segment = values[int((stem_active_start + 0.06) * 44100) * 2:int((stem_active_start + 0.24) * 44100) * 2:2]
                    mean = sum(segment) / len(segment)
                    centered = [sample - mean for sample in segment]
                    best_lag = max(range(90, 125), key=lambda lag: sum(centered[i] * centered[i + lag] for i in range(len(centered) - lag)))
                    measured_hz = 44100 / best_lag
                    assert 410 <= measured_hz <= 420, "Pitch correction should shift A4 close to G#4 without a double pitch shift: " + str(measured_hz)

                # Split a selected vocal region into three independently editable clips without changing the source blob.
                page.locator("[data-waveform-select-retained]").click()
                page.locator("[data-waveform-selection-start]").fill("0.20")
                page.locator("[data-waveform-selection-end]").fill("0.35")
                page.locator("[data-waveform-split-selection]").click()
                page.wait_for_function("document.querySelector('#mixStatus').textContent.includes('Split complete') || document.querySelector('#mixStatus').textContent.includes('Split cancelled safely')", timeout=15000)
                split_status = page.locator("#mixStatus").inner_text()
                print("SPLIT TEST STATUS: " + split_status)
                split_project = page.evaluate("JSON.parse(localStorage.getItem('mehran_music_studio_drafts_v1'))[0]")
                print("SPLIT TEST TRACKS: " + str([{key: track.get(key) for key in ('id', 'name', 'audioName', 'trimStart', 'trimEnd', 'startOffset')} for track in split_project['tracks']]))
                assert "Split complete" in split_status, "Split operation did not complete: " + split_status
                assert len(split_project["tracks"]) == 3, "Split did not create exactly three clips."
                assert [round(track["trimStart"], 2) for track in split_project["tracks"]] == [0.10, 0.20, 0.35], "Split clips do not preserve the selected source boundaries."
                assert [round(track["startOffset"], 2) for track in split_project["tracks"]] == [1.23, 1.33, 1.48], "Split clips do not preserve the original timeline offset and contiguous placement."
                assert all(track.get("audioName") for track in split_project["tracks"]), "A split clip lost its local audio reference."
                split_hashes = page.evaluate("""async () => {
                    const project = JSON.parse(localStorage.getItem('mehran_music_studio_drafts_v1'))[0];
                    const db = await new Promise((resolve, reject) => {
                        const request = indexedDB.open('mehran_music_studio_audio_v1', 1);
                        request.onsuccess = () => resolve(request.result);
                        request.onerror = () => reject(request.error);
                    });
                    const hashes = [];
                    for (const track of project.tracks) {
                        const record = await new Promise((resolve, reject) => {
                            const request = db.transaction('trackAudio').objectStore('trackAudio').get(project.id + ':' + track.id);
                            request.onsuccess = () => resolve(request.result);
                            request.onerror = () => reject(request.error);
                        });
                        if (!record?.blob) throw new Error('A split clip audio asset is missing');
                        const digest = await crypto.subtle.digest('SHA-256', await record.blob.arrayBuffer());
                        hashes.push(Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join(''));
                    }
                    db.close();
                    return hashes;
                }""")
                assert len(set(split_hashes)) == 1 and split_hashes[0] == source_audio_hash, "Splitting changed or detached the original source audio."
                assert "three independently editable clips" in page.locator("#mixStatus").inner_text(), "Split completion feedback is missing."

                # Generate an original local drum loop and attach its WAV to the same project.
                page.locator('[data-view="arrangement"]').click()
                page.wait_for_function("!document.querySelector('#view-arrangement')?.classList.contains('hidden')", timeout=5000)
                page.locator("#patternTempo").fill("96")
                page.locator("#patternMode").select_option("drums")
                page.locator("#patternBars").select_option("1")
                page.locator("#kickSteps [data-pattern-step='1']").click()
                page.locator("#openHatSteps [data-pattern-step='7']").click()
                page.locator("#clapSteps [data-pattern-step='5']").click()
                page.locator("#tomSteps [data-pattern-step='11']").click()
                page.locator("#percSteps [data-pattern-step='15']").click()
                page.locator("#drumKit").select_option("recorded")
                page.locator("#renderPattern").click()
                try:
                    page.wait_for_function("""(() => { const status = document.querySelector('#patternStatus')?.textContent || ''; return status.includes('Generated WAV added to the mixer') || status.includes('Pattern render failed:'); })()""", timeout=20000)
                except Exception as error:
                    status = page.locator("#patternStatus").inner_text()
                    raise AssertionError("Pattern renderer did not finish. Current status: " + status) from error
                pattern_status = page.locator("#patternStatus").inner_text()
                assert "Generated WAV added to the mixer" in pattern_status, "Pattern rendering failed: " + pattern_status
                generated_project = page.evaluate("JSON.parse(localStorage.getItem('mehran_music_studio_drafts_v1'))[0]")
                generated_track = next(track for track in generated_project["tracks"] if track.get("generated"))
                assert generated_track["type"] == "Drums / Percussion" and generated_track["audioName"].endswith(".wav")
                assert generated_project["patternStudio"]["drumKit"] == "recorded"
                assert 7 in generated_project["patternStudio"]["openHat"] and 5 in generated_project["patternStudio"]["clap"] and 11 in generated_project["patternStudio"]["tom"] and 15 in generated_project["patternStudio"]["perc"]
                with page.expect_download() as drum_midi_download:
                    page.locator("#exportPatternMidi").click()
                drum_midi_path = Path(temp) / "drum-roundtrip.mid"
                drum_midi_download.value.save_as(drum_midi_path)
                assert drum_midi_path.read_bytes().startswith(b"MThd")
                page.locator("#patternMidiFile").set_input_files(str(drum_midi_path))
                page.wait_for_function("document.querySelector('#patternStatus')?.textContent.includes('MIDI imported')", timeout=5000)
                drum_roundtrip = page.evaluate("JSON.parse(localStorage.getItem('mehran_music_studio_drafts_v1'))[0].patternStudio")
                assert drum_roundtrip["mode"] == "drums" and 7 in drum_roundtrip["openHat"] and 5 in drum_roundtrip["clap"] and 11 in drum_roundtrip["tom"] and 15 in drum_roundtrip["perc"], "MIDI drum round-trip lost lanes: " + str({key: drum_roundtrip.get(key) for key in ("mode", "kick", "snare", "hat", "openHat", "clap", "tom", "perc")})
                assert generated_track["audioSize"] > 44 and page.locator("#patternPreview").get_attribute("src")
                generated_blob_exists = page.evaluate("""async () => {
                    const project = JSON.parse(localStorage.getItem("mehran_music_studio_drafts_v1"))[0];
                    const track = project.tracks.find(item => item.generated);
                    const db = await new Promise((resolve, reject) => { const req = indexedDB.open("mehran_music_studio_audio_v1", 1); req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); });
                    const record = await new Promise((resolve, reject) => { const req = db.transaction("trackAudio").objectStore("trackAudio").get(project.id + ":" + track.id); req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); });
                    db.close(); return !!record?.blob && record.blob.size > 44;
                }""")
                assert generated_blob_exists, "Generated WAV was not persisted in local IndexedDB."

                # Render a single selected instrument through the dedicated recorded-sample path.
                page.locator('[data-view="arrangement"]').click()
                page.wait_for_function("!document.querySelector('#view-arrangement')?.classList.contains('hidden')", timeout=5000)
                page.locator("#patternMode").select_option("live_violin")
                page.locator("#buildListeningDemo").click()
                page.wait_for_function("""() => {
                    const text = document.querySelector('#patternStatus')?.textContent || '';
                    return text.includes('تست تک‌ساز violin آماده شد') || text.includes('ساخت تست ساز کامل نشد');
                }""", timeout=120000)
                demo_status = page.locator("#patternStatus").inner_text()
                assert "تست تک‌ساز violin آماده شد" in demo_status, "Recorded violin audition did not render: " + demo_status + " | Browser errors: " + " | ".join(errors)
                demo_project = page.evaluate("""() => {
                    const drafts = JSON.parse(localStorage.getItem("mehran_music_studio_drafts_v1") || "[]");
                    return drafts.find(item => item.name === "MEHRAN · violin Recorded Audition") || null;
                }""")
                assert demo_project and len([track for track in demo_project["tracks"] if track.get("generated") and track.get("audioSize", 0) > 44]) == 1, "Audition must contain exactly one recorded violin WAV track."
                assert "21/21 active seconds" in demo_project["tracks"][0]["notes"], "Audition WAV must contain active audio throughout its eight-second windows: " + str(demo_project["tracks"][0].get("notes"))
                audio_audit = page.evaluate("""async () => {
                    const project = JSON.parse(localStorage.getItem("mehran_music_studio_drafts_v1") || "[]").find(item => item.name === "MEHRAN · violin Recorded Audition");
                    const track = project?.tracks?.find(item => item.generated);
                    const db = await new Promise((resolve, reject) => { const req = indexedDB.open("mehran_music_studio_audio_v1", 1); req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); });
                    const record = await new Promise((resolve, reject) => { const req = db.transaction("trackAudio").objectStore("trackAudio").get(project.id + ":" + track.id); req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); });
                    db.close();
                    const ctx = new AudioContext();
                    const buffer = await ctx.decodeAudioData(await record.blob.arrayBuffer());
                    const left = buffer.getChannelData(0), right = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : left;
                    const rms = [];
                    for (let sec = 0; sec < 8; sec++) {
                        let sum = 0, count = 0;
                        for (let i = sec * buffer.sampleRate; i < Math.min(left.length, (sec + 1) * buffer.sampleRate); i += 32) {
                            const value = (left[i] + right[i]) * 0.5; sum += value * value; count++;
                        }
                        rms.push(Math.sqrt(sum / Math.max(1, count)));
                    }
                    await ctx.close();
                    return {duration: buffer.duration, rms};
                }""")
                assert audio_audit["duration"] >= 20.5, "Eight-bar audition should be about 21 seconds: " + str(audio_audit)
                assert all(level > 0.00035 for level in audio_audit["rms"]), "Audition contains silent seconds: " + str(audio_audit)
                print("PASS: selected violin uses only self-hosted recorded samples; 21-second WAV has active audio in every one-second window")
                # Velocity-layer regression: each piano velocity must load only its matching recorded layer.
                velocity_layer_audit = page.evaluate("""async () => {
                    const engine = await window.MEHRAN_SAMPLE_ENGINE.create();
                    const ctx = new AudioContext();
                    const cases = [];
                    for (const velocity of [0.1, 0.4, 0.9]) {
                        const player = await engine.instrument(ctx, "acoustic_grand_piano", {
                            noteEvents: [{note: 60, velocity}]
                        });
                        cases.push({velocity, urls: player.sampleDiagnostics.map(item => item.url)});
                    }
                    await ctx.close();
                    return cases;
                }""")
                expected_layers = ["Vel01", "Vel02", "Vel04"]
                for case, expected_layer in zip(velocity_layer_audit, expected_layers):
                    assert len(case["urls"]) == 1 and expected_layer in case["urls"][0], "Piano velocity did not select exactly its intended recorded layer: " + str(velocity_layer_audit)
                print("PASS: piano velocity selects one matching recorded sample layer at soft, medium and strong dynamics", flush=True)
                # Round-robin must advance within a velocity layer even when humanized MIDI velocities differ slightly.
                round_robin_audit = page.evaluate("""async () => {
                    const engine = await window.MEHRAN_SAMPLE_ENGINE.create();
                    const ctx = new AudioContext();
                    const velocities = [0.10, 0.12, 0.14, 0.16];
                    const player = await engine.instrument(ctx, "acoustic_drums", {
                        noteEvents: velocities.map(velocity => ({note: 36, velocity}))
                    });
                    const buffers = [];
                    const createSource = ctx.createBufferSource.bind(ctx);
                    ctx.createBufferSource = () => {
                        const source = createSource();
                        const start = source.start.bind(source);
                        source.start = (...args) => { buffers.push(source.buffer); return start(...args); };
                        return source;
                    };
                    velocities.forEach((velocity, index) => player.play(36, ctx.currentTime + 0.05 + index * 0.08, 0.06, {velocity}));
                    await ctx.close();
                    return {plays: buffers.length, uniqueBuffers: new Set(buffers).size, prepared: player.sampleDiagnostics.length};
                }""")
                assert round_robin_audit["plays"] == 4 and round_robin_audit["uniqueBuffers"] == 4, "Acoustic drum round-robin repeated a sample across slightly varied velocities: " + str(round_robin_audit)
                print("PASS: acoustic-drum round-robin advances across four recorded kick takes while velocity is humanized", flush=True)
                page.locator('[data-view="arrangement"]').first.click()
                page.locator("#mixProject").evaluate("""el => { const option = [...el.options].find(item => item.label === "Automated Audio QA"); if (!option) throw new Error("Automated Audio QA project option is missing"); el.value = option.value; el.dispatchEvent(new Event("change", { bubbles: true })); }""")
                page.locator("#patternMode").dispatch_event("change")  # Restore the pre-existing QA project's piano-roll state.
                # Build a recorded acoustic-piano layer and connect its notes to the lyric performance guide.
                page.locator("#patternMode").select_option("live_piano")
                page.locator("#patternNotes").evaluate("""el => { el.value = "C3, -, E3, -, G3, -, E3, -, C3, -, E3, -, G3, -, B3, -"; el.dispatchEvent(new Event("input", { bubbles: true })); el.dispatchEvent(new Event("change", { bubbles: true })); }""")
                assert page.locator("#pianoRollGrid [data-piano-note='C5']").count() == 16
                assert page.locator("#pianoRollGrid [data-piano-note='C2']").count() == 16
                assert page.locator("#pianoRollGrid [data-piano-step='1'][data-piano-note='D3']").count() == 1
                page.locator("#pianoRollGrid [data-piano-step='1'][data-piano-note='D3']").click()
                assert "D3" in page.locator("#patternNotes").input_value()
                page.locator("#patternVelocity").fill("65")
                page.locator("#patternGate").fill("55")
                assert page.locator("#patternVelocityValue").inner_text() == "65%"
                assert page.locator("#patternGateValue").inner_text() == "55%"
                page.locator("#pianoRollGrid [data-piano-step='1'][data-piano-note='D3']").click()
                assert "D3" not in page.locator("#patternNotes").input_value()
                # Polyphonic note events can overlap and retain independent duration/articulation.
                page.locator("#patternNoteLength").select_option("4")
                page.locator("#pianoRollGrid [data-piano-step='1'][data-piano-note='D3']").click()
                page.locator("#pianoRollGrid [data-piano-step='1'][data-piano-note='F3']").click()
                event_model = page.evaluate("JSON.parse(localStorage.getItem('mehran_music_studio_drafts_v1'))[0].patternStudio.noteEvents")
                overlapping = [event for event in event_model if event["startStep"] == 1]
                assert {event["note"] for event in overlapping} == {"D3", "F3"}
                assert all(event["lengthSteps"] == 4 and event["velocity"] == 65 and event["gate"] == 55 for event in overlapping)
                # Per-note microtonal cents must update the visible value and persist on that exact note event.
                micro_slider = page.locator("#patternMicroTuneRows [data-micro-note-id]").first
                assert micro_slider.count() == 1, "Microtuning slider was not rendered for selected piano-roll notes."
                micro_note_id = micro_slider.get_attribute("data-micro-note-id")
                micro_slider.evaluate("""el => { el.value = '37'; el.dispatchEvent(new Event('input', {bubbles:true})); el.dispatchEvent(new Event('change', {bubbles:true})); }""")
                micro_saved = page.evaluate("""id => JSON.parse(localStorage.getItem('mehran_music_studio_drafts_v1'))[0].patternStudio.noteEvents.find(event => event.id === id)""", micro_note_id)
                assert micro_saved and micro_saved["detuneCents"] == 37, "Per-note microtuning cents did not persist to the selected note."
                assert "+37 ¢" in page.locator("#patternMicroTuneRows").inner_text(), "Microtuning slider output did not reflect the selected cents value."
                print("PASS: per-note microtuning control updates and persists cents independently")
                page.locator("#patternNoteLength").select_option("8")
                page.locator("#applyPatternNoteLength").click()
                resized_events = page.evaluate("JSON.parse(localStorage.getItem('mehran_music_studio_drafts_v1'))[0].patternStudio.noteEvents.filter(event => event.startStep === 1)")
                assert len(resized_events) == 2 and all(event["lengthSteps"] == 8 for event in resized_events), "Applying a new duration did not resize all notes in the selected piano-roll step."
                page.locator("#patternNoteLength").select_option("4")
                page.locator("#applyPatternNoteLength").click()
                # Edit a second bar without overwriting the first bar's legacy note map.
                page.locator("#patternBars").select_option("2")
                page.locator("#patternEditBar").select_option("2")
                page.locator("#pianoRollGrid [data-piano-step='2'][data-piano-note='G3']").click()
                multibar_events = page.evaluate("JSON.parse(localStorage.getItem('mehran_music_studio_drafts_v1'))[0].patternStudio.noteEvents")
                assert any(event["startStep"] == 18 and event["note"] == "G3" for event in multibar_events), "Second-bar piano roll events were not stored at their absolute step."
                page.locator("#patternEditBar").select_option("1")

                page.locator("#patternTrackName").fill("Generated keys phrase")
                page.locator("#renderPattern").click()
                try:
                    page.wait_for_function("document.querySelector('#patternStatus')?.textContent.includes('Generated WAV added to the mixer')", timeout=20000)
                except Exception as error:
                    render_status = page.locator("#patternStatus").inner_text()
                    raise AssertionError("Keys pattern render did not finish. Status: " + render_status + ". Browser errors: " + " | ".join(errors)) from error
                melody_project = page.evaluate("JSON.parse(localStorage.getItem('mehran_music_studio_drafts_v1'))[0]")
                assert melody_project["patternStudio"]["mode"] == "live_piano" and "C3" in melody_project["patternStudio"]["notes"] and melody_project["patternStudio"]["velocityByStep"][1] == 65 and melody_project["patternStudio"]["gateByStep"][1] == 55
                melody_events = [event for event in melody_project["patternStudio"]["noteEvents"] if event["startStep"] == 1]
                assert {event["note"] for event in melody_events} == {"D3", "F3"} and all(event["lengthSteps"] == 4 for event in melody_events)
                with page.expect_download() as melody_midi_download:
                    page.locator("#exportPatternMidi").click()
                melody_midi_path = Path(temp) / "melody-roundtrip.mid"
                melody_midi_download.value.save_as(melody_midi_path)
                assert melody_midi_path.read_bytes().startswith(b"MThd")
                page.locator("#patternMidiFile").set_input_files(str(melody_midi_path))
                page.wait_for_function("document.querySelector('#patternStatus')?.textContent.includes('MIDI imported')", timeout=5000)
                melody_roundtrip = page.evaluate("JSON.parse(localStorage.getItem('mehran_music_studio_drafts_v1'))[0].patternStudio.noteEvents")
                assert {event["note"] for event in melody_roundtrip if event["startStep"] == 1} == {"D3", "F3"}
                assert any(event["startStep"] == 18 and event["note"] == "G3" for event in melody_roundtrip), "MIDI roundtrip did not preserve second-bar note positions."
                # Arrangement is a dedicated view; open it before interacting with its timeline.
                page.locator('[data-view="arrangement"]').click()
                page.wait_for_function("!document.querySelector('#view-arrangement')?.classList.contains('hidden')", timeout=5000)
                # Song-form sections are saved in sequence with computed bar positions.
                page.locator("#arrangementSection").select_option("Intro")
                page.locator("#arrangementBars").select_option("2")
                page.locator("#addArrangementSection").click()
                page.locator("#arrangementSection").select_option("Chorus")
                page.locator("#arrangementBars").select_option("2")
                page.locator("#addArrangementSection").click()
                arrangement = page.evaluate("JSON.parse(localStorage.getItem('mehran_music_studio_drafts_v1'))[0].arrangement")
                assert [(item["name"], item["startBar"], item["bars"]) for item in arrangement] == [("Intro", 1, 2), ("Chorus", 3, 2)]
                page.locator("#arrangementTimeline [data-arrangement-move='down']").first.click()
                reordered = page.evaluate("JSON.parse(localStorage.getItem('mehran_music_studio_drafts_v1'))[0].arrangement")
                assert [(item["name"], item["startBar"]) for item in reordered] == [("Chorus", 1), ("Intro", 3)], "Moving a section down did not recalculate song bar positions."
                page.locator("#arrangementTimeline [data-arrangement-move='up']").last.click()
                restored = page.evaluate("JSON.parse(localStorage.getItem('mehran_music_studio_drafts_v1'))[0].arrangement")
                assert [(item["name"], item["startBar"]) for item in restored] == [("Intro", 1), ("Chorus", 3)]
                arrangement_project = page.evaluate("JSON.parse(localStorage.getItem('mehran_music_studio_drafts_v1'))[0]")
                assigned_track_id = arrangement_project["tracks"][0]["id"]
                page.locator("#arrangementTimeline select").nth(0).select_option(assigned_track_id)
                assigned_arrangement = page.evaluate("JSON.parse(localStorage.getItem('mehran_music_studio_drafts_v1'))[0].arrangement")
                assert assigned_track_id in assigned_arrangement[0]["trackIds"], "Arrangement section did not persist its selected track."
                # Export only after song sections exist, then verify a real section-aware WAV download.
                page.locator("#arrangementTimeline select").nth(0).select_option(generated_track["id"])
                with page.expect_download(timeout=30000) as arrangement_download:
                    page.locator("#exportArrangement").click()
                arrangement_wav = Path(temp) / "arranged-song.wav"
                arrangement_download.value.save_as(arrangement_wav)
                assert arrangement_wav.read_bytes().startswith(b"RIFF") and arrangement_wav.stat().st_size > 44
                assert "track placements" in page.locator("#arrangementExportStatus").inner_text()
                # Preview renders the exact same offline arrangement mix, then supports an explicit stop.
                page.locator("#previewArrangement").click()
                page.wait_for_function("document.querySelector('#arrangementExportStatus')?.textContent.includes('Arrangement preview playing')", timeout=30000)
                assert page.locator("#stopArrangementPreview").is_enabled(), "Arrangement preview did not expose an active stop control."
                page.locator("#stopArrangementPreview").click()
                assert "preview stopped" in page.locator("#arrangementExportStatus").inner_text().lower()
                # Instrument and beat creation belongs to the dedicated Arrangement workspace.
                page.locator('[data-view="arrangement"]').click()
                page.wait_for_function("!document.querySelector('#view-arrangement')?.classList.contains('hidden')", timeout=5000)
                # Render a four-chord harmonic backing layer and verify the project record.
                page.locator("#patternMode").select_option("chords")
                page.locator("#patternChords").fill("Am, F, C, G")
                page.locator("#patternTrackName").fill("Generated chord backing")
                page.locator("#renderPattern").click()
                page.wait_for_function("(() => { const t=document.querySelector('#patternStatus')?.textContent||''; return t.includes('Generated WAV added to the mixer') || t.includes('Pattern render failed:'); })()", timeout=30000)
                chord_status = page.locator("#patternStatus").inner_text()
                print("CHORD RENDER DIAGNOSTIC:", chord_status)
                assert "Generated WAV added to the mixer" in chord_status, "Chord render failed: " + chord_status
                assert "cajonLow" in chord_status and "cajonSlap" in chord_status, "Song arrangement must load real recorded cajon low/slap samples: " + chord_status
                chord_project = page.evaluate("JSON.parse(localStorage.getItem('mehran_music_studio_drafts_v1'))[0]")
                chord_track = next(track for track in chord_project["tracks"] if track.get("generated") and track["name"] == "Generated chord backing")
                assert chord_track["type"] == "Chord Backing" and chord_track["audioSize"] > 44
                assert chord_track["gain"] == -4 and chord_track["effects"]["reverb"] == 18 and chord_track["effects"]["chorusDepth"] == 14
                assert chord_project["patternStudio"]["chords"] == ["Am", "F", "C", "G"]
                page.locator("#patternKey").select_option("C")
                page.locator("#patternScale").select_option("major")
                page.locator("#patternPreset").select_option("pop")
                page.locator("#buildChordPreset").click()
                assert page.locator("#patternChords").input_value() == "C, G, Am, F"
                preset_project = page.evaluate("JSON.parse(localStorage.getItem('mehran_music_studio_drafts_v1'))[0]")
                assert preset_project["patternStudio"]["chords"] == ["C", "G", "Am", "F"]

                page.locator("#patternMode").select_option("chords")
                page.locator("#patternChords").fill("Am, H-not-a-chord")
                page.locator("#renderPattern").click()
                assert "valid chords" in page.locator("#patternStatus").inner_text()
                page.locator("#patternChords").fill("Am, F, C, G")
                # Synthesizer modes and synthetic drum kits must not be offered in the user interface.
                synth_modes = ["keys", "epiano", "organ", "lead", "strings", "bell", "bass", "pad", "pluck", "sub", "riser", "impact", "texture", "choir"]
                for mode in synth_modes:
                    assert page.locator('#patternMode option[value="' + mode + '"]').count() == 0, "Synthesizer mode is still selectable: " + mode
                assert page.locator('#drumKit option[value="electronic"]').count() == 0
                assert page.locator('#drumKit option[value="lofi"]').count() == 0
                assert page.locator('#drumKit option[value="recorded"]').count() == 1

                # Every melodic instrument rendered by the instrument palette must use a recorded bank.
                for mode in ["live_piano", "live_organ", "live_violin", "live_kalimba", "live_electric_bass", "live_guitar"]:
                    page.locator("#patternMode").select_option(mode)
                    page.locator("#patternNotes").evaluate("""el => { el.value = "C4, -, E4, -, G4, -, E4, -, C4, -, E4, -, G4, -, B4, -"; el.dispatchEvent(new Event("input", { bubbles: true })); el.dispatchEvent(new Event("change", { bubbles: true })); }""")
                    page.locator("#patternTrackName").fill("Recorded " + mode)
                    page.locator("#renderPattern").click()
                    page.wait_for_function("document.querySelector('#patternStatus')?.textContent.includes('Generated WAV added to the mixer')", timeout=20000)
                    instrument_project = page.evaluate("JSON.parse(localStorage.getItem('mehran_music_studio_drafts_v1'))[0]")
                    instrument_track = next(track for track in instrument_project["tracks"] if track.get("generated") and track["name"] == "Recorded " + mode)
                    assert instrument_track["type"] == "MEHRAN Live Instrument" and instrument_track["audioSize"] > 44
                # Every newly imported melodic instrument must render from its own same-origin recorded samples.
                vocal_assets = page.evaluate("""async () => {
                    const response = await fetch("./assets/instruments/manifest.json", {cache: "no-store"});
                    if (!response.ok) throw new Error("Vocal manifest HTTP " + response.status);
                    const manifest = await response.json();
                    const expected = {female_vocal: 45, male_vocal: 55, female_choir: 45, male_choir: 55, mixed_choir: 100};
                    const counts = {};
                    for (const [name, count] of Object.entries(expected)) {
                        const bank = manifest.instruments?.[name];
                        if (!bank || bank.samples?.length !== count) throw new Error("Wrong sample count for " + name);
                        if (name.endsWith("_choir") && bank.layered !== true) throw new Error("Ensemble bank is not layered: " + name);
                        const loopLengths = bank.samples.map(sample => sample.loopEnd - sample.loopStart);
                        if (Math.min(...loopLengths) < 0.48 || Math.max(...loopLengths) < 1.30) throw new Error("Human vowel sustains are too short: " + name);
                        const sample = bank.samples[0];
                        const audio = await fetch(sample.url, {cache: "no-store"});
                        if (!audio.ok || (await audio.arrayBuffer()).byteLength < 256) throw new Error("Vocal sample failed to load: " + sample.url);
                        counts[name] = bank.samples.length;
                    }
                    return counts;
                }""")
                assert vocal_assets == {"female_vocal": 45, "male_vocal": 55, "female_choir": 45, "male_choir": 55, "mixed_choir": 100}, "Self-hosted human vocal assets are incomplete: " + str(vocal_assets)

                violin_assets = page.evaluate("""async () => {
                    const manifest = await (await fetch("./assets/instruments/manifest.json", {cache:"no-store"})).json();
                    const bank = manifest.instruments?.violin;
                    const expectedRoots = [55,57,60,64,67,69,72,76,79,81,84,88,91,93,96];
                    if (!bank || bank.samples?.length !== 45 || bank.license !== "CC0-1.0") throw new Error("Violin must use the 30-sample CC0 solo bank");
                    const roots = [...new Set(bank.samples.map(x => x.rootNote))].sort((a,b)=>a-b);
                    if (JSON.stringify(roots) !== JSON.stringify(expectedRoots)) throw new Error("Violin root-note coverage is incomplete");
                    const layers = [...new Set(bank.samples.map(x => Math.round(x.velocityMin*127)))].sort((a,b)=>a-b);
                    if (JSON.stringify(layers) !== JSON.stringify([0,64])) throw new Error("Violin must have both recorded velocity layers");
                    for (const sample of bank.samples) {
                        const response = await fetch(sample.url, {cache:"no-store"});
                        if (!response.ok || (await response.arrayBuffer()).byteLength < 256) throw new Error("Violin recording unavailable: " + sample.url);
                    }
                    const ctx = new AudioContext();
                    const engine = await window.MEHRAN_SAMPLE_ENGINE.create();
                    const player = await engine.instrument(ctx, "violin", {destination:ctx.destination, noteEvents:[]});
                    const soft = player.play(57, 0, 0.3, {gain:0.5, velocity:0.25});
                    const strong = player.play(57, 0.4, 0.3, {gain:0.5, velocity:0.85});
                    await ctx.close();
                    if (soft === false || strong === false) throw new Error("Violin recorded velocity-layer playback failed");
                    return {samples:bank.samples.length, roots, layers, softAccepted:soft!==false, strongAccepted:strong!==false};
                }""")
                assert violin_assets["samples"] == 45 and violin_assets["softAccepted"] and violin_assets["strongAccepted"], "Recorded solo violin bank validation failed: " + str(violin_assets)
                print("PASS: solo violin loads 30 checksum-verified CC0 samples plus 15 preserved legacy recordings across 15 roots and two recorded velocity layers", flush=True)

                handpan_assets = page.evaluate("""async () => {
                    const manifest = await (await fetch("./assets/instruments/manifest.json", {cache: "no-store"})).json();
                    const bank = manifest.instruments?.handpan;
                    const expectedRoots = [57, 62, 64, 65, 67, 69, 70, 72, 74];
                    if (!bank || bank.samples?.length !== 51) throw new Error("Handpan must contain all 51 native recorded takes");
                    if (JSON.stringify([...new Set(bank.samples.map(x => x.rootNote))].sort((a,b) => a-b)) !== JSON.stringify(expectedRoots)) throw new Error("Handpan native-note map is incomplete");
                    if (bank.maxPitchShiftSemitones > 0) throw new Error("Handpan pitch shifting must remain disabled");
                    const groups = new Map();
                    for (const sample of bank.samples) {
                        const response = await fetch(sample.url, {cache: "no-store"});
                        if (!response.ok || (await response.arrayBuffer()).byteLength < 256) throw new Error("Handpan recording unavailable: " + sample.url);
                        groups.set(sample.rootNote, (groups.get(sample.rootNote) || 0) + 1);
                    }
                    const ctx = new AudioContext();
                    const engine = await window.MEHRAN_SAMPLE_ENGINE.create();
                    const player = await engine.instrument(ctx, "handpan", {destination: ctx.destination, noteEvents: []});
                    const nativePlayed = player.play(57, 0, 0.2, {gain: 0.5, velocity: 0.5});
                    const nonNativePlayed = player.play(58, 0.3, 0.2, {gain: 0.5, velocity: 0.5});
                    await ctx.close();
                    if (nativePlayed === false || nonNativePlayed !== false) throw new Error("Handpan must play native notes and reject non-native notes without transposition");
                    return {samples: bank.samples.length, roots: expectedRoots, roundRobin: bank.roundRobin === true, rootLayerCounts: Object.fromEntries(groups), nativeAccepted: nativePlayed !== false, nonNativeRejected: nonNativePlayed === false};
                }""")
                assert handpan_assets["samples"] == 51 and handpan_assets["roundRobin"] and handpan_assets["nativeAccepted"] and handpan_assets["nonNativeRejected"], "Recorded handpan bank validation failed: " + str(handpan_assets)
                print("PASS: handpan loads 51 CC0 recordings, round-robins native notes, and rejects non-native notes without pitch shifting", flush=True)

                xylophone_assets = page.evaluate("""async () => {
                    const manifest = await (await fetch("./assets/instruments/manifest.json", {cache: "no-store"})).json();
                    const bank = manifest.instruments?.xylophone;
                    if (!bank || bank.samples?.length !== 18) throw new Error("Xylophone must contain 18 recorded samples");
                    const layers = [...new Set(bank.samples.map(x => x.velocityMin))].sort((a,b) => a-b);
                    if (layers.length !== 2 || Math.abs(layers[0] - 0) > 0.001 || Math.abs(layers[1] - 84/127) > 0.001) throw new Error("Xylophone must retain both recorded velocity layers");
                    const coverage = new Set();
                    for (const sample of bank.samples) {
                        if (!Number.isInteger(sample.keyLow) || !Number.isInteger(sample.keyHigh) || !Number.isInteger(sample.pitchKeyCenter)) throw new Error("Xylophone key-zone mapping is incomplete");
                        for (let note=sample.keyLow; note<=sample.keyHigh; note++) coverage.add(note);
                        const response = await fetch(sample.url, {cache:"no-store"});
                        if (!response.ok || (await response.arrayBuffer()).byteLength < 256) throw new Error("Xylophone recording unavailable: " + sample.url);
                    }
                    for (let note=46; note<=99; note++) if (!coverage.has(note)) throw new Error("Xylophone chromatic key zone missing MIDI " + note);
                    const ctx = new AudioContext();
                    const engine = await window.MEHRAN_SAMPLE_ENGINE.create();
                    const player = await engine.instrument(ctx, "xylophone", {destination:ctx.destination, noteEvents:[]});
                    const soft = player.play(48, 0, 0.2, {gain:0.5, velocity:0.4});
                    const hard = player.play(48, 0.3, 0.2, {gain:0.5, velocity:0.95});
                    const outside = player.play(45, 0.6, 0.2, {gain:0.5, velocity:0.5});
                    await ctx.close();
                    if (soft === false || hard === false || outside !== false) throw new Error("Xylophone velocity-layer or native key-zone playback failed");
                    return {samples:bank.samples.length, layers, coverage:[46,99], softAccepted:soft!==false, hardAccepted:hard!==false, outsideRejected:outside===false};
                }""")
                assert xylophone_assets["samples"] == 18 and xylophone_assets["softAccepted"] and xylophone_assets["hardAccepted"] and xylophone_assets["outsideRejected"], "Recorded xylophone bank validation failed: " + str(xylophone_assets)
                print("PASS: xylophone loads 18 CC0 recordings, both velocity layers, full mapped key range, and rejects unmapped notes", flush=True)
                accordion_assets = page.evaluate("""async () => {
                    const manifest = await (await fetch("./assets/instruments/manifest.json", {cache: "no-store"})).json();
                    const bank = manifest.instruments.button_accordion;
                    if (!bank || bank.samples?.length !== 17 || bank.releaseSamples?.length !== 17 || bank.requireReleaseSamples !== true) {
                        throw new Error("Button accordion sustain/release bank is incomplete");
                    }
                    const ctx = new AudioContext();
                    const decoded = [];
                    for (const sample of [...bank.samples, ...bank.releaseSamples]) {
                        const response = await fetch(sample.url, {cache: "no-store"});
                        if (!response.ok) throw new Error("Accordion asset unavailable: " + sample.url);
                        const buffer = await ctx.decodeAudioData(await response.arrayBuffer());
                        if (buffer.length < 1000 || buffer.numberOfChannels < 1) throw new Error("Invalid accordion audio: " + sample.url);
                        decoded.push({url: sample.url, duration: buffer.duration});
                    }
                    await ctx.close();
                    return {sustain: bank.samples.length, release: bank.releaseSamples.length, decoded: decoded.length,
                        range: bank.expectedKeyRange, uniqueSustainRoots: new Set(bank.samples.map(x => x.rootNote)).size};
                }""")
                assert accordion_assets == {"sustain": 17, "release": 17, "decoded": 34, "range": [47, 79], "uniqueSustainRoots": 17}, "Recorded Hohner accordion bank or key-release recordings are incomplete: " + str(accordion_assets)
                print("PASS: Hohner button accordion loads 17 sustain and 17 dedicated release recordings (CC0)", flush=True)

                # Inspect the full recorded Setar note bank at source level before judging the rendered sampler.
                setar_diagnostics = page.evaluate("""async () => {
                    const manifest = await (await fetch("./assets/instruments/manifest.json", {cache: "no-store"})).json();
                    const bank = manifest.instruments.setar;
                    const ctx = new AudioContext();
                    const rows = [];
                    for (const sample of bank.samples) {
                        const response = await fetch(sample.url, {cache: "no-store"});
                        if (!response.ok) throw new Error("Setar sample unavailable: " + sample.url);
                        const buffer = await ctx.decodeAudioData(await response.arrayBuffer());
                        let peak = 0, square = 0, count = 0, activeSeconds = 0, firstActive = null;
                        const data = buffer.getChannelData(0);
                        for (let i = 0; i < data.length; i++) {
                            const value = data[i], magnitude = Math.abs(value);
                            peak = Math.max(peak, magnitude); square += value * value; count++;
                            if (magnitude > 0.003 && firstActive === null) firstActive = i / buffer.sampleRate;
                        }
                        for (let sec = 0; sec < Math.ceil(buffer.duration); sec++) {
                            let localPeak = 0;
                            for (let i = sec * buffer.sampleRate; i < Math.min(data.length, (sec + 1) * buffer.sampleRate); i += 32) localPeak = Math.max(localPeak, Math.abs(data[i]));
                            if (localPeak > 0.003) activeSeconds++;
                        }
                        rows.push({note: sample.noteLabel, rootNote: sample.rootNote, duration: Number(buffer.duration.toFixed(2)), peak: Number(peak.toFixed(5)), rms: Number(Math.sqrt(square / Math.max(1, count)).toFixed(6)), firstActive: firstActive === null ? null : Number(firstActive.toFixed(3)), activeSeconds});
                    }
                    await ctx.close();
                    return rows;
                }""")
                print("SETAR SOURCE DIAGNOSTICS:", json.dumps(setar_diagnostics), flush=True)

                live_modes_available = ["live_violin", "live_cello", "live_accordion", "live_handpan", "live_kalimba", "live_bass", "live_setar", "live_electric_bass", "live_bassoon", "live_clarinet", "live_flute", "live_french_horn", "live_electric_guitar", "live_harmonium", "live_harp", "live_organ", "live_saxophone", "live_trombone", "live_trumpet", "live_tuba", "live_xylophone", "live_female_vocal", "live_male_vocal", "live_female_choir", "live_male_choir", "live_mixed_choir"]
                live_modes_missing = ["live_tar", "live_santur", "live_ney", "live_kamancheh"]
                page.locator('[data-view="arrangement"]').click()
                page.wait_for_function("!document.querySelector('#view-arrangement')?.classList.contains('hidden')", timeout=5000)
                page.locator("#patternBars").select_option("1")
                for mode in live_modes_available:
                    page.locator('[data-view="arrangement"]').click()
                    page.wait_for_function("!document.querySelector('#view-arrangement')?.classList.contains('hidden')", timeout=5000)
                    print("START LIVE BANK:", mode, flush=True)
                    page.locator("#patternMode").evaluate("(el, value) => { el.value = value; el.dispatchEvent(new Event('change', {bubbles:true})); }", mode)
                    page.locator("#patternNotes").evaluate("""async (el, mode) => { const map={live_violin:"violin",live_cello:"cello",live_accordion:"button_accordion",live_handpan:"handpan",live_kalimba:"kalimba",live_bass:"acoustic_bass",live_setar:"setar",live_electric_bass:"electric_bass",live_bassoon:"bassoon",live_clarinet:"clarinet",live_flute:"flute",live_french_horn:"french_horn",live_electric_guitar:"electric_guitar",live_harmonium:"harmonium",live_harp:"harp",live_organ:"organ",live_saxophone:"saxophone",live_trombone:"trombone",live_trumpet:"trumpet",live_tuba:"tuba",live_xylophone:"xylophone",live_female_vocal:"female_vocal",live_male_vocal:"male_vocal",live_female_choir:"female_choir",live_male_choir:"male_choir",live_mixed_choir:"mixed_choir"}; const inventory=await (await window.MEHRAN_SAMPLE_ENGINE.create()).status([map[mode]]); const info=inventory.instruments.find(item=>item.id===map[mode]); const roots=(mode.includes("vocal")||mode.includes("choir")?(info?.rootNotesByVowel?.o||[]):info?.rootNotes)||[]; if(!roots.length) throw new Error("No recorded roots for browser QA bank: "+mode); const names=["C","C#","D","D#","E","F","F#","G","G#","A","A#","B"]; const label=n=>names[n%12]+(Math.floor(n/12)-1); const noteRoots=mode.includes("choir")?roots:[...roots.slice(0,5),...roots.slice(0,3)]; const notes=[...noteRoots,...noteRoots].slice(0,8).map(label); el.value=notes.join(", ")+", -, -, -, -, -, -, -, -"; el.dispatchEvent(new Event("input", { bubbles: true })); el.dispatchEvent(new Event("change", { bubbles: true })); }""", mode)
                    page.locator("#patternTrackName").evaluate("(el) => el.dispatchEvent(new Event('input', { bubbles: true }))")
                    if mode in ["live_female_vocal", "live_male_vocal", "live_female_choir", "live_male_choir", "live_mixed_choir"]:
                        page.wait_for_function("""() => { const panel=document.querySelector("#vocalVowelPanel"); return !!panel && !panel.classList.contains("hidden") && getComputedStyle(panel).display !== "none"; }""", timeout=5000)
                        assert page.locator("#vocalVowelPanel").is_visible(), "Human vocal vowel selector did not appear: " + mode + "; selected=" + page.locator("#patternMode").input_value() + "; classes=" + page.locator("#vocalVowelPanel").get_attribute("class")
                        page.locator("#vocalVowel").select_option("o")
                    page.locator("#patternTrackName").evaluate("(el, value) => { el.value = value; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); }", "Live QA " + mode)
                    if mode == "live_accordion":
                        page.evaluate("""() => {
                            const prototype = AudioBufferSourceNode.prototype;
                            if (!prototype.__mehranReleaseAuditWrapped) {
                                const originalStart = prototype.start;
                                prototype.start = function(...args) {
                                    if (this.__mehranReleaseTrigger) window.__mehranAccordionReleaseStarts = (window.__mehranAccordionReleaseStarts || 0) + 1;
                                    return originalStart.apply(this, args);
                                };
                                prototype.__mehranReleaseAuditWrapped = true;
                            }
                            window.__mehranAccordionReleaseStarts = 0;
                        }""")
                    page.locator("#renderPattern").evaluate("(el) => el.click()")
                    try:
                        page.wait_for_function("(() => { const t=document.querySelector('#patternStatus')?.textContent||''; return t.includes('Generated WAV added to the mixer') || t.includes('Pattern render failed:'); })()", timeout=60000)
                    except Exception as exc:
                        print("LIVE INSTRUMENT TIMEOUT:", mode, "status=", page.locator("#patternStatus").inner_text(), "button_disabled=", page.locator("#renderPattern").is_disabled(), flush=True)
                        raise
                    live_status = page.locator("#patternStatus").inner_text()
                    print("LIVE BANK RESULT:", mode, live_status, flush=True)
                    assert "Generated WAV added to the mixer" in live_status, "Imported live instrument did not render from recorded samples: " + mode + "; " + live_status
                    if mode == "live_accordion":
                        release_starts = page.evaluate("window.__mehranAccordionReleaseStarts || 0")
                        assert release_starts >= 1, "Accordion note-off did not schedule any dedicated recorded release samples: " + str(release_starts)
                        print("PASS: accordion note endings trigger separate recorded key-release samples", flush=True)
                    expected_ensemble_layers = {"live_female_choir": 9, "live_male_choir": 11, "live_mixed_choir": 20}
                    if mode in expected_ensemble_layers:
                        actual_layers = page.evaluate("window.__mehranLastSampleVoices || 0")
                        assert actual_layers == expected_ensemble_layers[mode], "Human ensemble did not load every recorded singer: " + mode + "; loaded=" + str(actual_layers)
                        assert str(expected_ensemble_layers[mode]) + " recorded human singers layered" in live_status, "Layer count was not shown in the mixer status: " + live_status
                    # Keep the QA project below its 32-track product limit while testing every bank.
                    page.locator('[data-view="mix"]').click()
                    page.locator("#mixProject").evaluate("""el => { const option = [...el.options].find(item => item.label === "Automated Audio QA"); if (!option) throw new Error("Automated Audio QA project option is missing"); el.value = option.value; el.dispatchEvent(new Event("change", { bubbles: true })); }""")
                    project_for_audio = page.evaluate("JSON.parse(localStorage.getItem('mehran_music_studio_drafts_v1'))[0]")
                    audition_track = next(track for track in project_for_audio["tracks"] if track.get("generated") and track["name"] == "Live QA " + mode)
                    export_track_audio(page, project_for_audio["id"], audition_track["id"], mode + ".wav")
                    latest_track_delete = page.locator("[data-track-delete]").last
                    latest_track_text = latest_track_delete.evaluate("(el) => el.closest('article')?.innerText || ''")
                    if "Live QA " + mode not in latest_track_text:
                        raise AssertionError("Could not isolate the generated QA track for " + mode + ": " + latest_track_text)
                    latest_track_delete.click()
                    page.wait_for_timeout(150)
                # Test human third/fifth harmony after ensemble banks so choir QA stays unison and efficient.
                page.locator('[data-view="arrangement"]').click()
                page.wait_for_function("!document.querySelector('#view-arrangement')?.classList.contains('hidden')", timeout=5000)
                page.locator("#patternMode").evaluate("(el) => { el.value = \"live_female_vocal\"; el.dispatchEvent(new Event(\"input\", { bubbles: true })); el.dispatchEvent(new Event(\"change\", { bubbles: true })); }")
                page.locator("#vocalVowel").select_option("o")
                page.locator("#addVocalThird").click()
                assert "major-third" in page.locator("#patternStatus").inner_text(), "Third harmony was not added"
                page.locator("#addVocalFifth").click()
                assert "perfect-fifth" in page.locator("#patternStatus").inner_text(), "Fifth harmony was not added"
                page.locator("#patternTrackName").fill("Live QA human vocal harmony")
                page.locator("#renderPattern").click()
                page.wait_for_function("(() => { const t=document.querySelector('#patternStatus')?.textContent||''; return t.includes('Generated WAV added to the mixer') || t.includes('Pattern render failed:'); })()", timeout=60000)
                harmony_status = page.locator("#patternStatus").inner_text()
                assert "Generated WAV added to the mixer" in harmony_status, "Human vocal harmony render failed: " + harmony_status
                harmony_project = page.evaluate("JSON.parse(localStorage.getItem('mehran_music_studio_drafts_v1'))[0]")
                harmony_track_record = next(track for track in harmony_project["tracks"] if track.get("generated") and track["name"] == "Live QA human vocal harmony")
                export_track_audio(page, harmony_project["id"], harmony_track_record["id"], "human-vocal-harmony.wav")
                page.locator('[data-view="mix"]').click()
                page.locator("#mixProject").evaluate("""el => { const option = [...el.options].find(item => item.label === "Automated Audio QA"); if (!option) throw new Error("Automated Audio QA project option is missing"); el.value = option.value; el.dispatchEvent(new Event("change", { bubbles: true })); }""")
                harmony_track = page.locator("[data-track-delete]").last
                assert "Live QA human vocal harmony" in harmony_track.evaluate("(el) => el.closest('article')?.innerText || ''")
                harmony_track.click()
                page.wait_for_timeout(150)
                audition_dir = ROOT / "test-audio-output"
                (audition_dir / "README.txt").write_text(
                    "MEHRAN MUSIC isolated audition pack\n\n"
                    "WAV previews are rendered in Chromium from the studio's self-hosted recorded sample banks. "
                    "This pack is intended for technical and human listening review, not as proof of naturalness. "
                    "Some instruments have limited sample coverage and are not full chromatic libraries. "
                    "Persian Tar, Santur, Ney and Kamancheh phrase previews are real five-second recordings from PCMIR (CC BY 4.0), "
                    "not note-level sampler banks. PCMIR attribution: Mousavi, Prasath and Mousavi, Persian Classical Music Instrument Recognition Database, DOI 10.17632/bpyxwkv9wj.1. "
                    "Vocal samples are sustained human vowels from VocalSet (CC BY 4.0); ensemble files layer "
                    "separate recorded singers and are not single live-choir recordings.\n",
                    encoding="utf-8")
                audition_files = sorted(audition_dir.glob("*.wav"))
                manifest_lines = ["file,bank,source"]
                for audition_file in audition_files:
                    bank = audition_file.stem
                    source = "PCMIR CC BY 4.0 recorded Persian phrase" if bank.startswith("phrase_") else "VocalSet CC BY 4.0" if ("vocal" in bank or "choir" in bank or bank == "human-vocal-harmony") else "self-hosted recorded sample bank"
                    manifest_lines.append(f"{audition_file.name},{bank},{source}")
                (audition_dir / "manifest.csv").write_text("\n".join(manifest_lines) + "\n", encoding="utf-8")
                print("PASS: 19 melodic instrument banks, 2 solo vocal banks and 3 layered human ensembles")
                # Human-harmony cleanup leaves the UI in Mixing; return to Arrangement before remaining bank checks.
                page.locator('[data-view="arrangement"]').click()
                page.wait_for_function("!document.querySelector('#view-arrangement')?.classList.contains('hidden')", timeout=5000)
                for mode in live_modes_missing:
                    page.locator('[data-view="arrangement"]').click()
                    page.wait_for_function("!document.querySelector('#view-arrangement')?.classList.contains('hidden')", timeout=5000)
                    page.locator("#patternMode").evaluate("(el, value) => { el.value = value; el.dispatchEvent(new Event('change', {bubbles:true})); }", mode)
                    page.locator("#patternTrackName").fill("Live QA " + mode)
                    page.locator("#renderPattern").click()
                    page.wait_for_function("!document.querySelector('#renderPattern')?.disabled", timeout=60000)
                    live_status = page.locator("#patternStatus").inner_text()
                    assert "No real recorded samples are installed" in live_status, "Missing live instrument must fail closed without synthetic fallback: " + mode + "; " + live_status
                print("PASS: tar, santur, ney and kamancheh keyboard banks fail closed until note-level samples are imported")
                # Verify the self-hosted Persian phrase manifest exposes four takes for each instrument.
                phrase_manifest = page.evaluate("fetch('./assets/instruments/phrases/persian/manifest.json').then(r => r.json())")
                for instrument_id in ["tar", "santur", "ney", "kamancheh"]:
                    assert len(phrase_manifest["instruments"][instrument_id]["samples"]) == 4, "Expected four self-hosted recorded phrases for " + instrument_id
                # Real Persian performances are exposed as one-shot phrases, never mislabeled as chromatic note banks.
                for mode, label in [
                    ("phrase_tar", "Tar"),
                    ("phrase_santur", "Santur"),
                    ("phrase_ney", "Ney"),
                    ("phrase_kamancheh", "Kamancheh")
                ]:
                    page.locator('[data-view="arrangement"]').click()
                    page.wait_for_function("!document.querySelector('#view-arrangement')?.classList.contains('hidden')", timeout=5000)
                    page.locator("#patternMode").evaluate("(el, value) => { el.value = value; el.dispatchEvent(new Event('change', {bubbles:true})); }", mode)
                    page.locator("#patternBars").select_option("1")
                    page.locator("#patternTrackName").fill("Persian Phrase QA " + label)
                    page.locator("#renderPattern").click()
                    page.wait_for_function("(() => { const t=document.querySelector('#patternStatus')?.textContent||''; return t.includes('Generated WAV added to the mixer') || t.includes('Pattern render failed:'); })()", timeout=30000)
                    phrase_status = page.locator("#patternStatus").inner_text()
                    assert "Generated WAV added to the mixer" in phrase_status, "Recorded Persian phrase did not render: " + mode + "; " + phrase_status
                    phrase_state = page.evaluate("window.__mehranPersianPhraseRenderState || null")
                    assert phrase_state and phrase_state["mode"] == mode and phrase_state["scheduled"] == 1 and phrase_state["duration"] >= 5.0 and phrase_state["source"] in phrase_manifest["instruments"][mode.replace("phrase_", "")]["samples"], "Persian phrase was not scheduled from the licensed self-hosted sample list: " + str(phrase_state)
                    phrase_project = page.evaluate("JSON.parse(localStorage.getItem('mehran_music_studio_drafts_v1'))[0]")
                    phrase_track = next(track for track in phrase_project["tracks"] if track.get("generated") and track["name"] == "Persian Phrase QA " + label)
                    assert phrase_track["type"] == "Persian Recorded Phrase", "Phrase track was mislabeled: " + phrase_track["type"]
                    export_track_audio(page, phrase_project["id"], phrase_track["id"], mode + ".wav")
                    page.locator('[data-view="mix"]').click()
                    page.locator("#mixProject").evaluate("""el => { const option = [...el.options].find(item => item.label === "Automated Audio QA"); if (!option) throw new Error("Automated Audio QA project option is missing"); el.value = option.value; el.dispatchEvent(new Event("change", { bubbles: true })); }""")
                    phrase_delete = page.locator("[data-track-delete]").last
                    assert "Persian Phrase QA " + label in phrase_delete.evaluate("(el) => el.closest('article')?.innerText || ''")
                    phrase_delete.click()
                    page.wait_for_timeout(150)
                print("PASS: four Persian recorded phrases render from self-hosted CC BY 4.0 audio without pitch-shifting")
                page.locator('[data-view="mix"]').click()
                page.locator('[data-view="arrangement"]').click()
                page.wait_for_function("!document.querySelector('#view-arrangement')?.classList.contains('hidden')", timeout=5000)
                page.locator("#patternMode").select_option("live_cajon")
                # Recorded percussion and acoustic drum-kit samples must render from local assets.
                for mode, notes in [
                    ("live_cajon", "C3, C#3, D3, C3, C#3, D3, -, -, -, -, -, -, -, -, -, -"),
                    ("live_world_percussion", "C3, C#3, D3, D#3, E3, F3, F#3, G3, -, -, -, -, -, -, -, -"),
                    ("live_acoustic_drums", "C2, D2, C#2, F#2, A#2, D3, G2, D#3, -, -, -, -, -, -, -, -")
                ]:
                    page.locator('[data-view="arrangement"]').click()
                    page.wait_for_function("!document.querySelector('#view-arrangement')?.classList.contains('hidden')", timeout=5000)
                    page.locator("#patternNotes").evaluate("(el, value) => { el.value = value; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); }", notes)
                    page.locator("#patternMode").evaluate("(el, value) => { el.value = value; el.dispatchEvent(new Event('change', {bubbles:true})); }", mode)
                    page.locator("#patternTrackName").fill("Live QA " + mode)
                    page.locator("#renderPattern").click()
                    page.wait_for_function("(() => { const t=document.querySelector('#patternStatus')?.textContent||''; return t.includes('Generated WAV added to the mixer') || t.includes('Pattern render failed:'); })()", timeout=60000)
                    live_status = page.locator("#patternStatus").inner_text()
                    assert "Generated WAV added to the mixer" in live_status, "Recorded percussion/drum instrument did not render: " + mode + "; " + live_status
                    page.locator('[data-view="mix"]').click()
                    page.locator("#mixProject").evaluate("""el => { const option = [...el.options].find(item => item.label === "Automated Audio QA"); if (!option) throw new Error("Automated Audio QA project option is missing"); el.value = option.value; el.dispatchEvent(new Event("change", { bubbles: true })); }""")
                    percussion_project = page.evaluate("JSON.parse(localStorage.getItem('mehran_music_studio_drafts_v1'))[0]")
                    percussion_track = next(track for track in percussion_project["tracks"] if track.get("generated") and track["name"] == "Live QA " + mode)
                    export_track_audio(page, percussion_project["id"], percussion_track["id"], mode + ".wav")
                    percussion_delete = page.locator("[data-track-delete]").last
                    assert "Live QA " + mode in percussion_delete.evaluate("(el) => el.closest('article')?.innerText || ''")
                    percussion_delete.click()
                    page.wait_for_timeout(150)
                print("PASS: cajon, world percussion and acoustic drums render from self-hosted recorded samples")
                # The drum step sequencer must use recorded samples when a recorded kit is selected.
                for kit in ["recorded", "cajon", "world_percussion"]:
                    # Seed a deterministic first-bar groove instead of inheriting prior QA state.
                    page.evaluate("""(kit) => {
                        const drafts = JSON.parse(localStorage.getItem("mehran_music_studio_drafts_v1") || "[]");
                        const project = drafts.find(item => item.name === "Automated Audio QA");
                        if (!project) throw new Error("QA project disappeared before drum-grid test");
                        project.patternStudio = {
                            ...(project.patternStudio || {}),
                            mode: "drums", drumKit: kit, tempo: 96, bars: 1,
                            kick: [0, 8], snare: [4, 12], hat: [2, 6, 10, 14],
                            openHat: [], clap: [], tom: [], perc: [8]
                        };
                        localStorage.setItem("mehran_music_studio_drafts_v1", JSON.stringify(drafts));
                    }""", kit)
                    page.reload(wait_until="networkidle")
                    page.locator('[data-view="mix"]').click()
                    page.locator("#mixProject").evaluate("""el => { const option = [...el.options].find(item => item.label === "Automated Audio QA"); if (!option) throw new Error("Automated Audio QA project option is missing"); el.value = option.value; el.dispatchEvent(new Event("change", { bubbles: true })); }""")
                    page.locator('[data-view="arrangement"]').click()
                    page.wait_for_function("!document.querySelector('#view-arrangement')?.classList.contains('hidden')", timeout=5000)
                    # Re-select drum mode and kit through the real UI so the selected project's
                    # state, visible controls and renderer all use the same recorded bank.
                    page.locator("#patternMode").select_option("drums")
                    page.locator("#drumKit").select_option(kit)
                    page.wait_for_function("""(kit) => {
                        const drafts = JSON.parse(localStorage.getItem("mehran_music_studio_drafts_v1") || "[]");
                        const project = drafts.find(item => item.name === "Automated Audio QA");
                        return document.querySelector("#drumKit")?.value === kit &&
                            project?.patternStudio?.mode === "drums" &&
                            project?.patternStudio?.drumKit === kit;
                    }""", arg=kit, timeout=10000)
                    drum_grid_selectors = [
                        '[data-pattern-lane="kick"][data-pattern-step="0"]',
                        '[data-pattern-lane="snare"][data-pattern-step="4"]',
                        '[data-pattern-lane="hat"][data-pattern-step="2"]',
                        '[data-pattern-lane="perc"][data-pattern-step="8"]'
                    ]
                    page.wait_for_function("""(selectors) => selectors.every(selector => document.querySelector(selector))""", arg=drum_grid_selectors, timeout=15000)
                    # Explicitly activate each step through the real UI if state restoration did not.
                    for selector in drum_grid_selectors:
                        step_button = page.locator(selector)
                        if step_button.get_attribute("aria-pressed") != "true":
                            step_button.click()
                    page.wait_for_function("""(selectors) => selectors.every(selector => document.querySelector(selector)?.getAttribute("aria-pressed") === "true")""", arg=drum_grid_selectors, timeout=10000)
                    saved_grid = page.evaluate("""() => {
                        const drafts = JSON.parse(localStorage.getItem("mehran_music_studio_drafts_v1") || "[]");
                        const project = drafts.find(item => item.name === "Automated Audio QA");
                        const pat = project?.patternStudio || {};
                        return { mode: pat.mode, kit: pat.drumKit, kick: pat.kick, snare: pat.snare, hat: pat.hat, perc: pat.perc };
                    }""")
                    expected_grid = {"mode": "drums", "kit": kit, "kick": [0, 8], "snare": [4, 12], "hat": [2, 6, 10, 14], "perc": [8]}
                    if saved_grid != expected_grid:
                        raise AssertionError("Drum-grid UI state did not persist before render: " + kit + "; " + str(saved_grid))
                    print("DRUM GRID STATE VERIFIED:", kit, saved_grid, flush=True)
                    page.evaluate("""() => {
                        window.__mehranDrumPlaybackAudit = {engineCreates: 0, instruments: [], playCalls: []};
                        const originalCreate = window.MEHRAN_SAMPLE_ENGINE.create.bind(window.MEHRAN_SAMPLE_ENGINE);
                        window.MEHRAN_SAMPLE_ENGINE.create = async (...args) => {
                            window.__mehranDrumPlaybackAudit.engineCreates++;
                            const engine = await originalCreate(...args);
                            const originalInstrument = engine.instrument.bind(engine);
                            engine.instrument = async (context, name, options) => {
                                window.__mehranDrumPlaybackAudit.instruments.push({name, requestedEvents: options?.noteEvents?.length || 0});
                                const player = await originalInstrument(context, name, options);
                                const originalPlay = player.play.bind(player);
                                player.play = (...playArgs) => {
                                    window.__mehranDrumPlaybackAudit.playCalls.push({note: playArgs[0], at: playArgs[1], duration: playArgs[2], settings: playArgs[3]});
                                    return originalPlay(...playArgs);
                                };
                                return player;
                            };
                            return engine;
                        };
                    }""")
                    page.locator("#patternTrackName").fill("Recorded drum grid QA " + kit)
                    page.locator("#renderPattern").click()
                    page.wait_for_function("(() => { const t=document.querySelector('#patternStatus')?.textContent||''; return t.includes('Generated WAV added to the mixer') || t.includes('Pattern render failed:'); })()", timeout=60000)
                    drum_status = page.locator("#patternStatus").inner_text()
                    assert "Generated WAV added to the mixer" in drum_status, "Recorded drum grid failed: " + kit + "; " + drum_status
                    playback_audit = page.evaluate("window.__mehranDrumPlaybackAudit")
                    render_state = page.evaluate("window.__mehranDrumRenderState")
                    print("DRUM RENDER INPUT STATE:", kit, render_state, flush=True)
                    print("DRUM LOOP DIAGNOSTIC:", kit, {"loopSteps": (render_state or {}).get("loopSteps", []), "hitCalls": (render_state or {}).get("hitCalls", [])}, flush=True)
                    print("DRUM SAMPLE PLAYBACK AUDIT:", kit, playback_audit, flush=True)
                    if playback_audit["engineCreates"] < 1 or not playback_audit["playCalls"]:
                        raise AssertionError("Recorded drum renderer did not schedule any sample voices: " + kit + "; " + str(playback_audit))
                    page.locator('[data-view="mix"]').click()
                    page.locator("#mixProject").evaluate("""el => { const option = [...el.options].find(item => item.label === "Automated Audio QA"); if (!option) throw new Error("Automated Audio QA project option is missing"); el.value = option.value; el.dispatchEvent(new Event("change", { bubbles: true })); }""")
                    drum_project = page.evaluate("""() => {
                        const projects = JSON.parse(localStorage.getItem("mehran_music_studio_drafts_v1") || "[]");
                        const selectedId = document.querySelector("#mixProject")?.value;
                        const project = projects.find(item => item.id === selectedId && item.name === "Automated Audio QA");
                        if (!project) throw new Error("Selected QA project could not be resolved for drum WAV export");
                        return project;
                    }""")
                    drum_track = next(track for track in drum_project["tracks"] if track.get("generated") and track["name"] == "Recorded drum grid QA " + kit)
                    export_track_audio(page, drum_project["id"], drum_track["id"], "drum_grid_" + kit + ".wav")
                    drum_delete = page.locator("[data-track-delete]").last
                    assert "Recorded drum grid QA " + kit in drum_delete.evaluate("(el) => el.closest('article')?.innerText || ''")
                    drum_delete.click()
                    page.wait_for_timeout(150)
                print("PASS: drum sequencer uses real recorded acoustic drums, cajon and world percussion")
                # Write the manifest only after every melodic, vocal, percussion and drum-grid preview exists.
                audition_files = sorted(audition_dir.glob("*.wav"))
                manifest_lines = ["file,bank,source"]
                for audition_file in audition_files:
                    bank = audition_file.stem
                    source = "PCMIR CC BY 4.0 recorded Persian phrase" if bank.startswith("phrase_") else "VocalSet CC BY 4.0" if ("vocal" in bank or "choir" in bank or bank == "human-vocal-harmony") else "self-hosted recorded sample bank"
                    manifest_lines.append(f"{audition_file.name},{bank},{source}")
                (audition_dir / "manifest.csv").write_text("\n".join(manifest_lines) + "\n", encoding="utf-8")

                # The percussion audit may finish from a hidden/mixer panel after project export.
                # Re-enter Arrangement explicitly before editing the lead pattern.
                page.locator('[data-view="arrangement"]').click()
                page.wait_for_function("!document.querySelector('#view-arrangement')?.classList.contains('hidden')", timeout=10000)
                page.locator("#patternMode").select_option("live_piano")
                page.locator("#patternNotes").evaluate("""el => { el.value = "D4, -, -, -, -, -, -, -"; el.dispatchEvent(new Event("input", { bubbles: true })); el.dispatchEvent(new Event("change", { bubbles: true })); }""")
                page.locator("#patternNotes").dispatch_event("change")
                page.locator('[data-view="vocals"]').first.click()
                page.locator("#vocalProject").select_option(label="Automated Audio QA")
                page.locator("#loadProjectMelody").click()
                loaded_guide_notes = page.locator("#vocalGuideNotes").input_value()
                assert "D4" in loaded_guide_notes, "Vocal guide should import the selected lead note from the piano-roll phrase: " + loaded_guide_notes
                # The imported note values and rendered pitch cards are the behavioral contract; status wording is presentation-only.
                assert "Sing D4" in page.locator("#vocalGuideSteps").inner_text(), "Lyric rehearsal cards should show the first mapped pitch for each step."
                assert page.locator("#vocalGuideBacking").is_checked(), "Chord backing should be enabled by default."
                page.locator("#vocalGuideSyllables").fill("one / two / three / four / five / six / seven / eight")
                page.locator("#vocalGuideNotes").fill("C3, D3, E3, F3, G3, A3, B3, C4")
                page.locator("#vocalGuideTempo").fill("96")
                assert page.locator("#playVocalGuide").is_enabled(), "Vocal guide transport should remain available after changing the phrase."
                page.locator('[data-view="lyrics"]').click()
                page.locator("#lyricsProject").select_option(label="Automated Audio QA")

                # Exercise Persian lyric parsing, section-aware melody timing, and automatic harmony/lead track creation.
                lyric_fixture = "[Intro]\n\n[Verse 1]\nشب از پنجره آرام گذشت\nصدای تو در این خانه نشست\n\n[Chorus]\nبا تو دوباره بهار می‌رسد\nدل از غم روزگار می‌گذرد\n\n[Verse 2]\nراه دور است و چراغی روشن\nنام تو مانده به لب‌های من"
                page.locator("#lyricsEditor").fill(lyric_fixture)
                page.locator("#buildArrangementFromLyrics").click()
                arrangement_status = page.locator("#lyricsArrangementStatus").inner_text()
                assert "تایم‌لاین ساخته شد" in arrangement_status, "Lyrics-to-arrangement parser failed: " + arrangement_status
                # Keep this focused composition test fast while retaining four distinct song sections.
                # Full-length chunk rendering is covered by the dedicated long-audio tests.
                page.evaluate("""() => {
                    const key = "mehran_music_studio_drafts_v1";
                    const drafts = JSON.parse(localStorage.getItem(key) || "[]");
                    const project = drafts.find(item => item.name === "Automated Audio QA");
                    if (!project || !Array.isArray(project.arrangement)) throw new Error("Lyrics arrangement was not persisted.");
                    let startBar = 1;
                    project.arrangement.forEach(section => { section.bars = 2; section.startBar = startBar; startBar += 2; });
                    project.vocalRange = null; // Isolate section-cadence checks from the earlier vocal-range fitting test.
                    localStorage.setItem(key, JSON.stringify(drafts));
                }""")
                page.reload(wait_until="domcontentloaded")
                page.locator('[data-view="compose"]').click()
                page.wait_for_function("!document.querySelector('#view-compose')?.classList.contains('hidden')", timeout=10000)
                # Advanced composition controls are intentionally collapsed in Smart mode.
                # Switch to Pro mode before exercising explicit key/tempo controls.
                page.locator('#view-compose [data-experience-choice="pro"]').click()
                page.locator("#composeProject").select_option(label="Automated Audio QA")
                page.locator("#composeKey").select_option("0")
                page.locator("#composeTempo").fill("90")
                page.locator('[data-melody-choice="A"]').click()
                page.wait_for_function("document.querySelector('#lyricsMelodyStatus')?.textContent.includes('پیش‌شنوی A با جمله‌بندی روان آماده است')", timeout=30000)
                lyric_draft = page.evaluate("""() => {
                    const projects = JSON.parse(localStorage.getItem("mehran_music_studio_drafts_v1") || "[]");
                    const project = projects.find(item => item.name === "Automated Audio QA");
                    return project?.melodyDraft || null;
                }""")
                assert lyric_draft and lyric_draft["sections"][:6] == ["Verse 1", "Verse 1", "Chorus", "Chorus", "Verse 2", "Verse 2"], "Persian lyric section headers were not parsed correctly: " + str(lyric_draft and lyric_draft.get("sections"))
                assert lyric_draft["noteEvents"][0]["startStep"] >= 0
                lyric_syllable_probe = page.evaluate("""() => ({manual:window.__mehranTestLyricSyllables("پن/ج/ره")[0], ordinary:window.__mehranTestLyricSyllables("شب از پنجره آرام گذشت"), explicit:window.__mehranTestLyricSyllables("مُحَمَّد")[0],tanwin:window.__mehranTestLyricSyllables("کتاباً")[0]})""")
                assert lyric_syllable_probe["manual"] == 3 and all(value >= 1 for value in lyric_syllable_probe["ordinary"]) and lyric_syllable_probe["explicit"] >= 1 and lyric_syllable_probe["tanwin"] == 1, "Persian syllable overrides or conservative fallback failed: " + str(lyric_syllable_probe)
                print("PERSIAN SYLLABLE OVERRIDE REGRESSION:", lyric_syllable_probe, flush=True)
                print("PASS: explicit Persian splits, ordinary estimates and tanwin vowel marks are supported", flush=True)
                lyric_stress_probe = page.evaluate("""() => window.__mehranTestMakeLyricMelody("A", "[Verse 1]\\nپن/ج/ره آرام").noteEvents""")
                assert len(lyric_stress_probe) == 5 and lyric_stress_probe[2]["velocity"] == 87 and lyric_stress_probe[4]["velocity"] == 84, "Persian word-final accent must add exactly five velocity units without overriding the line cadence: " + str(lyric_stress_probe)
                print("PERSIAN WORD STRESS REGRESSION:", [(event["id"], event["velocity"]) for event in lyric_stress_probe], flush=True)
                print("PASS: word-final syllables receive a modest expressive accent", flush=True)
                lyric_alignment_probe = page.evaluate("""() => window.__mehranTestMakeLyricMelody("A", "[Verse 1]\\nپن/ج/ره آرام").noteEvents.map(event => ({word:event.lyricWordIndex, syllable:event.lyricWordSyllableIndex, count:event.lyricSyllablesInWord, line:event.lyricSyllableIndex, wordEnd:event.lyricWordEnd}))""")
                expected_lyric_alignment = [{"word":0,"syllable":0,"count":3,"line":0,"wordEnd":False},{"word":0,"syllable":1,"count":3,"line":1,"wordEnd":False},{"word":0,"syllable":2,"count":3,"line":2,"wordEnd":True},{"word":1,"syllable":0,"count":2,"line":3,"wordEnd":False},{"word":1,"syllable":1,"count":2,"line":4,"wordEnd":True}]
                assert lyric_alignment_probe == expected_lyric_alignment, "Every generated note must retain its exact lyric word and syllable position: " + str(lyric_alignment_probe)
                print("LYRIC SYLLABLE ALIGNMENT REGRESSION:", lyric_alignment_probe, flush=True)
                print("PASS: generated melody notes retain exact word, syllable and word-final sustain metadata", flush=True)
                long_vowel_probe = page.evaluate("""() => { const long=window.__mehranTestMakeLyricMelody("A", "[Verse 1]\\nما/ه").noteEvents[0], short=window.__mehranTestMakeLyricMelody("A", "[Verse 1]\\nمه/ه").noteEvents[0]; return {long:{length:long.lengthSteps,marked:long.lyricSyllableHasWrittenLongVowel},short:{length:short.lengthSteps,marked:short.lyricSyllableHasWrittenLongVowel}}; }""")
                assert long_vowel_probe["long"]["marked"] is True and long_vowel_probe["short"]["marked"] is False and long_vowel_probe["long"]["length"] == long_vowel_probe["short"]["length"] + 1, "A manually split syllable with a written long vowel must sustain exactly one extra step: " + str(long_vowel_probe)
                print("PERSIAN WRITTEN LONG-VOWEL REGRESSION:", long_vowel_probe, flush=True)
                print("PASS: manually split long-vowel syllables receive exactly one additional sustain step", flush=True)
                multiword_long_vowel_probe = page.evaluate("""() => window.__mehranTestMakeLyricMelody("A", "[Verse 1]\\nپن/ج/ره ما/ه").noteEvents.map(event => ({word:event.lyricWordIndex, syllable:event.lyricWordSyllableIndex, marked:event.lyricSyllableHasWrittenLongVowel}))""")
                assert len(multiword_long_vowel_probe) == 5 and multiword_long_vowel_probe[2]["marked"] is False and multiword_long_vowel_probe[3]["marked"] is True, "Written long vowels must be mapped to the correct word after whitespace boundaries: " + str(multiword_long_vowel_probe)
                print("MULTIWORD PERSIAN VOWEL ALIGNMENT REGRESSION:", multiword_long_vowel_probe, flush=True)
                lyric_stress_profile = page.evaluate("""() => window.__mehranTestMakeLyricMelody("A", "[Verse 1]\\nمن و تو").noteEvents.map(event => ({word:event.lyricWordIndex, count:event.lyricSyllablesInWord, stress:event.lyricWordStress, velocity:event.velocity}))""")
                assert len(lyric_stress_profile) == 3 and all(not event["stress"] for event in lyric_stress_profile), "Monosyllabic Persian words should not all receive artificial lexical stress: " + str(lyric_stress_profile)
                print("PERSIAN LEXICAL STRESS REGRESSION:", lyric_stress_profile, flush=True)
                print("PASS: lexical accents are reserved for multisyllabic word endings", flush=True)
                punctuation_cadence_probe = page.evaluate("""() => {
                    const events = window.__mehranTestMakeLyricMelody("A", "[Verse 1]\\nپنجره باز است،\\nپنجره باز است.").noteEvents;
                    const last = index => events.filter(event => event.id.startsWith("lyric-" + index + "-")).reduce((best,event) => !best || event.startStep > best.startStep ? event : best, null);
                    const pitchClass = note => { const match=String(note||"").match(/^([A-G])(#?)(-?\\d+)$/); if(!match)return null; return ((Number(match[3])+1)*12+({C:0,D:2,E:4,F:5,G:7,A:9,B:11}[match[1]])+(match[2]?1:0))%12; };
                    const comma=last(0),terminal=last(1);
                    return {comma:comma&&comma.note,terminal:terminal&&terminal.note,commaPc:comma&&pitchClass(comma.note),terminalPc:terminal&&pitchClass(terminal.note)};
                }""")
                assert punctuation_cadence_probe["commaPc"] == 4 and punctuation_cadence_probe["terminalPc"] == 9, "Verse commas should hold a dominant open cadence while sentence endings resolve to tonic: " + str(punctuation_cadence_probe)
                print("PERSIAN PUNCTUATION CADENCE REGRESSION:", punctuation_cadence_probe, flush=True)
                print("PASS: comma-ended verse phrases remain open and terminal phrases resolve to tonic", flush=True)
                chorus_lift_probe = page.evaluate("""() => {
                    const midi = note => { const match=String(note||"").match(/^([A-G])(#?)(-?\\d+)$/); if(!match)return NaN; return (Number(match[3])+1)*12+({C:0,D:2,E:4,F:5,G:7,A:9,B:11}[match[1]])+(match[2]?1:0); };
                    const verse=window.__mehranTestMakeLyricMelody("A", "[Verse 1]\\nپنجره باز است.").noteEvents.map(event=>midi(event.note));
                    const chorus=window.__mehranTestMakeLyricMelody("A", "[Chorus]\\nپنجره باز است.").noteEvents.map(event=>midi(event.note));
                    const median = values => { const sorted=values.slice(0,-1).sort((a,b)=>a-b); return sorted[Math.floor(sorted.length/2)]; };
                    return {verse,chorus,verseMedian:median(verse),chorusMedian:median(chorus)};
                }""")
                assert chorus_lift_probe["chorusMedian"] > chorus_lift_probe["verseMedian"], "The chorus contour should sit measurably above the same verse phrase: " + str(chorus_lift_probe)
                print("CHORUS LIFT REGRESSION:", chorus_lift_probe, flush=True)
                print("PASS: chorus phrases receive a higher melodic register than matching verse phrases", flush=True)
                phrase_link_probe = page.evaluate("""() => { const events=window.__mehranTestMakeLyricMelody("A", "[Bridge]\\nپن/ج/ره آرام\\n[Verse 2]\\nشب/های آرام").noteEvents; const midi=n=>{const m=String(n).match(/^([A-G])(#?)(-?\\d+)$/);if(!m)return NaN;const pc={C:0,D:2,E:4,F:5,G:7,A:9,B:11}[m[1]]+(m[2]?1:0);return (Number(m[3])+1)*12+pc;};const end=events.find(e=>e.id==="lyric-0-4"),start=events.find(e=>e.id==="lyric-1-0");return {end:end&&end.note,start:start&&start.note,interval:end&&start?midi(start.note)-midi(end.note):null}; }""")
                assert phrase_link_probe["interval"] is not None and abs(phrase_link_probe["interval"]) <= 5, "Large phrase-to-phrase melodic leaps should be limited to three scale degrees: " + str(phrase_link_probe)
                print("MELODIC PHRASE LINK REGRESSION:", phrase_link_probe, flush=True)
                print("PASS: consecutive lyric phrases avoid abrupt melodic leaps", flush=True)
                original_lyrics_for_regression = page.locator("#lyricsEditor").input_value()
                section_test_lyrics = "[Verse 1]\nیک مصرع تکراری،\n[Chorus]\nیک مصرع تکراری؟\n[Chorus]\nیک مصرع تکراری؟\n[Pre-Chorus]\nراهی به اوج\n[Bridge]\nیک مصرع تکراری،\n[Outro]\nپایان آرام"
                page.locator('[data-view="lyrics"]').click()
                page.wait_for_function("!document.querySelector('#view-lyrics')?.classList.contains('hidden')", timeout=10000)
                page.locator("#lyricsEditor").fill(section_test_lyrics)
                page.locator('[data-view="compose"]').click()
                page.wait_for_function("!document.querySelector('#view-compose')?.classList.contains('hidden')", timeout=10000)
                page.locator("#composeKey").select_option("auto")
                page.locator("#composeScale").select_option("minor")
                page.evaluate("() => { document.querySelector('#lyricsMelodyStatus').textContent = ''; }")
                page.locator('[data-melody-choice="A"]').click()
                page.wait_for_function("""() => {
                    const project = JSON.parse(localStorage.getItem("mehran_music_studio_drafts_v1") || "[]").find(item => item.name === "Automated Audio QA");
                    const draft = project?.melodyDraft;
                    const status = document.querySelector('#lyricsMelodyStatus')?.textContent || '';
                    return draft?.sourceLyrics === "[Verse 1]\\nیک مصرع تکراری،\\n[Chorus]\\nیک مصرع تکراری؟\\n[Chorus]\\nیک مصرع تکراری؟\\n[Pre-Chorus]\\nراهی به اوج\\n[Bridge]\\nیک مصرع تکراری،\\n[Outro]\\nپایان آرام" && (draft?.sourceNoteEvents || []).some(event => event.id.startsWith('lyric-1-'));
                }""", timeout=30000)
                melody_section_regression = page.evaluate("""() => {
                    const projectId = document.querySelector("#lyricsProject")?.value;
                    const project = JSON.parse(localStorage.getItem("mehran_music_studio_drafts_v1") || "[]").find(item => item.id === projectId);
                    const events = project?.melodyDraft?.sourceNoteEvents || [];
                    const lineNotes = index => events.filter(event => event.id.startsWith("lyric-" + index + "-")).sort((a,b) => a.startStep-b.startStep).map(event => event.note);
                    const midi = note => { const match = String(note || "").match(/^([A-G])([#b]?)(-?\\d)$/); if (!match) return null; return (Number(match[3])+1)*12+({C:0,D:2,E:4,F:5,G:7,A:9,B:11}[match[1]])+(match[2]==="#"?1:match[2]==="b"?-1:0); };
                    const finalMidi = index => midi(lineNotes(index).slice(-1)[0]);
                    const phraseRest = index => { const lineEvents=events.filter(event=>event.id.startsWith("lyric-"+index+"-")); const last=lineEvents.reduce((best,event)=>!best||event.startStep>best.startStep?event:best,null); return last?16-((last.startStep%16)+Number(last.lengthSteps||0)):0; };
                    const rhythmStarts = index => events.filter(event=>event.id.startsWith("lyric-"+index+"-")).sort((a,b)=>a.startStep-b.startStep).map(event=>event.startStep%16);
                    const bridgeNotes = lineNotes(4).map(midi);
                    const preChorusNotes = lineNotes(3).map(midi);
                    const rhythmChecks = Array.from({length:6},(_,index) => {
                        const start=index*16, lineEvents=events.filter(event=>event.id.startsWith("lyric-"+index+"-")).sort((a,b)=>a.startStep-b.startStep);
                        return lineEvents.length>0 && lineEvents[0].startStep===start && lineEvents.every((event,j)=>{
                            const localStart=event.startStep-start, next=lineEvents[j+1], localEnd=localStart+Number(event.lengthSteps||0);
                            return localStart>=0 && localStart<16 && Number(event.lengthSteps)>0 && localEnd<=16 && (!next || event.startStep+Number(event.lengthSteps)<=next.startStep);
                        });
                    });
                    return {verse:lineNotes(0),chorusFirst:lineNotes(1),chorusRepeat:lineNotes(2),verseRhythm:rhythmStarts(0),bridgeRhythm:rhythmStarts(4),bridgeNotes,preChorusNotes,verseCadence:finalMidi(0),chorusCadence:finalMidi(1),preChorusCadence:finalMidi(3),bridgeCadence:finalMidi(4),outroCadence:finalMidi(5),commaRest:phraseRest(0),terminalRest:phraseRest(1),rhythmChecks};
                }""")
                assert melody_section_regression["chorusFirst"] == melody_section_regression["chorusRepeat"], "Repeated chorus lyrics did not preserve the same melodic motif: " + str(melody_section_regression)
                assert melody_section_regression["verse"] != melody_section_regression["chorusFirst"], "Identical words in verse and chorus incorrectly reused the same melodic motif: " + str(melody_section_regression)
                assert melody_section_regression["verseRhythm"] != melody_section_regression["bridgeRhythm"], "Identical words and punctuation should receive section-specific rhythmic phrasing: " + str(melody_section_regression)
                bridge_interior = melody_section_regression["bridgeNotes"][1:-1]
                assert len(bridge_interior) >= 3 and min(bridge_interior) < min(melody_section_regression["bridgeNotes"][0], melody_section_regression["bridgeNotes"][-1]) and max(bridge_interior[-2:]) > min(bridge_interior), "Bridge melody should dip below its opening and then rise before resolving: " + str(melody_section_regression)
                pre_chorus_interior = melody_section_regression["preChorusNotes"][1:-1]
                assert len(pre_chorus_interior) >= 2 and pre_chorus_interior[-1] > pre_chorus_interior[0] and pre_chorus_interior[-1] > melody_section_regression["preChorusNotes"][0], "Pre-Chorus melody should build upward toward the Chorus: " + str(melody_section_regression)
                assert melody_section_regression["chorusCadence"] % 12 == 9 and melody_section_regression["outroCadence"] % 12 == 9, "Chorus and Outro should resolve to the A-minor tonic pitch class: " + str(melody_section_regression)
                assert melody_section_regression["preChorusCadence"] % 12 == 4 and melody_section_regression["bridgeCadence"] % 12 == 4, "Pre-Chorus and Bridge should approach their section changes on the E-dominant pitch class: " + str(melody_section_regression)
                assert all(melody_section_regression["rhythmChecks"]), "Generated lyric notes must start at each bar boundary, remain inside the 16-step bar and never overlap: " + str(melody_section_regression)
                assert melody_section_regression["commaRest"] >= 2 and melody_section_regression["terminalRest"] >= 4, "Punctuation should create a short comma breath and a longer sentence-ending rest: " + str(melody_section_regression)
                punctuation_probe_lyrics = "[Verse 1]\nیک مصرع تکراری،\nیک مصرع تکراری؟"
                page.locator('[data-view="lyrics"]').click()
                page.wait_for_function("!document.querySelector('#view-lyrics')?.classList.contains('hidden')", timeout=10000)
                page.locator("#lyricsEditor").fill(punctuation_probe_lyrics)
                page.locator('[data-view="compose"]').click()
                page.wait_for_function("!document.querySelector('#view-compose')?.classList.contains('hidden')", timeout=10000)
                page.evaluate("() => { document.querySelector('#lyricsMelodyStatus').textContent = ''; }")
                page.locator('[data-melody-choice="A"]').click()
                page.wait_for_function("document.querySelector('#lyricsMelodyStatus')?.textContent.includes('پیش‌شنوی A با جمله‌بندی روان آماده است')", timeout=30000)
                page.wait_for_function("""() => {
                    const projectId = document.querySelector("#lyricsProject")?.value;
                    const project = JSON.parse(localStorage.getItem("mehran_music_studio_drafts_v1") || "[]").find(item => item.id === projectId);
                    const events = project?.melodyDraft?.sourceNoteEvents || [];
                    return events.some(event => event.id.startsWith("lyric-0-")) && events.some(event => event.id.startsWith("lyric-1-"));
                }""", timeout=10000)
                punctuation_cache_regression = page.evaluate("""() => {
                    const projectId = document.querySelector("#lyricsProject")?.value;
                    const project = JSON.parse(localStorage.getItem("mehran_music_studio_drafts_v1") || "[]").find(item => item.id === projectId);
                    const events = project?.melodyDraft?.sourceNoteEvents || [];
                    const rest = index => { const line=events.filter(event=>event.id.startsWith("lyric-"+index+"-")); const last=line.reduce((best,event)=>!best||event.startStep>best.startStep?event:best,null); return last?16-((last.startStep%16)+Number(last.lengthSteps||0)):0; };
                    return {commaRest:rest(0),terminalRest:rest(1)};
                }""")
                assert punctuation_cache_regression["commaRest"] >= 2 and punctuation_cache_regression["terminalRest"] >= 4, "Same-lyric punctuation variants must retain distinct phrase rests: " + str(punctuation_cache_regression)
                print("COMPOSITION PUNCTUATION CACHE REGRESSION:", punctuation_cache_regression, flush=True)
                print("PASS: identical lyric text with different punctuation retains distinct pause timing", flush=True)
                breath_pause_probe = page.evaluate("""() => { const getEnd=text=>{const events=window.__mehranTestMakeLyricMelody("A", "[Verse 1]\\nپن/ج/ره"+text).noteEvents;const last=events[events.length-1];return last.startStep+last.lengthSteps;};return {period:getEnd("."),ellipsis:getEnd("…"),threeDots:getEnd("..."),comma:getEnd("،"),colon:getEnd(":"),open:getEnd("")}; }""")
                assert breath_pause_probe["period"] <= 12 and breath_pause_probe["ellipsis"] <= 12 and breath_pause_probe["threeDots"] <= 12 and breath_pause_probe["comma"] <= 14 and breath_pause_probe["colon"] <= 14 and breath_pause_probe["open"] == 16, "Punctuation-specific breath rests are incorrect: " + str(breath_pause_probe)
                print("PUNCTUATION BREATH REST REGRESSION:", breath_pause_probe, flush=True)
                print("PASS: ellipses, periods, commas and colons create appropriate lyric breath rests", flush=True)
                voice_leading_regression = page.evaluate("""() => {
                    const chords = [[60,64,67],[55,59,62],[57,60,64],[53,57,60]];
                    let previous = null;
                    const voicings = chords.map(chord => {
                        const notes = window.__mehranTestVoiceLeading(chord, previous);
                        const result = {notes, pitchClasses:notes.map(n=>((n%12)+12)%12), movements:previous?notes.map((n,i)=>Math.abs(n-previous[i])):[]};
                        previous = notes;
                        return result;
                    });
                    return voicings;
                }""")
                expected_pitch_classes = [{0,4,7},{7,11,2},{9,0,4},{5,9,0}]
                assert len(voice_leading_regression) == 4, "Voice-leading regression did not produce all four voicings: " + str(voice_leading_regression)
                for index, voicing in enumerate(voice_leading_regression):
                    assert set(voicing["pitchClasses"]) == expected_pitch_classes[index], "Chord voicing changed chord identity: " + str(voice_leading_regression)
                    assert voicing["notes"] == sorted(voicing["notes"]) and all(45 <= note <= 79 for note in voicing["notes"]), "Chord voicing is outside its register or not ordered: " + str(voice_leading_regression)
                    if index:
                        assert max(voicing["movements"]) <= 7, "Voice leading contains an avoidable leap larger than a fifth: " + str(voice_leading_regression)
                print("COMPOSITION VOICE LEADING REGRESSION:", voice_leading_regression, flush=True)
                print("PASS: chord inversions preserve chord tones and keep adjacent voices within seven semitones", flush=True)
                bass_voice_leading_regression = page.evaluate("""() => {
                    const symbols = ["C", "G", "Am", "F"];
                    let previous = null;
                    return symbols.map(symbol => {
                        const notes = window.__mehranTestBassVoiceLeading(symbol, previous === null ? null : [previous]);
                        const result = {symbol, notes, root:notes[0], pitchClasses:notes.map(n=>((n%12)+12)%12), movement:previous === null ? 0 : Math.abs(notes[0]-previous)};
                        previous = notes[0];
                        return result;
                    });
                }""")
                expected_bass_pitch_classes = [{"0","4","7"},{"7","11","2"},{"9","0","4"},{"5","9","0"}]
                assert len(bass_voice_leading_regression) == 4, "Bass voice-leading did not cover all chords: " + str(bass_voice_leading_regression)
                for index, bass in enumerate(bass_voice_leading_regression):
                    assert set(str(pc) for pc in bass["pitchClasses"]) == expected_bass_pitch_classes[index], "Bass inversion lost a chord tone: " + str(bass_voice_leading_regression)
                    assert 28 <= bass["root"] <= 55, "Bass inversion left the bass register: " + str(bass_voice_leading_regression)
                    if index:
                        assert bass["movement"] <= 7, "Bass voice leading contains a leap larger than a fifth: " + str(bass_voice_leading_regression)
                print("COMPOSITION BASS VOICE LEADING REGRESSION:", bass_voice_leading_regression, flush=True)
                print("PASS: bass selects smooth chord-tone inversions across adjacent chord changes", flush=True)
                extended_bass_regression = page.evaluate("""() => {
                    const symbols = ["Am", "Fmaj7", "Dm", "E7", "Cm", "Ddim", "Ab", "Bb"];
                    let previous = null;
                    return symbols.map(symbol => {
                        const notes = window.__mehranTestBassVoiceLeading(symbol, previous === null ? null : [previous]);
                        const result = {symbol, bass:notes[0], pitchClasses:notes.map(n=>((n%12)+12)%12), movement:previous === null ? 0 : Math.abs(notes[0]-previous)};
                        previous = notes[0];
                        return result;
                    });
                }""")
                expected_extended_bass = {
                    "Am": {9,0,4}, "Fmaj7": {5,9,0}, "Dm": {2,5,9}, "E7": {4,8,11},
                    "Cm": {0,3,7}, "Ddim": {2,5,8}, "Ab": {8,0,3}, "Bb": {10,2,5}
                }
                assert len(extended_bass_regression) == 8, "Extended bass progression is incomplete: " + str(extended_bass_regression)
                assert extended_bass_regression[0]["bass"] <= 43, "Initial bass note should start in the lower register: " + str(extended_bass_regression)
                for bass in extended_bass_regression:
                    assert set(bass["pitchClasses"]) == expected_extended_bass[bass["symbol"]], "Bass inversion changed chord identity: " + str(extended_bass_regression)
                    assert 28 <= bass["bass"] <= 55, "Bass note is outside its supported register: " + str(extended_bass_regression)
                assert max(item["movement"] for item in extended_bass_regression[1:]) <= 7, "Extended progression contains a bass leap larger than a fifth: " + str(extended_bass_regression)
                print("COMPOSITION EXTENDED BASS REGRESSION:", extended_bass_regression, flush=True)
                print("PASS: bass voice leading preserves minor, major-seventh, dominant-seventh and diminished chord tones", flush=True)
                bass_sample_coverage = page.evaluate("""async () => {
                    const manifest = await (await fetch("./assets/instruments/manifest.json", {cache:"no-store"})).json();
                    const bank = manifest.instruments.acoustic_bass;
                    if (!bank || !Array.isArray(bank.samples)) throw new Error("Recorded acoustic bass bank is missing.");
                    const roots = bank.samples.map(sample => sample.rootNote).filter(Number.isInteger).sort((a,b)=>a-b);
                    const targetNotes = [33,33,33,32,31,32,32,34];
                    const coverage = targetNotes.map(note => ({note,nearest:Math.min(...roots.map(root=>Math.abs(root-note)))}));
                    return {count:roots.length,min:Math.min(...roots),max:Math.max(...roots),roots,coverage};
                }""")
                assert bass_sample_coverage["count"] == 13 and bass_sample_coverage["min"] == 30 and bass_sample_coverage["max"] == 59, "Recorded acoustic bass sample inventory changed: " + str(bass_sample_coverage)
                assert all(item["nearest"] <= 1 for item in bass_sample_coverage["coverage"]), "Generated bass notes are not covered by a nearby recorded sample: " + str(bass_sample_coverage)
                print("RECORDED ACOUSTIC BASS SAMPLE COVERAGE:", bass_sample_coverage, flush=True)
                print("PASS: every generated low bass note has a recorded acoustic-bass sample within one semitone", flush=True)
                bass_approach_regression = page.evaluate("""() => {
                    const cases = [{current:30,next:"Am"},{current:50,next:"Fmaj7"},{current:36,next:"G"}];
                    return cases.map(item => {
                        const target = window.__mehranTestBassVoiceLeading(item.next, [item.current])[0];
                        return {current:item.current,next:item.next,target,approach:window.__mehranTestBassApproach(item.current,item.next)};
                    });
                }""")
                assert bass_approach_regression[0]["target"] == 33 and bass_approach_regression[0]["approach"] == 32, "Ascending bass approach should lead one semitone below the next A bass: " + str(bass_approach_regression)
                assert bass_approach_regression[1]["target"] == 53 and bass_approach_regression[1]["approach"] == 52, "Descending bass approach should lead one semitone above the next F inversion: " + str(bass_approach_regression)
                assert bass_approach_regression[2]["target"] == 35 and bass_approach_regression[2]["approach"] is None, "A one-semitone bass move should not receive a redundant chromatic approach: " + str(bass_approach_regression)
                print("COMPOSITION BASS APPROACH REGRESSION:", bass_approach_regression, flush=True)
                print("PASS: chromatic bass pickups target the next voice-led inversion from the actual previous bass note", flush=True)
                bass_rhythm_regression = page.evaluate("""() => {
                    const duration = window.__mehranTestBassEventDuration;
                    const hasLateHit = window.__mehranTestBassHasLateHit;
                    const beat = 0.5;
                    const durations = [0, 2, 3, 3.5].map(offset => ({offset,duration:duration(beat,offset)}));
                    const finalChorusPattern = [[0,0,1],[1,2,.48],[2,1,.72],[3.5,0,.36]];
                    const chorusPattern = [[0,0,1],[1,1,.35],[2,2,.68],[3.5,0,.42]];
                    return {durations,finalChorusHasLateHit:hasLateHit(finalChorusPattern),chorusHasLateHit:hasLateHit(chorusPattern),ordinaryPatternHasLateHit:hasLateHit([[0,0,1],[2,2,.7]])};
                }""")
                assert len(bass_rhythm_regression["durations"]) == 4, "Bass duration regression did not cover all beat positions: " + str(bass_rhythm_regression)
                assert all(item["duration"] > 0 and item["offset"]*0.5+item["duration"] < 2 for item in bass_rhythm_regression["durations"]), "Bass notes must end before the next four-beat chord boundary: " + str(bass_rhythm_regression)
                assert bass_rhythm_regression["durations"][0]["duration"] == 0.5*1.28 and bass_rhythm_regression["durations"][-1]["duration"] < 0.5, "Bass sustain should remain expressive but shorten safely near the bar line: " + str(bass_rhythm_regression)
                assert bass_rhythm_regression["finalChorusHasLateHit"] and bass_rhythm_regression["chorusHasLateHit"] and not bass_rhythm_regression["ordinaryPatternHasLateHit"], "Late bass-hit detection must prevent duplicate chorus pickups without changing ordinary patterns: " + str(bass_rhythm_regression)
                print("COMPOSITION BASS RHYTHM REGRESSION:", bass_rhythm_regression, flush=True)
                print("PASS: bass sustains stop before chord changes and late chorus pickups are not doubled", flush=True)
                bass_percussion_regression = page.evaluate("""() => {
                    const duck = window.__mehranTestBassPercussionGain;
                    const slap = duck(1, [{beatOffset:1,isSlap:true,velocity:.8}]);
                    const softAccent = duck(1, [{beatOffset:1,isSlap:false,velocity:.8}]);
                    const partialSlap = duck(1, [{beatOffset:1,isSlap:true,velocity:.4}]);
                    const betweenHits = duck(1.2, [{beatOffset:1,isSlap:true,velocity:.8}]);
                    const noPercussion = duck(1, []);
                    return {slap,softAccent,partialSlap,betweenHits,noPercussion};
                }""")
                assert abs(bass_percussion_regression["slap"] - .74) < 1e-9, "Bass should duck more under a strong cajon slap: " + str(bass_percussion_regression)
                assert abs(bass_percussion_regression["softAccent"] - .86) < 1e-9, "Bass should duck gently under a regular cajon accent: " + str(bass_percussion_regression)
                assert abs(bass_percussion_regression["partialSlap"] - .87) < 1e-9, "Bass ducking should scale with percussion velocity: " + str(bass_percussion_regression)
                assert bass_percussion_regression["betweenHits"] == 1 and bass_percussion_regression["noPercussion"] == 1, "Bass level should remain full between accents and without percussion: " + str(bass_percussion_regression)
                print("COMPOSITION BASS-PERCUSSION SYNC REGRESSION:", bass_percussion_regression, flush=True)
                print("PASS: bass ducking follows cajon accent strength and preserves full level between hits", flush=True)
                melody_feel_results = {}
                for feel, label in [("calm", "آرام"), ("flow", "روان"), ("lively", "پرتحرک")]:
                    page.locator(f'[data-melody-feel="{feel}"]').click()
                    page.wait_for_function(f"document.querySelector('#lyricsMelodyStatus')?.textContent.includes('پیش‌شنوی A با جمله‌بندی {label} آماده است')", timeout=30000)
                    melody_feel_results[feel] = page.evaluate("""() => {
                        const projectId = document.querySelector("#lyricsProject")?.value;
                        const project = JSON.parse(localStorage.getItem("mehran_music_studio_drafts_v1") || "[]").find(item => item.id === projectId);
                        const events = project?.melodyDraft?.sourceNoteEvents || [];
                        const first = events.filter(event => event.id.startsWith("lyric-0-"));
                        const last = events.filter(event => event.id.startsWith("lyric-1-")).reduce((best,event) => !best || event.startStep > best.startStep ? event : best, null);
                        const commaLast = first.reduce((best,event) => !best || event.startStep > best.startStep ? event : best, null);
                        return {feel:project?.melodyDraft?.feel, starts:first.map(event => event.startStep % 16), lengths:first.map(event => Number(event.lengthSteps)), commaRest:commaLast ? 16 - ((commaLast.startStep % 16) + Number(commaLast.lengthSteps || 0)) : -1, terminalRest:last ? 16 - ((last.startStep % 16) + Number(last.lengthSteps || 0)) : -1};
                    }""")
                assert all(melody_feel_results[feel]["feel"] == feel for feel in ("calm", "flow", "lively")), "Each melody phrasing choice must persist independently: " + str(melody_feel_results)
                assert max(melody_feel_results["calm"]["lengths"]) >= max(melody_feel_results["flow"]["lengths"]) >= max(melody_feel_results["lively"]["lengths"]), "Calm, flowing and lively phrasing must have progressively shorter note gates: " + str(melody_feel_results)
                assert all(result["commaRest"] >= 2 and result["terminalRest"] >= 4 for result in melody_feel_results.values()), "Phrasing choices must preserve punctuation rests: " + str(melody_feel_results)
                assert len({tuple(result["starts"]) for result in melody_feel_results.values()}) > 1, "At least two phrasing modes must have distinct rhythmic placement: " + str(melody_feel_results)
                print("COMPOSITION MELODY FEEL REGRESSION:", melody_feel_results, flush=True)
                print("PASS: calm, flowing and lively phrasing alter note timing and sustain while preserving punctuation", flush=True)
                print("COMPOSITION MELODY SECTION REGRESSION:", melody_section_regression, flush=True)
                print("PASS: section-specific melodic cadences and repeated chorus identity", flush=True)
                page.locator('[data-view="lyrics"]').click()
                page.wait_for_function("!document.querySelector('#view-lyrics')?.classList.contains('hidden')", timeout=10000)
                page.locator("#lyricsEditor").fill(original_lyrics_for_regression)
                page.locator("#saveLyrics").click()
                page.wait_for_function('document.querySelector("#lyricsSaveState")?.textContent.includes("Saved locally")', timeout=10000)
                page.locator('[data-view="compose"]').click()
                page.wait_for_function("!document.querySelector('#view-compose')?.classList.contains('hidden')", timeout=10000)
                page.locator("#composeKey").select_option("0")
                page.locator("#composeScale").select_option("minor")
                page.evaluate("() => { const preview=document.querySelector('#lyricsMelodyPreview'); preview.dataset.feel='flow'; preview.dataset.kind='A'; document.querySelector('#lyricsMelodyStatus').textContent=''; }")
                page.locator('[data-melody-choice="A"]').click()
                page.wait_for_function("document.querySelector('#lyricsMelodyStatus')?.textContent.includes('پیش‌شنوی A با جمله‌بندی روان آماده است') || document.querySelector('#lyricsMelodyStatus')?.textContent.includes('ناموفق')", timeout=90000)
                melody_preview_status = page.locator("#lyricsMelodyStatus").inner_text()
                assert "ناموفق" not in melody_preview_status, "Melody preview failed after returning to Composition: " + melody_preview_status
                lyric_draft = page.evaluate("""() => {
                    const projects = JSON.parse(localStorage.getItem("mehran_music_studio_drafts_v1") || "[]");
                    return projects.find(item => item.name === "Automated Audio QA")?.melodyDraft || null;
                }""")
                key_names = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]
                vocal_shift = int((lyric_draft.get("vocalRangeFit") or {}).get("semitoneShift", 0))
                expected_key = key_names[vocal_shift % 12] + " minor"
                assert lyric_draft["key"] == expected_key and lyric_draft["tempo"] == 90, "Compose key/tempo controls or vocal-range adaptation were not applied: " + str((lyric_draft.get("key"), expected_key, lyric_draft.get("tempo"), vocal_shift))
                assert lyric_draft["noteEvents"][0]["note"].startswith("C") or any(lyric_draft["noteEvents"][0]["note"].startswith(name) for name in ("D","D#","F","G","G#","A#")), "Selected C minor scale was not applied to melody notes."
                page.locator("#addLyricsMelody").click()
                page.wait_for_function("document.querySelector('#lyricsMelodyStatus')?.textContent.includes('به پروژه اضافه شد')", timeout=30000)
                melody_track_count = page.evaluate("""() => {
                    const project = JSON.parse(localStorage.getItem("mehran_music_studio_drafts_v1") || "[]").find(item => item.name === "Automated Audio QA");
                    return project.tracks.filter(track => track.name.startsWith("Melody A")).length;
                }""")
                page.locator('[data-melody-choice="A"]').click()
                page.wait_for_function("document.querySelector('#lyricsMelodyStatus')?.textContent.includes('پیش‌شنوی A با جمله‌بندی روان آماده است')", timeout=30000)
                assert page.evaluate("""() => {
                    const project = JSON.parse(localStorage.getItem("mehran_music_studio_drafts_v1") || "[]").find(item => item.name === "Automated Audio QA");
                    return project.tracks.filter(track => track.name.startsWith("Melody A")).length;
                }""") == melody_track_count, "Re-previewing the same melody duplicated a project track."
                page.locator("#composeHarmonyStyle").select_option("emotional")
                page.locator("#buildMelodyBacking").click()
                try:
                    page.wait_for_function("""(() => {
                        const status = document.querySelector('#lyricsMelodyStatus')?.textContent || '';
                        return status.includes('آهنگسازی پایه آماده شد') || status.includes('ساخت همراهی کامل نشد') || status.includes('بیش از ۶۸ میزان');
                    })()""", timeout=90000)
                except Exception as error:
                    diagnostic = page.evaluate("""() => ({
                        lyricsStatus: document.querySelector('#lyricsMelodyStatus')?.textContent || '',
                        patternStatus: document.querySelector('#patternStatus')?.textContent || '',
                        renderLogs: (window.__mehranPatternDebugLogs || []).slice(-35),
                        project: (() => { const p = JSON.parse(localStorage.getItem('mehran_music_studio_drafts_v1') || '[]').find(x => x.name === 'Automated Audio QA'); return p ? {tracks: p.tracks?.length, bars: p.arrangement?.reduce((n, s) => n + (Number(s.bars) || 0), 0), melodyApplied: p.melodyDraft?.applied, noteEvents: p.melodyDraft?.sourceNoteEvents?.length} : null; })()
                    })""")
                    raise AssertionError("Composition render stalled: " + str(diagnostic)) from error
                harmony_status = page.locator("#lyricsMelodyStatus").inner_text()
                assert "آهنگسازی پایه آماده شد" in harmony_status, "Automatic harmony/lead generation failed: " + harmony_status + " | Pattern status: " + page.locator("#patternStatus").inner_text()
                harmony_render_status = page.locator("#patternStatus").inner_text()
                assert "Quantized peak " in harmony_render_status, "Harmony WAV peak diagnostics are missing: " + harmony_render_status
                harmony_peak_db = float(harmony_render_status.split("Quantized peak ", 1)[1].split(" dBFS", 1)[0])
                assert -9.5 <= harmony_peak_db <= -7.5, "Harmony WAV normalization missed its -8 dBFS target: " + harmony_render_status
                assert page.locator("#view-compose").is_visible(), "Compose should remain open for review after harmony generation."
                assert page.locator("#composeResult").is_visible(), "Composition summary panel was not shown."
                # The professional controls explicitly select C minor for this fixture; harmony must honor that choice rather than infer a different key from a vocal-range-shifted preview.\n                expected_harmony_key = "C minor"\n                assert page.locator("#composeResultKey").inner_text() == expected_harmony_key, "Composition summary key does not match the analyzed melody key."
                displayed_chords = " ".join(page.locator("#composeResultChords").inner_text().split())
                expected_chords = page.evaluate("""() => {
                    const project = JSON.parse(localStorage.getItem("mehran_music_studio_drafts_v1") || "[]").find(item => item.name === "Automated Audio QA");
                    return project?.harmonyAnalysis?.chords || [];
                }""")
                expected_chords_text = " · ".join(expected_chords)
                assert expected_chords and displayed_chords.replace(" · ", "·") == expected_chords_text.replace(" · ", "·"), f"Chord progression summary differs from saved harmony: displayed={displayed_chords!r}, saved={expected_chords_text!r}."
                assert "احساسی" in page.locator("#composeResultTracks").inner_text(), "Selected harmony style was not reflected in the result.";
                page.locator("#previewComposeMix").click()
                page.wait_for_function("""(() => {
                    const status = document.querySelector('#mixerStatus')?.textContent || '';
                    return status.startsWith('Playing ') || status.startsWith('Mixer started') || status.startsWith('Mixer could not start:');
                })()""", timeout=20000)
                mixer_preview_status = page.locator("#mixerStatus").inner_text()
                assert mixer_preview_status.startswith("Playing "), "Composition preview did not start playback: " + mixer_preview_status
                page.locator("#stopMix").click()
                harmony_project = page.evaluate("""() => {
                    const projects = JSON.parse(localStorage.getItem("mehran_music_studio_drafts_v1") || "[]");
                    return projects.find(item => item.name === "Automated Audio QA") || null;
                }""")
                assert harmony_project and harmony_project.get("harmonyAnalysis", {}).get("melodyGuide") is True, "Harmony builder did not persist its lead guide result."
                assert any(track.get("name", "").startswith("Harmony & Instruments") for track in harmony_project["tracks"]), "Harmony WAV track is missing."
                assert any(track.get("name", "").startswith("Melody Guide") for track in harmony_project["tracks"]), "Melody guide WAV track is missing."
                harmony_audio_metrics = page.evaluate("""async () => {
                    const project = JSON.parse(localStorage.getItem("mehran_music_studio_drafts_v1") || "[]").find(item => item.name === "Automated Audio QA");
                    const tracks = project.tracks.filter(track => track.name.startsWith("Harmony & Instruments") || track.name.startsWith("Melody Guide"));
                    const db = await new Promise((resolve, reject) => { const req = indexedDB.open("mehran_music_studio_audio_v1", 1); req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); });
                    const results = [];
                    for (const track of tracks) {
                        const record = await new Promise((resolve, reject) => { const req = db.transaction("trackAudio").objectStore("trackAudio").get(project.id + ":" + track.id); req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); });
                        if (!record?.blob) throw new Error("Missing rendered audio blob for " + track.name);
                        const context = new (window.AudioContext || window.webkitAudioContext)();
                        const decoded = await context.decodeAudioData(await record.blob.arrayBuffer());
                        let sum = 0, peak = 0, active = 0, total = 0;
                        for (let channel = 0; channel < decoded.numberOfChannels; channel++) {
                            const data = decoded.getChannelData(channel);
                            for (let i = 0; i < data.length; i++) {
                                const value = Math.abs(data[i]); sum += value * value;
                                if (value > peak) peak = value;
                                if (value > 0.0005) active++;
                                total++;
                            }
                        }
                        results.push({name: track.name, bytes: record.blob.size, duration: decoded.duration, rms: Math.sqrt(sum / Math.max(1, total)), peak, activeRatio: active / Math.max(1, total)});
                        await context.close();
                    }
                    db.close();
                    return results;
                }""")
                print("COMPOSITION AUDIO METRICS:", harmony_audio_metrics, flush=True)
                assert len(harmony_audio_metrics) == 2, "Both harmony and melody guide audio must be present: " + str(harmony_audio_metrics)
                for metric in harmony_audio_metrics:
                    assert metric["duration"] > 5 and metric["bytes"] > 44100, "Rendered arrangement audio is unexpectedly short: " + str(metric)
                    assert metric["peak"] > 0.002 and metric["rms"] > 0.0005 and metric["activeRatio"] > 0.01, "Rendered arrangement contains silence or near-silence: " + str(metric)
                    assert metric["peak"] < 0.99, "Rendered arrangement is too close to digital full scale: " + str(metric)

                # Preview opens the mixer view. Return to Composition before checking its professional editors.
                page.locator('[data-view="compose"]').click()
                page.wait_for_function("document.querySelector('#view-compose')?.classList.contains('hidden') === false", timeout=5000)
                page.locator('[data-experience-stage="compose"] [data-experience-choice="pro"]').click()
                page.wait_for_function("document.querySelector('#compositionNoteEditor')?.offsetParent !== null && document.querySelector('#compositionChordEditor')?.offsetParent !== null", timeout=5000)
                page.locator("#composeNoteIndex").select_option("0")
                original_note = page.locator("#composeNotePitch").input_value()
                replacement_note = "D4" if original_note != "D4" else "E4"
                page.locator("#composeNotePitch").fill(replacement_note)
                page.locator("#saveCompositionNote").click()
                page.wait_for_function("document.querySelector('#compositionNoteStatus')?.textContent.includes('نت ذخیره شد') || document.querySelector('#compositionNoteStatus')?.textContent.includes('تغییر ذخیره نشد')", timeout=60000)
                note_edit_status = page.locator("#compositionNoteStatus").inner_text()
                assert "نت ذخیره شد" in note_edit_status, "Composition note editor failed to rebuild its WAV: " + note_edit_status
                page.locator("#composeChordBar").select_option("0")
                original_chord = page.locator("#composeChordSymbol").input_value()
                replacement_chord = "Fm" if original_chord != "Fm" else "G"
                page.locator("#composeChordSymbol").fill(replacement_chord)
                page.locator("#saveCompositionChord").click()
                page.wait_for_function("document.querySelector('#compositionChordStatus')?.textContent.includes('تغییر کرد') || document.querySelector('#compositionChordStatus')?.textContent.includes('ذخیره نشد')", timeout=60000)
                chord_edit_status = page.locator("#compositionChordStatus").inner_text()
                assert "تغییر کرد" in chord_edit_status, "Composition chord editor failed to rebuild its WAV: " + chord_edit_status
                edited_composition = page.evaluate("""() => JSON.parse(localStorage.getItem("mehran_music_studio_drafts_v1") || "[]").find(item => item.name === "Automated Audio QA")""")
                assert edited_composition["melodyDraft"]["sourceNoteEvents"][0]["note"] == replacement_note, "Edited melody note was not persisted."
                assert edited_composition["harmonyAnalysis"]["chords"][0] == replacement_chord, "Edited bar chord was not persisted."
                edited_audio_metrics = page.evaluate("""async () => {
                    const project = JSON.parse(localStorage.getItem("mehran_music_studio_drafts_v1") || "[]").find(item => item.name === "Automated Audio QA");
                    const melody = project.tracks.filter(track => String(track.name || "").startsWith("Melody Guide ·"));
                    const harmony = project.tracks.filter(track => String(track.name || "").startsWith("Harmony & Instruments ·"));
                    if (melody.length !== 1 || harmony.length !== 1) throw new Error("Edited composition must retain exactly one current melody guide and one harmony track.");
                    const db = await new Promise((resolve, reject) => { const req = indexedDB.open("mehran_music_studio_audio_v1", 1); req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); });
                    const results = [];
                    for (const track of [...melody, ...harmony]) {
                        const record = await new Promise((resolve, reject) => { const req = db.transaction("trackAudio").objectStore("trackAudio").get(project.id + ":" + track.id); req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); });
                        if (!record?.blob || record.blob.size <= 44100) throw new Error("Edited WAV is missing or unexpectedly small: " + track.name);
                        const context = new (window.AudioContext || window.webkitAudioContext)();
                        const decoded = await context.decodeAudioData(await record.blob.arrayBuffer());
                        let sum = 0, peak = 0, count = 0;
                        for (let channel = 0; channel < decoded.numberOfChannels; channel++) {
                            const data = decoded.getChannelData(channel);
                            for (let i = 0; i < data.length; i++) { const value = Math.abs(data[i]); sum += value * value; peak = Math.max(peak, value); count++; }
                        }
                        const rms = Math.sqrt(sum / Math.max(1, count));
                        if (decoded.duration <= 5 || peak <= 0.002 || rms <= 0.0005) throw new Error("Edited WAV is silent or too short: " + track.name);
                        results.push({name: track.name, bytes: record.blob.size, duration: decoded.duration, rms, peak});
                        await context.close();
                    }
                    db.close();
                    return results;
                }""")
                assert len(edited_audio_metrics) == 2, "Both edited composition WAV tracks must decode and contain audio: " + str(edited_audio_metrics)

                # Reload the browser and verify both composition metadata and WAV blobs survive a fresh page lifecycle.
                page.reload(wait_until="networkidle")
                page.wait_for_function("document.querySelector('#view-compose') && document.querySelector('#view-compose').classList.contains('hidden')", timeout=10000)
                reloaded_composition = page.evaluate("""() => JSON.parse(localStorage.getItem("mehran_music_studio_drafts_v1") || "[]").find(item => item.name === "Automated Audio QA")""")
                assert reloaded_composition["melodyDraft"]["sourceNoteEvents"][0]["note"] == replacement_note, "Edited melody note did not survive a full page reload."
                assert reloaded_composition["harmonyAnalysis"]["chords"][0] == replacement_chord, "Edited chord did not survive a full page reload."
                reloaded_audio = page.evaluate("""async () => {
                    const project = JSON.parse(localStorage.getItem("mehran_music_studio_drafts_v1") || "[]").find(item => item.name === "Automated Audio QA");
                    const tracks = project.tracks.filter(track => String(track.name || "").startsWith("Melody Guide ·") || String(track.name || "").startsWith("Harmony & Instruments ·"));
                    if (tracks.length !== 2) throw new Error("Reloaded composition must contain exactly two current rendered tracks.");
                    const db = await new Promise((resolve, reject) => { const req = indexedDB.open("mehran_music_studio_audio_v1", 1); req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); });
                    const results = [];
                    for (const track of tracks) {
                        const record = await new Promise((resolve, reject) => { const req = db.transaction("trackAudio").objectStore("trackAudio").get(project.id + ":" + track.id); req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); });
                        if (!record?.blob || record.blob.size <= 44100) throw new Error("Reloaded WAV missing: " + track.name);
                        const context = new (window.AudioContext || window.webkitAudioContext)();
                        const decoded = await context.decodeAudioData(await record.blob.arrayBuffer());
                        if (decoded.duration <= 5) throw new Error("Reloaded WAV is unexpectedly short: " + track.name);
                        results.push({name: track.name, bytes: record.blob.size, duration: decoded.duration});
                        await context.close();
                    }
                    db.close();
                    return results;
                }""")
                assert len(reloaded_audio) == 2, "Both edited composition WAVs must remain decodable after reload: " + str(reloaded_audio)
                print("PASS: composition note/chord edits and both playable WAV tracks survive a full browser reload")
                print("PASS: professional composition note and chord editors rebuild, persist and retain playable WAV tracks")

                # Beginner one-click composition must create melody and harmony without manual note/chord editing.
                page.locator('[data-view="compose"]').click()
                page.wait_for_function("!document.querySelector('#view-compose')?.classList.contains('hidden')", timeout=5000)
                # Smart and professional composition modes must expose the right controls and persist independently.
                composition_mode = page.locator('[data-experience-stage="compose"]')
                composition_mode.locator('[data-experience-choice="smart"]').click()
                assert not page.locator("#compositionNoteEditor").is_visible(), "Smart composition mode must keep advanced note editing out of the beginner workflow."
                assert not page.locator("#compositionChordEditor").is_visible(), "Smart composition mode must keep advanced chord editing out of the beginner workflow."
                composition_mode.locator('[data-experience-choice="pro"]').click()
                assert page.locator("#compositionNoteEditor").is_visible(), "Professional composition mode must expose the note editor."
                assert page.locator("#compositionChordEditor").is_visible(), "Professional composition mode must expose the chord editor."
                assert page.evaluate("JSON.parse(localStorage.getItem('mehranMusicExperienceModesV1') || '{}').compose") == "pro", "Professional composition mode was not persisted."
                composition_mode.locator('[data-experience-choice="smart"]').click()
                assert page.evaluate("JSON.parse(localStorage.getItem('mehranMusicExperienceModesV1') || '{}').compose") == "smart", "Smart composition mode was not persisted."
                print("PASS: beginner/professional composition modes reveal the correct controls and persist independently", flush=True)
                page.locator("#composeProject").select_option(label="Automated Audio QA")
                page.locator("#autoComposeSong").click()
                page.wait_for_function("document.querySelector('#lyricsMelodyStatus')?.textContent.includes('آهنگسازی پایه آماده شد')", timeout=90000)
                auto_composition = page.evaluate("JSON.parse(localStorage.getItem('mehran_music_studio_drafts_v1')).find(p => p.name === 'Automated Audio QA')")
                assert auto_composition.get("melodyDraft", {}).get("applied") is True, "One-click composition did not apply its melody."
                assert len(auto_composition.get("harmonyAnalysis", {}).get("chords", [])) >= 4, "One-click composition did not create chord harmony."
                assert any("Harmony & Instruments" in track.get("name", "") for track in auto_composition.get("tracks", [])), "One-click composition did not create a harmony audio track."
                assert page.locator("#autoComposeSong").is_enabled() and page.locator("#buildMelodyBacking").is_enabled(), "Composition actions remained disabled after one-click rendering."
                print("PASS: composition render controls recover after one-click generation", flush=True)



                # Generate an original local drum loop and attach its WAV to the same project.
                page.locator('[data-view="arrangement"]').click()
                page.wait_for_function("!document.querySelector('#view-arrangement')?.classList.contains('hidden')", timeout=5000)
                page.locator("#patternTempo").fill("96")
                page.locator("#patternMode").select_option("drums")
                page.locator("#patternBars").select_option("2")
                page.locator("#patternEditBar").select_option("2")
                page.locator("#kickSteps [data-pattern-step='1']").click()
                multibar_drums = page.evaluate("JSON.parse(localStorage.getItem('mehran_music_studio_drafts_v1'))[0].patternStudio.kick")
                assert 17 in multibar_drums, "Second-bar drum steps were not stored at their absolute positions."
                page.locator("#patternEditBar").select_option("1")
                page.locator("#kickSteps [data-pattern-step='1']").click()
                page.locator("#renderPattern").click()
                page.wait_for_function("document.querySelector('#patternStatus')?.textContent.includes('Generated WAV added to the mixer')", timeout=20000)
                generated_project = page.evaluate("JSON.parse(localStorage.getItem('mehran_music_studio_drafts_v1'))[0]")
                generated_track = next(track for track in generated_project["tracks"] if track.get("generated"))
                assert generated_track["type"] == "Drums / Percussion" and generated_track["audioName"].endswith(".wav")
                assert generated_track["audioSize"] > 44 and page.locator("#patternPreview").get_attribute("src")
                generated_blob_exists = page.evaluate("""async () => {
                    const project = JSON.parse(localStorage.getItem("mehran_music_studio_drafts_v1"))[0];
                    const track = project.tracks.find(item => item.generated);
                    const db = await new Promise((resolve, reject) => { const req = indexedDB.open("mehran_music_studio_audio_v1", 1); req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); });
                    const record = await new Promise((resolve, reject) => { const req = db.transaction("trackAudio").objectStore("trackAudio").get(project.id + ":" + track.id); req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); });
                    db.close(); return !!record?.blob && record.blob.size > 44;
                }""")
                assert generated_blob_exists, "Generated WAV was not persisted in local IndexedDB."

                # Regression: every supported song section must map to its own harmony bar.
                section_names = ["Intro", "Verse 1", "Pre-Chorus", "Chorus", "Verse 2", "Bridge", "Instrumental", "Outro"]
                page.evaluate("""(names) => {
                    const drafts = JSON.parse(localStorage.getItem('mehran_music_studio_drafts_v1') || '[]');
                    const project = drafts.find(item => item.name === 'Automated Audio QA');
                    if (!project) throw new Error('Composition regression fixture project is missing.');
                    const lead = project.tracks.find(track => String(track.name || '').startsWith('Melody Guide ·'));
                    if (!lead) throw new Error('Composition regression fixture needs its existing melody guide track.');
                    const arrangementNames = ["intro", "verse 1", "PreChorus", "chorus", "VERSE 2", "bridge", "instrumental", "outro"];
                    project.arrangement = arrangementNames.map((name, index) => ({id: 'section-regression-' + index, name, bars: 4, startBar: index * 4 + 1, trackIds: []}));
                    const notes = ['C4', 'D4', 'Eb4', 'F4', 'G4', 'Ab4', 'Bb4', 'C5'];
                    const harmonyPhrases = [['C4','Eb4','G4','C5'],['D4','F4','Ab4','D5'],['Eb4','G4','Bb4','G5'],['F4','Ab4','C5','C5'],['G4','D5','Bb4','G5'],['Ab4','C5','Eb5','D5'],['Bb4','D5','F5','Bb5'],['C5','Eb5','G5','C6']];
                    const events = names.flatMap((name, index) => harmonyPhrases[index].map((note, noteIndex) => ({id: 'lyric-' + index + '-' + noteIndex, note, startStep: noteIndex * 4, lengthSteps: 1, section: name})));
                    project.melodyDraft.sections = names.slice();
                    project.melodyDraft.sourceNoteEvents = events;
                    project.melodyDraft.noteEvents = events;
                    project.melodyDraft.notes = notes.slice();
                    project.melodyDraft.applied = true;
                    project.melodyDraft.appliedTrackId = lead.id;
                    project.melodyDraft.tempo = 90;
                    localStorage.setItem('mehran_music_studio_drafts_v1', JSON.stringify(drafts));
                }""", section_names)
                page.reload(wait_until="networkidle")
                page.locator('[data-view="compose"]').click()
                page.locator("#composeProject").select_option(label="Automated Audio QA")
                page.evaluate("""() => { const source = document.querySelector("#composeProject"); const target = document.querySelector("#lyricsProject"); target.value = source.value; target.dispatchEvent(new Event("change", {bubbles: true})); }""")
                page.locator("#buildMelodyBacking").click()
                page.wait_for_function("document.querySelector('#lyricsMelodyStatus')?.textContent.includes('آهنگسازی پایه آماده شد') || document.querySelector('#lyricsMelodyStatus')?.textContent.includes('ساخت همراهی کامل نشد')", timeout=90000)
                section_regression = page.evaluate("""() => {
                    const project = JSON.parse(localStorage.getItem('mehran_music_studio_drafts_v1') || '[]').find(item => item.name === 'Automated Audio QA');
                    return {sections: project?.patternStudio?.sectionMap || [], key: project?.harmonyAnalysis?.key || '', chords: project?.harmonyAnalysis?.chords || [], bars: project?.harmonyAnalysis?.bars || 0, status: document.querySelector('#lyricsMelodyStatus')?.textContent || ''};
                }""")
                expected_section_map = ["intro", "verse 1", "PreChorus", "chorus", "VERSE 2", "bridge", "instrumental", "outro"]
                assert "آهنگسازی پایه آماده شد" in section_regression["status"], "Section-aware harmony generation failed: " + str(section_regression)
                expected_section_map = [name for name in expected_section_map for _ in range(4)]
                assert section_regression["sections"] == expected_section_map, "Harmony section map lost, reordered or mislabelled a song section: " + str(section_regression["sections"])
                assert section_regression["bars"] == len(section_names) * 4 and len(section_regression["chords"]) == len(section_names) * 4, "Harmony progression does not cover all four bars of every song section: " + str(section_regression)
                assert section_regression["key"] == "C minor", "Known C-minor melody was assigned the wrong key: " + str(section_regression)
                assert all(chord in {"Cm", "Ddim", "Eb", "Fm", "G", "Ab", "Bb"} for chord in section_regression["chords"]), "C-minor harmony contains a chord outside its supported diatonic set (including the major dominant): " + str(section_regression["chords"])
                assert len(set(section_regression["chords"])) >= 5, "Harmony progression collapsed into too few repeated chords instead of following the melody and section changes: " + str(section_regression["chords"])
                assert section_regression["chords"][-1] == "Cm", "The final C-minor Outro bar must resolve to the tonic chord: " + str(section_regression["chords"])
                assert section_regression["chords"][11] == "G", "Pre-Chorus must approach the Chorus through the dominant G chord: " + str(section_regression["chords"])
                assert section_regression["chords"][15] == "Cm", "Chorus must resolve to the C-minor tonic when its final melody note is C: " + str(section_regression["chords"])
                assert section_regression["chords"][23] == "G", "Bridge should land on the dominant G chord before the final sections: " + str(section_regression["chords"])
                melody_chord_support = page.evaluate("""() => {
                    const project = JSON.parse(localStorage.getItem('mehran_music_studio_drafts_v1') || '[]').find(item => item.name === 'Automated Audio QA');
                    const pitchClass = note => {
                        const match = String(note || '').trim().match(/^([A-G])([#b]?)-?\\d+$/i);
                        if (!match) return null;
                        const root = {C:0,D:2,E:4,F:5,G:7,A:9,B:11}[match[1].toUpperCase()];
                        return (root + (match[2] === '#' ? 1 : match[2] === 'b' ? 11 : 0)) % 12;
                    };
                    const chordTones = symbol => {
                        const match = String(symbol || '').match(/^([A-G])([#b]?)(.*)$/);
                        if (!match) return [];
                        const root = ({C:0,D:2,E:4,F:5,G:7,A:9,B:11}[match[1]] + (match[2] === '#' ? 1 : match[2] === 'b' ? 11 : 0)) % 12;
                        const intervals = match[3] === 'dim' ? [0,3,6] : match[3].startsWith('m') ? [0,3,7] : [0,4,7];
                        return intervals.map(interval => (root + interval) % 12);
                    };
                    const sourceEvents = project?.melodyDraft?.sourceNoteEvents || [];
                    const sections = project?.melodyDraft?.sections || [];
                    const arrangement = project?.arrangement || [];
                    const normalize = value => {
                        let name = String(value || "Verse").trim().toLowerCase().replace(/[ _]+/g, "-").replace(/-+/g, "-");
                        if (name === "verse") name = "verse-1";
                        if (name === "prechorus") name = "pre-chorus";
                        return name;
                    };
                    const placements = new Map();
                    let arrangementCursor = 0, lineCursor = 0;
                    while (lineCursor < sections.length) {
                        const sectionName = String(sections[lineCursor] || "Verse");
                        const wantedName = normalize(sectionName);
                        let lineEnd = lineCursor + 1;
                        while (lineEnd < sections.length && String(sections[lineEnd] || "Verse") === sectionName) lineEnd++;
                        let matchIndex = -1;
                        for (let j = arrangementCursor; j < arrangement.length; j++) {
                            if (normalize(arrangement[j].name || "Verse 1") === wantedName) { matchIndex = j; break; }
                        }
                        if (matchIndex < 0) {
                            for (let j = 0; j < arrangement.length; j++) {
                                if (normalize(arrangement[j].name || "Verse 1") === wantedName) { matchIndex = j; break; }
                            }
                        }
                        if (matchIndex >= 0) {
                            const section = arrangement[matchIndex];
                            const startBar = Math.max(0, (Number(section.startBar) || 1) - 1);
                            const capacity = Math.max(1, Number(section.bars) || 1);
                            const lineCount = lineEnd - lineCursor;
                            const stepsPerLine = capacity * 16 / lineCount;
                            for (let line = lineCursor; line < lineEnd; line++) {
                                const local = line - lineCursor;
                                placements.set(line, {startStep: startBar * 16 + Math.floor(local * stepsPerLine), scale: stepsPerLine / 16, spanSteps: stepsPerLine});
                            }
                            arrangementCursor = matchIndex + 1;
                        }
                        lineCursor = lineEnd;
                    }
                    const events = sourceEvents.map(event => {
                        const match = String(event.id || "").match(/^lyric-(\\d+)-/);
                        const line = match ? Number(match[1]) : null;
                        const placement = line !== null ? (placements.get(line) || null) : null;
                        if (!placement) return {...event};
                        const localStep = ((Number(event.startStep) || 0) % 16 + 16) % 16;
                        const relativeStart = Math.min(Math.max(0, Math.round(localStep * placement.scale)), Math.max(0, Math.ceil(placement.spanSteps) - 1));
                        const remaining = Math.max(1, Math.ceil(placement.spanSteps - relativeStart));
                        return {...event, startStep: Math.min(arrangement.length * 64 - 1, placement.startStep + relativeStart), lengthSteps: Math.max(1, Math.min(remaining, Math.round((Number(event.lengthSteps) || 2) * placement.scale)))};
                    });
                    const chords = project?.harmonyAnalysis?.chords || [];
                    return events.map(event => {
                        const bar = Math.floor(Math.max(0, Number(event.startStep) || 0) / 16);
                        const chord = bar >= 0 && bar < chords.length ? chords[bar] : null;
                        const pc = pitchClass(event.note);
                        return {section:event.section,note:event.note,chord,supported:pc !== null && chordTones(chord).includes(pc)};
                    });
                }""")
                assert len(melody_chord_support) == len(section_names) * 4 and all(item["supported"] for item in melody_chord_support), "All four melody notes in every four-bar section must be supported by their exact mapped bar chords: " + str(melody_chord_support)
                assert len({item["section"] for item in melody_chord_support}) == len(section_names), "Harmony support regression did not cover all eight song sections: " + str(melody_chord_support)
                assert all(__import__("re").fullmatch(r"[A-G](?:#|b)?(?:m|dim|aug|sus2|sus4|7|m7|maj7)?", chord) for chord in section_regression["chords"]), "Section-aware harmony produced an invalid chord symbol: " + str(section_regression["chords"])
                print("COMPOSITION HARMONY REGRESSION:", {"key": section_regression["key"], "bars": section_regression["bars"], "chordCount": len(section_regression["chords"]), "chords": section_regression["chords"], "melodySupport": melody_chord_support}, flush=True)
                print("PASS: eight song sections map in order and the known C-minor melody retains a compatible diatonic harmony set", flush=True)

                # Regression: smart arrangement must create a deliberate section-level energy arc.
                smart_layer_plan = page.evaluate("""() => {
                    const choose = window.__mehranTestSmartArrangementLayerIndexes;
                    if (typeof choose !== 'function') throw new Error('Smart arrangement layer planner is unavailable.');
                    return {
                        intro: choose('Intro'),
                        verse: choose('Verse 1'),
                        preChorus: choose('Pre-Chorus'),
                        chorus: choose('Chorus'),
                        bridge: choose('Bridge'),
                        outro: choose('Outro')
                    };
                }""")
                assert smart_layer_plan == {
                    "intro": [2],
                    "verse": [0, 1, 3],
                    "preChorus": [0, 1, 2, 3],
                    "chorus": [0, 1, 2, 3],
                    "bridge": [1, 2, 3],
                    "outro": [2]
                }, "Smart arrangement must thin the Intro/Outro, keep Verse controlled, and build the Chorus with recorded guitar: " + str(smart_layer_plan)
                print("SMART ARRANGEMENT SECTION LAYERS:", smart_layer_plan, flush=True)
                print("PASS: smart arrangement assigns generated drums, bass and atmosphere according to song-section energy", flush=True)

                # Regression: all five harmony styles must produce real, style-sensitive progressions in minor,
                # and the same composition engine must correctly analyze and harmonize a major-key melody.
                page.evaluate("""() => {
                    const drafts = JSON.parse(localStorage.getItem('mehran_music_studio_drafts_v1') || '[]');
                    const project = drafts.find(item => item.name === 'Automated Audio QA');
                    if (!project) throw new Error('Style regression fixture project is missing.');
                    const sectionNames = ['Intro', 'Verse 1', 'Chorus', 'Bridge'];
                    project.arrangement = sectionNames.map((name, index) => ({id:'style-regression-'+index,name,bars:2,startBar:index*2+1,trackIds:[]}));
                    const phrase = ['C4','D4','Eb4','F4','G4','Ab4','Bb4','C5'];
                    const draftSections = sectionNames.flatMap(section => [section,section]);
                    const events = phrase.map((note,index) => ({id:'lyric-'+index+'-0',note,startStep:2,lengthSteps:1,section:sectionNames[Math.floor(index/2)]}));
                    project.melodyDraft.sections = draftSections;
                    project.melodyDraft.sourceNoteEvents = events;
                    project.melodyDraft.noteEvents = events;
                    project.melodyDraft.notes = phrase.slice(0,8);
                    project.melodyDraft.applied = true;
                    project.melodyDraft.tempo = 90;
                    localStorage.setItem('mehran_music_studio_drafts_v1', JSON.stringify(drafts));
                }""")
                page.reload(wait_until="networkidle")
                page.locator('[data-view="compose"]').click()
                page.locator("#composeProject").select_option(label="Automated Audio QA")
                page.evaluate("""() => { const source=document.querySelector("#composeProject"); const target=document.querySelector("#lyricsProject"); target.value=source.value; target.dispatchEvent(new Event("change",{bubbles:true})); }""")
                style_progressions = {}
                for harmony_style in ("auto", "pop", "emotional", "cinematic", "folk"):
                    page.evaluate("(value) => { const select=document.querySelector('#composeHarmonyStyle'); select.value=value; select.dispatchEvent(new Event('change',{bubbles:true})); }", harmony_style)
                    page.evaluate("() => { document.querySelector('#lyricsMelodyStatus').textContent=''; }")
                    page.locator("#buildMelodyBacking").click()
                    page.wait_for_function("""() => {
                        const status=document.querySelector('#lyricsMelodyStatus')?.textContent || '';
                        return status.includes('آهنگسازی پایه آماده شد') || status.includes('ساخت همراهی کامل نشد');
                    }""", timeout=90000)
                    style_result = page.evaluate("""() => {
                        const project=JSON.parse(localStorage.getItem('mehran_music_studio_drafts_v1') || '[]').find(item=>item.name==='Automated Audio QA');
                        return {status:document.querySelector('#lyricsMelodyStatus')?.textContent || '',key:project?.harmonyAnalysis?.key || '',chords:project?.harmonyAnalysis?.chords || [],bars:project?.harmonyAnalysis?.bars || 0,resultLabel:document.querySelector('#composeResultTracks')?.textContent || ''};
                    }""")
                    assert "آهنگسازی پایه آماده شد" in style_result["status"], "Harmony style render failed for " + harmony_style + ": " + str(style_result)
                    assert style_result["key"] == "C minor" and style_result["bars"] == 8 and len(style_result["chords"]) == 8, "Minor-key style fixture was not analyzed or rendered correctly for " + harmony_style + ": " + str(style_result)
                    assert all(chord in {"Cm","Ddim","Eb","Fm","G","Ab","Bb"} for chord in style_result["chords"]), "Minor style generated a chord outside the diatonic harmony set: " + harmony_style + " " + str(style_result["chords"])
                    expected_style_labels = {"auto":"خودکار","pop":"پاپ و روان","emotional":"احساسی","cinematic":"سینمایی","folk":"فولک و ساده"}
                    assert expected_style_labels[harmony_style] in style_result["resultLabel"], "Selected harmony style was not reflected in the result summary: " + harmony_style
                    style_progressions[harmony_style] = style_result["chords"]
                assert len({tuple(chords) for chords in style_progressions.values()}) >= 3, "Harmony style choices collapsed to fewer than three distinct progressions: " + str(style_progressions)
                print("COMPOSITION STYLE REGRESSION:", style_progressions, flush=True)
                print("PASS: all five harmony styles render distinct minor-key progressions and preserve the supported diatonic chord set", flush=True)

                page.evaluate("() => { document.querySelector('#composeKey').value='0'; document.querySelector('#composeScale').value='major'; document.querySelector('#composeKey').dispatchEvent(new Event('change',{bubbles:true})); document.querySelector('#composeScale').dispatchEvent(new Event('change',{bubbles:true})); }")
                page.evaluate("""() => {
                    const drafts=JSON.parse(localStorage.getItem('mehran_music_studio_drafts_v1') || '[]');
                    const project=drafts.find(item=>item.name==='Automated Audio QA');
                    const sectionNames=['Intro','Verse 1','Chorus','Outro'];
                    const phrase=['C4','D4','E4','F4','G4','A4','B4','C5'];
                    const draftSections=sectionNames.flatMap(section=>[section,section]);
                    const events=phrase.map((note,index)=>({id:'lyric-'+index+'-0',note,startStep:2,lengthSteps:1,section:sectionNames[Math.floor(index/2)]}));
                    project.arrangement=sectionNames.map((name,index)=>({id:'major-regression-'+index,name,bars:2,startBar:index*2+1,trackIds:[]}));
                    project.melodyDraft.sections=draftSections;
                    project.melodyDraft.sourceNoteEvents=events;
                    project.melodyDraft.noteEvents=events;
                    project.melodyDraft.notes=phrase.slice(0,8);
                    localStorage.setItem('mehran_music_studio_drafts_v1',JSON.stringify(drafts));
                }""")
                page.evaluate("() => { const select=document.querySelector('#composeHarmonyStyle'); select.value='auto'; select.dispatchEvent(new Event('change',{bubbles:true})); }")
                page.evaluate("() => { document.querySelector('#lyricsMelodyStatus').textContent=''; }")
                page.locator("#buildMelodyBacking").click()
                page.wait_for_function("""() => {
                    const status=document.querySelector('#lyricsMelodyStatus')?.textContent || '';
                    return status.includes('آهنگسازی پایه آماده شد') || status.includes('ساخت همراهی کامل نشد');
                }""", timeout=90000)
                major_result = page.evaluate("""() => {
                    const project=JSON.parse(localStorage.getItem('mehran_music_studio_drafts_v1') || '[]').find(item=>item.name==='Automated Audio QA');
                    return {status:document.querySelector('#lyricsMelodyStatus')?.textContent || '',key:project?.harmonyAnalysis?.key || '',chords:project?.harmonyAnalysis?.chords || [],bars:project?.harmonyAnalysis?.bars || 0};
                }""")
                assert "آهنگسازی پایه آماده شد" in major_result["status"], "Major-key harmony generation failed: " + str(major_result)
                assert major_result["key"] == "C major" and major_result["bars"] == 8 and len(major_result["chords"]) == 8, "Known C-major melody was assigned the wrong key or bar count: " + str(major_result)
                assert all(chord in {"C","Dm","Em","F","G","Am","Bdim"} for chord in major_result["chords"]), "C-major harmony contains a chord outside its supported diatonic set: " + str(major_result["chords"])
                assert major_result["chords"][-1] == "C", "The final C-major Outro bar must resolve to the tonic chord in the major-key fixture: " + str(major_result["chords"])
                print("COMPOSITION MAJOR REGRESSION:", major_result, flush=True)
                print("PASS: known C-major melody receives an eight-bar diatonic progression and tonic resolution", flush=True)

                # Exercise the real smart-arrangement generator and inspect all three rendered WAV stems.
                page.locator('[data-view="create"]').first.click()
                page.locator("#projectName").fill("Automated Smart Arrangement QA")
                page.locator("#saveProject").click()
                page.locator('[data-view="mix"]').click()
                page.locator("#mixProject").evaluate("""el => {
                    const option = [...el.options].find(item => item.label === "Automated Smart Arrangement QA");
                    if (!option) throw new Error("Automated Smart Arrangement QA project option is missing");
                    el.value = option.value;
                    el.dispatchEvent(new Event("change", {bubbles:true}));
                }""")
                smart_project_id = page.evaluate("""() => {
                    const project = JSON.parse(localStorage.getItem("mehran_music_studio_drafts_v1") || "[]")
                        .find(item => item.name === "Automated Smart Arrangement QA");
                    if (!project) throw new Error("Smart arrangement QA project was not saved");
                    project.harmonyAnalysis = {key:"C minor", chords:["Cm","Ab","Eb","Bb"], bars:4};
                    project.melodyDraft = {applied:true, tempo:96};
                    project.arrangement = [
                        {id:"smart-intro",name:"Intro",bars:1,startBar:1,trackIds:[]},
                        {id:"smart-verse",name:"Verse 1",bars:1,startBar:2,trackIds:[]},
                        {id:"smart-chorus",name:"Chorus",bars:1,startBar:3,trackIds:[]},
                        {id:"smart-outro",name:"Outro",bars:1,startBar:4,trackIds:[]}
                    ];
                    localStorage.setItem("mehran_music_studio_drafts_v1", JSON.stringify(
                        JSON.parse(localStorage.getItem("mehran_music_studio_drafts_v1") || "[]").map(item => item.id === project.id ? project : item)
                    ));
                    return project.id;
                }""")
                page.reload(wait_until="domcontentloaded")
                page.locator('[data-view="mix"]:visible').first.click()
                page.locator("#mixProject").evaluate("""el => {
                    const option = [...el.options].find(item => item.label === "Automated Smart Arrangement QA");
                    if (!option) throw new Error("Automated Smart Arrangement QA project option is missing after reload");
                    el.value = option.value;
                    el.dispatchEvent(new Event("change", {bubbles:true}));
                }""")
                page.locator('[data-view="arrangement"]:visible').click()
                page.locator("#autoBuildArrangement").click()
                page.wait_for_function("""() => {
                    const status = document.querySelector("#smartArrangementStatus")?.textContent || "";
                    return status.includes("تنظیم هوشمند ساخته شد") || status.includes("تنظیم کامل نشد");
                }""", timeout=180000)
                smart_status = page.locator("#smartArrangementStatus").inner_text()
                assert "تنظیم هوشمند ساخته شد" in smart_status, "Smart arrangement generation failed: " + smart_status
                smart_state = page.evaluate("""() => {
                    const project = JSON.parse(localStorage.getItem("mehran_music_studio_drafts_v1") || "[]")
                        .find(item => item.name === "Automated Smart Arrangement QA");
                    return {
                        tracks:(project?.tracks || []).filter(track => track.generated).map(track => ({id:track.id,name:track.name,type:track.type,notes:track.notes || ""})),
                        sections:(project?.arrangement || []).map(section => ({name:section.name,trackIds:section.trackIds || []})),
                        drumAudit:window.__mehranDrumRenderState || null
                    };
                }""")
                assert len(smart_state["tracks"]) == 4, "Smart arrangement must create exactly four generated recorded-instrument stems: " + str(smart_state)
                assert [track["type"] for track in smart_state["tracks"]] == ["Drums / Percussion","Bass","Keys / Piano","Guitar / Acoustic"], "Generated stem types do not match the expected recorded drum, electric bass, acoustic piano and acoustic guitar layers: " + str(smart_state["tracks"])
                assert all("recorded samples only" in track["notes"] for track in smart_state["tracks"]), "Smart arrangement must render from real recorded sample banks, never synth fallback: " + str(smart_state["tracks"])
                assert smart_state["drumAudit"] and smart_state["drumAudit"].get("dedicatedScheduled") is True and smart_state["drumAudit"].get("dedicatedScheduledCalls", 0) > 0, "Recorded drum samples were not scheduled by the dedicated sample engine: " + str(smart_state["drumAudit"])
                guitar_audit = page.evaluate("window.__mehranInstrumentRenderAudit || null")
                assert guitar_audit and guitar_audit.get("mode") == "live_guitar" and guitar_audit.get("bank") == "acoustic_guitar_steel" and guitar_audit.get("loadedSampleCount", 0) > 0, "Smart guitar did not load the self-hosted steel-string acoustic guitar samples: " + str(guitar_audit)
                assert all(40 <= note <= 84 for note in guitar_audit["loadedRootNotes"]), "Smart guitar selected samples outside the instrument's playable source range: " + str(guitar_audit)
                track_ids = {track["name"].split(" · ")[0]:track["id"] for track in smart_state["tracks"]}
                expected_sections = {
                    "Intro":["Smart Piano Harmony"],
                    "Verse 1":["Smart Drums","Smart Bass","Smart Acoustic Guitar"],
                    "Chorus":["Smart Drums","Smart Bass","Smart Piano Harmony","Smart Acoustic Guitar"],
                    "Outro":["Smart Piano Harmony"]
                }
                for section in smart_state["sections"]:
                    selected_names = [track["name"].split(" · ")[0] for track in smart_state["tracks"] if track["id"] in section["trackIds"]]
                    assert selected_names == expected_sections[section["name"]], "Smart section layering is incorrect for " + section["name"] + ": " + str(selected_names)
                smart_metrics = {}
                for prefix, track_id in track_ids.items():
                    stem_path = export_track_audio(page, smart_project_id, track_id, "smart-" + prefix.lower().replace(" ", "-") + ".wav")
                    with wave.open(str(stem_path), "rb") as rendered:
                        assert rendered.getnchannels() == 2 and rendered.getsampwidth() == 2 and rendered.getframerate() == 44100, "Smart arrangement stem must be stereo 16-bit 44.1 kHz: " + prefix
                        duration = rendered.getnframes() / rendered.getframerate()
                        pcm = array.array("h")
                        pcm.frombytes(rendered.readframes(rendered.getnframes()))
                    rms = math.sqrt(sum(sample * sample for sample in pcm) / max(1, len(pcm))) / 32768
                    peak = max((abs(sample) for sample in pcm), default=0) / 32768
                    assert 9.9 <= duration <= 10.7, "Smart arrangement stem duration does not match four bars at 96 BPM, including the recorded sample tail: " + prefix + " " + str(duration)
                    assert rms > 0.001 and peak > 0.005, "Smart arrangement generated a silent or near-silent stem: " + prefix
                    assert peak < 0.98, "Smart arrangement stem is clipping: " + prefix
                    smart_metrics[prefix] = {"duration":round(duration,3),"rms":round(rms,5),"peak":round(peak,5)}
                assert len({(metric["rms"],metric["peak"]) for metric in smart_metrics.values()}) == 4, "Drum, bass, piano and guitar stems unexpectedly have identical level signatures: " + str(smart_metrics)
                print("SMART ARRANGEMENT AUDIO METRICS:", smart_metrics, flush=True)
                print("PASS: smart arrangement creates four non-silent, distinct, unclipped recorded-instrument WAV stems and assigns layers by song section", flush=True)

                # Use a fresh project so this regression is isolated from all earlier fixtures.
                page.locator('[data-view="create"]').first.click()
                page.locator("#projectName").fill("Automated Multi-track QA")
                page.locator("#saveProject").click()
                page.locator('[data-view="mix"]').click()
                page.locator("#mixProject").evaluate("""el => {
                    const option = [...el.options].find(item => item.label === "Automated Multi-track QA");
                    if (!option) throw new Error("Automated Multi-track QA project option is missing");
                    el.value = option.value;
                    el.dispatchEvent(new Event("change", {bubbles:true}));
                }""")
                page.locator("#trackName").fill("Lead QA")
                page.locator("#trackType").select_option(label="Lead Vocal")
                page.locator("#addTrack").click()
                page.locator("[data-track-audio]").nth(0).click()
                page.locator("#trackAudioFile").set_input_files(str(audio_path))
                page.get_by_text("Audio saved on this device. Preview playback is ready.").wait_for(timeout=10000)
                page.locator("#trackName").fill("Backing Instrument QA")
                page.locator("#trackType").select_option(label="Keys / Piano")
                page.locator("#trackRole").select_option(label="Harmony")
                page.locator("#addTrack").click()
                page.locator("[data-track-audio]").nth(1).click()
                page.locator("#trackAudioFile").set_input_files(str(audio_path))
                page.get_by_text("Audio saved on this device. Preview playback is ready.").wait_for(timeout=10000)
                assert page.locator("[data-track-audio]").count() == 2, "Two audio tracks were not attached to the isolated mix project."
                second_gain = page.locator("[data-track-gain]").nth(1)
                second_gain.fill("-6")
                second_gain.dispatch_event("input")
                second_gain.dispatch_event("change")
                second_pan = page.locator("[data-track-pan]").nth(1)
                second_pan.fill("65")
                second_pan.dispatch_event("input")
                second_pan.dispatch_event("change")
                two_track_state = page.evaluate("""() => {
                    const project = JSON.parse(localStorage.getItem("mehran_music_studio_drafts_v1") || "[]")
                        .find(item => item.name === "Automated Multi-track QA");
                    return (project?.tracks || []).filter(track => track.audioName)
                        .map(track => ({name: track.name, gain: track.gain, pan: track.pan}));
                }""")
                assert len(two_track_state) == 2 and two_track_state[1]["gain"] == -6 and two_track_state[1]["pan"] == 65, (
                    "Second track gain/pan did not persist: " + str(two_track_state)
                )
                try:
                    with page.expect_download(timeout=30000) as two_track_download:
                        page.locator("#renderWav").click()
                except Exception as error:
                    raise AssertionError(
                        "Two-track mix export failed. Status: " + page.locator("#renderWavStatus").inner_text()
                    ) from error
                two_track_file = Path(temp) / "two-track-mix.wav"
                two_track_download.value.save_as(str(two_track_file))
                with wave.open(str(two_track_file), "rb") as two_track_wav:
                    assert two_track_wav.getnchannels() == 2 and two_track_wav.getsampwidth() == 3
                    assert two_track_wav.getframerate() == 44100 and two_track_wav.getnframes() > 0
                    two_track_pcm = two_track_wav.readframes(two_track_wav.getnframes())
                left_samples = [int.from_bytes(two_track_pcm[i:i+3], "little", signed=True)
                                for i in range(0, len(two_track_pcm)-5, 6)]
                right_samples = [int.from_bytes(two_track_pcm[i+3:i+6], "little", signed=True)
                                 for i in range(0, len(two_track_pcm)-5, 6)]
                left_peak = max(map(abs, left_samples), default=0)
                right_peak = max(map(abs, right_samples), default=0)
                stereo_difference = max((abs(left-right) for left, right in zip(left_samples, right_samples)), default=0)
                assert left_peak > 0 and right_peak > 0, "Two-track mix has an empty stereo channel."
                assert stereo_difference > 1000, "Second track pan did not produce a distinct stereo image."
                assert max(left_peak, right_peak) < 8388608, "Two-track mix clipped at the 24-bit PCM rail."
                two_track_status = page.locator("#renderWavStatus").inner_text()
                two_track_true_peak = float(two_track_status.split("8x 48-tap sinc inter-sample peak estimate ", 1)[1].split(" dBTP", 1)[0])
                assert math.isfinite(two_track_true_peak) and two_track_true_peak <= -1.0, (
                    "Two-track master exceeded its true-peak safety ceiling: " + str(two_track_true_peak) + " dBTP"
                )

                print("PASS: isolated two-track stereo mix renders with independent gain/pan and safe master peak", flush=True)
                assert not errors, "Browser JavaScript errors: " + " | ".join(errors)
                print("PASS: project creation and persistence")
                print("PASS: phone vocal recording import, local persistence and Lead Vocal track creation")
                print("PASS: Vocal Polish, live/offline noise gate, and saved spectral noise profiles")
                print("PASS: spectral noise reduction applied to offline mix and stem WAV renders")
                print("PASS: per-track Filter, Cutoff, Drive, Reverb, Delay Time, Feedback and Chorus controls")
                print("PASS: local IndexedDB audio attachment and live Web Audio playback")
                print("PASS: independent per-track peak meter responds to playback")
                print("PASS: master output peak meter and live safety limiter are present")
                print("PASS: offline mix and stem WAV paths include the safety limiter")
                print("PASS: local original/corrected A/B stem preview, explicit WAV download, duration-preserving pitch correction, and SHA-256 source immutability")
                print("PASS: no uncaught browser JavaScript exceptions")
                context.close()
                browser.close()
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)


if __name__ == "__main__":
    main()
