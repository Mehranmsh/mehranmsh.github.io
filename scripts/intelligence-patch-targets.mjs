export const INTELLIGENCE_PATCH_TARGETS = Object.freeze({
  "scripts/intelligence-capabilities.test.mjs": Object.freeze({
    testCommand: "node --test scripts/intelligence-capabilities.test.mjs"
  }),
  "scripts/intelligence-inbox-schema.test.mjs": Object.freeze({
    testCommand: "node --test scripts/intelligence-inbox-schema.test.mjs"
  })
});

export function isAllowedIntelligencePatchTarget(path) {
  return typeof path === "string" && Object.hasOwn(INTELLIGENCE_PATCH_TARGETS, path);
}

export function getIntelligencePatchTarget(path) {
  return isAllowedIntelligencePatchTarget(path) ? INTELLIGENCE_PATCH_TARGETS[path] : null;
}
