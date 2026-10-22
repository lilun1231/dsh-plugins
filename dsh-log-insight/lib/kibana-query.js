import { KibanaSession } from './kibana-auth.js';

/**
 * 构造 ES 查询体。
 * @param {{namespace: string, keyword?: string, services?: string[], traceId?: string, level?: string, from: Date, to: Date, limit: number, maxHits?: number}} input 查询条件
 * @returns {object} ES 查询 JSON
 */
export function buildSearchBody(input) {
  const {
    namespace, keyword, keywords, excludeKeywords, services = [], traceId, level, from, to, maxHits = 200,
  } = input;
  const size = Math.min(input.limit ?? 50, maxHits);

  const filter = [
    { term: { 'kubernetes.namespace_name': namespace } },
    { range: { '@timestamp': { gte: from.toISOString(), lte: to.toISOString() } } },
  ];
  if (services.length > 0) {
    filter.push({ terms: { 'kubernetes.container_name.raw': services } });
  }
  if (level) {
    filter.push({ term: { level: level.toLowerCase() } });
  }

  // 多个关键字之间是 AND，排除关键字走 must_not
  const must = [];
  if (traceId) {
    must.push({ query_string: { query: `message:"${escapeQuery(traceId)}"`, analyze_wildcard: true } });
  } else {
    const terms = Array.isArray(keywords) && keywords.length > 0
      ? keywords
      : (typeof keyword === 'string' && keyword !== '' ? [keyword] : []);
    for (const term of terms) {
      if (typeof term === 'string' && term !== '') {
        must.push({ query_string: { query: `message:"${escapeQuery(term)}"`, analyze_wildcard: true } });
      }
    }
  }
  const mustNot = (Array.isArray(excludeKeywords) ? excludeKeywords : [])
    .filter((term) => typeof term === 'string' && term !== '')
    .map((term) => ({ query_string: { query: `message:"${escapeQuery(term)}"`, analyze_wildcard: true } }));

  const bool = { filter };
  if (must.length > 0) bool.must = must;
  if (mustNot.length > 0) bool.must_not = mustNot;

  return {
    size,
    query: { bool },
    sort: [{ '@timestamp': 'desc' }],
  };
}

/**
 * 执行日志检索。
 * @param {KibanaSession} session Kibana 会话
 * @param {{index: string, body: object}} options 索引与查询体
 * @returns {Promise<{total: number, hits: object[]}>} 检索结果
 */
export async function searchLogs(session, options) {
  const path = `/api/console/proxy?path=${encodeURIComponent(`${options.index}/_search`)}&method=POST`;
  const res = await session.post(path, JSON.stringify(options.body));
  if (res.status !== 200) {
    throw new Error(`Kibana 查询失败：HTTP ${res.status} ${res.body.slice(0, 200)}`);
  }
  const payload = JSON.parse(res.body);
  if (payload.error) {
    throw new Error(`ES 查询失败：${payload.error.reason ?? JSON.stringify(payload.error).slice(0, 200)}`);
  }
  const total = typeof payload.hits.total === 'object' ? payload.hits.total.value : payload.hits.total;
  const hits = payload.hits.hits.map((h) => toLogHit(h._source));
  return { total, hits };
}

/**
 * 把 ES 文档映射为统一日志结构。流水号优先取 message 里的 lid 字段。
 * @param {object} src ES 文档
 * @returns {object} 日志条目
 */
export function toLogHit(src) {
  const message = src.message ?? '';
  let traceId;
  const lidMatch = message.match(/"lid"\s*:\s*"([^"]+)"/);
  if (lidMatch) {
    traceId = lidMatch[1];
  } else {
    const loose = message.match(/\b[a-z][a-z-]*-\d+-\d+-\d+\b/);
    if (loose) traceId = loose[0];
  }
  return {
    timestamp: src['@timestamp'],
    service: src.kubernetes?.container_name ?? '',
    level: src.level ?? '',
    logger: src.kubernetes?.container_name ?? '',
    message,
    traceId,
  };
}

/**
 * 转义 query_string 里的引号与反斜杠，避免用户输入破坏查询语法。
 * @param {unknown} value 原始关键字
 * @returns {string} 转义后的关键字
 */
function escapeQuery(value) {
  return String(value).replace(/["\\]/g, '\\$&');
}
