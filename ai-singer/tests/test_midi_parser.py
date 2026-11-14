import base64
import unittest

from midi_parser import MidiParseError, parse_standard_midi


def vlq(value):
    buffer = value & 0x7F
    while (value := value >> 7):
        buffer <<= 8
        buffer |= (value & 0x7F) | 0x80
    result = []
    while True:
        result.append(buffer & 0xFF)
        if buffer & 0x80:
            buffer >>= 8
        else:
            return bytes(result)


def make_midi(track_events, division=480):
    header = b"MThd" + (6).to_bytes(4, "big") + b"\x00\x00\x00\x01" + division.to_bytes(2, "big")
    track = b"".join(track_events) + b"\x00\xff\x2f\x00"
    return header + b"MTrk" + len(track).to_bytes(4, "big") + track


class MidiParserTests(unittest.TestCase):
    def test_note_and_default_tempo(self):
        data = make_midi([
            b"\x00\x90\x3c\x64",
            vlq(480) + b"\x80\x3c\x00",
        ])
        result = parse_standard_midi(data)
        self.assertEqual(result["noteCount"], 1)
        self.assertEqual(result["notes"][0]["note"], "C4")
        self.assertEqual(result["notes"][0]["durationBeats"], 1.0)
        self.assertAlmostEqual(result["notes"][0]["durationSeconds"], 0.5)

    def test_tempo_change_is_integrated(self):
        data = make_midi([
            b"\x00\xff\x51\x03\x07\xa1\x20",
            b"\x00\x90\x45\x64",
            vlq(480) + b"\xff\x51\x03\x0f\x42\x40",
            vlq(480) + b"\x80\x45\x00",
        ])
        result = parse_standard_midi(data)
        self.assertEqual(result["noteCount"], 1)
        self.assertAlmostEqual(result["notes"][0]["durationSeconds"], 1.5)

    def test_rejects_smpte_division(self):
        data = make_midi([b"\x00\x90\x3c\x64"], division=0xE728)
        with self.assertRaises(MidiParseError):
            parse_standard_midi(data)

    def test_rejects_truncated_track(self):
        with self.assertRaises(MidiParseError):
            parse_standard_midi(b"MThd\x00\x00\x00\x06\x00\x00\x00\x01\x01\xe0MTrk\x00\x00\x00\x10")

if __name__ == "__main__":
    unittest.main()
