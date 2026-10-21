import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSearchBody, toLogHit } from '../lib/kibana-query.js';

const base = {
  namespace: 'a-wsyyt-hall-serv-fat',
  from: new Date('2026-10-21T02:00:00Z'),
  to: new Date('2026-10-21T03:00:00Z'),
  limit: 50,
};

test('关键字与服务过滤生成 bool 查询', () => {
  const body = buildSearchBody({ ...base, keyword: 'W100024', services: ['hall-restful'] });
  assert.equal(body.query.bool.filter[0].term['kubernetes.namespace_name'], 'a-wsyyt-hall-serv-fat');
  assert.equal(body.query.bool.filter[1].range['@timestamp'].gte, '2026-10-21T02:00:00.000Z');
  assert.equal(body.query.bool.must[0].query_string.query, 'message:"W100024"');
  assert.equal(body.query.bool.filter[2].terms['kubernetes.container_name.raw'][0], 'hall-restful');
  assert.equal(body.size, 50);
});

test('按流水号精确查询使用 traceId 分支', () => {
  const body = buildSearchBody({ ...base, traceId: 'hall-restful-1-2-3' });
  assert.equal(body.query.bool.must[0].query_string.query, 'message:"hall-restful-1-2-3"');
});

test('无关键字时没有 must 子句', () => {
  const body = buildSearchBody(base);
  assert.equal(body.query.bool.must, undefined);
});

test('级别过滤转小写', () => {
  const body = buildSearchBody({ ...base, level: 'ERROR' });
  assert.equal(body.query.bool.filter[2].term.level, 'error');
});

test('limit 超过上限时被截断', () => {
  const body = buildSearchBody({ ...base, limit: 9999, maxHits: 200 });
  assert.equal(body.size, 200);
});

test('从 message 的 lid 字段提取流水号', () => {
  const hit = toLogHit({
    '@timestamp': '2026-10-21T02:00:00Z',
    message: '{"chnl":"5","lid":"hall-restful-2887720851-497934-1649","x":"/rest/a"}',
    kubernetes: { container_name: 'hall-restful' },
  });
  assert.equal(hit.traceId, 'hall-restful-2887720851-497934-1649');
  assert.equal(hit.service, 'hall-restful');
});

test('无 lid 时按格式兜底提取', () => {
  const hit = toLogHit({ message: '请求 hall-restful-1-2-3 失败' });
  assert.equal(hit.traceId, 'hall-restful-1-2-3');
});

test('普通日志不误判流水号', () => {
  const hit = toLogHit({ message: '启动完成，耗时 120ms' });
  assert.equal(hit.traceId, undefined);
});
