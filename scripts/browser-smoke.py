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
                page.locator('[data-view="vocals"]').click()
                page.locator("#vocalProject").select_option(label="Automated Audio QA")
                page.locator("#vocalRecordingFile").set_input_files(str(audio_path))
                page.wait_for_function("document.querySelector('#vocalImportStatus')?.textContent.includes('Vocal recording imported and saved on this device.')", timeout=10000)
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
                page.wait_for_function("document.querySelector('[data-track-audio-player]')?.paused === false && document.querySelector('[data-track-audio-player]')?.currentTime >= 0.12", timeout=10000)
                page.wait_for_function("document.querySelector('[data-track-audio-player]')?.paused === true && Math.abs(document.querySelector('[data-track-audio-player]')?.currentTime - 0.10) < 0.04", timeout=5000)

                # Exercise both offline render paths and verify actual downloadable WAV artifacts.
                with page.expect_download(timeout=30000) as mix_download:
                    page.locator("#renderWav").click()
                mix_file = Path(temp) / "mix.wav"
                mix_download.value.save_as(str(mix_file))
                assert mix_file.is_file() and mix_file.stat().st_size > 44
                with wave.open(str(mix_file), "rb") as rendered_mix:
                    assert rendered_mix.getnchannels() == 2
                    assert rendered_mix.getframerate() == 44100
                    assert 3.52 * 44100 <= rendered_mix.getnframes() <= 3.54 * 44100, "Mix duration did not account for the 0.10 s start trim, 0.10 s end trim, and timeline offset."
                    mix_pcm = rendered_mix.readframes(rendered_mix.getnframes())
                    assert any(mix_pcm), "Rendered mix is silent."
                    early_mix_bytes = mix_pcm[:int(1.22 * 44100) * 4]
                    early_mix = struct.unpack("<" + "h" * (len(early_mix_bytes) // 2), early_mix_bytes)
                    assert max(map(abs, early_mix), default=0) < 100, "Trimmed vocal audio leaked into the mix before its timeline entry and start trim."
                    assert any(mix_pcm[int(1.30 * 44100) * 4:int(1.45 * 44100) * 4]), "The trimmed vocal segment was not rendered at its scheduled position."
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
                waveform_box = page.locator("[data-track-waveform]").bounding_box()
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
                    # Left channel, 0.20–0.45 s: A4 should be moved toward G#4 in C natural minor.
                    segment = values[int(0.20 * 44100) * 2:int(0.45 * 44100) * 2:2]
                    crossings = sum(1 for a, b in zip(segment, segment[1:]) if a <= 0 < b)
                    measured_hz = crossings / 0.25
                    assert 395 <= measured_hz <= 435, "Pitch correction did not shift A4 toward G#4: " + str(measured_hz)

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
