/**
 * Client half of `dsh-log-insight`.
 *
 * 两块界面，都在 Harness Web UI 内：
 *   - `sidebar.panellist`：侧边栏图标，id 与主面板 key 对应。
 *   - `main`：主面板，三个 Tab（日志 / 链路 / 服务状态）。
 *
 * 查询能力全部在 Host 侧，这里通过 `connection.rpc` 调用同一批核心函数，
 * 不重复实现任何检索逻辑。
 */
window.__ModuleLoader__.load({
	id: 'dsh-log-insight',
	factory(require) {
		const React = require('react');
		const h = React.createElement;
		const { useCallback, useEffect, useMemo, useRef, useState } = React;

		const NS = 'log-insight';
		const ENTRY_ID = 'log-insight';
		const CHANNEL = '/api';
		const METHOD_BASE = `${ENTRY_ID}/`;

		/** Set in `apply`; components read services through it. */
		let hostCtx = null;
		let translate = (key) => key;

		//#region dictionaries
		const zh = {
			nav: '日志洞察',
			title: '日志洞察',
			tabLogs: '日志查询',
			tabAnalyze: '接口分析',
			projectLabel: '项目',
			analyzeBtn: '分析',
			analyzing: '分析中…（读取代码并调用模型，约 10-30 秒）',
			sequenceTitle: '调用时序',
			clickToSearch: '蓝色接口可点击，直接跳转日志查询',
			tabTrace: '调用链',
			tabStatus: '服务状态',
			tabAsk: '问一问',
			askPlaceholder: '用自然语言提问，例如：最近半小时 hall-restful 有没有报错',
			askButton: '提问',
			asking: '分析中…（需要调用模型，约 10-20 秒）',
			answerLabel: '分析结论',
			planLabel: '解析为',
			askExamples: '试试：',
			tabAudit: '操作日志',
			connected: '已连接',
			disconnected: '未连接',
			refresh: '刷新',
			auditHint: '记录本插件的所有查询与导出，便于回溯与排查',
			noAudit: '暂无操作记录',
			sourcePanel: '面板',
			sourceTool: '对话',
			okLabel: '成功',
			failLabel: '失败',
			keyword: '关键字',
			keywordPlaceholder: '错误码/接口/入参，空格分隔多个词=同时包含',
			exclude: '排除',
			excludePlaceholder: '不包含这些词，空格分隔',
			env: '环境',
			levelAll: '全部级别',
			traceId: '流水号',
			traceIdPlaceholder: 'hall-restful-...',
			services: '服务',
			servicesPlaceholder: '多个用逗号分隔，如 hall-restful,hall-app-service',
			level: '级别',
			range: '时间范围',
			range30m: '近30分钟',
			range1h: '近1小时',
			range6h: '近6小时',
			range24h: '近24小时',
			search: '查询',
			searching: '查询中…',
			serialNo: '流水号',
			modeSerial: '流水号',
			modeCondition: '条件搜索',
			uriLabel: '接口路径',
			uriPlaceholder: '如 /hall/indexinfo/query',
			traceKeyword: '关键字',
			traceKeywordPlaceholder: '入参、返回值或错误码',
			traceService: '服务名',
			traceServicePlaceholder: '留空=全部，如 hall-restful',
			typeLabel: '类型',
			typeHttp: '正常调用',
			typeException: '异常调用',
			resultList: '搜索结果',
			clickToOpen: '点击查看链路详情',
			detail: '查看链路',
			exportCsv: '导出 CSV',
			total: '总量',
			errors: '异常',
			errorRate: '错误率',
			avg: '耗时均值',
			max: '峰值',
			topExceptions: '高频异常',
			noResult: '没有命中记录',
			noException: '没有异常记录',
			bottleneck: '瓶颈节点',
			hintTraceDelay: '链路入库约有 1-2 分钟延迟，刚发生的请求可能搜不到',
			hintNoLogin: '首次查询会自动登录，可能需要几秒',
			failed: '查询失败',
			copy: '复制',
			copied: '已复制',
			backToLogs: '返回日志',
			openInPlatform: '在平台打开',
			exportPdf: '导出 PDF',
			exportPdfHint: '导出使用平台页面自带的「导出为pdf文件」功能',
			spans: '调用段落',
			empty: '填写条件后点击查询',
		};
		const en = {
			nav: 'Log Insight',
			title: 'Log Insight',
			tabLogs: 'Log query',
			tabAnalyze: 'API analysis',
			projectLabel: 'Project',
			analyzeBtn: 'Analyze',
			analyzing: 'Analyzing… (reads code, calls model, 10-30s)',
			sequenceTitle: 'Sequence',
			clickToSearch: 'Blue endpoints jump to log query',
			tabTrace: 'Traces',
			tabStatus: 'Status',
			tabAsk: 'Ask',
			askPlaceholder: 'Ask in natural language, e.g. any errors in hall-restful',
			askButton: 'Ask',
			asking: 'Analyzing… (model call, ~10-20s)',
			answerLabel: 'Analysis',
			planLabel: 'Parsed as',
			askExamples: 'Try:',
			tabAudit: 'Activity',
			connected: 'connected',
			disconnected: 'offline',
			refresh: 'Refresh',
			auditHint: 'Every query and export this plugin performs',
			noAudit: 'No activity yet',
			sourcePanel: 'Panel',
			sourceTool: 'Chat',
			okLabel: 'ok',
			failLabel: 'failed',
			keyword: 'Keyword',
			keywordPlaceholder: 'space-separated words are ANDed',
			exclude: 'Exclude',
			excludePlaceholder: 'words to exclude',
			env: 'Env',
			levelAll: 'All levels',
			traceId: 'Trace id',
			traceIdPlaceholder: 'hall-restful-...',
			services: 'Services',
			servicesPlaceholder: 'comma separated',
			level: 'Level',
			range: 'Range',
			range30m: '30 min',
			range1h: '1 hour',
			range6h: '6 hours',
			range24h: '24 hours',
			search: 'Search',
			searching: 'Searching…',
			serialNo: 'Serial no',
			modeSerial: 'Serial',
			modeCondition: 'Filter',
			uriLabel: 'URI',
			uriPlaceholder: '/hall/indexinfo/query',
			traceKeyword: 'Keyword',
			traceKeywordPlaceholder: 'parameters, result or error code',
			traceService: 'Service',
			traceServicePlaceholder: 'empty = all',
			typeLabel: 'Type',
			typeHttp: 'Normal',
			typeException: 'Exception',
			resultList: 'Results',
			clickToOpen: 'Open trace detail',
			detail: 'Open trace',
			exportCsv: 'Export CSV',
			total: 'Total',
			errors: 'Errors',
			errorRate: 'Error rate',
			avg: 'Avg',
			max: 'Peak',
			topExceptions: 'Top exceptions',
			noResult: 'No records',
			noException: 'No exceptions',
			bottleneck: 'Bottleneck',
			hintTraceDelay: 'Trace indexing lags about 1-2 minutes',
			hintNoLogin: 'First query signs in automatically',
			failed: 'Request failed',
			copy: 'Copy',
			copied: 'Copied',
			backToLogs: 'Back to logs',
			openInPlatform: 'Open in platform',
			exportPdf: 'Export PDF',
			exportPdfHint: 'Export uses the platform page built-in PDF export',
			spans: 'Spans',
			empty: 'Fill in and search',
		};
		//#endregion

		//#region styles
		const COLORS = {
			base: 'var(--dsw-alias-bg-base)',
			layer1: 'var(--dsw-alias-bg-layer-1)',
			layer2: 'var(--dsw-alias-bg-layer-2)',
			border1: 'var(--dsw-alias-border-l1)',
			border2: 'var(--dsw-alias-border-l2)',
			brand: 'var(--dsw-alias-brand-primary)',
			label1: 'var(--dsw-alias-label-primary)',
			label2: 'var(--dsw-alias-label-secondary)',
			error: 'var(--dsw-alias-state-error-primary)',
			warn: 'var(--dsw-alias-state-warn-primary)',
			success: 'var(--dsw-alias-state-success-primary)',
			idle: 'var(--dsw-alias-state-idle-primary)',
		};

		const S = {
			root: {
				display: 'flex',
				flexDirection: 'column',
				height: '100%',
				minHeight: 0,
				background: COLORS.base,
				color: COLORS.label1,
				fontSize: 13,
			},
			header: {
				display: 'flex',
				alignItems: 'center',
				gap: 8,
				padding: '10px 16px',
				borderBottom: `1px solid ${COLORS.border1}`,
				background: COLORS.layer1,
			},
			title: { fontSize: 14, fontWeight: 600, marginRight: 8 },
			tabs: { display: 'flex', gap: 4 },
			tab: (active) => ({
				padding: '4px 12px',
				borderRadius: 6,
				cursor: 'pointer',
				border: 'none',
				fontSize: 13,
				background: active ? COLORS.layer2 : 'transparent',
				color: active ? COLORS.label1 : COLORS.label2,
				fontWeight: active ? 600 : 400,
			}),
			body: { flex: 1, minHeight: 0, overflow: 'auto', padding: 16 },
			form: {
				display: 'flex',
				flexWrap: 'wrap',
				gap: 8,
				alignItems: 'flex-end',
				marginBottom: 12,
			},
			field: { display: 'flex', flexDirection: 'column', gap: 4, minWidth: 150, flex: '1 1 150px' },
			label: { fontSize: 11, color: COLORS.label2 },
			input: {
				padding: '6px 8px',
				borderRadius: 6,
				border: `1px solid ${COLORS.border1}`,
				background: COLORS.layer1,
				color: COLORS.label1,
				fontSize: 13,
				outline: 'none',
				minWidth: 0,
			},
			button: (primary) => ({
				padding: '6px 14px',
				borderRadius: 6,
				cursor: 'pointer',
				fontSize: 13,
				border: `1px solid ${primary ? COLORS.brand : COLORS.border1}`,
				background: primary ? COLORS.brand : COLORS.layer1,
				color: primary ? '#fff' : COLORS.label1,
			}),
			chip: {
				padding: '3px 8px',
				borderRadius: 12,
				fontSize: 11,
				background: COLORS.layer2,
				color: COLORS.label2,
			},
			row: {
				display: 'flex',
				gap: 8,
				padding: '7px 10px',
				borderBottom: `1px solid ${COLORS.border1}`,
				alignItems: 'baseline',
			},
			mono: {
				fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
				fontSize: 12,
			},
			card: {
				padding: 12,
				borderRadius: 8,
				background: COLORS.layer1,
				border: `1px solid ${COLORS.border1}`,
			},
			cards: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))', gap: 10, marginBottom: 12 },
			cardLabel: { fontSize: 11, color: COLORS.label2, marginBottom: 4 },
			cardValue: { fontSize: 18, fontWeight: 600 },
			bar: {
				height: 6,
				borderRadius: 3,
				background: COLORS.layer2,
				overflow: 'hidden',
				minWidth: 40,
				flex: 1,
			},
			barFill: (pct, color) => ({
				height: '100%',
				width: `${Math.min(100, Math.max(2, pct))}%`,
				background: color,
			}),
			empty: {
				padding: 40,
				textAlign: 'center',
				color: COLORS.label2,
				fontSize: 13,
			},
			errorBox: {
				padding: 10,
				borderRadius: 6,
				background: COLORS.layer1,
				border: `1px solid ${COLORS.error}`,
				color: COLORS.error,
				marginBottom: 12,
				fontSize: 12,
			},
			hint: { fontSize: 11, color: COLORS.label2, marginTop: 6 },
		};
		//#endregion

		//#region rpc
		/** 调用 Host 侧端点，统一把错误转成异常。 */
		async function callRpc(endpoint, payload, timeoutMs = 20000) {
			const connection = hostCtx === null ? null : hostCtx.connection;
			if (connection === null || connection === undefined || typeof connection.rpc?.call !== 'function') {
				throw new Error('连接不可用');
			}
			const controller = new AbortController();
			const timer = setTimeout(() => controller.abort(), timeoutMs);
			let result;
			try {
				result = await connection.rpc.call(CHANNEL, METHOD_BASE + endpoint, payload ?? {}, controller.signal);
			} catch (thrown) {
				if (thrown !== null && typeof thrown === 'object' && thrown.name === 'AbortError') {
					throw new Error(`请求超时（${Math.round(timeoutMs / 1000)} 秒）`);
				}
				throw thrown;
			} finally {
				clearTimeout(timer);
			}
			// DSH RPC 契约：成功为 { ok: true, value }，失败为 { ok: false, error }
			if (result === null || typeof result !== 'object' || result.ok !== true) {
				const failure = result !== null && typeof result === 'object' ? result.error : null;
				const message = failure !== null && typeof failure === 'object'
					? (failure.message ?? failure.code)
					: (result !== null && typeof result === 'object' ? (result.reason ?? result.code) : null);
				throw new Error(String(message ?? '请求失败'));
			}
			return result.value;
		}

		/** 面板状态记忆：切到别处再回来时恢复输入与结果。 */
		const memory = {
			tab: 'logs',
			logs: { keyword: '', services: '', exclude: '', level: '', env: '', minutes: 30, result: null },
			trace: { mode: 'serial', serialNo: '', uri: '', keyword: '', service: '', traceType: 'http', minutes: 30, detail: null, picked: null, list: null },
			status: { service: 'hall-restful', minutes: 60, stats: null },
			audit: { items: null },
			ask: { question: '', answer: '', plan: null, result: null },
			analyze: { project: 'hall-micro-serv-3', uri: '', data: null },
		};

		/** 按时间范围生成 ISO 起止。 */
		function rangeOf(minutes) {
			const to = new Date();
			const from = new Date(to.getTime() - minutes * 60 * 1000);
			return { from: from.toISOString(), to: to.toISOString() };
		}
		//#endregion

		//#region shared components
		/** 表单字段。 */
		function Field({ label, children }) {
			return h('div', { style: S.field }, h('span', { style: S.label }, label), children);
		}

		/** 时间范围选择。 */
		function RangePicker({ minutes, onChange }) {
			const options = [
				{ v: 30, k: 'range30m' },
				{ v: 60, k: 'range1h' },
				{ v: 360, k: 'range6h' },
				{ v: 1440, k: 'range24h' },
			];
			return h('div', { style: { display: 'flex', gap: 4, alignSelf: 'flex-end' } },
				options.map((o) => h('button', {
					key: o.v,
					style: S.tab(minutes === o.v),
					onClick: () => onChange(o.v),
					type: 'button',
				}, translate(o.k))));
		}

		/** 错误提示条。 */
		function ErrorBox({ message }) {
			if (!message) return null;
			return h('div', { style: S.errorBox }, `${translate('failed')}：${message}`);
		}

		/** 指标卡。 */
		function StatCard({ label, value, color }) {
			return h('div', { style: S.card },
				h('div', { style: S.cardLabel }, label),
				h('div', { style: { ...S.cardValue, color: color ?? COLORS.label1 } }, value));
		}

		const fmtMs = (v) => (typeof v === 'number' ? `${v.toFixed(v >= 100 ? 0 : 1)}ms` : '—');

		/** 单条日志行，展开时显示全文。 */
		function LogRow({ hit, open, onToggle, onOpenTrace }) {
			const hasTrace = typeof hit.traceId === 'string' && hit.traceId !== '';
			const message = String(hit.message ?? '');
			return h('div', { style: S.row },
				h('div', { style: { display: 'flex', flexDirection: 'column', gap: 4, width: '100%' } },
					h('div', { style: { display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' } },
						h('span', { style: { ...S.mono, color: COLORS.label2, flexShrink: 0 } }, String(hit.timestamp ?? '').slice(11, 23)),
						h('span', { style: S.chip }, hit.service || '—'),
						hasTrace
							? h('span', {
								style: { ...S.mono, color: COLORS.brand, cursor: 'pointer' },
								onClick: () => onOpenTrace(hit.traceId),
							}, hit.traceId)
							: null,
						h('span', {
							style: { marginLeft: 'auto', fontSize: 11, color: COLORS.label2, cursor: 'pointer' },
							onClick: onToggle,
						}, open ? '收起' : '展开')),
					h('div', {
						style: {
							...S.mono,
							whiteSpace: open ? 'pre-wrap' : 'nowrap',
							overflow: open ? 'visible' : 'hidden',
							textOverflow: 'ellipsis',
							wordBreak: 'break-all',
							color: COLORS.label1,
						},
					}, open ? message : message.slice(0, 160))));
		}
		const fmtPct = (v) => (typeof v === 'number' ? `${(v * 100).toFixed(2)}%` : '—');
		//#endregion

		//#region tabs
		/** 日志 Tab。 */
		function LogsTab({ pendingQuery, onConsumed, onOpenTrace }) {
			const [keyword, setKeyword] = useState(memory.logs.keyword);
			const [services, setServices] = useState(memory.logs.services);
			const [exclude, setExclude] = useState(memory.logs.exclude);
			const [level, setLevel] = useState(memory.logs.level);
			const [env, setEnv] = useState(memory.logs.env);
			const [minutes, setMinutes] = useState(memory.logs.minutes);
			const [loading, setLoading] = useState(false);
			const [error, setError] = useState('');
			const [result, setResult] = useState(memory.logs.result);
			const [expanded, setExpanded] = useState({});

			useEffect(() => {
				memory.logs = { keyword, services, exclude, level, env, minutes, result };
			}, [keyword, services, exclude, level, env, minutes, result]);

			// 接口分析里点击某个接口后，带上关键字直接查一次
			useEffect(() => {
				if (pendingQuery === null || typeof pendingQuery !== 'object') return;
				const incoming = String(pendingQuery.keyword ?? '');
				if (incoming === '') {
					onConsumed();
					return;
				}
				setKeyword(incoming);
				setServices('');
				onConsumed();
				setLoading(true);
				setError('');
				(async () => {
					try {
						const range = rangeOf(minutes);
						setResult(await callRpc('search', {
							keywords: [incoming],
							from: range.from,
							to: range.to,
							limit: 20,
						}));
						setExpanded({});
					} catch (e) {
						setError(String(e?.message ?? e));
					} finally {
						setLoading(false);
					}
				})();
				// 仅在外部跳转请求变化时触发
				// eslint-disable-next-line react-hooks/exhaustive-deps
			}, [pendingQuery]);

			const run = useCallback(async () => {
				setLoading(true);
				setError('');
				try {
					const range = rangeOf(minutes);
					const words = keyword.split(/\s+/).map((x) => x.trim()).filter((x) => x !== '');
					const excludes = exclude.split(/\s+/).map((x) => x.trim()).filter((x) => x !== '');
					const list = services.split(',').map((x) => x.trim()).filter((x) => x !== '');
					const res = await callRpc('search', {
						keywords: words.length > 0 ? words : undefined,
						excludeKeywords: excludes.length > 0 ? excludes : undefined,
						services: list.length > 0 ? list : undefined,
						level: level === '' ? undefined : level,
						env: env === '' ? undefined : env,
						from: range.from,
						to: range.to,
						limit: 20,
					});
					setResult(res);
					setExpanded({});
				} catch (e) {
					setError(String(e?.message ?? e));
				} finally {
					setLoading(false);
				}
			}, [keyword, services, minutes]);

			const hits = result?.hits ?? [];

			return h('div', null,
				h('div', { style: S.form },
					h(Field, { label: translate('keyword') },
						h('input', {
							style: S.input,
							value: keyword,
							placeholder: translate('keywordPlaceholder'),
							onChange: (e) => setKeyword(e.target.value),
							onKeyDown: (e) => { if (e.key === 'Enter') run(); },
						})),
					h(Field, { label: translate('exclude') },
						h('input', {
							style: S.input,
							value: exclude,
							placeholder: translate('excludePlaceholder'),
							onChange: (e) => setExclude(e.target.value),
							onKeyDown: (e) => { if (e.key === 'Enter') run(); },
						})),
					h(Field, { label: translate('services') },
						h('input', {
							style: S.input,
							value: services,
							placeholder: translate('servicesPlaceholder'),
							onChange: (e) => setServices(e.target.value),
						})),
					h(Field, { label: translate('level') },
						h('select', {
							style: S.input,
							value: level,
							onChange: (e) => setLevel(e.target.value),
						}, [h('option', { key: '', value: '' }, translate('levelAll'))]
							.concat(['ERROR', 'WARN', 'INFO'].map((v) => h('option', { key: v, value: v }, v))))),
					h(Field, { label: translate('env') },
						h('select', {
							style: S.input,
							value: env,
							onChange: (e) => setEnv(e.target.value),
						}, [h('option', { key: '', value: '' }, 'fat'),
							...['uat', 'dev'].map((v) => h('option', { key: v, value: v }, v))])),
					h(Field, { label: translate('range') }, h(RangePicker, { minutes, onChange: setMinutes })),
					h('button', { style: S.button(true), onClick: run, disabled: loading, type: 'button' },
						loading ? translate('searching') : translate('search'))),

				h(ErrorBox, { message: error }),

				result === null
					? h('div', { style: S.empty }, translate('empty'))
					: h('div', null,
						h('div', { style: { marginBottom: 8, display: 'flex', gap: 8, alignItems: 'center' } },
							h('span', { style: S.chip }, `${translate('total')} ${result.total}`),
							result.truncated ? h('span', { style: S.chip }, '已截断') : null),
						hits.length === 0
							? h('div', { style: S.empty }, translate('noResult'))
							: h('div', { style: { border: `1px solid ${COLORS.border1}`, borderRadius: 8, overflow: 'hidden' } },
								hits.map((hit, idx) => h(LogRow, {
									key: idx,
									hit,
									open: expanded[idx] === true,
									onToggle: () => setExpanded((prev) => ({ ...prev, [idx]: !(prev[idx] === true) })),
									onOpenTrace,
								}))),));
		}

		/** 链路 Tab。 */
		/** 截断长文本，保留可读预览。 */
		function truncateText(text, max) {
			if (typeof text !== 'string') return '';
			if (text.length <= max) return text;
			return `${text.slice(0, max)}…（共 ${text.length} 字符）`;
		}

		/** 链路节点行：点击展开该节点的明细。 */
		function SpanRow({ span, maxDuration, isBottleneck }) {
			const [open, setOpen] = useState(false);
			const isError = span.type === 'exception';

			const fields = [
				['类型', span.type],
				['服务', span.service],
				['接口', span.uri],
				['方法', span.method],
				['状态码', span.code === '' ? span.status : span.code],
				['耗时', span.durationMs === undefined ? '' : `${span.durationMs}ms`],
				['应用', span.app],
				['操作名', span.operationName],
				['URL', span.url],
				['线程', span.thread],
				['IP', span.ip],
				['端口', span.port],
				['时间', span.timestamp === null || span.timestamp === undefined ? '' : new Date(Number(span.timestamp)).toISOString().replace('T', ' ').slice(0, 19)],
				['入参', span.request],
				['返回值', span.response],
				['日志', span.log],
				['错误', span.error],
			].filter(([, value]) => value !== undefined && value !== null && String(value) !== '');

			const detail = open ? h('div', {
				style: {
					padding: '8px 12px 10px',
					borderTop: `1px solid ${COLORS.border1}`,
					background: COLORS.layer1,
				},
			}, fields.map(([label, value], idx) => h('div', {
				key: idx,
				style: { display: 'flex', gap: 10, marginBottom: 4 },
			},
				h('span', { style: { fontSize: 11, color: COLORS.label2, width: 60, flexShrink: 0, textAlign: 'right' } }, label),
				h('span', {
					style: { ...S.mono, fontSize: 11, color: COLORS.label1, wordBreak: 'break-all', whiteSpace: 'pre-wrap' },
				}, truncateText(String(value), 2000))))) : null;

			return h('div', null,
				h('div', {
					style: {
						...S.row,
						paddingLeft: 10 + span.depth * 18,
						cursor: 'pointer',
						background: isBottleneck ? COLORS.layer2 : 'transparent',
					},
					onClick: () => setOpen(!open),
				},
					h('span', { style: { ...S.mono, color: COLORS.label2, flexShrink: 0, width: 12 } }, open ? '▾' : '▸'),
					h('span', { style: { ...S.mono, color: COLORS.label2, flexShrink: 0, width: 145 } }, span.type),
					h('span', { style: { ...S.mono, color: isError ? COLORS.error : COLORS.label1, flexShrink: 0, width: 130, overflow: 'hidden', textOverflow: 'ellipsis' } }, span.service || '—'),
					h('span', { style: { ...S.mono, color: COLORS.label2, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, span.uri || ''),
					h('div', { style: S.bar }, h('div', { style: S.barFill((span.durationMs / maxDuration) * 100, isError ? COLORS.error : (isBottleneck ? COLORS.warn : COLORS.brand)) })),
					h('span', { style: { ...S.mono, width: 60, textAlign: 'right', flexShrink: 0, color: isBottleneck ? COLORS.warn : COLORS.label2 } }, fmtMs(span.durationMs))),
				detail);
		}

		/** 渲染链路详情：瓶颈卡片 + 段落树 + 异常信息。 */
		function buildTraceDetail(detail) {
			const spans = detail.spans ?? [];
			const maxDuration = spans.reduce((acc, x) => Math.max(acc, x.durationMs), 0) || 1;
			const bottleneck = detail.bottleneck;

			const bottleneckCard = bottleneck
				? h('div', { style: { ...S.card, marginBottom: 12, borderColor: COLORS.warn } },
					h('div', { style: S.cardLabel }, translate('bottleneck')),
					h('div', { style: { ...S.mono, color: COLORS.warn } },
						`${bottleneck.span?.service ?? '—'} ${bottleneck.span?.uri ?? ''} — ${fmtMs(bottleneck.durationMs)}（占 ${fmtPct(bottleneck.share)}）`))
				: null;

			/** 打开平台详情页：原生导出 PDF 就在该页面里。 */
			const openPlatform = () => {
				// 先同步开窗占位，避免异步取地址后被浏览器拦截
				const win = window.open('', '_blank');
				callRpc('export-trace', { serialNo: detail.serialNo, format: 'url' }).then((res) => {
					if (typeof res?.url === 'string' && res.url !== '') {
						if (win) win.location.href = res.url;
						else window.open(res.url, '_blank');
					} else if (win) {
						win.close();
					}
				}).catch((e) => {
					// 打不开平台页不影响已渲染的链路树
					console.warn('[log-insight] 打开平台页失败', e);
					if (win) win.close();
				});
			};

			const toolbar = h('div', { style: { display: 'flex', gap: 8, marginBottom: 8, alignItems: 'center' } },
				h('span', { style: S.chip }, `${translate('spans')} ${spans.length}`),
				h('button', { style: S.button(true), type: 'button', onClick: openPlatform }, translate('exportPdf')),
				h('button', { style: S.button(false), type: 'button', onClick: openPlatform }, translate('openInPlatform')),
				h('span', { style: { fontSize: 11, color: COLORS.label2 } }, translate('exportPdfHint')));

			const rows = spans.map((span, idx) => h(SpanRow, {
				key: idx,
				span,
				maxDuration,
				isBottleneck: bottleneck && span.service === bottleneck.span?.service && span.durationMs === bottleneck.durationMs,
			}));

			const exceptionLine = spans.some((x) => x.type === 'exception')
				? h('div', { style: S.hint }, spans.filter((x) => x.type === 'exception').map((x) => x.error).join(' | '))
				: null;

			return h('div', null,
				bottleneckCard,
				toolbar,
				h('div', { style: { border: `1px solid ${COLORS.border1}`, borderRadius: 8, overflow: 'hidden' } }, rows),
				exceptionLine);
		}

		/** 调用链 Tab：按流水号直查，或按接口+关键字搜索。 */
		function TraceTab({ pending, onConsumed }) {
			const [mode, setMode] = useState(memory.trace.mode);
			const [serialNo, setSerialNo] = useState(typeof pending === 'string' && /^[\w-]+-\d+-\d+-\d+$/.test(pending) ? pending : memory.trace.serialNo);
			const [uri, setUri] = useState(memory.trace.uri);
			const [keyword, setKeyword] = useState(memory.trace.keyword);
			const [service, setService] = useState(memory.trace.service);
			const [traceType, setTraceType] = useState(memory.trace.traceType);
			const [minutes, setMinutes] = useState(memory.trace.minutes);
			const [loading, setLoading] = useState(false);
			const [error, setError] = useState('');
			const [detail, setDetail] = useState(typeof pending === 'string' && pending !== '' ? null : memory.trace.detail);
			const [picked, setPicked] = useState(memory.trace.picked);
			const [list, setList] = useState(memory.trace.list);

			useEffect(() => {
				memory.trace = { mode, serialNo, uri, keyword, service, traceType, minutes, detail, picked, list };
			}, [mode, serialNo, uri, keyword, service, traceType, minutes, detail, picked, list]);

			const loadDetail = useCallback(async (target) => {
				const value = String(target ?? serialNo).trim();
				if (value === '') return;
				setLoading(true);
				setError('');
				try {
					setSerialNo(value);
					setDetail(await callRpc('trace', { serialNo: value }));
				} catch (e) {
					setError(String(e?.message ?? e));
					setDetail(null);
				} finally {
					setLoading(false);
				}
			}, [serialNo]);

			const searchByCondition = useCallback(async () => {
				setLoading(true);
				setError('');
				try {
					const range = rangeOf(minutes);
					setList(await callRpc('traces', {
						uri: uri.trim() === '' ? undefined : uri.trim(),
						keyword: keyword.trim() === '' ? undefined : keyword.trim(),
						service: service.trim() === '' ? undefined : service.trim(),
						type: traceType,
						from: range.from,
						to: range.to,
						limit: 20,
					}));
				} catch (e) {
					setError(String(e?.message ?? e));
					setList(null);
				} finally {
					setLoading(false);
				}
			}, [uri, keyword, service, traceType, minutes]);

			/** 条件搜索结果里点开某一条，详情独立存放，不影响流水号模式。 */
			const openFromList = useCallback(async (value) => {
				if (typeof value !== 'string' || value === '') return;
				setLoading(true);
				setError('');
				try {
					setPicked(await callRpc('trace', { serialNo: value }));
				} catch (e) {
					setError(String(e?.message ?? e));
					setPicked(null);
				} finally {
					setLoading(false);
				}
			}, []);

			// 从其他页面右键带过来的文本：流水号直接查详情，其余当作接口/关键字做条件搜索
			useEffect(() => {
				if (typeof pending !== 'string' || pending.trim() === '') return;
				const text = pending.trim();
				onConsumed();
				if (/^[\w-]+-\d+-\d+-\d+$/.test(text)) {
					setMode('serial');
					loadDetail(text);
					return;
				}
				setMode('condition');
				setUri(text);
				setLoading(true);
				setError('');
				(async () => {
					try {
						const range = rangeOf(minutes);
						setList(await callRpc('traces', {
							uri: text,
							type: 'http',
							from: range.from,
							to: range.to,
							limit: 20,
						}));
					} catch (e) {
						setError(String(e?.message ?? e));
						setList(null);
					} finally {
						setLoading(false);
					}
				})();
				// 仅在外部跳转变化时触发
				// eslint-disable-next-line react-hooks/exhaustive-deps
			}, [pending]);

			const modeBar = h('div', { style: { display: 'flex', gap: 4, marginBottom: 10 } },
				[['serial', 'modeSerial'], ['condition', 'modeCondition']].map(([key, labelKey]) =>
					h('button', { key, type: 'button', style: S.tab(mode === key), onClick: () => setMode(key) }, translate(labelKey))));

			const serialForm = h('div', { style: S.form },
				h(Field, { label: translate('serialNo') },
					h('input', {
						style: S.input,
						value: serialNo,
						placeholder: translate('traceIdPlaceholder'),
						onChange: (e) => setSerialNo(e.target.value),
						onKeyDown: (e) => { if (e.key === 'Enter') loadDetail(); },
					})),
				h('button', { style: S.button(true), onClick: () => loadDetail(), disabled: loading, type: 'button' },
					loading ? translate('searching') : translate('search')));

			const conditionForm = h('div', { style: S.form },
				h(Field, { label: translate('uriLabel') },
					h('input', {
						style: S.input,
						value: uri,
						placeholder: translate('uriPlaceholder'),
						onChange: (e) => setUri(e.target.value),
						onKeyDown: (e) => { if (e.key === 'Enter') searchByCondition(); },
					})),
				h(Field, { label: translate('traceKeyword') },
					h('input', {
						style: S.input,
						value: keyword,
						placeholder: translate('traceKeywordPlaceholder'),
						onChange: (e) => setKeyword(e.target.value),
						onKeyDown: (e) => { if (e.key === 'Enter') searchByCondition(); },
					})),
				h(Field, { label: translate('traceService') },
					h('input', {
						style: S.input,
						value: service,
						placeholder: translate('traceServicePlaceholder'),
						onChange: (e) => setService(e.target.value),
					})),
				h(Field, { label: translate('typeLabel') },
					h('select', {
						style: S.input,
						value: traceType,
						onChange: (e) => setTraceType(e.target.value),
					}, [
						h('option', { key: 'http', value: 'http' }, translate('typeHttp')),
						h('option', { key: 'exception', value: 'exception' }, translate('typeException')),
					])),
				h(Field, { label: translate('range') }, h(RangePicker, { minutes, onChange: setMinutes })),
				h('button', { style: S.button(true), onClick: searchByCondition, disabled: loading, type: 'button' },
					loading ? translate('searching') : translate('search')));

			const listView = list === null ? null : h('div', { style: { marginBottom: 12 } },
				h('div', { style: { marginBottom: 8 } }, h('span', { style: S.chip }, `${translate('resultList')} ${list.total}`)),
				(list.items ?? []).length === 0
					? h('div', { style: S.empty }, translate('noResult'))
					: h('div', { style: { border: `1px solid ${COLORS.border1}`, borderRadius: 8, overflow: 'hidden' } },
						list.items.map((item, idx) => h('div', {
							key: idx,
							style: { ...S.row, cursor: 'pointer' },
							onClick: () => openFromList(item.serialNo),
						},
							h('span', { style: { ...S.mono, color: COLORS.label2, flexShrink: 0, width: 150 } }, String(item.callTime ?? '').slice(0, 19)),
							h('span', { style: { ...S.mono, flexShrink: 0, width: 120, overflow: 'hidden', textOverflow: 'ellipsis' } }, item.service || '—'),
							h('span', { style: { ...S.mono, color: COLORS.label2, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, item.uri || ''),
							h('span', { style: { ...S.mono, width: 64, textAlign: 'right', flexShrink: 0 } }, fmtMs(item.durationMs)),
							h('span', { style: { ...S.mono, color: COLORS.brand, flexShrink: 0, fontSize: 11 } }, String(item.serialNo ?? '').slice(-20))))));

			// 两种模式各自渲染自己的结果，切换时互不串台；数据保留在 memory 里，切回来还在
			const serialView = h('div', null,
				serialForm,
				h(ErrorBox, { message: error }),
				detail === null ? h('div', { style: S.empty }, translate('empty')) : buildTraceDetail(detail));

			const conditionView = h('div', null,
				conditionForm,
				h(ErrorBox, { message: error }),
				list === null ? h('div', { style: S.empty }, translate('empty')) : listView,
				picked === null ? null : buildTraceDetail(picked));

			return h('div', null,
				modeBar,
				mode === 'serial' ? serialView : conditionView);
		}

		/** 判断链路里是否含异常节点。 */
		function isAnyError(spans) {
			return spans.some((x) => x.type === 'exception');
		}

		/** 服务状态 Tab。 */
		function StatusTab() {
			const [service, setService] = useState(memory.status.service);
			const [minutes, setMinutes] = useState(memory.status.minutes);
			const [loading, setLoading] = useState(false);
			const [error, setError] = useState('');
			const [stats, setStats] = useState(memory.status.stats);

			useEffect(() => {
				memory.status = { service, minutes, stats };
			}, [service, minutes, stats]);

			const run = useCallback(async () => {
				setLoading(true);
				setError('');
				try {
					const range = rangeOf(minutes);
					const res = await callRpc('status', {
						service: service.trim() === '' ? undefined : service.trim(),
						from: range.from,
						to: range.to,
					});
					setStats(res);
				} catch (e) {
					setError(String(e?.message ?? e));
					setStats(null);
				} finally {
					setLoading(false);
				}
			}, [service, minutes]);

			return h('div', null,
				h('div', { style: S.form },
					h(Field, { label: translate('services') },
						h('input', { style: S.input, value: service, onChange: (e) => setService(e.target.value) })),
					h(Field, { label: translate('range') }, h(RangePicker, { minutes, onChange: setMinutes })),
					h('button', { style: S.button(true), onClick: run, disabled: loading, type: 'button' },
						loading ? translate('searching') : translate('search'))),

				h(ErrorBox, { message: error }),

				stats === null
					? h('div', { style: S.empty }, translate('empty'))
					: h('div', null,
						h('div', { style: S.cards },
							h(StatCard, { label: translate('total'), value: String(stats.total ?? 0) }),
							h(StatCard, { label: translate('errors'), value: String(stats.errorCount ?? 0), color: (stats.errorCount ?? 0) > 0 ? COLORS.error : COLORS.success }),
							h(StatCard, { label: translate('errorRate'), value: fmtPct(stats.errorRate), color: (stats.errorRate ?? 0) > 0.05 ? COLORS.error : COLORS.success }),
							h(StatCard, { label: translate('avg'), value: fmtMs(stats.avgDurationMs) }),
							h(StatCard, { label: translate('max'), value: fmtMs(stats.maxDurationMs), color: (stats.maxDurationMs ?? 0) > 1000 ? COLORS.warn : COLORS.label1 })),
						h('div', { style: S.card },
							h('div', { style: S.cardLabel }, translate('topExceptions')),
							(stats.topExceptions ?? []).length === 0
								? h('div', { style: { color: COLORS.label2, fontSize: 12 } }, translate('noException'))
								: (stats.topExceptions ?? []).map((item, idx) => h('div', {
									key: idx,
									style: { display: 'flex', gap: 8, padding: '4px 0', borderBottom: idx < stats.topExceptions.length - 1 ? `1px solid ${COLORS.border1}` : 'none' },
								},
									h('span', { style: { ...S.chip, color: COLORS.error } }, `${item.count}×`),
									h('span', { style: { ...S.mono, fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, String(item.message ?? '')))))));
		}
		/** 操作日志 Tab：查看本插件自己的调用历史。 */
		function AuditTab() {
			const [items, setItems] = useState(memory.audit.items);
			const [loading, setLoading] = useState(false);
			const [error, setError] = useState('');

			const load = useCallback(async () => {
				setLoading(true);
				setError('');
				try {
					const res = await callRpc('audit', { limit: 200 });
					setItems(Array.isArray(res.items) ? res.items : []);
				} catch (e) {
					setError(String(e?.message ?? e));
				} finally {
					setLoading(false);
				}
			}, []);

			useEffect(() => {
				memory.audit = { items };
			}, [items]);

			useEffect(() => {
				if (items === null) load();
			}, []);

			const cell = (width, extra) => ({ ...S.mono, flexShrink: 0, width, ...extra });

			return h('div', null,
				h('div', { style: S.form },
					h('button', { style: S.button(true), onClick: load, disabled: loading, type: 'button' },
						loading ? translate('searching') : translate('refresh')),
					h('span', { style: { fontSize: 11, color: COLORS.label2, alignSelf: 'center' } }, translate('auditHint'))),
				h(ErrorBox, { message: error }),
				items === null
					? h('div', { style: S.empty }, translate('empty'))
					: (items.length === 0
						? h('div', { style: S.empty }, translate('noAudit'))
						: h('div', { style: { border: `1px solid ${COLORS.border1}`, borderRadius: 8, overflow: 'hidden' } },
							items.map((item, idx) => h('div', {
								key: idx,
								style: { ...S.row, gap: 10 },
							},
								h('span', { style: cell(140, { color: COLORS.label2 }) }, String(item.time ?? '').slice(0, 19).replace('T', ' ')),
								h('span', { style: { ...S.chip, flexShrink: 0, minWidth: 44, textAlign: 'center' } }, item.source === 'panel' ? translate('sourcePanel') : translate('sourceTool')),
								h('span', { style: cell(96, null) }, String(item.action ?? '')),
								h('span', { style: { ...S.mono, color: COLORS.label2, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, String(item.params ?? '') || '—'),
								h('span', { style: cell(64, { textAlign: 'right', color: COLORS.label2 }) }, item.durationMs === undefined ? '—' : `${item.durationMs}ms`),
								h('span', {
									style: { fontSize: 11, width: 110, flexShrink: 0, textAlign: 'right', color: item.ok ? COLORS.success : COLORS.error },
								}, item.ok ? translate('okLabel') : `${translate('failLabel')} ${String(item.error ?? '').slice(0, 18)}`))))));
		}

		/** 解析 Mermaid sequenceDiagram 的常用语法子集。 */
		function parseMermaid(text) {
			const participants = [];
			const items = [];
			const stack = [];

			const pushItem = (item) => {
				if (stack.length === 0) items.push(item);
				else stack[stack.length - 1].items.push(item);
			};

			for (const raw of String(text ?? '').split('\n')) {
				const line = raw.trim();
				if (line === '' || line.startsWith('%%')) continue;
				if (/^sequenceDiagram/i.test(line) || /^autonumber/i.test(line)) continue;

				const participant = line.match(/^participant\s+([^\s]+)(?:\s+as\s+(.+))?$/i);
				if (participant !== null) {
					participants.push({ key: participant[1], label: (participant[2] ?? participant[1]).trim() });
					continue;
				}
				const note = line.match(/^Note\s+(?:over|left of|right of)\s+([^:]+):\s*(.+)$/i);
				if (note !== null) {
					pushItem({ type: 'note', target: note[1].trim(), text: note[2].trim() });
					continue;
				}
				const par = line.match(/^par\s*(.*)$/i);
				if (par !== null) {
					const group = { type: 'group', label: (par[1] ?? '').trim(), items: [] };
					pushItem(group);
					stack.push(group);
					continue;
				}
				const and = line.match(/^and\s*(.*)$/i);
				if (and !== null && stack.length > 0) {
					const group = { type: 'group', label: (and[1] ?? '').trim(), items: [] };
					stack[stack.length - 1].items.push(group);
					stack.push(group);
					continue;
				}
				if (/^end$/i.test(line)) {
					stack.pop();
					continue;
				}
				const message = line.match(/^([A-Za-z0-9_]+)\s*(-->>|->>|-->|->)\s*([A-Za-z0-9_]+)\s*:\s*(.*)$/);
				if (message !== null) {
					pushItem({
						type: 'message',
						from: message[1],
						to: message[3],
						text: message[4].trim(),
						dashed: message[2].startsWith('--'),
					});
					continue;
				}
				pushItem({ type: 'text', text: line });
			}
			return { participants, items };
		}

		/** 判断某段消息文字是否对应可查日志的接口。 */
		function matchEndpoint(text, endpoints) {
			if (typeof text !== 'string' || text === '') return null;
			for (const endpoint of endpoints) {
				const candidates = [endpoint.label, endpoint.uri].filter((item) => typeof item === 'string' && item !== '');
				if (candidates.some((item) => text.includes(item))) return endpoint;
			}
			return null;
		}

		/** 把 Mermaid 时序图渲染为可点击的 SVG。 */
		function SequenceDiagram({ mermaid, endpoints, onOpenLogs }) {
			const parsed = useMemo(() => parseMermaid(mermaid), [mermaid]);
			const participants = parsed.participants;
			if (participants.length === 0) return null;

			const n = participants.length;
			const width = Math.max(760, n * 165);
			const step = width / n;
			const indexOf = new Map(participants.map((item, idx) => [item.key, idx]));
			const columnX = (key) => (indexOf.has(key) ? (indexOf.get(key) + 0.5) * step : step / 2);

			const groupRects = [];
			let y = 74;
			const walk = (items, depth) => {
				for (const item of items) {
					if (item.type === 'group') {
						const top = y;
						y += 22;
						walk(item.items, depth + 1);
						groupRects.push({ label: item.label, top, bottom: y + 4, depth });
						y += 8;
						continue;
					}
					item.y = y;
					y += 38;
				}
			};
			walk(parsed.items, 0);
			const height = y + 24;

			const nodes = [];
			for (const rect of groupRects) {
				nodes.push(h('rect', {
					key: `g${nodes.length}`,
					x: 6,
					y: rect.top,
					width: width - 12,
					height: rect.bottom - rect.top,
					rx: 6,
					fill: rect.depth === 0 ? 'rgba(99,102,241,0.05)' : 'rgba(99,102,241,0.09)',
					stroke: 'rgba(99,102,241,0.35)',
					strokeDasharray: '4 3',
				}));
				if (rect.label !== '') {
					nodes.push(h('text', {
						key: `gl${nodes.length}`,
						x: 14,
						y: rect.top + 15,
						fontSize: 11,
						fontWeight: 600,
						fill: COLORS.brand,
					}, rect.label));
				}
			}

			for (const item of parsed.items) {
				// 生命线由参与者列统一绘制，这里只画消息
				void item;
			}

			participants.forEach((item, idx) => {
				const cx = columnX(item.key);
				nodes.push(h('rect', {
					key: `p${idx}`,
					x: cx - 72,
					y: 12,
					width: 144,
					height: 40,
					rx: 6,
					fill: COLORS.layer2,
					stroke: COLORS.border1,
				}));
				const plain = String(item.label).replace(/<br\s*\/?>/gi, ' ').replace(/\s+/g, ' ').trim();
				nodes.push(h('text', {
					key: `pt${idx}`,
					x: cx,
					y: 30,
					textAnchor: 'middle',
					fontSize: 11,
					fontWeight: 600,
					fill: COLORS.label1,
				}, plain.length > 20 ? `${plain.slice(0, 19)}…` : plain));
				nodes.push(h('line', {
					key: `pl${idx}`,
					x1: cx,
					y1: 52,
					x2: cx,
					y2: height - 12,
					stroke: COLORS.border1,
					strokeDasharray: '3 4',
				}));
			});

			const flat = [];
			const flatten = (items) => {
				for (const item of items) {
					if (item.type === 'group') flatten(item.items);
					else flat.push(item);
				}
			};
			flatten(parsed.items);

			for (const item of flat) {
				if (item.type === 'note') {
					const keys = item.target.split(',').map((part) => part.trim());
					const xs = keys.map((key) => columnX(key));
					const left = Math.min(...xs) - 60;
					const right = Math.max(...xs) + 60;
					nodes.push(h('rect', {
						key: `n${nodes.length}`,
						x: Math.max(6, left),
						y: item.y - 14,
						width: Math.min(width - 12, right) - Math.max(6, left),
						height: 26,
						rx: 4,
						fill: 'rgba(250,204,21,0.16)',
						stroke: 'rgba(250,204,21,0.5)',
					}));
					nodes.push(h('text', {
						key: `nt${nodes.length}`,
						x: Math.max(6, left) + 8,
						y: item.y + 3,
						fontSize: 10.5,
						fill: COLORS.label1,
					}, item.text.length > 90 ? `${item.text.slice(0, 89)}…` : item.text));
					continue;
				}
				if (item.type === 'text') continue;

				const fromX = columnX(item.from);
				const toX = columnX(item.to);
				const same = Math.abs(fromX - toX) < 1;
				const endpoint = matchEndpoint(item.text, endpoints);
				const color = endpoint === null ? COLORS.label1 : COLORS.brand;
				const marker = item.dashed ? 'url(#arrow-open)' : 'url(#arrow-solid)';

				if (same) {
					// 自调用：画一个回环
					nodes.push(h('path', {
						key: `m${nodes.length}`,
						d: `M ${fromX} ${item.y - 10} h 46 v 22 h -46`,
						fill: 'none',
						stroke: color,
						strokeWidth: endpoint === null ? 1 : 1.6,
						strokeDasharray: item.dashed ? '4 3' : undefined,
						markerEnd: marker,
					}));
				} else {
					nodes.push(h('line', {
						key: `m${nodes.length}`,
						x1: fromX,
						y1: item.y - 6,
						x2: toX,
						y2: item.y - 6,
						stroke: color,
						strokeWidth: endpoint === null ? 1 : 1.6,
						strokeDasharray: item.dashed ? '4 3' : undefined,
						markerEnd: marker,
					}));
				}

				const label = item.text.length > 62 ? `${item.text.slice(0, 61)}…` : item.text;
				const textY = item.y - 12;
				const centerX = same ? fromX + 52 : (fromX + toX) / 2;
				const textNode = h('text', {
					key: `mt${nodes.length}`,
					x: centerX,
					y: textY,
					textAnchor: same ? 'start' : 'middle',
					fontSize: 10.5,
					fill: color,
					fontWeight: endpoint === null ? 400 : 700,
					textDecoration: endpoint === null ? 'none' : 'underline',
					style: endpoint === null ? undefined : { cursor: 'pointer' },
					onClick: endpoint === null ? undefined : () => onOpenLogs(endpoint.uri),
				}, label);
				nodes.push(textNode);
			}

			return h('div', { style: { overflowX: 'auto', border: `1px solid ${COLORS.border1}`, borderRadius: 8, background: COLORS.layer1 } },
				h('svg', {
					width,
					height,
					viewBox: `0 0 ${width} ${height}`,
					style: { display: 'block' },
				},
					h('defs', null,
						h('marker', {
							id: 'arrow-solid',
							viewBox: '0 0 10 10',
							refX: 9,
							refY: 5,
							markerWidth: 7,
							markerHeight: 7,
							orient: 'auto',
						}, h('path', { d: 'M 0 0 L 10 5 L 0 10 z', fill: 'currentColor' })),
						h('marker', {
							id: 'arrow-open',
							viewBox: '0 0 10 10',
							refX: 9,
							refY: 5,
							markerWidth: 7,
							markerHeight: 7,
							orient: 'auto',
						}, h('path', { d: 'M 0 0 L 10 5 L 0 10', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5 }))),
					nodes));
		}

		/** 接口分析 Tab：选定项目与接口，定位代码后生成调用时序。 */
		function AnalyzeTab({ onOpenLogs, pending, onConsumed }) {
			const [project, setProject] = useState(memory.analyze.project);
			const [uri, setUri] = useState(memory.analyze.uri);
			const [loading, setLoading] = useState(false);
			const [error, setError] = useState('');
			const [data, setData] = useState(memory.analyze.data);

			useEffect(() => {
				memory.analyze = { project, uri, data };
			}, [project, uri, data]);

			// 从其他页面右键带过来的接口路径：填入并立即分析
			useEffect(() => {
				if (pending === null || typeof pending !== 'object') return;
				const text = String(pending.uri ?? '').trim();
				onConsumed();
				if (text === '') return;
				setUri(text);
				setLoading(true);
				setError('');
				(async () => {
					try {
						setData(await callRpc('analyze', { project, uri: text }, 120000));
					} catch (e) {
						setError(String(e?.message ?? e));
						setData(null);
					} finally {
						setLoading(false);
					}
				})();
				// 仅在外部跳转变化时触发
				// eslint-disable-next-line react-hooks/exhaustive-deps
			}, [pending]);

			const run = useCallback(async () => {
				const value = uri.trim();
				if (value === '') return;
				setLoading(true);
				setError('');
				try {
					setData(await callRpc('analyze', { project, uri: value }, 120000));
				} catch (e) {
					setError(String(e?.message ?? e));
					setData(null);
				} finally {
					setLoading(false);
				}
			}, [project, uri]);

			const header = data === null ? null : h('div', { style: { ...S.card, marginBottom: 12 } },
				h('div', { style: { fontSize: 13, fontWeight: 600, marginBottom: 6 } }, data.title || '—'),
				h('div', { style: { fontSize: 12, color: COLORS.label2, lineHeight: 1.7 } }, data.summary || ''),
				h('div', { style: { ...S.mono, fontSize: 11, color: COLORS.label2, marginTop: 6 } },
					`${data.project ?? ''} · ${data.source?.file ?? ''}:${data.source?.line ?? ''}`));

			const endpoints = data === null || !Array.isArray(data.endpoints) ? [] : data.endpoints;
			const sequence = data === null ? null : h('div', null,
				h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8, flexWrap: 'wrap' } },
					h('span', { style: S.chip }, translate('sequenceTitle')),
					h('span', { style: { fontSize: 11, color: COLORS.label2 } }, translate('clickToSearch'))),
				typeof data.mermaid === 'string' && data.mermaid !== ''
					? h(SequenceDiagram, { mermaid: data.mermaid, endpoints, onOpenLogs })
					: h('div', { style: S.empty }, translate('noResult')));

			return h('div', null,
				h('div', { style: S.form },
					h(Field, { label: translate('projectLabel') },
						h('select', {
							style: S.input,
							value: project,
							onChange: (e) => setProject(e.target.value),
						}, ['hall-user', 'hall-micro-serv-3'].map((v) => h('option', { key: v, value: v }, v)))),
					h(Field, { label: translate('uriLabel') },
						h('input', {
							style: S.input,
							value: uri,
							placeholder: translate('uriPlaceholder'),
							onChange: (e) => setUri(e.target.value),
							onKeyDown: (e) => { if (e.key === 'Enter') run(); },
						})),
					h('button', { style: S.button(true), onClick: run, disabled: loading, type: 'button' },
						loading ? translate('analyzing') : translate('analyzeBtn'))),
				h(ErrorBox, { message: error }),
				loading ? h('div', { style: S.empty }, translate('analyzing')) : null,
				header,
				sequence);
		}

		/** 自然语言问答 Tab：描述问题，由模型解析并执行查询后给出解读。 */
		function AskTab() {
			const [question, setQuestion] = useState(memory.ask.question);
			const [loading, setLoading] = useState(false);
			const [error, setError] = useState('');
			const [answer, setAnswer] = useState(memory.ask.answer);
			const [plan, setPlan] = useState(memory.ask.plan);
			const [result, setResult] = useState(memory.ask.result);

			useEffect(() => {
				memory.ask = { question, answer, plan, result };
			}, [question, answer, plan, result]);

			const ask = useCallback(async () => {
				const text = question.trim();
				if (text === '') return;
				setLoading(true);
				setError('');
				setAnswer('');
				setPlan(null);
				setResult(null);
				try {
					const res = await callRpc('ask', { question: text }, 90000);
					setAnswer(typeof res?.answer === 'string' ? res.answer : '');
					setPlan(res?.plan ?? null);
					setResult(res?.result ?? null);
				} catch (e) {
					setError(String(e?.message ?? e));
				} finally {
					setLoading(false);
				}
			}, [question]);

			const examples = [
				'最近半小时 hall-restful 有没有报错',
				'看看 /actuator/info 接口最近有没有异常调用',
				'hall-restful 最近一小时的健康指标怎么样',
			];

			const answerCard = answer === '' ? null : h('div', { style: { ...S.card, marginBottom: 12 } },
				h('div', { style: S.cardLabel }, translate('answerLabel')),
				h('div', { style: { whiteSpace: 'pre-wrap', lineHeight: 1.7, fontSize: 13 } }, answer));

			const planLine = plan === null ? null : h('div', { style: { marginBottom: 10 } },
				h('span', { style: S.chip }, translate('planLabel') + ' ' + String(plan.action ?? '')),
				h('span', { style: { ...S.mono, color: COLORS.label2, marginLeft: 8, fontSize: 11 } }, JSON.stringify(plan.args ?? {})));

			const hits = Array.isArray(result?.hits) ? result.hits.slice(0, 20) : [];
			const resultView = hits.length === 0 ? null : h('div', { style: { marginBottom: 10 } },
				h('div', { style: { marginBottom: 6 } }, h('span', { style: S.chip }, `命中 ${result.total ?? hits.length}`)),
				h('div', { style: { border: `1px solid ${COLORS.border1}`, borderRadius: 8, overflow: 'hidden' } },
					hits.map((hit, idx) => h(LogRow, {
						key: idx,
						hit,
						open: false,
						onToggle: () => {},
						onOpenTrace: () => {},
					}))));

			return h('div', null,
				h('div', { style: S.form },
					h('input', {
						style: S.input,
						value: question,
						placeholder: translate('askPlaceholder'),
						onChange: (e) => setQuestion(e.target.value),
						onKeyDown: (e) => { if (e.key === 'Enter') ask(); },
					}),
					h('button', { style: S.button(true), onClick: ask, disabled: loading, type: 'button' },
						loading ? translate('asking') : translate('askButton'))),
				h('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 10, alignItems: 'center' } },
					h('span', { style: { fontSize: 11, color: COLORS.label2 } }, translate('askExamples')),
					examples.map((ex, idx) => h('button', {
						key: idx,
						type: 'button',
						style: S.button(false),
						onClick: () => setQuestion(ex),
					}, ex))),
				h(ErrorBox, { message: error }),
				loading ? h('div', { style: S.empty }, translate('asking')) : null,
				answerCard,
				planLine,
				resultView);
		}

		//#endregion

		//#region shell
		/** 主面板：三个 Tab。 */
		/** 右键菜单：当前页面可跳转的目标页面。 */
		const MENU_TARGETS = {
			analyze: [['logs', 'tabLogs'], ['trace', 'tabTrace']],
			logs: [['analyze', 'tabAnalyze'], ['trace', 'tabTrace']],
			trace: [['analyze', 'tabAnalyze'], ['logs', 'tabLogs']],
		};

		function MainPanel() {
			const [tab, setTab] = useState(memory.tab);
			const [health, setHealth] = useState(null);

			useEffect(() => {
				memory.tab = tab;
			}, [tab]);

			useEffect(() => {
				let alive = true;
				callRpc('ping', {})
					.then(() => { if (alive) setHealth({ ok: true }); })
					.catch((e) => { if (alive) setHealth({ ok: false, reason: String(e?.message ?? e) }); });
				return () => { alive = false; };
			}, []);
			const [pendingTrace, setPendingTrace] = useState('');
			const [pendingLog, setPendingLog] = useState(null);
			const [pendingAnalyze, setPendingAnalyze] = useState(null);
			const [menu, setMenu] = useState(null);

			const openTrace = useCallback((serialNo) => {
				setPendingTrace(serialNo);
				setTab('trace');
			}, []);

			const consumePending = useCallback(() => setPendingTrace(''), []);

			/** 接口分析点接口后跳到日志查询并自动搜索。 */
			const openLogs = useCallback((keyword) => {
				setPendingLog({ keyword });
				setTab('logs');
			}, []);

			const consumeLog = useCallback(() => setPendingLog(null), []);
			const consumeAnalyze = useCallback(() => setPendingAnalyze(null), []);

			// 右键瞬间选区可能已被浏览器清空，这里缓存最近一次非空选区兜底
			const lastSelection = useRef('');

			useEffect(() => {
				if (typeof document === 'undefined') return;
				const onSelect = () => {
					const raw = String(window.getSelection()?.toString() ?? '').trim();
					if (raw !== '') lastSelection.current = raw;
				};
				document.addEventListener('selectionchange', onSelect);
				return () => document.removeEventListener('selectionchange', onSelect);
			}, []);

			/** 取当前选中的文字：优先页面选区，其次输入框内的选区，最后用缓存兜底。 */
			const readSelection = useCallback(() => {
				const pageText = String(typeof window === 'undefined' ? '' : (window.getSelection()?.toString() ?? '')).trim();
				if (pageText !== '') return pageText;
				const active = typeof document === 'undefined' ? null : document.activeElement;
				if (active !== null && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA')) {
					const start = Number(active.selectionStart ?? 0);
					const end = Number(active.selectionEnd ?? 0);
					if (end > start) {
						const picked = String(active.value ?? '').slice(start, end).trim();
						if (picked !== '') return picked;
					}
				}
				return String(lastSelection.current ?? '').trim();
			}, []);

			/** 选中文本后右键：呼出跨页跳转菜单。 */
			const openSelectionMenu = useCallback((event, source) => {
				const text = readSelection();
				if (text === '') return;
				if (typeof event.preventDefault === 'function') event.preventDefault();
				setMenu({ x: event.clientX, y: event.clientY, text, source });
			}, [readSelection]);

			/** 把选中的文本带到目标页面并自动查询。 */
			const jumpTo = useCallback((target) => {
				const text = menu === null ? '' : menu.text;
				setMenu(null);
				if (text === '') return;
				if (target === 'logs') {
					setPendingLog({ keyword: text });
					setTab('logs');
				} else if (target === 'trace') {
					setPendingTrace(text);
					setTab('trace');
				} else {
					setPendingAnalyze({ uri: text });
					setTab('analyze');
				}
			}, [menu]);

			// 点击别处或按 Esc 关闭菜单
			useEffect(() => {
				if (menu === null) return;
				const close = () => setMenu(null);
				const onKey = (event) => { if (event.key === 'Escape') setMenu(null); };
				document.addEventListener('click', close);
				document.addEventListener('keydown', onKey);
				return () => {
					document.removeEventListener('click', close);
					document.removeEventListener('keydown', onKey);
				};
			}, [menu]);

			return h('div', { style: S.root },
				h('div', { style: S.header },
					h('span', { style: S.title }, translate('title')),
					health === null
						? null
						: h('span', {
							style: {
								...S.chip,
								color: health.ok ? COLORS.success : COLORS.error,
								marginRight: 8,
							},
						}, health.ok ? translate('connected') : `${translate('disconnected')}：${String(health.reason ?? '').slice(0, 60)}`),
					h('div', { style: S.tabs },
						[['analyze', 'tabAnalyze'], ['logs', 'tabLogs'], ['trace', 'tabTrace'], ['status', 'tabStatus'], ['ask', 'tabAsk'], ['audit', 'tabAudit']].map(([key, labelKey]) =>
							h('button', {
								key,
								style: S.tab(tab === key),
								onClick: () => setTab(key),
								type: 'button',
							}, translate(labelKey))))),
				h('div', { style: S.body, onContextMenu: (event) => openSelectionMenu(event, tab) },
					tab === 'analyze' ? h(AnalyzeTab, { onOpenLogs: openLogs, pending: pendingAnalyze, onConsumed: consumeAnalyze }) : null,
					tab === 'logs' ? h(LogsTab, { pendingQuery: pendingLog, onConsumed: consumeLog, onOpenTrace: openTrace }) : null,
					tab === 'trace' ? h(TraceTab, { pending: pendingTrace, onConsumed: consumePending }) : null,
					tab === 'status' ? h(StatusTab, null) : null,
					tab === 'ask' ? h(AskTab, null) : null,
					tab === 'audit' ? h(AuditTab, null) : null),
				menu === null ? null : h('div', {
					style: {
						position: 'fixed',
						left: Math.max(8, Math.min(menu.x, (typeof window === 'undefined' ? 900 : window.innerWidth) - 200)),
						top: menu.y,
						zIndex: 9999,
						background: COLORS.layer1,
						border: `1px solid ${COLORS.border1}`,
						borderRadius: 8,
						boxShadow: '0 8px 24px rgba(0,0,0,0.18)',
						padding: 4,
						minWidth: 168,
					},
					onClick: (event) => event.stopPropagation(),
				},
					h('div', {
						style: {
							fontSize: 10,
							color: COLORS.label2,
							padding: '4px 8px 6px',
							borderBottom: `1px solid ${COLORS.border1}`,
							marginBottom: 4,
							maxWidth: 220,
							overflow: 'hidden',
							textOverflow: 'ellipsis',
							whiteSpace: 'nowrap',
						},
					}, `用「${menu.text.length > 18 ? `${menu.text.slice(0, 17)}…` : menu.text}」查询`),
					(MENU_TARGETS[menu.source] ?? []).map(([target, labelKey]) => h('button', {
						key: target,
						type: 'button',
						onClick: () => jumpTo(target),
						style: {
							display: 'block',
							width: '100%',
							textAlign: 'left',
							padding: '6px 10px',
							background: 'none',
							border: 'none',
							borderRadius: 4,
							cursor: 'pointer',
							fontSize: 12,
							color: COLORS.label1,
						},
					}, translate(labelKey)))));
		}

		/** 侧边栏图标。 */
		function PanelIcon({ size }) {
			const edge = typeof size === 'number' && size > 0 ? size : 18;
			return h('svg', {
				width: edge,
				height: edge,
				viewBox: '0 0 24 24',
				fill: 'none',
				stroke: 'currentColor',
				strokeWidth: 2,
				strokeLinecap: 'round',
				strokeLinejoin: 'round',
			}, h('path', { d: 'M3 12h4l3-8 4 16 3-8h4' }));
		}
		//#endregion

		return {
			inject: ['slots', 'locale', 'connection'],
			apply(ctx) {
				hostCtx = ctx;
				translate = ctx.locale.bind(NS);
				ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-log-insight: dictionaries');

				ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
					name: 'sidebar.panellist',
					id: ENTRY_ID,
					order: 50,
					label: () => translate('nav'),
					locale: NS,
				}, PanelIcon));

				ctx.slots.inject('main', () => ctx.slots.register({
					name: 'main',
					key: ENTRY_ID,
				}, MainPanel));
			},
		};
	},
});
