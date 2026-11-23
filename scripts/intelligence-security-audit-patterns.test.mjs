import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const runnerPath = new URL("../.github/workflows/mehran-intelligence-runner.yml", import.meta.url);
const runnerSource = readFileSync(runnerPath, "utf8");

function loadForbiddenRunnerPatterns() {
  const match = runnerSource.match(/const forbiddenRunnerPatterns = (\[[\s\S]*?\]);/);
  assert.ok(match, "runner must declare its forbidden command patterns");
  return vm.runInNewContext(match[1], Object.create(null), { timeout: 100 });
}

test("security audit patterns do not match their own definitions in the runner", () => {
  const patterns = loadForbiddenRunnerPatterns();
  assert.equal(patterns.length, 4);
  for (const pattern of patterns) {
    assert.equal(pattern.test(runnerSource), false, `pattern self-matched: ${pattern}`);
  }
});

test("security audit patterns detect all forbidden command fixtures", () => {
  const patterns = loadForbiddenRunnerPatterns();
  const fixtures = [
    "wrangler deploy",
    "git push origin main",
    "CLOUDFLARE_API_TOKEN",
    "createOrUpdateFileContents"
  ];
  assert.equal(fixtures.length, patterns.length);
  for (let index = 0; index < patterns.length; index += 1) {
    assert.equal(patterns[index].test(fixtures[index]), true, `missed forbidden fixture: ${fixtures[index]}`);
  }
});

test("the audit check requires every forbidden pattern to be absent", () => {
  assert.match(
    runnerSource,
    /runner_has_no_deploy_or_repository_write_commands[\s\S]{0,220}forbiddenRunnerPatterns\.every\(pattern => !pattern\.test\(runnerSource\.text\)\)/
  );
});
