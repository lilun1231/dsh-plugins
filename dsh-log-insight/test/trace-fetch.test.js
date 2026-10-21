import { test } from 'node:test';
import assert from 'node:assert/strict';
import { flattenTree, findBottleneck } from '../lib/trace-fetch.js';

const tree = [{
  type: 'http_execute_after', project: 'hall-restful', uri: '/a', duration: 100, code: 200,
  procedure: [
    { type: 'rpc_invoke_after', project: 'hall-restful', duration: 90, procedure: [
      { type: 'rpc_execute_after', project: 'hall-app-service', duration: 80, procedure: [] },
    ] },
    { type: 'log', project: 'hall-restful', duration: 1, procedure: [] },
  ],
}];

test('扁平化保留层级与顺序', () => {
  const spans = flattenTree(tree);
  assert.equal(spans.length, 4);
  assert.equal(spans[0].depth, 0);
  assert.equal(spans[0].service, 'hall-restful');
  assert.equal(spans[1].depth, 1);
  assert.equal(spans[2].depth, 2);
  assert.equal(spans[2].service, 'hall-app-service');
});

test('瓶颈取耗时最大的节点', () => {
  const spans = flattenTree(tree);
  const bottleneck = findBottleneck(spans);
  assert.equal(bottleneck.span.service, 'hall-restful');
  assert.equal(bottleneck.durationMs, 100);
  assert.equal(bottleneck.share, 1);
});

test('空树返回空结果且不报错', () => {
  assert.deepEqual(flattenTree([]), []);
  assert.equal(findBottleneck([]), null);
});

test('异常节点带 error 字段', () => {
  const spans = flattenTree([{ type: 'exception', project: 'hall-app-service', duration: 1, message: '空指针' }]);
  assert.equal(spans[0].error, '空指针');
});
