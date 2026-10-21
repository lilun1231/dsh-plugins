import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRange, formatGovernanceTime } from '../lib/time.js';

test('不传 from/to 时默认近 30 分钟', () => {
  const now = new Date('2026-10-21T14:30:00+08:00');
  const r = parseRange({}, now);
  assert.equal(r.to.getTime(), now.getTime());
  assert.equal(r.from.getTime(), now.getTime() - 30 * 60 * 1000);
});

test('带时区偏移的 ISO 8601 被正确解析', () => {
  const r = parseRange({ from: '2026-10-21T10:10:00+08:00', to: '2026-10-21T10:20:00+08:00' });
  assert.equal(r.from.toISOString(), '2026-10-21T02:10:00.000Z');
  assert.equal(r.to.toISOString(), '2026-10-21T02:20:00.000Z');
});

test('非法时间字符串抛错', () => {
  assert.throws(() => parseRange({ from: '不是时间' }), /无法解析时间/);
});

test('起始晚于结束抛错', () => {
  assert.throws(() => parseRange({ from: '2026-10-21T12:00:00+08:00', to: '2026-10-21T11:00:00+08:00' }), /起始时间不能晚于结束时间/);
});

test('格式化服务治理时间格式', () => {
  const d = new Date('2026-10-21T02:10:00.000Z');
  assert.equal(formatGovernanceTime(d, 'Asia/Shanghai'), '2026/10/21 10:10:00');
});
