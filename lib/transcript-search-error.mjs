// Only public parameter names and validation conditions enter a reader's view.
// Pi validation messages also include the full supplied arguments.
const missingQuery = '缺少必填的检索词 query。';
export function searchArgumentIssue(args) {
  if (!args || args.query == null || args.query === '') return missingQuery;
  if (typeof args.query !== 'string') return '检索词 query 必须是文本。';
  if (!args.query.trim()) return missingQuery;
}

export function searchErrorMessage(output) {
  const diagnostic = String(output ?? '').split(/\n\s*Received arguments:/i, 1)[0].trim().replace(/^Error:\s*/i, '');
  if (diagnostic === missingQuery || diagnostic === '检索词 query 必须是文本。') return diagnostic;
  if (/query: must have required properties query|query 不能为空/i.test(diagnostic)) return missingQuery;
  const field = diagnostic.match(/(?:^|\n)\s*-?\s*(query|limit|turn|turnRange|handle):\s*must\b/i)?.[1];
  if (field) return '历史检索参数 ' + field + ' 不符合要求。';
  if (/句柄|handle.*(?:expired|invalid)/i.test(diagnostic)) return '历史引用句柄已失效或不属于本轮检索。';
  if (/cancelled|canceled|取消/i.test(diagnostic)) return '本次历史检索已取消。';
  return '历史检索未能执行，请检查检索条件后重试。';
}
