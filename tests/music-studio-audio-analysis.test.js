"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const html = fs.readFileSync(require("node:path").join(__dirname, "..", "music-studio.html"), "utf8");
const match = html.match(/function analyzeStudioIntelSamples\(channelData,sampleRate\)\s*\{[\s\S]*?\n \}/);
assert.ok(match, "production PCM analyzer must exist in music-studio.html");
const analyzeStudioIntelSamples = vm.runInNewContext("(" + match[0].trim() + ")");

test("silence produces zero level and no clipping", () => {
  const result = analyzeStudioIntelSamples([new Float32Array(8)], 8);
  assert.equal(result.peak, 0);
  assert.equal(result.rms, 0);
  assert.equal(result.clipRatio, 0);
  assert.equal(result.dc, 0);
  assert.equal(result.quiet, 0);
});

test("clean symmetric signal reports expected peak and RMS", () => {
  const result = analyzeStudioIntelSamples([new Float32Array([-0.5, 0.5, -0.5, 0.5])], 4);
  assert.equal(result.peak, 0.5);
  assert.equal(result.rms, 0.5);
  assert.equal(result.dc, 0);
  assert.equal(result.clipRatio, 0);
});

test("near-full-scale samples are counted against all channel samples", () => {
  const result = analyzeStudioIntelSamples([new Float32Array([0, 0.999, -1, 0.2])], 4);
  assert.equal(result.clipRatio, 0.5);
});

test("constant offset is detected without confusing it with peak", () => {
  const result = analyzeStudioIntelSamples([new Float32Array([0.1, 0.1, 0.1, 0.1])], 4);
  assert.ok(Math.abs(result.dc - 0.1) < 1e-6);
  assert.ok(Math.abs(result.peak - 0.1) < 1e-6);
});

test("stereo channels are weighted by their actual sample count", () => {
  const result = analyzeStudioIntelSamples([
    new Float32Array([0.5, 0.5]),
    new Float32Array([0, 0])
  ], 4);
  assert.equal(result.channelCount, 2);
  assert.ok(Math.abs(result.rms - Math.sqrt(0.125)) < 1e-6);
});

test("rejects malformed channel layouts and invalid sample rates", () => {
  assert.throws(() => analyzeStudioIntelSamples([], 44100), /Invalid audio sample input/);
  assert.throws(() => analyzeStudioIntelSamples([new Float32Array(2), new Float32Array(3)], 44100), /equal lengths/);
  assert.throws(() => analyzeStudioIntelSamples([new Float32Array(2)], 0), /Invalid audio sample input/);
});
