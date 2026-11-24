export function buildDeterministicRoutinePlan(mission) {
  const text = String(mission || "").toLowerCase();
  // Never downgrade a change request into a read-only check just because it
  // also contains a recognized health, repository, or security keyword.
  const changeIntent = /\b(fix|repair|change|modify|update|edit|implement|build|create|add|remove|delete|refactor|improve|optimize|deploy|merge|apply|write)\b|ترمیم|تعمیر|اصلاح|تغییر|بهبود|پیاده\s*سازی|ایجاد|ساخت|اضافه|حذف|بازنویسی|بهینه\s*سازی|استقرار/i;
  if (changeIntent.test(text)) return null;
  const tasks = [];
  const add = (task) => {
    if (!tasks.some((item) => item.actionType === task.actionType)) tasks.push(task);
  };
  if (/(service health|worker health|database health|d1 health|health check|check health|بررسی سلامت|سلامت سرویس|سلامت ورکر|سلامت دیتابیس|وضعیت سرویس)/i.test(text)) {
    add({ taskId: "service-health", title: "Verify Worker and D1 service health", description: "Read the Worker health endpoint and verify service and database readiness.", actionType: "service_health_report", dependsOn: [] });
  }
  if (/(repository quality|repository status|repo status|github repository|check repository|کیفیت مخزن|وضعیت مخزن|وضعیت گیت.?هاب|بررسی مخزن)/i.test(text)) {
    add({ taskId: "repository-quality", title: "Inspect repository metadata", description: "Read repository metadata and latest commit information without changing files.", actionType: "repository_quality_check", dependsOn: [] });
  }
  if (/(security audit|source security|security check|audit source|بررسی امنیت|ممیزی امنیتی|ممیزی سورس|امنیت کد)/i.test(text)) {
    add({ taskId: "source-security", title: "Run deterministic source security checks", description: "Run existing bounded, pattern-based read-only checks. This is not a semantic AI code review.", actionType: "source_security_audit", dependsOn: [] });
  }
  if (!tasks.length) return null;
  return {
    title: "MEHRAN INTELLIGENCE routine checks",
    objective: "Complete only the explicitly recognized routine read-only checks using deterministic rules, without invoking an AI provider.",
    priority: "normal",
    planSummary: "Recognized routine checks were planned locally by the deterministic rules engine. No AI inference was requested.",
    tasks
  };
}
