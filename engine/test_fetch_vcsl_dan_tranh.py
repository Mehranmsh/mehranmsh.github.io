import unittest
from fetch_vcsl_dan_tranh import append_verified_b4_ff_region, parse_dan_tranh_websfz
def fixture():
 return {"meta":{"name":"Dan Tranh - Normal","license":"Creative Commons 0","source":"https://github.com/sgossner/VCSL"},"groups":[{"regions":[{"sample":"Dan Tranh/Normal/B1_mf_1","pitch_keycenter":47,"lokey":47,"hikey":48,"lovel":0,"hivel":65,"volume":12},{"sample":"Dan Tranh/Normal/B1_f_1","pitch_keycenter":47,"lokey":47,"hikey":48,"lovel":66,"hivel":99,"volume":8}]}]}
class DanTranhTests(unittest.TestCase):
 def test_preserves_velocity_pitch_gain(self):
  x=parse_dan_tranh_websfz(fixture(),False); self.assertEqual(len(x),2); self.assertEqual(x[0]["velocity_min"],1); self.assertEqual(x[0]["gain_db"],12.0)
 def test_rejects_wrong_license(self):
  d=fixture(); d["meta"]["license"]="CC-BY"
  with self.assertRaisesRegex(ValueError,"CC0 VCSL"): parse_dan_tranh_websfz(d)
 def test_rejects_duplicate_source(self):
  d=fixture(); d["groups"][0]["regions"].append(dict(d["groups"][0]["regions"][0]))
  with self.assertRaisesRegex(ValueError,"Duplicate"): parse_dan_tranh_websfz(d)
 def test_restores_exact_root_b4_ff_from_verified_source_inventory(self):
  regions=parse_dan_tranh_websfz(fixture(),False)
  # Add representative peer ff mappings so the inferred layer is guarded by
  # the same 100-127 interval used throughout the pinned instrument map.
  for note in (47,49,51):
   regions.append({"filename":f"peer{note}_ff_1.wav","source_path":f"Dan Tranh/Normal/peer{note}_ff_1.wav","midi_note":note,"low_key":note,"high_key":note+1,"velocity_min":100,"velocity_max":127,"gain_db":0.0})
  restored=append_verified_b4_ff_region(regions,{"Chordophones/Zithers/Dan Tranh/Normal/B4_ff_1.wav":"abc"})
  b4=[x for x in restored if x["midi_note"]==83]
  self.assertEqual(sorted((x["velocity_min"],x["velocity_max"]) for x in b4),[(1,65),(66,99),(100,127)])
  self.assertEqual(b4[-1]["source_path"],"Chordophones/Zithers/Dan Tranh/Normal/B4_ff_1.wav")
  self.assertEqual((b4[-1]["low_key"],b4[-1]["high_key"]),(82,84))
 def test_refuses_to_infer_when_peer_velocity_mapping_changes(self):
  regions=parse_dan_tranh_websfz(fixture(),False)
  with self.assertRaisesRegex(ValueError,"Cannot corroborate"):
   append_verified_b4_ff_region(regions,{"Chordophones/Zithers/Dan Tranh/Normal/B4_ff_1.wav":"abc"})
 def test_requires_exact_root_source_recording(self):
  regions=parse_dan_tranh_websfz(fixture(),False)
  with self.assertRaisesRegex(ValueError,"exact-root"):
   append_verified_b4_ff_region(regions,{})
 def test_requires_full_bank(self):
  with self.assertRaisesRegex(ValueError,"Expected 47"): parse_dan_tranh_websfz(fixture())
if __name__=="__main__": unittest.main()
