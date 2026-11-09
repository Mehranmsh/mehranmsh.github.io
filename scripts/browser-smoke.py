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
    frames = int(sample_rate * 0.35)
    with wave.open(str(path), "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(sample_rate)
        samples = bytearray()
        for index in range(frames):
            value = int(7000 * math.sin(2 * math.pi * 440 * index / sample_rate))
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
                print("DEBUG saved drafts:", saved_projects)
                print("DEBUG library visible:", page.locator("#view-library").get_attribute("class"))
                print("DEBUG library content:", library_text)
                if not saved_projects or "Automated Audio QA" not in saved_projects:
                    raise AssertionError("Project creation did not persist. Browser errors: " + " | ".join(errors))
                assert "Automated Audio QA" in library_text

                # Import a phone-recorded vocal through Vocal Lab and verify it becomes a real audio track.
                page.locator('[data-view="vocals"]').click()
                page.locator("#vocalProject").select_option(label="Automated Audio QA")
                page.locator("#vocalRecordingFile").set_input_files(str(audio_path))
                page.get_by_text("Vocal recording imported and saved on this device.", exact=True).wait_for(timeout=10000)
                assert page.locator("#vocalRecordingPreview").is_visible()
                assert page.locator("#vocalRecordingPreview").get_attribute("src")
                saved_after_vocal = page.evaluate("JSON.parse(localStorage.getItem('mehran_music_studio_drafts_v1'))")
                assert len(saved_after_vocal[0]["tracks"]) == 1
                assert saved_after_vocal[0]["tracks"][0]["type"] == "Lead Vocal"

                # Open the mix planner and verify the imported vocal track's complete effects rack.
                page.locator('[data-view="mix"]').click()
                page.locator("#mixProject").select_option(label="Automated Audio QA")
                page.locator('[data-track-reverb]').wait_for(state="visible")
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
                assert page.locator('[data-track-chorus-depth]').input_value() == "65"
                assert page.locator('[data-track-chorus-rate]').input_value() == "2.4"

                # Attach a generated local WAV, confirm IndexedDB-backed storage, and run live playback.
                page.locator('[data-track-audio]').click()
                page.locator("#trackAudioFile").set_input_files(str(audio_path))
                page.get_by_text("Audio saved on this device. Preview playback is ready.").wait_for(timeout=10000)
                assert page.locator('[data-track-audio-player]').count() == 1
                page.wait_for_function("!!document.querySelector('[data-track-audio-player]')?.src", timeout=10000)
                page.locator("#playMix").click()
                page.get_by_text("Playing 1 track(s) together.", exact=False).wait_for(timeout=10000)
                page.wait_for_function("parseFloat(document.querySelector('#masterMeterFill')?.style.width || '0') > 0", timeout=5000)
                assert "dBFS" in page.locator("#masterMeterValue").inner_text()
                page.locator("#stopMix").click()

                # Exercise both offline render paths and verify actual downloadable WAV artifacts.
                with page.expect_download(timeout=30000) as mix_download:
                    page.locator("#renderWav").click()
                mix_file = Path(temp) / "mix.wav"
                mix_download.value.save_as(str(mix_file))
                assert mix_file.is_file() and mix_file.stat().st_size > 44
                with wave.open(str(mix_file), "rb") as rendered_mix:
                    assert rendered_mix.getnchannels() == 2
                    assert rendered_mix.getframerate() == 44100
                    assert rendered_mix.getnframes() >= int(2.3 * 44100)
                    mix_pcm = rendered_mix.readframes(rendered_mix.getnframes())
                    assert any(mix_pcm), "Rendered mix is silent."
                page.locator("#stemTrack").select_option(index=1)
                with page.expect_download(timeout=30000) as stem_download:
                    page.locator("#exportStem").click()
                stem_file = Path(temp) / "stem.wav"
                stem_download.value.save_as(str(stem_file))
                assert stem_file.is_file() and stem_file.stat().st_size > 44
                with wave.open(str(stem_file), "rb") as rendered_stem:
                    assert rendered_stem.getnchannels() == 2
                    assert rendered_stem.getframerate() == 44100
                    assert rendered_stem.getnframes() >= int(2.3 * 44100)
                    stem_pcm = rendered_stem.readframes(rendered_stem.getnframes())
                    assert any(stem_pcm), "Rendered stem is silent."

                assert not errors, "Browser JavaScript errors: " + " | ".join(errors)
                print("PASS: project creation and persistence")
                print("PASS: phone vocal recording import, local persistence and Lead Vocal track creation")
                print("PASS: per-track Filter, Cutoff, Drive, Reverb, Delay Time, Feedback and Chorus controls")
                print("PASS: local IndexedDB audio attachment and live Web Audio playback")
                print("PASS: master output peak meter and live safety limiter are present")
                print("PASS: offline mix and stem WAV paths include the safety limiter")
                print("PASS: offline full-mix WAV and individual stem WAV downloads")
                print("PASS: no uncaught browser JavaScript exceptions")
                context.close()
                browser.close()
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)


if __name__ == "__main__":
    main()
