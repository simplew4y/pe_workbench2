import { emit, keyValues } from "./shared.mjs";

export const doctor = {
  summary: "检查本地服务、模型、项目和能力开关（不输出任何密钥）",
  usage: "pe doctor [--json]",
  options: [],
  async run({ client }) {
    const health = await client.get("/api/health", { scope: false });
    emit({}, health, (data) => keyValues([
      ["服务", data.ok ? "ok" : "异常"],
      ["模型", data.model],
      ["默认项目", data.defaultProject],
      ["项目", (data.projects || []).map((project) => `${project.id}(${project.name})`).join(", ")],
      ["调度器", `tracking=${data.trackingScheduler ? "on" : "off"} · monitor=${data.monitorScheduler ? "on" : "off"} · source=${data.sourceScheduler ? "on" : "off"}`],
      ["ASR", `${data.asr?.enabled ? "on" : "off"} · configured=${data.asr?.configured ? "yes" : "no"}`],
      ["AnySearch", `${data.anysearch?.enabled ? "on" : "off"} · configured=${data.anysearch?.configured ? "yes" : "no"}`],
      ["DeepSeek Search", data.deepseekSearch?.enabled ? "on" : "off"],
      ["Web Fetch", `${data.webFetch?.enabled ? "on" : "off"} · private=${data.webFetch?.allowPrivate ? "yes" : "no"}`],
      ["Calc", data.calc?.available ? `${data.calc.version || "available"}` : "unavailable"],
    ]));
  },
};

export const doctorNote = "能力开关以 /api/health 为准；workbook/pdf 能力未在该接口暴露，可分别用 material workbook / material pdf 探测。";
