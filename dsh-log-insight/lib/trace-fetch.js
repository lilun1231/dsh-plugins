import { request } from './http.js';

/**
 * 拉取完整链路树。该接口免认证，不依赖登录态。
 * @param {{hibbertBaseUrl: string, serialNo: string}} input 连接与链路号
 * @returns {Promise<object[]>} 链路树根节点数组
 */
export async function fetchTraceTree(input) {
  const url = `${input.hibbertBaseUrl}/api/callchain/fetch?serialNo=${encodeURIComponent(input.serialNo)}`;
  const res = await request(url, { timeoutMs: 30000 });
  if (res.status !== 200) {
    throw new Error(`链路接口返回 HTTP ${res.status}`);
  }
  let payload;
  try {
    payload = JSON.parse(res.body);
  } catch {
    throw new Error('链路接口返回非 JSON');
  }
  if (payload.code !== 1) {
    throw new Error(`链路不存在或查询失败：code=${payload.code}`);
  }
  return payload.data ?? [];
}

/**
 * 把链路树扁平化为按调用顺序排列的段落列表。
 * @param {object[]} nodes 树节点
 * @param {number} [depth] 当前深度
 * @returns {Array<{depth: number, type: string, service: string, uri: string, durationMs: number, status: number|string, error?: string}>} 扁平列表
 */
export function flattenTree(nodes, depth = 0) {
  if (!Array.isArray(nodes)) return [];
  const out = [];
  for (const node of nodes) {
    out.push({
      depth,
      type: node.type ?? 'unknown',
      service: node.project ?? '',
      uri: node.uri ?? node.operationName ?? '',
      durationMs: Number(node.duration ?? 0),
      status: node.code ?? '',
      error: node.type === 'exception' ? String(node.message ?? '异常节点') : undefined,
    });
    if (Array.isArray(node.procedure) && node.procedure.length > 0) {
      out.push(...flattenTree(node.procedure, depth + 1));
    }
  }
  return out;
}

/**
 * 找出耗时最大的段落及其占比。
 * @param {Array<{service: string, uri: string, durationMs: number}>} spans 扁平列表
 * @returns {{span: object, durationMs: number, share: number}|null} 瓶颈信息
 */
export function findBottleneck(spans) {
  if (!Array.isArray(spans) || spans.length === 0) return null;
  const root = spans[0];
  let max = spans[0];
  for (const span of spans) {
    if (span.durationMs > max.durationMs) max = span;
  }
  const total = root.durationMs > 0 ? root.durationMs : max.durationMs;
  return {
    span: max,
    durationMs: max.durationMs,
    share: total > 0 ? Number((max.durationMs / total).toFixed(3)) : 0,
  };
}
