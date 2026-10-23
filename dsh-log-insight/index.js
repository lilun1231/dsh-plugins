import { writeFileSync } from 'node:fs';
import { clearAnalysisCache, findCachedAnalysis, readAnalysisCache, saveAnalysis, touchCachedAnalysis } from './lib/analysis-cache.js';
import { clearAskHistory, readAskHistory, saveAsk } from './lib/ask-history.js';
import { randomUUID } from 'node:crypto';
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
import { searchJava, searchJavaMany, readSnippet, buildKeywords, pickEndpoint, findClassFile, extractServiceVars, extractLisaNames, shortServiceName } from './lib/code-scan.js';

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
  const analyzeSessionId = typeof config?.analyzeSessionId === 'string' ? config.analyzeSessionId : '';
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

  /** 字段名到中文标签，用于图表标题。 */
  const CHART_FIELD_LABELS = {
    level: '级别', service: '服务', status: '状态', method: '方法', uri: '接口',
    count: '数量', total: '总数', type: '类型', error: '错误', env: '环境',
    durationMs: '耗时', costMs: '耗时', elapsed: '耗时', timestamp: '时间', callTime: '时间',
  };

  /**
   * 分析一组记录的字段类型，判断哪些能画图。
   * @param {Array<object>} rows 记录
   * @returns {{categorical: Array<object>, numeric: string[], time: string[]}} 字段分类
   */
  function analyzeRowFields(rows) {
    const keys = new Set();
    for (const row of rows) {
      if (row === null || typeof row !== 'object') continue;
      for (const key of Object.keys(row)) keys.add(key);
    }
    const categorical = [];
    const numeric = [];
    const time = [];
    const need = Math.max(2, Math.ceil(rows.length * 0.3));

    for (const key of keys) {
      const values = rows
        .map((row) => (row === null || typeof row !== 'object' ? undefined : row[key]))
        .filter((value) => value !== undefined && value !== null && value !== '');
      if (values.length < need) continue;

      const sample = values[0];
      if (typeof sample === 'number' && Number.isFinite(sample)) {
        numeric.push(key);
        continue;
      }
      if (typeof sample !== 'string') continue;
      if (/time|timestamp|date/i.test(key)) {
        time.push(key);
        continue;
      }
      // 低基数（2~12 种）且确实有重复的字符串字段，才适合做分类统计
      const unique = new Set(values.map((value) => String(value)));
      if (unique.size >= 2 && unique.size <= 12 && unique.size < values.length) {
        categorical.push({ key, unique: unique.size });
      }
    }
    return { categorical, numeric, time };
  }

  /**
   * 从查询结果里自动识别可画图的数据，并给出对应图表。
   *
   * 不依赖具体查询动作，只看数据结构：
   *   - 低基数分类字段（级别/服务/状态）→ 分类分布柱状图
   *   - 数值字段（耗时/数量）→ 排行榜柱状图
   *   - 时间字段 + 数值字段 → 按分钟聚合的趋势折线图
   *
   * @param {object} result 查询结果
   * @returns {Array<object>} 图表列表，最多 3 张
   */
  function buildCharts(result) {
    if (result === null || typeof result !== 'object' || result.ok === false) return [];

    // 找出结果里的记录数组
    const collections = [];
    for (const [key, value] of Object.entries(result)) {
      if (!Array.isArray(value) || value.length < 2) continue;
      const rows = value.filter((row) => row !== null && typeof row === 'object');
      if (rows.length >= 2) collections.push({ key, rows });
    }

    const charts = [];
    const labelOf = (key) => CHART_FIELD_LABELS[key] ?? key;
    const pickName = (row) => {
      for (const field of ['service', 'uri', 'name', 'label', 'serialNo']) {
        const value = row?.[field];
        if (typeof value === 'string' && value !== '') return value.slice(0, 26);
      }
      return '—';
    };

    for (const { rows } of collections) {
      const fields = analyzeRowFields(rows);

      // 1) 分类分布：最容易看懂的，优先出
      for (const field of fields.categorical.slice(0, 2)) {
        const counts = new Map();
        for (const row of rows) {
          const value = String(row?.[field.key] ?? '').trim();
          if (value === '') continue;
          counts.set(value, (counts.get(value) ?? 0) + 1);
        }
        const items = [...counts.entries()]
          .sort((left, right) => right[1] - left[1])
          .slice(0, 8)
          .map(([label, value]) => ({ label, value }));
        if (items.length >= 2) {
          charts.push({ kind: 'bar', title: `按${labelOf(field.key)}分布`, unit: '条', items });
        }
      }

      // 2) 数值排行：谁是最大的
      for (const numKey of fields.numeric.slice(0, 1)) {
        const items = rows
          .filter((row) => typeof row?.[numKey] === 'number' && Number.isFinite(row[numKey]))
          .sort((left, right) => right[numKey] - left[numKey])
          .slice(0, 8)
          .map((row) => ({ label: pickName(row), value: Math.round(row[numKey]) }));
        if (items.length >= 2) {
          const isMs = /duration|cost|elapsed|ms/i.test(numKey);
          charts.push({ kind: 'bar', title: `${labelOf(numKey)}排行`, unit: isMs ? 'ms' : '', items });
        }
      }

      // 3) 时间趋势：按分钟分桶
      if (fields.time.length > 0) {
        const buckets = new Map();
        for (const row of rows) {
          const raw = row?.[fields.time[0]];
          const at = Date.parse(String(raw ?? ''));
          if (Number.isNaN(at)) continue;
          const minute = Math.floor(at / 60000) * 60000;
          buckets.set(minute, (buckets.get(minute) ?? 0) + 1);
        }
        if (buckets.size >= 3) {
          const items = [...buckets.entries()]
            .sort((left, right) => left[0] - right[0])
            .slice(-24)
            .map(([minute, value]) => {
              const date = new Date(minute);
              const hh = String(date.getHours()).padStart(2, '0');
              const mm = String(date.getMinutes()).padStart(2, '0');
              return { label: `${hh}:${mm}`, value };
            });
          charts.push({ kind: 'line', title: '按分钟趋势', unit: '条', items });
        }
      }
    }

    return charts.slice(0, 3);
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
      const charts = buildCharts(result);
      saveAsk({ question, answer, plan, result, charts });
      return { ok: true, question, plan, answer, result, charts };
    } catch (error) {
      return { ok: false, reason: String(error?.message ?? error) };
    }
  }

  /**
   * 分阶段问答：面板逐步调用，每一步都能显示明确状态。
   *
   * stage=plan    把问题解析成执行计划
   * stage=exec    按计划执行查询
   * stage=explain 基于查询结果生成解读与图表
   *
   * 拆开的好处是每一步失败都能指出卡在哪，而不是让用户对着一个转圈等 90 秒。
   *
   * @param {object} payload 阶段、问题与上一步产物
   * @returns {Promise<object>} 该阶段结果
   */
  async function runAskStep(payload) {
    const stage = String(payload?.stage ?? '');
    const question = String(payload?.question ?? '').trim();
    if (question === '') return { ok: false, reason: '请输入问题' };

    if (stage === 'plan') {
      try {
        const plan = parsePlan(await callModel(PLANNER_PROMPT, question));
        return { ok: true, stage, plan };
      } catch (error) {
        return { ok: false, reason: `理解问题失败：${String(error?.message ?? error)}` };
      }
    }

    if (stage === 'exec') {
      const plan = payload?.plan;
      if (plan === null || typeof plan !== 'object') return { ok: false, reason: '缺少执行计划，请先完成上一步' };
      try {
        const result = await executePlan(plan, payload?.env);
        const failed = result !== null && typeof result === 'object' && result.ok === false;
        return {
          ok: true,
          stage,
          plan,
          result,
          total: result?.total ?? (Array.isArray(result?.hits) ? result.hits.length : 0),
          failed,
          reason: failed ? String(result.reason ?? '') : '',
        };
      } catch (error) {
        return { ok: false, reason: `查询失败：${String(error?.message ?? error)}` };
      }
    }

    if (stage === 'explain') {
      const plan = payload?.plan;
      const result = payload?.result;
      if (plan === null || typeof plan !== 'object') return { ok: false, reason: '缺少执行计划，请先完成上一步' };
      try {
        const answer = await callModel(ANSWER_PROMPT, `用户问题：${question}\n\n查询结果：\n${summarizeForModel(plan, result)}`);
        const charts = buildCharts(result);
        saveAsk({ question, answer, plan, result, charts });
        return { ok: true, stage, question, plan, answer, result, charts };
      } catch (error) {
        return { ok: false, reason: `生成解读失败：${String(error?.message ?? error)}` };
      }
    }

    return { ok: false, reason: `未知阶段：${stage}` };
  }

  /**
   * 列出问答历史，只返回列表需要的字段，不携带完整结果。
   * @returns {Promise<object>} 历史列表
   */
  async function runAskHistory() {
    const items = readAskHistory().map((item) => ({
      question: String(item.question ?? ''),
      answer: String(item.answer ?? ''),
      action: String(item?.plan?.action ?? ''),
      createdAt: String(item.createdAt ?? ''),
      chartCount: Array.isArray(item.charts) ? item.charts.length : 0,
      hitCount: Number(item?.result?.total ?? 0),
    }));
    return { ok: true, items };
  }

  /**
   * 读取一条完整的历史记录（含结果与图表）。
   * @param {object} payload 含 question
   * @returns {Promise<object>} 历史条目
   */
  async function runAskLoad(payload) {
    const question = String(payload?.question ?? '').trim();
    const found = readAskHistory().find((item) => item.question === question);
    if (found === undefined) return { ok: false, reason: '这条历史已经不在了，可能已被新记录挤出' };
    return {
      ok: true,
      question: found.question,
      answer: found.answer ?? '',
      plan: found.plan ?? null,
      result: found.result ?? null,
      charts: Array.isArray(found.charts) ? found.charts : [],
    };
  }

  /**
   * 清空问答历史。
   * @returns {Promise<object>} 结果
   */
  async function runAskClear() {
    return clearAskHistory() ? { ok: true } : { ok: false, reason: '清空失败，请检查文件权限' };
  }

  //#endregion

  /**
   * 清理文本里的孤立代理对，避免 JSON 序列化产出非法字符串。
   * @param {unknown} value 原始值
   * @returns {string} 安全字符串
   */
  function cleanText(value) {
    const text = typeof value === 'string' ? value : String(value ?? '');
    return text.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '');
  }

  //#region 会话派发

  /**
   * 取会话当前事件列表。
   * @param {object} session 会话对象
   * @returns {Array<object>} 事件数组
   */
  function eventsOf(session) {
    if (session === null || session === undefined) return [];
    if (Array.isArray(session.events)) return session.events;
    if (typeof session.snapshotEvents === 'function') {
      const value = session.snapshotEvents();
      return Array.isArray(value) ? value : [];
    }
    return [];
  }

  /**
   * 把一段任务发给指定会话，等它产出 assistant 文本后返回。
   * @param {string} sessionId 目标会话 id
   * @param {string} task 任务文本
   * @param {number} timeoutMs 等待上限
   * @returns {Promise<string>} 会话最终文本
   */
  async function askSession(sessionId, task, timeoutMs = 200000) {
    let agents;
    try {
      agents = typeof ctx?.get === 'function' ? ctx.get('agents') : ctx?.agents;
    } catch {
      agents = undefined;
    }
    if (agents === undefined || agents === null || typeof agents.get !== 'function') {
      throw new Error('当前环境不支持会话派发（缺少 agents 服务）');
    }
    const agent = agents.get(sessionId);
    if (agent === null || agent === undefined) {
      throw new Error(`会话 ${sessionId} 不在线，请先在 DSH 里打开它`);
    }

    const before = eventsOf(agent.session).reduce((max, event) => (typeof event?.seq === 'number' && event.seq > max ? event.seq : max), 0);
    agent.followup({
      id: randomUUID(),
      role: 'user',
      content: [{ type: 'text', text: task }],
      source: { kind: 'user' },
    });

    const deadline = Date.now() + timeoutMs;
    const chunks = [];
    let cursor = before;
    let ended = false;
    while (Date.now() < deadline) {
      for (const event of eventsOf(agent.session)) {
        if (typeof event?.seq !== 'number' || event.seq <= cursor) continue;
        if (event.seq > before) cursor = Math.max(cursor, event.seq);
        if (event.type === 'assistant/message') {
          const blocks = event.data?.message?.content;
          if (Array.isArray(blocks)) {
            const joined = blocks
              .filter((block) => block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string')
              .map((block) => block.text)
              .join('');
            if (joined.trim() !== '') chunks.push(joined);
          }
        }
        if (event.type === 'turn/end') ended = true;
      }
      if (ended && chunks.length > 0) break;
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
    const text = chunks.join('\n');
    if (text === '') throw new Error('会话没有返回内容（可能仍在分析，请到该会话查看）');
    return text;
  }

  /**
   * 组织交给会话的分析任务说明。
   * @param {string} project 项目名
   * @param {string} repoPath 仓库路径
   * @param {string} uri 接口路径
   * @returns {string} 任务文本
   */
  function buildSessionTask(project, repoPath, uri) {
    return [
      `请分析这个接口的完整执行链路：${uri}`,
      `项目：${project}；代码仓库：${repoPath}`,
      '',
      '要求：',
      '1. 从 Controller 入口开始逐层向下追，不要只看一层：Controller → Service 实现 → 配置类（@Bean + @LisaService 生成的服务）→ 中台调用（setFuncNo 的功能号）。',
      '2. 每条调用写明方法名、参数或条件，关键判断与组装逻辑用 Note 说明，并行调用用 par/and 表示。',
      '3. 在回复最后输出一个 JSON 代码块（用三个反引号包住，标注 json），结构：',
      '{"title":"一句话用途","summary":"两三句业务逻辑","steps":[{"from":"客户端","to":"NewShareController","action":"GET /rest/xxx","kind":"http","uri":"/rest/xxx","note":"接口入口","group":""}],"endpoints":[{"label":"GET /rest/xxx","uri":"/rest/xxx","kind":"http"}]}',
      '4. endpoints 列出所有可查日志的入口：HTTP 接口给完整路径，中台调用给功能号（kind 用 middle）。',
      '5. kind 取值：http / service / middle（中台）/ dao / return / note；group 用于并行或同组步骤。',
      '6. uri 只给可查日志的接口，action 文案要与 endpoints 的 label 保持一致。',
      '6. 只写代码里有依据的调用，不确定的用 Note 标注。',
    ].join('\n');
  }

  /**
   * 从会话回复里提取 JSON 结果。
   * @param {string} text 会话文本
   * @returns {object} 解析结果
   */
  function parseSessionReply(text) {
    const source = String(text);
    const candidates = [];
    for (const match of source.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)) candidates.push(match[1]);
    candidates.push(source);

    // 依次尝试每个代码块；块内从后往前找 JSON 起点，兼容回复里混有多段 JSON
    let value = null;
    for (const raw of candidates) {
      const starts = [];
      for (let index = 0; index < raw.length; index += 1) {
        if (raw[index] === '{') starts.push(index);
      }
      for (let start = starts.length - 1; start >= 0 && value === null; start -= 1) {
        const tail = raw.slice(starts[start]);
        for (let end = tail.length; end > 1; end -= 1) {
          if (tail[end - 1] !== '}') continue;
          try {
            const parsed = JSON.parse(tail.slice(0, end));
            if (Array.isArray(parsed?.steps)) {
              value = parsed;
              break;
            }
          } catch {
            // 这个结尾不是合法 JSON，继续缩小
          }
        }
      }
      if (value !== null) break;
    }
    if (value === null) throw new Error('会话没有返回可解析的结果');
    const endpoints = Array.isArray(value.endpoints)
      ? value.endpoints
        .map((item) => ({ label: cleanText(item?.label), uri: cleanText(item?.uri), kind: cleanText(item?.kind) || 'http' }))
        .filter((item) => item.uri !== '')
      : [];
    const steps = Array.isArray(value.steps) ? value.steps.map((step, index) => ({
      seq: index + 1,
      from: cleanText(step?.from),
      to: cleanText(step?.to),
      action: cleanText(step?.action),
      kind: cleanText(step?.kind) || 'service',
      uri: cleanText(step?.uri),
      note: cleanText(step?.note),
      group: cleanText(step?.group),
    })) : [];
    return {
      title: cleanText(value.title),
      summary: cleanText(value.summary),
      steps,
      endpoints,
    };
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
    '  "steps": [',
    '    {"from":"客户端","to":"XxxController","action":"GET /homepage/info/qry","kind":"http","uri":"/homepage/info/qry","note":"接口入口","group":""},',
    '    {"from":"XxxController","to":"IHomepageService","action":"qryColumnList(param)","kind":"service","uri":"","note":"Lisa RPC","group":""},',
    '    {"from":"HomepageServiceImpl","to":"中台 TC 141.87","action":"setFuncNo(CBD_XXX)","kind":"middle","uri":"CBD_XXX","note":"中台功能号","group":""},',
    '    {"from":"XxxController","to":"客户端","action":"RespBodyInfo","kind":"return","uri":"","note":"","group":""}',
    '  ],',
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
    '- label 必须与 steps 里 action 的文案保持一致，便于前端高亮；uri 只填可查日志的接口，其余留空',
    '- kind 取值：http / service / middle / dao / return / note；group 用于标记并行或同组步骤',
    '',
    '规则：只写代码里有依据的调用，不要编造；不确定的地方用 Note 标注「需结合实现确认」。',
  ].join('\\n');

  /**
   * 收集接口分析所需的代码上下文：Controller 片段加一层 Service 实现。
   * @param {string} repoPath 仓库根目录
   * @param {string} uri 接口路径
   * @returns {{endpoint: object | null, context: string}} 定位结果与上下文
   */
  function collectContext(repoPath, uri, maxFiles = 9) {
    // 一次性批量搜索所有候选关键字：逐个关键字搜索每次都要扫全仓库（实测约 13 秒）
    // limit 要给足：候选截断后再打分，会让真正命中的 Controller 排在截断线外
    const candidates = searchJavaMany(repoPath, buildKeywords(uri), 200);
    const best = pickEndpoint(candidates, uri);
    if (best === null) return { endpoint: null, context: '' };

    {
      const picked = best;

      const parts = [];
      const seen = new Set();
      const push = (file, snippet, label, line = 0) => {
        if (file.includes('/test/')) return false;
        const key = `${file}:${Math.floor(line / 40)}`;
        if (seen.has(key) || parts.length >= maxFiles) return false;
        seen.add(key);
        parts.push(`### ${label}：${file.replace(repoPath, '')}\n${snippet}`);
        return true;
      };

      // 第 0 层：类头部（含 @LisaService 字段注入）+ 入口方法
      const head = readSnippet(picked.file, 1, 0, 60);
      const method = readSnippet(picked.file, picked.line, 8, 110);
      const entry = { snippet: `${head.snippet}\n\n// ...（省略中间代码）...\n\n${method.snippet}` };
      push(picked.file, entry.snippet, 'Controller 入口');

      // 第 1 层：按 @LisaService(name) 找服务定义，这类工程常用 @Bean 配置类生成实现
      const lisaShorts = extractLisaNames(entry.snippet).slice(0, 4).map((fullName) => shortServiceName(fullName));
      if (lisaShorts.length > 0) {
        for (const hit of searchJavaMany(repoPath, lisaShorts, 16)) {
          if (!/@Bean|@LisaService|class /.test(hit.text)) continue;
          const matchedName = lisaShorts.find((name) => hit.text.includes(name)) ?? 'service';
          push(hit.file, readSnippet(hit.file, hit.line, 30, 90).snippet, `服务定义 ${matchedName}`, hit.line);
        }
      }

      // 第 2 层：继续按被调用的服务变量名定位实现类
      let frontier = extractServiceVars(entry.snippet);
      for (let depth = 0; depth < 3 && frontier.length > 0 && parts.length < maxFiles; depth++) {
        const next = [];
        for (const name of frontier) {
          const file = findClassFile(repoPath, name);
          if (file === null || seen.has(file)) continue;
          const snippet = readSnippet(file, 1, 0, 100);
          if (!push(file, snippet.snippet, `第 ${depth + 1} 层服务`, 1)) continue;
          next.push(...extractServiceVars(snippet.snippet));
          const deeper = extractLisaNames(snippet.snippet).slice(0, 2).map((fullName) => shortServiceName(fullName));
          if (deeper.length > 0) {
            for (const hit of searchJavaMany(repoPath, deeper, 6)) {
              push(hit.file, readSnippet(hit.file, hit.line, 20, 70).snippet, '下游服务定义', hit.line);
            }
          }
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
      label: cleanText(item?.label),
      uri: cleanText(item?.uri),
      kind: cleanText(item?.kind) || 'http',
    })).filter((item) => item.uri !== '') : [];
    const steps = Array.isArray(value.steps) ? value.steps.map((step, index) => ({
      seq: index + 1,
      from: cleanText(step?.from),
      to: cleanText(step?.to),
      action: cleanText(step?.action),
      kind: cleanText(step?.kind) || 'service',
      uri: cleanText(step?.uri),
      note: cleanText(step?.note),
      group: cleanText(step?.group),
    })) : [];
    return {
      title: cleanText(value.title),
      summary: cleanText(value.summary),
      steps,
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
    // 本地已固化的分析直接复用，不必每次都去问会话；force=true 时强制重新分析
    if (payload?.force !== true) {
      try {
        const cached = findCachedAnalysis(project, uri);
        if (cached !== null && Array.isArray(cached.steps) && cached.steps.length > 0) {
          const updated = touchCachedAnalysis(project, uri);
          return {
            ok: true,
            project,
            uri,
            title: cached.title,
            summary: cached.summary,
            steps: cached.steps,
            endpoints: Array.isArray(cached.endpoints) ? cached.endpoints : [],
            source: {
              mode: 'cache',
              updatedAt: cached.updatedAt,
              hits: Number(updated?.hits ?? (Number(cached.hits ?? 0) + 1)),
            },
          };
        }
      } catch {
        // 缓存损坏就当没有，继续正常分析
      }
    }

    // 优先委派给固定会话：它有完整工具，能逐层读代码，也便于排查思维链
    let sessionError = '';
    if (analyzeSessionId !== '' && payload?.via !== 'local') {
      try {
        const reply = await askSession(analyzeSessionId, buildSessionTask(project, repoPath, uri));
        const parsed = parseSessionReply(reply);
        if (parsed.steps.length > 0) {
          const result = {
            ok: true,
            project,
            uri,
            title: parsed.title,
            summary: parsed.summary,
            steps: parsed.steps,
            endpoints: parsed.endpoints,
            source: { mode: 'session', sessionId: analyzeSessionId },
          };
          saveAnalysis({ project, uri, title: result.title, summary: result.summary, steps: result.steps, endpoints: result.endpoints });
          return result;
        }
      } catch (error) {
        // 会话不可用或超时，退回本地分析；原因带回面板，避免用户以为是会话结果
        sessionError = String(error?.message ?? error);
      }
    }

    try {
      const { endpoint, context } = collectContext(repoPath, uri);
      if (endpoint === null) {
        return { ok: false, reason: `在 ${project} 里没有找到接口 ${uri}，请检查项目或路径` };
      }
      const prompt = [`项目：${project}`, `接口：${uri}`, '', '代码如下：', context.slice(0, 40000)].join('\n');
      const analysis = parseAnalysis(await callModel(ANALYZE_PROMPT, prompt));
      const localResult = {
        ok: true,
        project,
        uri,
        title: analysis.title,
        summary: analysis.summary,
        steps: analysis.steps,
        endpoints: analysis.endpoints,
        source: {
          mode: 'local',
          file: endpoint.file.replace(repoPath, ''),
          line: endpoint.line,
          sessionError,
        },
      };
      saveAnalysis({ project, uri, title: localResult.title, summary: localResult.summary, steps: localResult.steps, endpoints: localResult.endpoints });
      return localResult;
    } catch (error) {
      return { ok: false, reason: String(error?.message ?? error) };
    }
  }

  /**
   * 读取分析会话里最近一次的接口分析结果。
   * @returns {Promise<object>} 分析结果
   */
  async function runAnalyzeLatest(payload) {
    try {
      return await readSessionLatest(payload);
    } catch (error) {
      return { ok: false, reason: `读取会话失败：${String(error?.message ?? error)}` };
    }
  }

  /**
   * 真正读取会话最近一条分析结果。
   * @returns {Promise<object>} 分析结果
   */
  async function readSessionLatest(payload) {
    if (analyzeSessionId === '') return { ok: false, reason: '未配置分析会话' };
    let agents;
    try {
      agents = typeof ctx?.get === 'function' ? ctx.get('agents') : ctx?.agents;
    } catch {
      agents = undefined;
    }
    if (agents === undefined || agents === null || typeof agents.get !== 'function') {
      return { ok: false, reason: '当前环境不支持读取会话' };
    }
    const agent = agents.get(analyzeSessionId);
    if (agent === null || agent === undefined) {
      return { ok: false, reason: `会话 ${analyzeSessionId} 不在线，请先在 DSH 里打开它` };
    }

    const events = eventsOf(agent.session);

    // 助手回复可能被拆成多条增量事件，单条里没有完整 JSON：
    // 从后往前累积拼接，每拼一段就尝试解析，命中即返回
    let buffer = '';
    let attempts = 0;
    let preview = '';
    for (let index = events.length - 1; index >= 0 && attempts < 60; index -= 1) {
      const event = events[index];
      if (event?.type !== 'assistant/message') continue;
      const payload = event.data?.message ?? event.data;
      const blocks = payload?.content;
      if (!Array.isArray(blocks)) continue;
      const text = blocks
        .filter((block) => block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string')
        .map((block) => block.text)
        .join('');
      if (text.trim() === '') continue;
      if (preview === '') preview = text.trim().replace(/\s+/g, ' ').slice(0, 200);
      buffer = `${text}\n${buffer}`;
      attempts += 1;
      try {
        const parsed = parseSessionReply(buffer);
        if (parsed.steps.length > 0) {
          const latest = {
            ok: true,
            title: parsed.title,
            summary: parsed.summary,
            steps: parsed.steps,
            endpoints: parsed.endpoints,
            source: { mode: 'session-latest', sessionId: analyzeSessionId },
          };
          // 只有调用方明确告诉是哪个接口时才落库，避免写入无法复用的脏数据
          const project = String(payload?.project ?? '');
          const uri = String(payload?.uri ?? '').trim();
          if (project !== '' && uri !== '') {
            saveAnalysis({ project, uri, title: latest.title, summary: latest.summary, steps: latest.steps, endpoints: latest.endpoints });
          }
          return latest;
        }
      } catch {
        // 还没拼出完整 JSON，继续往前累积
      }
    }

    // 拿不到结构化结果时，把最近一段助手文本原样返回，至少能看到内容
    if (buffer.trim() !== '') {
      return {
        ok: true,
        title: '',
        summary: '',
        steps: [],
        endpoints: [],
        text: cleanText(buffer.trim().slice(-6000)),
        source: { mode: 'session-text', sessionId: analyzeSessionId },
      };
    }

    const assistantCount = events.filter((event) => event?.type === 'assistant/message').length;
    return {
      ok: false,
      reason: [
        `会话里有 ${events.length} 条事件、${assistantCount} 条助手回复，没有找到含 steps 的分析结果。`,
        preview === '' ? '' : `最近一条回复开头：${cleanText(preview)}…`,
        '请点「分析」等它跑完再读取，或确认会话里最新回复带 steps 的 JSON。',
      ].filter((line) => line !== '').join(' '),
    };
  }

  /**
   * 列出本地固化的接口分析历史。
   * @returns {Promise<object>} 历史列表
   */
  async function runAnalyzeHistory() {
    const items = readAnalysisCache().map((item) => ({
      project: String(item.project ?? ''),
      uri: String(item.uri ?? ''),
      title: String(item.title ?? ''),
      stepCount: Array.isArray(item.steps) ? item.steps.length : 0,
      updatedAt: String(item.updatedAt ?? ''),
      hits: Number(item.hits ?? 0),
    }));
    return { ok: true, items };
  }

  /**
   * 清空本地分析历史。
   * @returns {Promise<object>} 结果
   */
  async function runAnalyzeClear() {
    const cleared = clearAnalysisCache();
    return cleared ? { ok: true } : { ok: false, reason: '清空失败，请检查缓存文件权限' };
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
    'analyze-latest': runAnalyzeLatest,
    'analyze-history': runAnalyzeHistory,
    'analyze-clear': runAnalyzeClear,
    'ask-step': runAskStep,
    'ask-history': runAskHistory,
    'ask-load': runAskLoad,
    'ask-clear': runAskClear,
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

    // 单个端点异常不能让整个路由崩掉，否则客户端只会看到 invalid server-response
    try {
      return await dispatchEndpoint(message, endpoint);
    } catch (error) {
      return Response.json({
        type: 'server-response',
        rpcId: message.rpcId,
        result: { ok: false, error: { code: 'endpoint-failed', message: String(error?.message ?? error) } },
      });
    }
  }

  /**
   * 执行单个端点并组装 RPC 响应。
   * @param {object} message 客户端请求消息
   * @param {string} endpoint 端点名
   * @returns {Promise<Response>} HTTP 响应
   */
  async function dispatchEndpoint(message, endpoint) {

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
    try {
      return Response.json({ type: 'server-response', rpcId: message.rpcId, result });
    } catch {
      // 结果里有不可序列化内容时也要给出合法响应，否则客户端只会看到 invalid server-response
      return Response.json({
        type: 'server-response',
        rpcId: message.rpcId,
        result: { ok: false, error: { code: 'serialize-failed', message: '结果无法序列化，请缩小范围后重试' } },
      });
    }
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
