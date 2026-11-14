import unittest
from fetch_vsco2_violin import parse
def it(n):return {"name":n,"sha":"0"*40}
class T(unittest.TestCase):
 def test_arco_velocity(self):
  x=parse([it("LLVln_ArcoVib_G3_p.wav"),it("LLVln_ArcoVib_G3_f.wav")],[],False)
  self.assertEqual([z["midi_note"] for z in x],[55,55]);self.assertEqual([(z["velocity_min"],z["velocity_max"]) for z in x],[(1,63),(64,127)])
 def test_pizz_rr(self):
  x=parse([],[it("LLVln_Pizz_C4_f_RR1.wav"),it("LLVln_Pizz_C4_f_RR2.wav")],False);self.assertEqual([z["round_robin_index"] for z in x],[0,1])
 def test_bad_name(self):
  with self.assertRaises(ValueError):parse([it("bad.wav")],[],False)
 def test_full_required(self):
  with self.assertRaisesRegex(ValueError,"expected 30 arco"):parse([it("LLVln_ArcoVib_G3_p.wav")],[],True)
if __name__=="__main__":unittest.main()
