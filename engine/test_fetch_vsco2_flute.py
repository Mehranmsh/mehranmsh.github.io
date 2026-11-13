import unittest
from fetch_vsco2_flute import parse
def it(n):return {"name":n,"sha":"0"*40}
class T(unittest.TestCase):
 def test_articulation_rr(self):
  x=parse([it("LDFlute_susvib_C4_v1_1.wav"),it("LDFlute_susvib_C4_v1_2.wav")],[it("LDFlute_expvib_C4_v1_1.wav")],False)
  self.assertEqual([z["round_robin_index"] for z in x],[0,1,0])
  self.assertEqual(x[2]["articulation"],"expressive_vibrato")
 def test_unknown_layer_rejected(self):
  with self.assertRaises(ValueError):parse([it("LDFlute_susvib_C4_v2_1.wav")],[],False)
 def test_complete_coverage_required(self):
  with self.assertRaisesRegex(ValueError,"expected 13 sustain"):parse([it("LDFlute_susvib_C4_v1_1.wav")],[],True)
if __name__=="__main__":unittest.main()
