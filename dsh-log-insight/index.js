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
import { appendAudit, readAudit, summarizeParams } from './lib/audit.js';
import { searchJava, readSnippet, buildKeywords, pickEndpoint, findClassFile, extractServiceVars } from './lib/code-scan.js';

export const name = 'log-insight';
// llm 用于自然语言问答；tools 提供工具注册，connection 提供 Web RPC
export const inject = ['tools', 'connection', 'llm'];

/**
 * 截断长文本，保留前缀并注明原长度。
 * @param {unknown} text 原始文本
 * @param {number} max 保留的最大字符数
 * @returns {string} 截断后的文本
 */
function truncate(text, max) {
  const value = String(text ?? '');
  return value.length <= max ? value : `${value.slice(0, max)}…（共 ${value.length} 字符）`;
}

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
  const llmConfig = config?.llm ?? {};
  const projects = config?.projects ?? {};
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

  /**
   * 执行一次查询并记录审计，失败也记录。
   * @param {string} source 来源，tool 或 panel
   * @param {string} action 操作名
   * @param {object} payload 原始参数
   * @param {() => Promise<object>} run 实际执行
   * @returns {Promise<object>} 查询结果
   */
  async function audited(source, action, payload, run) {
    const started = Date.now();
    try {
      const result = await run();
      appendAudit({
        source,
        action,
        params: summarizeParams(payload),
        ok: result.ok !== false,
        durationMs: Date.now() - started,
        total: result.total,
        returned: Array.isArray(result.hits) ? result.hits.length : (Array.isArray(result.items) ? result.items.length : undefined),
        error: result.ok === false ? result.reason : undefined,
      });
      return result;
    } catch (error) {
      appendAudit({
        source,
        action,
        params: summarizeParams(payload),
        ok: false,
        durationMs: Date.now() - started,
        error: String(error?.message ?? error),
      });
      throw error;
    }
  }

  //#region 自然语言问答

  /** 意图解析提示词。 */
  const PLANNER_PROMPT = [
    '你是日志查询助手。把用户的问题转换成 JSON 查询计划，只输出 JSON，不要任何解释。',
    '',
    '可用动作与参数：',
    '1. log_search — 查日志',
    '   keywords: 字符串数组，多个词之间是「且」关系',
    '   excludeKeywords: 字符串数组，排除包含这些词的日志',
    '   services: 容器名数组，例如 hall-restful',
    '   level: ERROR / WARN / INFO',
    '   traceId: 流水号',
    '   minutes: 时间范围（分钟），默认 30',
    '   limit: 返回条数，默认 20',
    '2. trace_search — 查调用链列表',
    '   uri: 接口路径，例如 /hall/indexinfo/query',
    '   keyword: 匹配入参、返回值或错误码',
    '   service: 服务名',
    '   type: http（正常调用）或 exception（异常调用）',
    '   minutes: 时间范围（分钟）',
    '   limit: 条数',
    '3. trace_detail — 查单条链路详情',
    '   serialNo: 流水号',
    '4. service_status — 查服务健康指标',
    '   service: 服务名',
    '   minutes: 时间范围（分钟）',
    '',
    '示例：',
    '问题：最近半小时 hall-restful 有没有报错',
    '输出：{"action":"log_search","args":{"services":["hall-restful"],"level":"ERROR","minutes":30}}',
    '',
    '问题：看看 /hall/indexinfo/query 接口最近有没有异常调用',
    '输出：{"action":"trace_search","args":{"uri":"/hall/indexinfo/query","type":"exception","minutes":30}}',
  ].join('\n');

  /** 结果解读提示词。 */
  const ANSWER_PROMPT = [
    '你是资深的 Java 后端与 SRE 工程师。根据日志或调用链的查询结果回答用户问题。',
    '',
    '要求：',
    '- 用中文，先给结论，再补充依据',
    '- 有报错时指出错误码与异常关键字，推测可能原因',
    '- 链路场景指出瓶颈服务及其耗时占比',
    '- 不要罗列原始 JSON，也不要复述全部日志',
    '- 结果为空或信息不足时，说明还需要补充什么条件',
  ].join('\n');

  /**
   * 调用一次模型，返回纯文本。
   * @param {string} system 系统提示
   * @param {string} user 用户内容
   * @returns {Promise<string>} 模型输出
   */
  async function callModel(system, user) {
    const llm = ctx.llm;
    if (llm === undefined || typeof llm?.stream !== 'function') {
      throw new Error('当前会话未启用模型服务，无法使用自然语言问答');
    }
    const route = await resolveLlmRoute(llm);
    let text = '';
    for await (const chunk of llm.stream({
      provider: route.provider,
      model: route.model,
      messages: [
        { role: 'system', content: [{ type: 'text', text: system }] },
        { role: 'user', content: [{ type: 'text', text: user }] },
      ],
    })) {
      if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') {
        text += chunk.text;
      }
    }
    return text.trim();
  }

  /**
   * 选择模型路由：配置优先，否则取第一个提供方的第一个模型。
   * @param {object} llm 模型服务
   * @returns {Promise<{provider: string, model: string}>} 路由
   */
  async function resolveLlmRoute(llm) {
    if (llmConfig.provider && llmConfig.model) {
      return { provider: llmConfig.provider, model: llmConfig.model };
    }
    const providers = typeof llm.listProviders === 'function' ? llm.listProviders() : [];
    for (const row of providers) {
      if (typeof row?.id !== 'string') continue;
      const models = typeof llm.listModels === 'function' ? await llm.listModels(row.id) : [];
      const first = Array.isArray(models) ? models[0] : undefined;
      if (typeof first?.id === 'string') {
        return { provider: row.id, model: first.id };
      }
    }
    throw new Error('未找到可用模型，请在插件配置里指定 llm.provider 与 llm.model');
  }

  /**
   * 把模型输出解析成查询计划。
   * @param {string} text 模型输出
   * @returns {{action: string, args: object}} 查询计划
   */
  function parsePlan(text) {
    const match = String(text).match(/\{[\s\S]*\}/);
    if (match === null) {
      throw new Error('模型没有返回查询计划，请换一种问法');
    }
    let value;
    try {
      value = JSON.parse(match[0]);
    } catch {
      throw new Error('模型返回的查询计划不是合法 JSON');
    }
    const action = String(value.action ?? '');
    const allowed = ['log_search', 'trace_search', 'trace_detail', 'service_status'];
    if (!allowed.includes(action)) {
      throw new Error(`不支持的查询动作：${action || '空'}`);
    }
    const args = value.args !== null && typeof value.args === 'object' ? value.args : {};
    return { action, args };
  }

  /**
   * 执行查询计划。
   * @param {{action: string, args: object}} plan 计划
   * @param {string} env 环境
   * @returns {Promise<object>} 查询结果
   */
  async function executePlan(plan, env) {
    const minutes = Number(plan.args.minutes ?? plan.args.windowMinutes ?? defaults.windowMinutes);
    const args = { ...plan.args, env: plan.args.env ?? env, windowMinutes: minutes };
    switch (plan.action) {
      case 'log_search':
        return runLogSearch({ ...args, limit: Math.min(Number(args.limit ?? 20), defaults.maxHits ?? 200) });
      case 'trace_search':
        return runTraceSearch(args);
      case 'trace_detail':
        return runTraceDetail(args);
      case 'service_status':
        return runServiceStatus(args);
      default:
        throw new Error(`不支持的查询动作：${plan.action}`);
    }
  }

  /**
   * 把查询结果压成给模型阅读的摘要。
   * @param {object} plan 查询计划
   * @param {object} result 查询结果
   * @returns {string} 摘要文本
   */
  function summarizeForModel(plan, result) {
    if (result?.ok === false) return `查询失败：${result.reason ?? '未知原因'}`;
    if (plan.action === 'log_search') {
      const lines = (result.hits ?? []).slice(0, 20)
        .map((hit, i) => `${i + 1}. [${hit.timestamp}] ${hit.service} ${hit.level}: ${truncate(hit.message, 300)}`);
      return `共 ${result.total} 条，展示 ${lines.length} 条：\n${lines.join('\n') || '（无数据）'}`;
    }
    if (plan.action === 'trace_search') {
      const lines = (result.items ?? []).slice(0, 20)
        .map((x, i) => `${i + 1}. ${x.callTime ?? ''} ${x.service ?? ''} ${x.uri ?? ''} ${x.durationMs ?? 0}ms ${x.serialNo ?? ''}`);
      return `共 ${result.total} 条，展示 ${lines.length} 条：\n${lines.join('\n') || '（无数据）'}`;
    }
    if (plan.action === 'trace_detail') {
      const spans = (result.spans ?? []).slice(0, 40)
        .map((s) => `${'  '.repeat(s.depth ?? 0)}${s.type} ${s.service ?? ''} ${s.uri ?? ''} ${s.durationMs ?? 0}ms${s.error ? ` 错误:${s.error}` : ''}`);
      const bottleneck = result.bottleneck;
      const hotspot = bottleneck === undefined || bottleneck === null
        ? '未识别到瓶颈'
        : `${bottleneck.span?.service ?? '—'} ${bottleneck.span?.uri ?? ''} 耗时 ${bottleneck.durationMs}ms（占 ${Math.round((bottleneck.share ?? 0) * 100)}%）`;
      return `流水号 ${result.serialNo ?? ''}，段落 ${result.spans?.length ?? 0} 个，瓶颈：${hotspot}\n${spans.join('\n')}`;
    }
    return JSON.stringify(result).slice(0, 3000);
  }

  /**
   * 自然语言问答：解析意图 → 执行查询 → 生成解读。
   * @param {object} payload 请求参数
   * @returns {Promise<object>} 问答结果
   */
  async function runAsk(payload) {
    const question = String(payload?.question ?? '').trim();
    if (question === '') return { ok: false, reason: '请输入问题' };
    try {
      const plan = parsePlan(await callModel(PLANNER_PROMPT, question));
      const result = await executePlan(plan, payload?.env);
      const answer = await callModel(ANSWER_PROMPT, `用户问题：${question}\n\n查询结果：\n${summarizeForModel(plan, result)}`);
      return { ok: true, question, plan, answer, result };
    } catch (error) {
      return { ok: false, reason: String(error?.message ?? error) };
    }
  }

  //#endregion

  //#region 接口分析

  /** 接口分析提示词。 */
  const ANALYZE_PROMPT = [
    '你是 Java 后端架构师。根据给定代码分析接口的执行逻辑，画成 Mermaid 时序图。',
    '',
    '只输出 JSON，不要解释，格式：',
    '{',
    '  "title": "接口用途，一句话",',
    '  "summary": "两三句话说明业务逻辑",',
    '  "mermaid": "sequenceDiagram\\n    autonumber\\n    participant App as 优理宝App\\n    participant CTRL as XxxController\\n    App->>CTRL: GET /homepage/info/qry 带 stockcode\\n    CTRL->>SVC: qryColumnList(param)\\n    SVC-->>CTRL: 列表\\n    CTRL-->>App: RespBodyInfo",',
    '  "endpoints": [',
    '    {"label":"GET /homepage/info/qry","uri":"/homepage/info/qry","kind":"http"},',
    '    {"label":"TC 141.189 个股异动解读","uri":"141.189","kind":"middle"}',
    '  ]',
    '}',
    '',
    'Mermaid 要求：',
    '- 首行 sequenceDiagram，第二行 autonumber',
    '- 用 participant 别名 as 中文说明；参与者要覆盖代码里出现的全部服务、外部系统与中台',
    '- 调用用 ->>，返回用 -->>，并行调用用 par / and / end',
    '- 关键判断、参数透传、字段变更、组装逻辑用 Note over 说明',
    '- 中台调用（如 TC 141.189）单独作为 participant，并在 endpoints 里给出编码',
    '- 消息文案里写清参数名、条件或字段，越具体越好',
    '',
    'endpoints 要求：',
    '- 列出所有可查询日志的接口：HTTP 接口给完整路径（含类级前缀），中台接口给编码',
    '- label 必须与 mermaid 里出现的文案保持一致，便于前端高亮',
    '',
    '规则：只写代码里有依据的调用，不要编造；不确定的地方用 Note 标注「需结合实现确认」。',
  ].join('\\n');

  /**
   * 从代码片段里提取被注入的 Service 接口名。
   * @param {string} snippet 代码片段
   * @returns {string[]} 接口名列表
   */
  function extractServiceNames(snippet) {
    const names = new Set();
    const pattern = /\bI[A-Z][A-Za-z0-9]*Service\b/g;
    let matched;
    while ((matched = pattern.exec(snippet)) !== null) {
      names.add(matched[0]);
      if (names.size >= 4) break;
    }
    return [...names];
  }

  /**
   * 收集接口分析所需的代码上下文：Controller 片段加一层 Service 实现。
   * @param {string} repoPath 仓库根目录
   * @param {string} uri 接口路径
   * @returns {{endpoint: object | null, context: string}} 定位结果与上下文
   */
  function collectContext(repoPath, uri, maxFiles = 8) {
    for (const keyword of buildKeywords(uri)) {
      const picked = pickEndpoint(searchJava(repoPath, keyword));
      if (picked === null) continue;

      const parts = [];
      const seen = new Set();
      const push = (file, snippet, label) => {
        if (seen.has(file) || parts.length >= maxFiles) return false;
        seen.add(file);
        parts.push(`### ${label}：${file.replace(repoPath, '')}\n${snippet}`);
        return true;
      };

      // 第 0 层：Controller 入口方法
      const entry = readSnippet(picked.file, picked.line, 8, 110);
      push(picked.file, entry.snippet, 'Controller 入口');

      // 逐层向下追踪：按被调用的服务变量名定位实现类
      let frontier = extractServiceVars(entry.snippet);
      for (let depth = 0; depth < 3 && frontier.length > 0 && parts.length < maxFiles; depth++) {
        const next = [];
        for (const name of frontier) {
          const file = findClassFile(repoPath, name);
          if (file === null || seen.has(file)) continue;
          const snippet = readSnippet(file, 1, 0, 110);
          if (!push(file, snippet.snippet, `第 ${depth + 1} 层`)) continue;
          next.push(...extractServiceVars(snippet.snippet));
        }
        frontier = next;
      }

      return { endpoint: picked, context: parts.join('\n\n') };
    }
    return { endpoint: null, context: '' };
  }

  /**
   * 解析模型返回的时序分析。
   * @param {string} text 模型输出
   * @returns {{title: string, summary: string, steps: Array<object>}} 分析结果
   */
  function parseAnalysis(text) {
    const matched = String(text).match(/\{[\s\S]*\}/);
    if (matched === null) throw new Error('模型没有返回时序分析');
    let value;
    try {
      value = JSON.parse(matched[0]);
    } catch {
      throw new Error('时序分析不是合法 JSON');
    }
    const endpoints = Array.isArray(value.endpoints) ? value.endpoints.map((item) => ({
      label: String(item?.label ?? ''),
      uri: String(item?.uri ?? ''),
      kind: String(item?.kind ?? 'http'),
    })).filter((item) => item.uri !== '') : [];
    return {
      title: String(value.title ?? ''),
      summary: String(value.summary ?? ''),
      mermaid: typeof value.mermaid === 'string' ? value.mermaid : '',
      endpoints,
    };
  }

  /**
   * 接口分析：定位代码后交由模型生成时序步骤。
   * @param {object} payload 请求参数，含 project 与 uri
   * @returns {Promise<object>} 分析结果
   */
  async function runAnalyze(payload) {
    const project = String(payload?.project ?? '');
    const uri = String(payload?.uri ?? '').trim();
    if (uri === '') return { ok: false, reason: '请输入接口地址' };
    const repoPath = projects[project];
    if (typeof repoPath !== 'string' || repoPath === '') {
      return { ok: false, reason: `未配置项目路径：${project}` };
    }
    try {
      const { endpoint, context } = collectContext(repoPath, uri);
      if (endpoint === null) {
        return { ok: false, reason: `在 ${project} 里没有找到接口 ${uri}，请检查项目或路径` };
      }
      const prompt = [`项目：${project}`, `接口：${uri}`, '', '代码如下：', context.slice(0, 26000)].join('\n');
      const analysis = parseAnalysis(await callModel(ANALYZE_PROMPT, prompt));
      return {
        ok: true,
        project,
        uri,
        title: analysis.title,
        summary: analysis.summary,
        mermaid: analysis.mermaid,
        endpoints: analysis.endpoints,
        source: { file: endpoint.file.replace(repoPath, ''), line: endpoint.line },
      };
    } catch (error) {
      return { ok: false, reason: String(error?.message ?? error) };
    }
  }

  //#endregion

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
        keywords: args.keywords,
        excludeKeywords: args.excludeKeywords,
        services: args.services,
        level: args.level,
        traceId: args.traceId,
        from: range.from,
        to: range.to,
        limit: args.limit ?? 20,
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
      keyword: { type: 'string', description: '单个关键字，例如错误码或接口路径' },
      keywords: { type: 'array', items: { type: 'string' }, description: '多个关键字，之间是且（AND）关系' },
      excludeKeywords: { type: 'array', items: { type: 'string' }, description: '排除包含这些关键字的日志' },
      services: { type: 'array', items: { type: 'string' }, description: '限定容器名，可多个' },
      level: { type: 'string', description: '日志级别，如 ERROR、WARN、INFO' },
      traceId: { type: 'string', description: '流水号，给出则按它精确检索' },
      env: { type: 'string', description: '环境，默认 fat' },
      from: { type: 'string', description: '起，ISO 8601 带时区' },
      to: { type: 'string', description: '止，ISO 8601 带时区' },
      limit: { type: 'integer', description: '返回条数，默认 20，上限 200。条数越多占用上下文越多' },
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
        text: !value.ok
          ? `查询失败：${value.reason}`
          : (value.hits.length === 0
            ? '没有命中记录'
            : `命中 ${value.total} 条${value.truncated ? '（返回前若干条）' : ''}\n`
              + value.hits.map((hit) => {
                const time = String(hit.timestamp ?? '').slice(0, 19).replace('T', ' ');
                const trace = hit.traceId === undefined || hit.traceId === '' ? '' : ` ${hit.traceId}`;
                return `${time} [${hit.service || '-'}]${trace} ${String(hit.message ?? '').slice(0, 120)}`;
              }).join('\n')),
      }],
    },
    async execute(args) {
      const result = await audited('tool', 'log_search', args, () => runLogSearch(args));
      // 模型侧只保留摘要，完整日志留给面板展开与导出
      return {
        ...result,
        hits: result.hits.map((hit) => ({ ...hit, message: truncate(hit.message, 400) })),
      };
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
      return audited('tool', 'trace_detail', args, () => runTraceDetail(args));
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
      return audited('tool', 'trace_search', args, () => runTraceSearch(args));
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
      return audited('tool', 'service_status', args, () => runServiceStatus(args));
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
      return audited('tool', 'log_export', args, () => runLogExport(args));
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
      return audited('tool', 'trace_export', args, () => runTraceExport(args));
    },
  }));

  //#region 面板 RPC：Web UI 通过 connection.rpc 调用同一批核心函数

  /** 面板可调用的端点与处理函数映射。 */
  const ENDPOINTS = Object.freeze({
    ask: runAsk,
    analyze: runAnalyze,
    ping: async () => ({
      ok: true,
      env: defaults.env ?? 'fat',
      kibana: kibanaConfig.baseUrl ?? '',
      governance: govConfig.baseUrl ?? '',
      hibbert: govConfig.hibbertBaseUrl ?? '',
    }),
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

    // DSH RPC 契约：成功为 { ok: true, value }，失败为 { ok: false, error }
    let result;
    try {
      const value = endpoint === 'audit'
        ? { ok: true, items: readAudit(Number(message.payload?.limit ?? 100)) }
        : await audited('panel', endpoint, message.payload, () => ENDPOINTS[endpoint](message.payload));
      result = value.ok === false
        ? { ok: false, error: { code: 'query-failed', message: String(value.reason ?? '查询失败') } }
        : { ok: true, value };
    } catch (error) {
      result = { ok: false, error: { code: 'endpoint-failed', message: String(error?.message ?? error) } };
    }
    return Response.json({ type: 'server-response', rpcId: message.rpcId, result });
  }

  // audit 端点只读文件，不进 ENDPOINTS，避免记录「查看审计」本身
  const ROUTES = [...Object.keys(ENDPOINTS), 'audit'];

  // 缺少 connection 或 effect 时静默跳过，插件在无 Web 能力的环境下仍只提供工具
  const canRegisterRpc = typeof ctx.effect === 'function'
    && typeof ctx.connection?.fetch?.register === 'function';
  if (canRegisterRpc) {
    for (const endpoint of ROUTES) {
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
