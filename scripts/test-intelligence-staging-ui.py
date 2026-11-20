#!/usr/bin/env python3
"""Static safety contract for the isolated INTELLIGENCE staging console."""
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
page = (ROOT / "intelligence-staging.html").read_text(encoding="utf-8")

required = [
    'const STAGING_WORKER_URL = "REPLACE_WITH_VERIFIED_STAGING_WORKER_URL";',
    'mehran-intelligence-staging\\.',
    'workers\\.dev',
    'Pi.authenticate(["username"]',
    'request("/session",{method:"POST"',
    'request("/session",{method:"DELETE"',
    'request("/session")',
    'request("/health",{allowHttpError:true})',
    '/intelligence/knowledge/review-queue',
    '/intelligence/projects?limit=100',
    '/intelligence/tasks/',
    '/dependencies',
    '/status',
    'data-save-project-status',
    'data-assign-project',
    'data-update-task-status',
    'data-add-dependency',
    'data-show-dependencies',
    'data-remove-dependency',
    'Manual status changes only. Execution enabled: ',
    'body:{action}',
    'data-review="verify"',
    'data-review="dispute"',
    'data-review="unverify"',
    'Execution enabled: ',
    'EXECUTOR: DISABLED',
    'sessionToken = ""',
    'Staging session expired. Sign in with Pi again.',
    'response.status===401&&sessionToken',
    'No production data, secrets, approvals or sessions are shared.',
]
for marker in required:
    if marker not in page:
        raise SystemExit(f"Staging console is missing required safety marker: {marker}")

for forbidden in [
    "AUTH_WORKER",
    "ADMIN_SESSION_KEY",
    "localStorage",
    '"/admin/session"',
    '"/intelligence/chat"',
    '"/intelligence/scheduler/',
    "mehran-msh-auth.mehran79mehran.workers.dev",
]:
    if forbidden in page:
        raise SystemExit(f"Staging console must not reference production capability: {forbidden}")

if "REPLACE_WITH_VERIFIED_STAGING_WORKER_URL" not in page:
    raise SystemExit("Staging Worker URL must remain an explicit unconfigured placeholder.")
if page.count("STAGING_WORKER_URL") < 5:
    raise SystemExit("Staging Worker URL must be consistently isolated through one config constant.")

print("INTELLIGENCE staging UI safety contract passed.")
