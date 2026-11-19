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
    '/intelligence/knowledge/evaluations?state=all&limit=100',
    'id="intelligenceOverviewPanel"',
    'id="refreshOverviewBtn"',
    'async function loadOverview()',
    'request("/intelligence/overview")',
    'value.textContent=String(data.counts?.[key]??0)',
    'id="knowledgeSearchForm"',
    'id="knowledgeSearchInput"',
    'maxlength="120"',
    'async function searchKnowledge(event)',
    '/intelligence/knowledge?state=all&limit=50&q="+encodeURIComponent(query)',
    'knowledgeSearchResults',
    'content.textContent=String(item.content||"").slice(0,360)',

    'refreshEvaluationsBtn',
    'request("/intelligence/memory/"+encodeURIComponent(id),{method:"DELETE"})',
    'body:{action}',
    'memoryKind',
    'sourceType',
    '/intelligence/knowledge?state=all&limit=100&offset="+memorySourceOffset',
    'async function loadMemorySourceOptions(direction=0)',
    'memorySourcePrev',
    'memorySourceNext',
    'memorySourceHasMore',
    'hasMore',
    'Records ',
    'memorySourceRef',
    'updateMemorySourceControl()',
    'confidenceScore',
    '/intelligence/memory/review-queue?offset="+memoryOffset',
    'async function loadMemory(direction=0)',
    'async function loadMemoryReviewQueue(direction=0)',
    'function updateMemoryPager(data)',
    'memoryPrev',
    'memoryNext',
    'memoryHasMore',
    'if(memoryView==="review")await loadMemoryReviewQueue();else await loadMemory()',
    'memoryOffset=0;$("memoryState").value="active";loadMemory();return',
    'hasMore',
    'memoryState',
    'archived',
    'owner_confirmed',
    'data-review="verify"',
    'data-review="dispute"',
    'data-review="unverify"',
    'Execution enabled: ',
    'EXECUTOR: DISABLED',
    'sessionToken = ""',
    'Staging session expired. Sign in with Pi again.',
    'response.status===401&&sessionToken',
    'No production data, secrets, approvals or sessions are shared.',
    "id=\"capabilityApprovalPanel\"",
    "request(\"/intelligence/capability-approvals\")",
    "request(\"/intelligence/capability-approvals\",{method:\"POST\"",
    "request(\"/intelligence/capability-approvals/\"+encodeURIComponent(item.id),{method:\"DELETE\"})",
    "request(\"/intelligence/capabilities/evaluate\",{method:\"POST\"",
    "approvalId",
    "assessmentOnly",
    "operationPerformed",
    "approvalConsumed",
    "Executor enabled: ",
    "No data mutation, deletion, external action, or approval consumption",
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

def test_staging_logout_does_not_claim_revocation_when_server_did_not_confirm():
    assert 'Session revocation was not confirmed:' in page
    assert 'The local session remains available so you can retry.' in page
    assert 'The server rejected this session; sign in again.' in page
    assert 'Staging session revoked. The bearer token was cleared from this page.' in page
    assert 'finally{sessionToken="";sessionExpiresAt=0;setAuthenticated(false)' not in page


def test_staging_ui_has_one_footer_and_only_three_review_templates():
    assert page.count("<footer>") == 1
    assert page.count("</footer>") == 1
    assert page.count(".innerHTML=") == 3


def test_staging_ui_escapes_untrusted_content_before_html_insertion():
    # The few HTML-string templates must escape every server-controlled value.
    for marker in [
        "function esc(value)",
        ".replace(/[&<>",
        "&amp;",
        "&lt;",
        "&gt;",
        "&quot;",
        "&#39;",
        'esc(item.verificationStatus)',
        'esc(item.title)',
        'esc(reasons)',
        'esc(item.sourceType||"—")',
        'esc(item.observedAt||"—")',
        'esc(item.id)',
        'esc(task.title)',
        'esc(task.description)',
        'esc(task.status)',
        'esc(task.priority)',
        'esc(item.reviewState)',
        'title.textContent=item.category+" · "+item.memory_kind',
        'body.textContent=item.content',
    ]:
        assert marker in page, f"Server-controlled UI content must be escaped or assigned as text: {marker}"

if "REPLACE_WITH_VERIFIED_STAGING_WORKER_URL" not in page:
    raise SystemExit("Staging Worker URL must remain an explicit unconfigured placeholder.")
if page.count("STAGING_WORKER_URL") < 5:
    raise SystemExit("Staging Worker URL must be consistently isolated through one config constant.")

print("INTELLIGENCE staging UI safety contract passed.")

# Company module registry contract
assert 'companyModuleRegistryPanel' in page

# Company module registry contract
assert 'refreshCompanyModulesBtn' in page

# Company module registry contract
assert 'loadCompanyModules()' in page

# Company module registry contract
assert 'request("/intelligence/company/modules")' in page

# Company assessment blueprint contract
assert 'companyAssessmentPlanPanel' in page
assert 'loadCompanyAssessmentBlueprint' in page
assert 'assessment-template?moduleId=' in page
assert 'data-assess-module' in page


# Findings dashboard contract: authenticated GET only, bounded filters, safe text rendering.
for marker in [
    'id="findingsPanel"',
    'id="findingsModuleFilter"',
    'id="findingsSeverityFilter"',
    'id="findingsStatusFilter"',
    'id="refreshFindingsBtn"',
    'id="loadMoreFindingsBtn"',
    'id="findingsSafetyNotice"',
    'async function loadFindings(reset=true)',
    'request("/intelligence/findings?"+params.toString())',
    'params.set("module",moduleId)',
    'params.set("severity",severity)',
    'params.set("status",status)',
    'new URLSearchParams({limit:"25",offset:String(findingsOffset)})',
    'findingsOffset=Number(data.nextOffset',
    'findingsHasMore=!!data.hasMore',
    'findingsElement("h3","",item.title||"Untitled finding")',
    'findingsElement("p","",item.description||"No description recorded.")',
    'findingsElement("p","small",item.recommendation?',
    'card.append(top,title,module,description,evidence,recommendation,reason,dates)',
    'Execution enabled: false.',
    'Assessment: "+String(data.assessment)',
]:
    assert marker in page, f"Findings dashboard missing required safe/read-only behavior: {marker}"

findings_function = page.split("async function loadFindings(reset=true)", 1)[1].split("async function loadOverview()", 1)[0]
assert 'method:"GET"' not in findings_function or 'request("/intelligence/findings?' in findings_function
for forbidden in ['method:"POST"', 'method:"PUT"', 'method:"DELETE"', 'innerHTML', 'insertAdjacentHTML', 'eval(']:
    assert forbidden not in findings_function, f"Findings dashboard must remain read-only and avoid HTML injection: {forbidden}"
assert 'findingsList' in findings_function and '.append(card)' in findings_function
assert 'textContent' in page or 'findingsElement' in page

refresh_block = page.split("async function refreshAll(){", 1)[1].split("}", 1)[0]
assert "loadFindings(true)" in refresh_block, "Findings must load automatically after owner authentication."


# Assessment coverage dashboard contract: owner-scoped GET, safe DOM, no pass inference.
for marker in [
    'id="assessmentCoveragePanel"',
    'id="refreshAssessmentCoverageBtn"',
    'id="assessmentCoverageSummary"',
    'id="assessmentCoverageSafetyNotice"',
    'id="assessmentCoverageList"',
    'async function loadAssessmentCoverage()',
    'request("/intelligence/company/assessment-coverage")',
    'data.totalChecks',
    'data.checksWithFindings',
    'data.checksWithoutRecordedFindings',
    'item.recordState==="findings_recorded"',
    'No recorded findings does not mean a check passed.',
    'Execution enabled: false.',
    'loadAssessmentCoverage()',
]:
    assert marker in page, f"Assessment coverage dashboard missing required safety behavior: {marker}"

coverage_function = page.split("async function loadAssessmentCoverage()", 1)[1].split("async function loadOverview()", 1)[0]
for forbidden in ['method:"POST"', 'method:"PUT"', 'method:"DELETE"', 'innerHTML', 'insertAdjacentHTML', 'eval(']:
    assert forbidden not in coverage_function, f"Assessment coverage must remain read-only and avoid HTML injection: {forbidden}"
assert 'createElement' in coverage_function and '.textContent' in coverage_function
assert "loadAssessmentCoverage()" in refresh_block, "Coverage must load automatically after owner authentication."
