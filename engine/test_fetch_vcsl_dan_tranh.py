import unittest
from fetch_vcsl_dan_tranh import parse_dan_tranh_websfz
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
 def test_requires_full_bank(self):
  with self.assertRaisesRegex(ValueError,"Expected 47"): parse_dan_tranh_websfz(fixture())
if __name__=="__main__": unittest.main()
