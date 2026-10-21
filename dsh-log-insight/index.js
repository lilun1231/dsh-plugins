import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { KibanaSession } from './lib/kibana-auth.js';
import { buildSearchBody, searchLogs } from './lib/kibana-query.js';
import { parseRange, formatGovernanceTime } from './lib/time.js';
import { GovernanceSession } from './lib/governance-auth.js';
import { searchCallChains, aggregateServiceStatus } from './lib/governance-query.js';
import { fetchTraceTree, flattenTree, findBottleneck } from './lib/trace-fetch.js';
import { resolveExportDir, fetchAllLogs, writeLogExport } from './lib/export.js';

export const name = 'log-insight';
export const inject = ['tools', 'connection'];

/**
 * 解析 Client 发来的 RPC 请求体。
 * @param {any} body 请求体
 * @returns {{rpcId: string, method: string, payload: object}|null} 解析结果
 */
function readClientRequest(body) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return null;
  const { type, rpcId, method, payload } = body;
  if (type !== 'client-request') return null;
  if (typeof rpcId !== 'string' || rpcId === '') return null;
  if (typeof method !== 'string' || method === '') return null;
  const carried = payload !== null && typeof payload === 'object' && !Array.isArray(payload) ? payload : {};
  return { rpcId, method, payload: carried };
}

export function apply(ctx, config) {
  const kibanaConfig = config?.kibana ?? {};
  const defaults = config?.defaults ?? {};
  let session = null;

  const govConfig = config?.governance ?? {};
  let govSession = null;

  /** 惰性创建 Kibana 会话。 */
  function getSession() {
    if (!session) session = new KibanaSession(kibanaConfig);
    return session;
  }

  /** 惰性创建服务治理会话。 */
  function getGovSession() {
    if (!govSession) govSession = new GovernanceSession(govConfig);
    return govSession;
  }

  //#region 核心查询能力（工具与面板 RPC 共用）

  /** 解析环境对应的日志命名空间。 */
  function resolveNamespace(envArg) {
    const env = envArg ?? defaults.env ?? 'fat';
    const namespace = kibanaConfig.namespaceByEnv?.[env];
    if (!namespace) throw new Error(`未配置环境 ${env} 的命名空间`);
    return { env, namespace };
  }

  /** 执行日志检索。 */
  async function runLogSearch(args) {
    try {
      const { namespace } = resolveNamespace(args.env);
      const range = parseRange({ from: args.from, to: args.to, windowMinutes: defaults.windowMinutes });
      const body = buildSearchBody({
        namespace,
        keyword: args.keyword,
        services: args.services,
        level: args.level,
        traceId: args.traceId,
        from: range.from,
        to: range.to,
        limit: args.limit ?? 50,
        maxHits: defaults.maxHits ?? 200,
      });
      const result = await searchLogs(getSession(), { index: kibanaConfig.index, body });
      return { ok: true, total: result.total, truncated: result.total > result.hits.length, hits: result.hits };
    } catch (error) {
      return { ok: false, total: 0, truncated: false, hits: [], reason: String(error.message ?? error) };
    }
  }

  /** 拉取单条链路详情。 */
  async function runTraceDetail(args) {
    try {
      const tree = await fetchTraceTree({ hibbertBaseUrl: govConfig.hibbertBaseUrl, serialNo: args.serialNo });
      const spans = flattenTree(tree);
      return { ok: true, serialNo: args.serialNo, spans, bottleneck: findBottleneck(spans) };
    } catch (error) {
      return { ok: false, serialNo: args.serialNo, spans: [], reason: String(error.message ?? error) };
    }
  }

  /** 搜索链路列表。 */
  async function runTraceSearch(args) {
    try {
      const tz = defaults.timezone ?? 'Asia/Shanghai';
      const range = parseRange({ from: args.from, to: args.to, windowMinutes: defaults.windowMinutes });
      const result = await searchCallChains(getGovSession(), {
        projectId: govConfig.projectId,
        projectName: govConfig.projectName,
        from: formatGovernanceTime(range.from, tz),
        to: formatGovernanceTime(range.to, tz),
        type: args.type ?? 'http',
        keyword: args.keyword,
        matchType: args.matchType ?? 1,
        serviceName: args.service,
        uri: args.uri,
        limit: args.limit ?? 20,
      });
      let detail;
      if (args.withDetail && result.items.length > 0) {
        const tree = await fetchTraceTree({ hibbertBaseUrl: govConfig.hibbertBaseUrl, serialNo: result.items[0].serialNo });
        detail = { serialNo: result.items[0].serialNo, spans: flattenTree(tree) };
      }
      return { ok: true, total: result.total, items: result.items, detail };
    } catch (error) {
      return { ok: false, total: 0, items: [], reason: String(error.message ?? error) };
    }
  }

  /** 聚合服务状态。 */
  async function runServiceStatus(args) {
    try {
      const tz = defaults.timezone ?? 'Asia/Shanghai';
      const range = parseRange({ from: args.from, to: args.to, windowMinutes: defaults.windowMinutes });
      const stats = await aggregateServiceStatus(getGovSession(), {
        projectId: govConfig.projectId,
        projectName: govConfig.projectName,
        from: formatGovernanceTime(range.from, tz),
        to: formatGovernanceTime(range.to, tz),
        serviceName: args.service,
        uri: args.uri,
      });
      return { ok: true, ...stats };
    } catch (error) {
      return { ok: false, total: 0, errorCount: 0, errorRate: 0, avgDurationMs: 0, maxDurationMs: 0, topExceptions: [], reason: String(error.message ?? error) };
    }
  }

  /** 导出日志。 */
  async function runLogExport(args) {
    try {
      const { env, namespace } = resolveNamespace(args.env);
      const range = parseRange({ from: args.from, to: args.to, windowMinutes: defaults.windowMinutes });
      const limit = Math.min(args.limit ?? defaults.exportLimit ?? 2000, 10000);
      const hits = await fetchAllLogs(getSession(), {
        index: kibanaConfig.index,
        namespace,
        keyword: args.keyword,
        services: args.services,
        traceId: args.traceId,
        from: range.from,
        to: range.to,
        limit,
      });
      const dir = resolveExportDir(args.outDir ?? defaults.exportDir);
      const written = writeLogExport({
        dir,
        env,
        keyword: args.keyword,
        from: range.from,
        to: range.to,
        hits,
        format: args.format ?? 'csv',
      });
      return { ok: true, path: written.path, exported: written.exported };
    } catch (error) {
      return { ok: false, reason: String(error.message ?? error) };
    }
  }

  /** 导出链路。 */
  async function runTraceExport(args) {
    try {
      const format = args.format ?? 'url';
      const pageUrl = `${govConfig.hibbertBaseUrl}/invokechain.html?serialNo=${encodeURIComponent(args.serialNo)}`;
      if (format === 'url') return { ok: true, url: pageUrl };

      const tree = await fetchTraceTree({ hibbertBaseUrl: govConfig.hibbertBaseUrl, serialNo: args.serialNo });
      const dir = resolveExportDir(args.outDir ?? defaults.exportDir);
      const file = path.join(dir, `${args.serialNo}.${format === 'json' ? 'json' : 'html'}`);
      if (format === 'json') {
        writeFileSync(file, JSON.stringify(tree, null, 2), 'utf8');
        return { ok: true, path: file };
      }
      const spans = flattenTree(tree);
      const rows = spans
        .map((x) => `<div style="padding-left:${x.depth * 20}px">[${x.type}] ${x.service} ${x.uri} — ${x.durationMs}ms</div>`)
        .join('\n');
      const html = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><title>调用链 ${args.serialNo}</title></head><body><h2>${args.serialNo}</h2>${rows}</body></html>`;
      writeFileSync(file, html, 'utf8');
      return { ok: true, path: file };
    } catch (error) {
      return { ok: false, reason: String(error.message ?? error) };
    }
  }

  //#endregion

  ctx.tools.register(defineTool({
    name: 'log_insight_ping',
    description: '健康检查：确认日志洞察插件已加载。返回配置的环境名。',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          env: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `插件已加载，默认环境 ${value.env}` }],
    },
    async execute() {
      return { ok: true, env: defaults.env ?? 'fat' };
    },
  }));

  ctx.tools.register(defineTool({
    name: 'log_search',
    description: '按关键字、服务、级别或流水号检索应用日志。默认查近 30 分钟。返回日志条目，其中 traceId 即流水号，可直接用于 trace_detail。',
    parameters: {
      keyword: { type: 'string', description: '关键字，例如错误码或接口路径' },
      services: { type: 'array', items: { type: 'string' }, description: '限定容器名，可多个' },
      level: { type: 'string', description: '日志级别，如 ERROR、WARN、INFO' },
      traceId: { type: 'string', description: '流水号，给出则按它精确检索' },
      env: { type: 'string', description: '环境，默认 fat' },
      from: { type: 'string', description: '起，ISO 8601 带时区' },
      to: { type: 'string', description: '止，ISO 8601 带时区' },
      limit: { type: 'integer', description: '返回条数，默认 50，上限 200' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          total: { type: 'integer', required: true },
          truncated: { type: 'boolean', required: true },
          hits: { type: 'array', required: true, items: { type: 'json' } },
          reason: { type: 'string' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.ok
          ? `命中 ${value.total} 条${value.truncated ? '（已截断）' : ''}\n${JSON.stringify(value.hits, null, 2)}`
          : `查询失败：${value.reason}`,
      }],
    },
    async execute(args) {
      return runLogSearch(args);
    },
  }));

  ctx.tools.register(defineTool({
    name: 'trace_detail',
    description: '按流水号拉取完整调用链树（免认证）。返回扁平的调用段落、层级、耗时与瓶颈节点。流水号即日志里的 lid，可直接从 log_search 的 traceId 取得。',
    parameters: {
      serialNo: { type: 'string', required: true, description: '链路流水号，如 hall-restful-2887722905-497936-13387' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          serialNo: { type: 'string', required: true },
          spans: { type: 'array', required: true, items: { type: 'json' } },
          bottleneck: { type: 'json' },
          reason: { type: 'string' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.ok
          ? `链路 ${value.serialNo}\n${value.spans.map((x) => `${'  '.repeat(x.depth)}[${x.type}] ${x.service} ${x.uri} ${x.durationMs}ms`).join('\n')}`
          : `查询失败：${value.reason}`,
      }],
    },
    async execute(args) {
      return runTraceDetail(args);
    },
  }));

  ctx.tools.register(defineTool({
    name: 'trace_search',
    description: '按入参、返回值、错误码或服务名搜索调用链列表（需登录）。默认只返回列表；要看详情时把 serialNo 传给 trace_detail，或本次传 withDetail=true。注意：链路入库约有 1-2 分钟延迟，刚发生的请求可能搜不到；若已知流水号，直接用 trace_detail 更可靠。',
    parameters: {
      keyword: { type: 'string', description: '入参、返回值或错误码' },
      matchType: { type: 'integer', description: '1 模糊（默认），2 精确' },
      service: { type: 'string', description: '服务名，如 hall-restful' },
      uri: { type: 'string', description: '接口路径' },
      type: { type: 'string', description: 'http | exception | other，默认 http' },
      from: { type: 'string', description: '起，ISO 8601 带时区' },
      to: { type: 'string', description: '止，ISO 8601 带时区' },
      limit: { type: 'integer', description: '返回条数，默认 20' },
      withDetail: { type: 'boolean', description: '是否对首条结果自动展开链路树' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          total: { type: 'integer', required: true },
          items: { type: 'array', required: true, items: { type: 'json' } },
          detail: { type: 'json' },
          reason: { type: 'string' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: !value.ok
          ? `查询失败：${value.reason}`
          : (value.total > 0
            ? `命中 ${value.total} 条\n${value.items.map((i) => `${i.callTime} ${i.serialNo} ${i.service} ${i.uri} ${i.durationMs}ms`).join('\n')}`
            : '未命中。链路入库约有 1-2 分钟延迟，刚发生的请求可能还没索引；若已知流水号，直接用 trace_detail 更可靠。'),
      }],
    },
    async execute(args) {
      return runTraceSearch(args);
    },
  }));

  ctx.tools.register(defineTool({
    name: 'service_status',
    description: '按时间范围聚合服务状态：调用总量、异常数、错误率、耗时均值与峰值、高频异常。',
    parameters: {
      service: { type: 'string', description: '服务名，如 hall-restful' },
      uri: { type: 'string', description: '接口路径' },
      from: { type: 'string', description: '起，ISO 8601 带时区' },
      to: { type: 'string', description: '止，ISO 8601 带时区' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          total: { type: 'integer', required: true },
          errorCount: { type: 'integer', required: true },
          errorRate: { type: 'number', required: true },
          avgDurationMs: { type: 'number', required: true },
          maxDurationMs: { type: 'number', required: true },
          topExceptions: { type: 'array', required: true, items: { type: 'json' } },
          reason: { type: 'string' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.ok
          ? `总量 ${value.total}，异常 ${value.errorCount}，错误率 ${(value.errorRate * 100).toFixed(2)}%，耗时均值 ${value.avgDurationMs}ms，峰值 ${value.maxDurationMs}ms`
          : `查询失败：${value.reason}`,
      }],
    },
    async execute(args) {
      return runServiceStatus(args);
    },
  }));

  ctx.tools.register(defineTool({
    name: 'log_export',
    description: '按查询条件导出日志到文件。CSV 含关键列，JSONL 保留全部字段。默认最多 2000 条。',
    parameters: {
      keyword: { type: 'string', description: '关键字' },
      services: { type: 'array', items: { type: 'string' }, description: '限定容器' },
      traceId: { type: 'string', description: '流水号' },
      env: { type: 'string', description: '环境，默认 fat' },
      from: { type: 'string', description: '起，ISO 8601 带时区' },
      to: { type: 'string', description: '止，ISO 8601 带时区' },
      limit: { type: 'integer', description: '导出上限，默认 2000' },
      format: { type: 'string', description: 'csv 或 jsonl，默认 csv' },
      outDir: { type: 'string', description: '输出目录，默认系统临时目录' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          path: { type: 'string' },
          exported: { type: 'integer' },
          reason: { type: 'string' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.ok ? `已导出 ${value.exported} 条到 ${value.path}` : `导出失败：${value.reason}`,
      }],
    },
    async execute(args) {
      return runLogExport(args);
    },
  }));

  ctx.tools.register(defineTool({
    name: 'trace_export',
    description: '导出调用链。默认返回平台原生详情页链接，可直接看瀑布图并导出 PDF；也可选 html/json 生成离线快照。',
    parameters: {
      serialNo: { type: 'string', required: true, description: '链路流水号' },
      format: { type: 'string', description: 'url（默认）| html | json' },
      outDir: { type: 'string', description: '输出目录，默认系统临时目录' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          url: { type: 'string' },
          path: { type: 'string' },
          reason: { type: 'string' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.ok
          ? (value.url ? `平台详情页：${value.url}` : `已导出到 ${value.path}`)
          : `导出失败：${value.reason}`,
      }],
    },
    async execute(args) {
      return runTraceExport(args);
    },
  }));

  //#region 面板 RPC：Web UI 通过 connection.rpc 调用同一批核心函数

  /** 面板可调用的端点与处理函数映射。 */
  const ENDPOINTS = Object.freeze({
    search: runLogSearch,
    trace: runTraceDetail,
    traces: runTraceSearch,
    status: runServiceStatus,
    'export-log': runLogExport,
    'export-trace': runTraceExport,
  });

  /**
   * 处理一次面板 RPC 请求。
   * @param {Request} request 请求
   * @param {string} endpoint 端点名
   * @returns {Promise<Response>} 响应
   */
  async function routeEndpoint(request, endpoint) {
    const contentType = request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
    if (contentType !== 'application/json') {
      return new Response('content type must be application/json', { status: 415 });
    }
    let body;
    try {
      body = await request.json();
    } catch {
      return new Response('body is not JSON', { status: 400 });
    }
    const message = readClientRequest(body);
    if (message === null) return new Response('invalid client-request message', { status: 400 });

    let result;
    try {
      result = await ENDPOINTS[endpoint](message.payload);
    } catch (error) {
      result = { ok: false, reason: String(error?.message ?? error) };
    }
    return Response.json({ type: 'server-response', rpcId: message.rpcId, result });
  }

  // 缺少 connection 或 effect 时静默跳过，插件在无 Web 能力的环境下仍只提供工具
  const canRegisterRpc = typeof ctx.effect === 'function'
    && typeof ctx.connection?.fetch?.register === 'function';
  if (canRegisterRpc) {
    for (const endpoint of Object.keys(ENDPOINTS)) {
      ctx.effect(() => ctx.connection.fetch.register({
        path: `/api/log-insight/${endpoint}`,
        methods: ['POST'],
        requestBody: 'buffered',
        fetch: (request) => routeEndpoint(request, endpoint),
      }), `log-insight: ${endpoint} rpc route`);
    }
  }

  //#endregion
}
