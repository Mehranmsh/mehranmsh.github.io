import unittest
from fetch_vcsl_recorder import parse_recordings

def fixture():
    sus=[{"name":f"SopRecorder_Sus_{n}_rr1_Main.wav","sha":"a"*40} for n in ["C4","D4","E4","F#4","G#4","A#4","C5","D5","E5","F#5","G5","A#5","C6"]]
    sta=[{"name":f"SopRecorder_Stac_{n}_rr1_Main.wav","sha":"b"*40} for n in ["C4","D4","E4","F#4","G#4","A#4","C5","D5","E5","F#5","G5","A#5"]]
    return sus,sta

class RecorderTests(unittest.TestCase):
    def test_full_bank_has_distinct_articulations_and_pitch_map(self):
        sus,sta=fixture(); out=parse_recordings(sus,sta)
        self.assertEqual(len(out),25)
        self.assertEqual(sum(x["articulation"]=="sustain" for x in out),13)
        self.assertEqual(sum(x["articulation"]=="staccato" for x in out),12)
        self.assertEqual(next(x["midi_note"] for x in out if x["filename"].startswith("SopRecorder_Sus_C4")),60)
    def test_rejects_wrong_pitch_coverage(self):
        sus,sta=fixture(); sus.pop()
        with self.assertRaisesRegex(ValueError,"Expected 13 sustained"): parse_recordings(sus,sta)
    def test_rejects_unknown_filename(self):
        sus,sta=fixture(); sus[0]["name"]="not-a-recorder.wav"
        with self.assertRaisesRegex(ValueError,"Unexpected recorder filename"): parse_recordings(sus,sta)
    def test_rejects_duplicate_source(self):
        sus,sta=fixture(); sus.append(dict(sus[0]))
        with self.assertRaisesRegex(ValueError,"Duplicate"): parse_recordings(sus,sta)

if __name__=="__main__": unittest.main()
