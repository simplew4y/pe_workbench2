import { opt } from "../args.mjs";
import { writeJson } from "../output.mjs";

function parseBlock(block) {
  const data = [];
  for (const line of block.split("\n")) {
    if (line.startsWith(":")) continue;
    if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
  }
  if (!data.length) return null;
  const text = data.join("\n");
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

export const events = {
  summary: "订阅实时事件流（SSE，长连接；默认不进入普通脚本）",
  children: {
    tail: {
      summary: "持续输出事件；--json 使用 NDJSON（每个事件一行）",
      usage: "pe events tail [--session <session-id>] [--json]",
      options: [
        { flags: "--session <session-id>", desc: "订阅单会话事件，省略则订阅项目全局事件" },
      ],
      async run({ client, options, json }) {
        const sessionId = opt(options, "session");
        const pathname = sessionId
          ? `/api/sessions/${encodeURIComponent(sessionId)}/events`
          : "/api/events";
        const response = await client.request(pathname, {
          raw: true,
          timeoutMs: 24 * 60 * 60 * 1000,
        });
        if (!response.ok) {
          const text = await response.text().catch(() => "");
          throw new Error(text || `${response.status} ${response.statusText}`);
        }
        if (!response.body) throw new Error("事件流没有响应体");

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true }).replace(/\r/g, "");
          let index = buffer.indexOf("\n\n");
          while (index >= 0) {
            const block = buffer.slice(0, index);
            buffer = buffer.slice(index + 2);
            const event = parseBlock(block);
            if (event) {
              if (json) writeJson(event);
              else {
                const type = event.type || "event";
                const summary = event.message
                  || event.title
                  || event.text
                  || event.error
                  || (event.material?.name)
                  || (event.watch?.name)
                  || "";
                process.stdout.write(`${new Date().toISOString()}  ${type}${summary ? `  ${String(summary).slice(0, 160)}` : ""}\n`);
              }
            }
            index = buffer.indexOf("\n\n");
          }
        }
      },
    },
  },
};
