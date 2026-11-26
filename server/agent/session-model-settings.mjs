import fs from "node:fs";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai/compat";

export function modelThinkingLevels(model) {
  return model?.reasoning ? getSupportedThinkingLevels(model) : ["off"];
}

export function defaultThinkingLevel(model) {
  const levels = modelThinkingLevels(model);
  return levels.includes("high") ? "high" : levels.at(-1) || "off";
}

export function sessionModelSettings(entry) {
  return {
    model: entry.modelId,
    thinkingLevel: entry.session.thinkingLevel ?? defaultThinkingLevel(entry.session.model),
    thinkingLevels: modelThinkingLevels(entry.session.model),
  };
}

export function persistEmptySessionSettings(session) {
  const manager = session.sessionManager;
  const file = manager?.getSessionFile();
  if (!file || fs.existsSync(file)) return;
  const records = [manager.getHeader(), ...manager.getEntries()];
  fs.writeFileSync(file, records.map(record=>JSON.stringify(record)).join("\n")+"\n",{flag:"wx",mode:0o600});
  manager.setSessionFile(file);
}
