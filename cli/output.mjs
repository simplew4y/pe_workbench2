/** Output helpers. JSON mode is stable; human mode is intentionally compact. */

export function writeJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

export function writeText(value) {
  process.stdout.write(String(value ?? ""));
}

function stringifyCell(value) {
  if (value === null || value === undefined) return "";
  if (Array.isArray(value)) return value.map(stringifyCell).join(", ");
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function pad(value, width) {
  const cell = stringifyCell(value);
  const length = [...cell].length;
  return cell + " ".repeat(Math.max(0, width - length));
}

/** Render an ASCII table. Columns: { key, label, width?, max? }. */
export function table(rows, columns) {
  if (!Array.isArray(rows) || rows.length === 0) return "（空）\n";
  const cells = rows.map((row) => columns.map((column) => {
    const value = typeof column.get === "function" ? column.get(row) : row?.[column.key];
    const text = stringifyCell(value);
    const max = column.max ?? 60;
    return [...text].length > max ? `${[...text].slice(0, Math.max(0, max - 1)).join("")}…` : text;
  }));
  const widths = columns.map((column, index) => (
    column.width
    ?? Math.max([...column.label].length, ...cells.map((row) => [...row[index]].length))
  ));
  const header = columns.map((column, index) => pad(column.label, widths[index])).join("  ");
  const lines = [header];
  for (const row of cells) {
    lines.push(row.map((cell, index) => pad(cell, widths[index])).join("  "));
  }
  return `${lines.join("\n")}\n`;
}

/** Render a small key/value block. */
export function keyValues(entries) {
  const rows = entries
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => [key, stringifyCell(value)]);
  if (!rows.length) return "";
  const width = Math.max(...rows.map(([key]) => [...key].length));
  return `${rows.map(([key, value]) => `${key}${" ".repeat(width - [...key].length)}  ${value}`).join("\n")}\n`;
}

/**
 * Emit a command result. `render` receives the same data and must write text.
 * Human mode falls back to pretty JSON when the command does not define one.
 */
export function emit(ctx, data, render = null) {
  if (ctx.json) {
    writeJson(data);
    return;
  }
  if (typeof render === "function") {
    const text = render(data);
    if (text !== undefined && text !== null) process.stdout.write(String(text));
    return;
  }
  writeJson(data);
}
