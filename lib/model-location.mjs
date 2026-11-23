import fs from "node:fs";
import path from "node:path";

export function uploadedWorkbook(tracking) {
  const target = tracking?.relPath || tracking?.targetPath || "";
  return /^(?:uploads|inputs)\/.+\.xlsx$/i.test(target) && tracking.targetId ? target : "";
}

export function modelUpdateState(sourceId) {
  return path.posix.join("exports/model-updates", sourceId, "model/analysis-state.json");
}

export function trackingStatePath(root, tracking) {
  const target = tracking?.relPath || tracking?.targetPath || "";
  if (!target) return "";
  const sibling = path.posix.join(path.posix.dirname(target), "analysis-state.json");
  if (!uploadedWorkbook(tracking)) return sibling;
  const dedicated = modelUpdateState(tracking.targetId);
  if (fs.existsSync(path.join(root, dedicated))) return dedicated;
  try {
    const previous = JSON.parse(fs.readFileSync(path.join(root, sibling), "utf8"));
    if (previous.subject?.model_file === target) return sibling;
  } catch (error) {
    if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
  }
  return dedicated;
}
