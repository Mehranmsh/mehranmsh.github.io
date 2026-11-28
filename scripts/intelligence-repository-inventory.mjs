import { isAllowedInspectionPath } from "./intelligence-patch-policy.mjs";

const SOURCE_EXTENSION = /\.(?:mjs|js|jsx|ts|tsx|html|css|json|py)$/i;
const EXCLUDED_SEGMENT = /^(?:node_modules|vendor|dist|build|coverage|\.git|\.github|\.next|\.cache)$/i;

export function filterRepositoryInventoryPaths(paths) {
  if (!Array.isArray(paths)) return [];
  return [...new Set(paths.filter(path =>
    typeof path === "string" &&
    SOURCE_EXTENSION.test(path) &&
    !path.split("/").some(segment => EXCLUDED_SEGMENT.test(segment)) &&
    isAllowedInspectionPath(path)
  ))].sort();
}

export function getRepositoryModuleKey(path) {
  const parts = String(path || "").split("/");
  return parts.length > 1 ? parts[0] : "root";
}
