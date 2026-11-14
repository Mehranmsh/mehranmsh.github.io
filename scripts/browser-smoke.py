#!/usr/bin/env python3
"""Headless Chromium end-to-end smoke tests for MEHRAN MUSIC STUDIO."""
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from pathlib import Path
from threading import Thread
from tempfile import TemporaryDirectory
import math
import struct
import wave

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
            make_test_wav(audio_path)
            with sync_playwright() as playwright:
                browser = playwright.chromium.launch(args=["--autoplay-policy=no-user-gesture-required"])
                context = browser.new_context(accept_downloads=True)
                page = context.new_page()
                page.on("pageerror", lambda error: errors.append(str(error)))
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
                assert "52.0 cents" in pitch_text, "Correction strength calculation is incorrect: " + pitch_text
                assert page.locator("#pitchContour").count() == 1, "Pitch contour visualization was not rendered"
                assert int(page.locator("#pitchContour").get_attribute("data-pitch-points")) >= 1, "Pitch contour has no voiced frames"

                assert "fade=Math.max(32,Math.floor(rate*0.035))" in page.content(), "Pitch correction must use a longer 35 ms transition fade."
                assert "mix=0.5-0.5*Math.cos(Math.PI*edge)" in page.content(), "Pitch correction must use smooth cosine edge blending."

                # Build and save a lyric-to-performance rehearsal guide.
                page.locator('[data-view="lyrics"]').click()
                page.wait_for_function("Array.from(document.querySelector('#lyricsProject').options).some(option => option.textContent.trim() === 'Automated Audio QA')", timeout=10000)
                page.locator("#lyricsProject").select_option(label="Automated Audio QA")
                page.locator("#lyricsEditor").fill("[Verse 1]\nتو رفتی و هنوز دلم به یاد توئه\nI keep walking through the night\nI hold a little light")
                assert "تو رفتی و هنوز دلم به یاد توئه" in page.locator("#lyricsEditor").input_value()
                assert page.locator("#lyricFlowPanel").is_visible()
                page.locator("#saveLyrics").click()
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
                page.locator("#mixProject").select_option(label="Automated Audio QA")
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
                page.locator("#mixProject").select_option(label="Automated Audio QA")
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
                with page.expect_download(timeout=30000) as mix_download:
                    page.locator("#renderWav").click()
                mix_file = Path(temp) / "mix.wav"
                mix_download.value.save_as(str(mix_file))
                assert mix_file.is_file() and mix_file.stat().st_size > 44
                mix_sample_rate = 22050
                with wave.open(str(mix_file), "rb") as rendered_mix:
                    assert rendered_mix.getnchannels() == 2
                    assert rendered_mix.getframerate() == mix_sample_rate
                    assert 3.52 * mix_sample_rate <= rendered_mix.getnframes() <= 3.54 * mix_sample_rate, "Mix duration did not account for the 0.10 s start trim, 0.10 s end trim, and timeline offset."
                    mix_pcm = rendered_mix.readframes(rendered_mix.getnframes())
                    assert any(mix_pcm), "Rendered mix is silent."
                    early_mix_bytes = mix_pcm[:int(1.22 * mix_sample_rate) * 4]
                    early_mix = struct.unpack("<" + "h" * (len(early_mix_bytes) // 2), early_mix_bytes)
                    assert max(map(abs, early_mix), default=0) < 100, "Trimmed vocal audio leaked into the mix before its timeline entry and start trim."
                    assert any(mix_pcm[int(1.30 * mix_sample_rate) * 4:int(1.45 * mix_sample_rate) * 4]), "The trimmed vocal segment was not rendered at its scheduled position."
                page.locator("#stemTrack").select_option(index=1)
                with page.expect_download(timeout=30000) as stem_download:
                    page.locator("#exportStem").click()
                stem_file = Path(temp) / "stem.wav"
                stem_download.value.save_as(str(stem_file))
                assert stem_file.is_file() and stem_file.stat().st_size > 44
                with wave.open(str(stem_file), "rb") as rendered_stem:
                    assert rendered_stem.getnchannels() == 2
                    assert rendered_stem.getframerate() == 44100
                    assert 2.29 * 44100 <= rendered_stem.getnframes() <= 2.31 * 44100, "Stem duration did not reflect the non-destructive trim range."
                    stem_pcm = rendered_stem.readframes(rendered_stem.getnframes())
                    assert any(stem_pcm), "Rendered stem is silent."
                    early_stem = struct.unpack("<" + "h" * (len(stem_pcm[:int(0.04 * 44100) * 4]) // 2), stem_pcm[:int(0.04 * 44100) * 4])
                    active_stem = struct.unpack("<" + "h" * (len(stem_pcm[int(0.16 * 44100) * 4:int(0.22 * 44100) * 4]) // 2), stem_pcm[int(0.16 * 44100) * 4:int(0.22 * 44100) * 4])
                    assert max(map(abs, early_stem), default=0) < 2000, "Stem contains the source material before the configured trim point."
                    assert max(map(abs, active_stem), default=0) > 4000, "Stem omitted the expected retained vocal segment after trimming."

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
                    frames = tuned_stem.getnframes()
                    pcm = tuned_stem.readframes(frames)
                    values = struct.unpack("<" + "h" * (len(pcm) // 2), pcm)
                    # After the 0.10 s source trim, the 440 Hz tone begins at 0.05 s in the rendered stem.
                    # Use autocorrelation in a retained, non-silent window so fade-in does not bias zero-crossing counts.
                    segment = values[int(0.06 * 44100) * 2:int(0.24 * 44100) * 2:2]
                    mean = sum(segment) / len(segment)
                    centered = [sample - mean for sample in segment]
                    best_lag = max(range(90, 125), key=lambda lag: sum(centered[i] * centered[i + lag] for i in range(len(centered) - lag)))
                    measured_hz = 44100 / best_lag
                    assert 395 <= measured_hz <= 435, "Pitch correction did not shift A4 toward G#4: " + str(measured_hz)

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
                page.locator("#patternTempo").fill("96")
                page.locator("#patternMode").select_option("drums")
                page.locator("#patternBars").select_option("1")
                page.locator("#kickSteps [data-pattern-step='1']").click()
                page.locator("#openHatSteps [data-pattern-step='7']").click()
                page.locator("#clapSteps [data-pattern-step='5']").click()
                page.locator("#tomSteps [data-pattern-step='11']").click()
                page.locator("#percSteps [data-pattern-step='15']").click()
                page.locator("#drumKit").select_option("lofi")
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
                assert generated_project["patternStudio"]["drumKit"] == "lofi"
                assert 7 in generated_project["patternStudio"]["openHat"] and 5 in generated_project["patternStudio"]["clap"] and 11 in generated_project["patternStudio"]["tom"] and 15 in generated_project["patternStudio"]["perc"]
                with page.expect_download() as drum_midi_download:
                    page.locator("#exportPatternMidi").click()
                drum_midi_path = Path(temp) / "drum-roundtrip.mid"
                drum_midi_download.value.save_as(drum_midi_path)
                assert drum_midi_path.read_bytes().startswith(b"MThd")
                page.locator("#patternMidiFile").set_input_files(str(drum_midi_path))
                page.wait_for_function("document.querySelector('#patternStatus')?.textContent.includes('MIDI imported')", timeout=5000)
                drum_roundtrip = page.evaluate("JSON.parse(localStorage.getItem('mehran_music_studio_drafts_v1'))[0].patternStudio")
                assert drum_roundtrip["mode"] == "drums" and 7 in drum_roundtrip["openHat"] and 5 in drum_roundtrip["clap"] and 11 in drum_roundtrip["tom"] and 15 in drum_roundtrip["perc"]
                assert generated_track["audioSize"] > 44 and page.locator("#patternPreview").get_attribute("src")
                generated_blob_exists = page.evaluate("""async () => {
                    const project = JSON.parse(localStorage.getItem("mehran_music_studio_drafts_v1"))[0];
                    const track = project.tracks.find(item => item.generated);
                    const db = await new Promise((resolve, reject) => { const req = indexedDB.open("mehran_music_studio_audio_v1", 1); req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); });
                    const record = await new Promise((resolve, reject) => { const req = db.transaction("trackAudio").objectStore("trackAudio").get(project.id + ":" + track.id); req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); });
                    db.close(); return !!record?.blob && record.blob.size > 44;
                }""")
                assert generated_blob_exists, "Generated WAV was not persisted in local IndexedDB."
                # Build a melodic synth layer and connect its notes to the lyric performance guide.
                page.locator("#patternMode").select_option("keys")
                page.locator("#patternNotes").fill("C3, -, E3, -, G3, -, E3, -, C3, -, E3, -, G3, -, B3, -")
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
                page.wait_for_function("document.querySelector('#patternStatus')?.textContent.includes('Generated WAV added to the mixer')", timeout=20000)
                melody_project = page.evaluate("JSON.parse(localStorage.getItem('mehran_music_studio_drafts_v1'))[0]")
                assert melody_project["patternStudio"]["mode"] == "keys" and "C3" in melody_project["patternStudio"]["notes"] and melody_project["patternStudio"]["velocityByStep"][1] == 65 and melody_project["patternStudio"]["gateByStep"][1] == 55
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
                # Song-form sections are saved in sequence with computed bar positions.
                page.locator("#arrangementSection").select_option("Intro")
                page.locator("#arrangementBars").select_option("4")
                page.locator("#addArrangementSection").click()
                page.locator("#arrangementSection").select_option("Chorus")
                page.locator("#arrangementBars").select_option("8")
                page.locator("#addArrangementSection").click()
                arrangement = page.evaluate("JSON.parse(localStorage.getItem('mehran_music_studio_drafts_v1'))[0].arrangement")
                assert [(item["name"], item["startBar"], item["bars"]) for item in arrangement] == [("Intro", 1, 4), ("Chorus", 5, 8)]
                page.locator("#arrangementTimeline [data-arrangement-move='down']").first.click()
                reordered = page.evaluate("JSON.parse(localStorage.getItem('mehran_music_studio_drafts_v1'))[0].arrangement")
                assert [(item["name"], item["startBar"]) for item in reordered] == [("Chorus", 1), ("Intro", 9)], "Moving a section down did not recalculate song bar positions."
                page.locator("#arrangementTimeline [data-arrangement-move='up']").last.click()
                restored = page.evaluate("JSON.parse(localStorage.getItem('mehran_music_studio_drafts_v1'))[0].arrangement")
                assert [(item["name"], item["startBar"]) for item in restored] == [("Intro", 1), ("Chorus", 5)]
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
                # Render a four-chord harmonic backing layer and verify the project record.
                page.locator("#patternMode").select_option("chords")
                page.locator("#patternChords").fill("Am, F, C, G")
                page.locator("#patternTrackName").fill("Generated chord backing")
                page.locator("#renderPattern").click()
                page.wait_for_function("document.querySelector('#patternStatus')?.textContent.includes('Generated WAV added to the mixer')", timeout=20000)
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
                # Exercise dedicated sub-bass and cinematic sound-layer render paths.
                for mode, expected_type in [("sub", "Bass"), ("riser", "Sound Effects"), ("impact", "Sound Effects"), ("texture", "Sound Effects")]:
                    page.locator("#patternMode").select_option(mode)
                    page.locator("#patternTrackName").fill("Generated " + mode)
                    page.locator("#renderPattern").click()
                    page.wait_for_function("document.querySelector('#patternStatus')?.textContent.includes('Generated WAV added to the mixer')", timeout=20000)
                    project_after_layer = page.evaluate("JSON.parse(localStorage.getItem('mehran_music_studio_drafts_v1'))[0]")
                    layer = next(track for track in project_after_layer["tracks"] if track.get("generated") and track["name"] == "Generated " + mode)
                    assert layer["type"] == expected_type and layer["audioSize"] > 44
                # Exercise the expanded virtual instrument palette through actual WAV rendering.
                for mode, expected_type in [("epiano", "Keys / Piano"), ("organ", "Organ"), ("lead", "Synth Lead"), ("strings", "Strings"), ("bell", "Bell / Mallet")]:
                    page.locator("#patternMode").select_option(mode)
                    page.locator("#patternTrackName").fill("Generated " + mode)
                    page.locator("#renderPattern").click()
                    page.wait_for_function("document.querySelector('#patternStatus')?.textContent.includes('Generated WAV added to the mixer')", timeout=20000)
                    instrument_project = page.evaluate("JSON.parse(localStorage.getItem('mehran_music_studio_drafts_v1'))[0]")
                    instrument_track = next(track for track in instrument_project["tracks"] if track.get("generated") and track["name"] == "Generated " + mode)
                    assert instrument_track["type"] == expected_type and instrument_track["audioSize"] > 44
                page.locator('[data-view="lyrics"]').click()
                page.locator("#lyricsProject").select_option(label="Automated Audio QA")
                page.locator("#loadProjectMelody").click()
                assert "C3" in page.locator("#vocalGuideNotes").input_value()
                assert "melody notes loaded" in page.locator("#vocalGuideStatus").inner_text()
                assert "Sing C3" in page.locator("#vocalGuideSteps").inner_text(), "Lyric rehearsal cards should show the pitch for each mapped step."
                assert page.locator("#vocalGuideBacking").is_checked(), "Chord backing should be enabled by default."
                page.locator("#vocalGuideSyllables").fill("one / two / three / four / five / six / seven / eight")
                page.locator("#vocalGuideNotes").fill("C3, D3, E3, F3, G3, A3, B3, C4")
                page.locator("#vocalGuideTempo").fill("96")
                assert page.locator("#playVocalGuide").is_enabled(), "Vocal guide transport should remain available after changing the phrase."



                # Generate an original local drum loop and attach its WAV to the same project.
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
