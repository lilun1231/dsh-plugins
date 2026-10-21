/**
 * 调用链路搜索。
 * @param {import('./governance-auth.js').GovernanceSession} session 服务治理会话
 * @param {{projectId: number, projectName: string, from: string, to: string, type?: string, keyword?: string, matchType?: number, serviceName?: string, uri?: string, limit?: number}} input 查询条件
 * @returns {Promise<{total: number, items: object[]}>} 链路列表
 */
export async function searchCallChains(session, input) {
  const params = {
    pId: input.projectId,
    projectName: input.projectName,
    mId: '',
    serviceName: input.serviceName ?? '',
    resourceUri: input.uri ?? '',
    dateFrom: input.from,
    dateTo: input.to,
    matchType: input.matchType ?? 1,
    searchKeywords: input.keyword ?? '',
    requestResult: 1,
    order: 1,
    preTags: '<font style="color:red;">',
    postTags: '</font>',
    page: 1,
    rows: input.limit ?? 20,
    type: input.type ?? 'http',
    t: Date.now(),
  };

  const body = await session.get('/apm/callchain/search', params);
  if (body.resphead?.succeed !== true) {
    throw new Error(`链路搜索失败：${body.resphead?.message ?? '平台返回失败'}`);
  }
  const rows = body.respbody?.rows ?? [];
  return {
    total: body.respbody?.totalReal ?? rows.length,
    items: rows.map(toChainItem),
  };
}

/**
 * 把平台返回的链路行映射为统一结构。
 * @param {object} row 原始行
 * @returns {object} 链路条目
 */
export function toChainItem(row) {
  return {
    serialNo: row.serialNo,
    service: row.serviceName ?? row.project ?? '',
    uri: row.resourceUri ?? row.uri ?? '',
    durationMs: Number(row.duration ?? 0),
    status: String(row.status ?? ''),
    callTime: row.callTime ?? '',
    timestamp: row.timestamp ?? 0,
    message: stripHighlight(row.message ?? ''),
  };
}

/**
 * 去掉平台返回的高亮标签。
 * @param {string} text 原始文本
 * @returns {string} 纯文本
 */
export function stripHighlight(text) {
  return String(text).replace(/<font[^>]*>/g, '').replace(/<\/font>/g, '');
}

/**
 * 聚合服务状态指标。分别统计总量与异常量，再计算错误率。
 * @param {import('./governance-auth.js').GovernanceSession} session 服务治理会话
 * @param {{projectId: number, projectName: string, from: string, to: string, serviceName?: string, uri?: string, limit?: number}} input 查询条件
 * @returns {Promise<{total: number, errorCount: number, errorRate: number, avgDurationMs: number, maxDurationMs: number, topExceptions: Array<{message: string, count: number}>}>} 指标
 */
export async function aggregateServiceStatus(session, input) {
  const base = {
    projectId: input.projectId,
    projectName: input.projectName,
    from: input.from,
    to: input.to,
    serviceName: input.serviceName,
    uri: input.uri,
    limit: input.limit ?? 200,
  };

  const normal = await searchCallChains(session, { ...base, type: 'http' });
  const errors = await searchCallChains(session, { ...base, type: 'exception' });

  const durations = normal.items.map((i) => i.durationMs).filter((d) => d > 0);
  const avg = durations.length > 0 ? durations.reduce((a, b) => a + b, 0) / durations.length : 0;
  const max = durations.length > 0 ? Math.max(...durations) : 0;

  /** @type {Map<string, number>} */
  const counter = new Map();
  for (const item of errors.items) {
    const line = (item.message ?? '').split('\n').find((l) => l.includes('err_no')) ?? item.message ?? '未知异常';
    counter.set(line, (counter.get(line) ?? 0) + 1);
  }
  const topExceptions = [...counter.entries()]
    .map(([message, count]) => ({ message, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);

  const total = normal.total + errors.total;
  return {
    total,
    errorCount: errors.total,
    errorRate: total > 0 ? Number((errors.total / total).toFixed(4)) : 0,
    avgDurationMs: Number(avg.toFixed(2)),
    maxDurationMs: max,
    topExceptions,
  };
}
