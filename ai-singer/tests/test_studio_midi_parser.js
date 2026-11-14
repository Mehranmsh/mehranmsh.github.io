const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");

const html = fs.readFileSync(path.join(__dirname, "../../music-studio.html"), "utf8");
const start = html.indexOf("function parseMehranMidiBytes(bytes){");
const end = html.indexOf("\n let mehranSingerMidiFile=", start);
assert.ok(start >= 0 && end > start, "Studio MIDI parser function must exist");
const parserSource = html.slice(start, end);
const parse = new Function("bytes", parserSource + "\nreturn parseMehranMidiBytes(bytes);");

function makeMidi(track, format = 0, division = 480) {
  const header = Buffer.from([
    0x4d,0x54,0x68,0x64, 0,0,0,6,
    (format >> 8) & 255, format & 255, 0,1,
    (division >> 8) & 255, division & 255
  ]);
  const chunk = Buffer.from([0x4d,0x54,0x72,0x6b,
    (track.length >>> 24)&255,(track.length >>> 16)&255,
    (track.length >>> 8)&255,track.length&255, ...track]);
  return new Uint8Array(Buffer.concat([header, chunk]));
}

// One C4 note spanning a tempo change at beat 1: 0.5s + 1.0s.
const midi = makeMidi([
  0x00,0xff,0x51,0x03,0x07,0xa1,0x20,
  0x00,0x90,0x3c,0x64,
  0x83,0x60,0xff,0x51,0x03,0x0f,0x42,0x40,
  0x83,0x60,0x80,0x3c,0x00,
  0x00,0xff,0x2f,0x00
]);
const parsed = parse(midi);
assert.equal(parsed.format, 0);
assert.equal(parsed.noteCount, 1);
assert.equal(parsed.notes[0].note, "C4");
assert.equal(parsed.notes[0].startSeconds, 0);
assert.equal(parsed.notes[0].durationSeconds, 1.5);
assert.equal(parsed.tempoMap.length, 2);
assert.throws(() => parse(makeMidi([0,0xff,0x2f,0], 2)), /format 0 and 1/);
assert.throws(() => parse(makeMidi([0,0xff,0x2f,0], 0, 0xe728)), /SMPTE/);
console.log("Studio MIDI parser: 6 assertions passed.");
