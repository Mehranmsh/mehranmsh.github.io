from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

import numpy as np

from waveform_output import write_waveform_output


class WaveformOutputTests(unittest.TestCase):
    def test_writes_and_verifies_mono_pcm_wav(self):
        with tempfile.TemporaryDirectory() as directory:
            samples = (0.2 * np.sin(np.linspace(0, 30, 4800))).astype(np.float32)
            result = write_waveform_output(
                samples, output_directory=directory, project_id="project-1", sample_rate=48000
            )
            self.assertTrue(result["valid"])
            self.assertEqual(result["codec"], "pcm_s16le")
            self.assertEqual(result["frames"], 4800)
            self.assertEqual(result["sample_rate"], 48000)
            self.assertTrue((Path(directory) / result["artifact_path"]).is_file())

    def test_rejects_non_finite_or_out_of_range_samples(self):
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaisesRegex(ValueError, "finite and normalized"):
                write_waveform_output(
                    np.array([0.0, np.nan]), output_directory=directory,
                    project_id="project-1", sample_rate=48000,
                )
            with self.assertRaisesRegex(ValueError, "finite and normalized"):
                write_waveform_output(
                    np.array([0.0, 1.1]), output_directory=directory,
                    project_id="project-1", sample_rate=48000,
                )

    def test_rejects_empty_and_stereo_shapes(self):
        with tempfile.TemporaryDirectory() as directory:
            for audio in (np.array([], dtype=np.float32), np.zeros((2, 10), dtype=np.float32)):
                with self.assertRaisesRegex(ValueError, "mono"):
                    write_waveform_output(
                        audio, output_directory=directory,
                        project_id="project-1", sample_rate=48000,
                    )

    def test_rejects_symlink_output_directory(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            target = root / "target"
            target.mkdir()
            link = root / "link"
            link.symlink_to(target, target_is_directory=True)
            with self.assertRaisesRegex(ValueError, "symbolic link"):
                write_waveform_output(
                    np.zeros(100, dtype=np.float32), output_directory=link,
                    project_id="project-1", sample_rate=48000,
                )


if __name__ == "__main__":
    unittest.main()
