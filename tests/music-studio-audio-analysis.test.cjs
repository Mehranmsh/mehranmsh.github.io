const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const html = fs.readFileSync(require("node:path").join(__dirname, "..", "music-studio.html"), "utf8");
const start = html.indexOf(" function analyzeStudioIntelSamples(");
const end = html.indexOf("\n function intelDb(", start);
assert.notEqual(start, -1, "audio analysis helper must exist in music-studio.html");
assert.notEqual(end, -1, "audio analysis helper must end before intelDb");
const declaration = html.slice(start, end).trim();
const analyzeStudioIntelSamples = vm.runInNewContext("(" + declaration + ")");

function signal(length, sample) {
  return Array.from({ length }, (_, index) => sample(index));
}

test("silence reports zero peak and RMS without clipping", () => {
  const result = analyzeStudioIntelSamples([signal(1000, () => 0)], 1000);
  assert.equal(result.peak, 0);
  assert.equal(result.rms, 0);
  assert.equal(result.clipRatio, 0);
  assert.equal(result.dc, 0);
});

test("a full-scale-free sine has the expected RMS", () => {
  const result = analyzeStudioIntelSamples(
    [signal(1000, i => 0.5 * Math.sin(2 * Math.PI * 10 * i / 1000))],
    1000
  );
  assert.ok(Math.abs(result.peak - 0.5) < 1e-6);
  assert.ok(Math.abs(result.rms - Math.SQRT1_2 * 0.5) < 0.002);
  assert.equal(result.clipRatio, 0);
});

test("samples at digital full scale are counted as near-clipping", () => {
  const result = analyzeStudioIntelSamples([signal(1000, () => 1)], 1000);
  assert.equal(result.peak, 1);
  assert.equal(result.clipRatio, 1);
});

test("a constant offset is measured as DC offset", () => {
  const result = analyzeStudioIntelSamples([signal(1000, () => 0.125)], 1000);
  assert.ok(Math.abs(result.dc - 0.125) < 1e-9);
  assert.ok(Math.abs(result.rms - 0.125) < 1e-9);
});

test("stereo channels are included in aggregate metrics", () => {
  const result = analyzeStudioIntelSamples(
    [signal(1000, () => 0.5), signal(1000, () => 0)],
    1000
  );
  assert.equal(result.channelCount, 2);
  assert.equal(result.total, 2000);
  assert.ok(Math.abs(result.rms - Math.sqrt(0.125)) < 1e-9);
});

test("invalid channel shapes and non-finite samples are rejected", () => {
  assert.throws(() => analyzeStudioIntelSamples([], 1000));
  assert.throws(() => analyzeStudioIntelSamples([[0, 1], [0]], 1000));
  assert.throws(() => analyzeStudioIntelSamples([[0, Number.NaN]], 1000));
});
