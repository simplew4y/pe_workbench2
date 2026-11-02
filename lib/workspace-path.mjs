/**
 * Project-root path guard shared by Pi custom tools.
 *
 * Tools receive model-generated paths. Accept a project-relative path (or an
 * absolute path that resolves inside the project), normalise it and reject
 * everything outside the current project root.
 */

import fs from "node:fs";
import path from "node:path";

export function workspaceRel(workspace, value) {
  if (typeof value !== "string" || !value.trim()) {
    throw Object.assign(new Error("path is required"), { status: 400 });
  }
  let candidate = value.trim();
  // Tolerate the root label the model saw in older prompts.
  for (const prefix of ["agent-workspace/", "agent-workspace\\"]) {
    if (candidate.startsWith(prefix)) candidate = candidate.slice(prefix.length);
  }
  const root = path.resolve(workspace);
  const absolute = path.isAbsolute(candidate) ? path.resolve(candidate) : path.resolve(root, candidate);
  if (absolute !== root && !absolute.startsWith(root + path.sep)) {
    throw Object.assign(new Error("path must stay inside the current project"), { status: 403 });
  }
  const rel = path.relative(root, absolute).split(path.sep).join("/");
  if (!rel || rel.startsWith("..")) {
    throw Object.assign(new Error("path must stay inside the current project"), { status: 403 });
  }
  return rel;
}

/**
 * Follow symlinks for an existing file and verify the real target is still
 * under the project root. Missing paths are left to the caller's 404 handling.
 */
export function insideProjectRealRoot(workspace, absolute) {
  try {
    const root = fs.realpathSync(workspace);
    const real = fs.realpathSync(absolute);
    return real === root || real.startsWith(root + path.sep);
  } catch {
    return true;
  }
}

export default workspaceRel;
