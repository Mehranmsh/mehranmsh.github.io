export const SECURITY_AUDIT_PATHS = Object.freeze([
  "worker.js",
  "scripts/intelligence-agent.mjs",
  "scripts/intelligence-capabilities.mjs",
  "scripts/intelligence-capabilities.test.mjs",
  ".github/workflows/mehran-intelligence-runner.yml",
  "docs/INTELLIGENCE_EXECUTION_PROTOCOL.md"
]);

const RULES = Object.freeze([
  { id:"private_key_pem", severity:"critical", pattern:/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g },
  { id:"github_personal_access_token", severity:"critical", pattern:/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}\b/g },
  { id:"github_fine_grained_token", severity:"critical", pattern:/\bgithub_pat_[A-Za-z0-9_]{40,}\b/g },
  { id:"aws_access_key_id", severity:"high", pattern:/\bAKIA[0-9A-Z]{16}\b/g },
  { id:"slack_bearer_token", severity:"high", pattern:/\bxox[baprs]-[A-Za-z0-9-]{20,}\b/g },
  { id:"hardcoded_password_or_secret", severity:"high", pattern:/\b(?:password|passwd|client_secret|clientSecret|private_key|privateKey|access_token|accessToken)\s*[:=]\s*["'`][^"'`\r\n]{16,}["'`]/gi }
]);

export function buildStaticSecurityAudit(files, commitSha) {
  if (!Array.isArray(files) || files.length < 1 || files.length > SECURITY_AUDIT_PATHS.length ||
      typeof commitSha !== "string" || !/^[a-f0-9]{40}$/i.test(commitSha)) {
    throw new Error("Invalid bounded security audit input.");
  }
  const seen = new Set();
  let totalBytes = 0;
  const findings = [];
  for (const file of files) {
    if (!file || typeof file.path !== "string" || !SECURITY_AUDIT_PATHS.includes(file.path) ||
        seen.has(file.path) || typeof file.content !== "string" ||
        typeof file.blobSha !== "string" || !/^[a-f0-9]{40}$/i.test(file.blobSha)) {
      throw new Error("Invalid, duplicate, or non-allowlisted security audit source.");
    }
    seen.add(file.path);
    const bytes = new TextEncoder().encode(file.content).length;
    if (bytes > 600000 || (totalBytes += bytes) > 750000) {
      throw new Error("Static security audit source limit exceeded.");
    }
    const lines = file.content.split(/\r\n|\n|\r/);
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index].slice(0, 4000);
      for (const rule of RULES) {
        rule.pattern.lastIndex = 0;
        if (rule.pattern.test(line)) {
          findings.push({ path:file.path, line:index + 1, rule:rule.id, severity:rule.severity });
          if (findings.length >= 100) break;
        }
      }
      if (findings.length >= 100) break;
    }
    if (findings.length >= 100) break;
  }
  const severityCounts = { critical:0, high:0, medium:0, low:0 };
  for (const finding of findings) severityCounts[finding.severity]++;
  return {
    type:"source_security_audit",
    mode:"bounded_static_pattern_scan",
    repository:"Mehranmsh/mehranmsh.github.io",
    commitSha,
    summary:{filesScanned:seen.size,totalBytes,findings:findings.length,severityCounts},
    findings,
    limitations:[
      "Pattern matching only; no semantic analysis, dependency audit, runtime test, or exploit validation.",
      "Absence of findings does not prove the repository is secure.",
      "Matched source text and credential values are never included in this report.",
      "Only exact allowlisted files from one immutable commit were scanned."
    ]
  };
}
