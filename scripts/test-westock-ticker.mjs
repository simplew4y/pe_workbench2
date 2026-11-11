import assert from 'node:assert/strict';
import { normalizeWestockTicker, normalizedArgs, parseWestockQuotes } from '../lib/westock-tool.mjs';
for (const [raw, expected] of [['02513.HK（港股）','hk02513'],[' 00700.HK (港股) ','hk00700'],['hk00700','hk00700'],[' AAPL.US【美股】 ','usAAPL'],['sh600519','sh600519']]) assert.equal(normalizeWestockTicker(raw),expected);
assert.deepEqual(normalizedArgs(['quote','02513.HK（港股）, 00700.HK（港股）']),['quote','hk02513,hk00700']);
assert.deepEqual(normalizedArgs(['news','--keyword','腾讯（港股）']),['news','--keyword','腾讯（港股）']);
console.log('westock ticker normalization passed');
const quotes = parseWestockQuotes('| 代码 | 最新价 | 币种 | 时间 |\n| --- | --- | --- | --- |\n| sh600519 | 1,426.00 | CNY | 2026-11-11 10:05:00 |', ['quote','sh600519'], '2026-11-11T02:06:00.000Z');
assert.deepEqual(quotes, [{ticker:'sh600519',price:1426,currency:'CNY',quote_at:'2026-11-11T02:05:00.000Z',fetched_at:'2026-11-11T02:06:00.000Z'}]);
assert.deepEqual(parseWestockQuotes('| 代码 | 最新价 |\n|---|---|\n| sh600519 | -- |', ['quote','sh600519'], 'x'), []);
assert.deepEqual(normalizedArgs(['quote',' 02513 .HK （港股） ']),['quote','hk02513']);
for (const [raw, expected] of [['02513.HK 港股','hk02513'],['600519.sh 沪股','sh600519'],['000651.SZ 深股','sz000651'],['aapl.us 美股','usAAPL'],['HK00700 港股','hk00700'],['usmsft 美股','usMSFT']]) {
  assert.equal(normalizeWestockTicker(raw), expected);
  assert.deepEqual(normalizedArgs(['quote', raw]), ['quote', expected]);
}
assert.deepEqual(normalizedArgs(['quote','02513.HK 港股, aapl.US 美股']),['quote','hk02513,usAAPL']);
