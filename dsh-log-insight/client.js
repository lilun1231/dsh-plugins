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
			tabLogs: '日志',
			tabTrace: '调用链',
			tabStatus: '服务状态',
			keyword: '关键字',
			keywordPlaceholder: '错误码、接口路径或入参',
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
			spans: '调用段落',
			empty: '填写条件后点击查询',
		};
		const en = {
			nav: 'Log Insight',
			title: 'Log Insight',
			tabLogs: 'Logs',
			tabTrace: 'Traces',
			tabStatus: 'Status',
			keyword: 'Keyword',
			keywordPlaceholder: 'error code, path or parameter',
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
		async function callRpc(endpoint, payload) {
			const connection = hostCtx === null ? null : hostCtx.connection;
			if (connection === null || connection === undefined || typeof connection.rpc?.call !== 'function') {
				throw new Error('连接不可用');
			}
			const result = await connection.rpc.call(CHANNEL, METHOD_BASE + endpoint, payload ?? {});
			if (result !== null && typeof result === 'object') {
				if (typeof result.code === 'string' && result.code !== '') {
					throw new Error(result.message ?? result.code);
				}
				if (result.ok === false) {
					throw new Error(result.reason ?? 'unknown');
				}
			}
			return result;
		}

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
		function LogsTab({ onOpenTrace }) {
			const [keyword, setKeyword] = useState('');
			const [services, setServices] = useState('');
			const [minutes, setMinutes] = useState(30);
			const [loading, setLoading] = useState(false);
			const [error, setError] = useState('');
			const [result, setResult] = useState(null);
			const [expanded, setExpanded] = useState({});

			const run = useCallback(async () => {
				setLoading(true);
				setError('');
				try {
					const range = rangeOf(minutes);
					const list = services.split(',').map((x) => x.trim()).filter((x) => x !== '');
					const res = await callRpc('search', {
						keyword: keyword.trim() === '' ? undefined : keyword.trim(),
						services: list.length > 0 ? list : undefined,
						from: range.from,
						to: range.to,
						limit: 50,
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
					h(Field, { label: translate('services') },
						h('input', {
							style: S.input,
							value: services,
							placeholder: translate('servicesPlaceholder'),
							onChange: (e) => setServices(e.target.value),
						})),
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
								}))),
						h('div', { style: S.hint }, translate('hintNoLogin'))));
		}

		/** 链路 Tab。 */
		function TraceTab({ initialSerialNo, onConsumed }) {
			const [serialNo, setSerialNo] = useState(initialSerialNo ?? '');
			const [loading, setLoading] = useState(false);
			const [error, setError] = useState('');
			const [detail, setDetail] = useState(null);

			const run = useCallback(async (target) => {
				const value = String(target ?? serialNo).trim();
				if (value === '') return;
				setLoading(true);
				setError('');
				try {
					const res = await callRpc('trace', { serialNo: value });
					setDetail(res);
				} catch (e) {
					setError(String(e?.message ?? e));
					setDetail(null);
				} finally {
					setLoading(false);
				}
			}, [serialNo]);

			useEffect(() => {
				if (typeof initialSerialNo === 'string' && initialSerialNo !== '') {
					setSerialNo(initialSerialNo);
					run(initialSerialNo);
					onConsumed();
				}
			}, [initialSerialNo]);

			const spans = detail?.spans ?? [];
			const maxDuration = spans.reduce((acc, x) => Math.max(acc, x.durationMs), 0) || 1;
			const bottleneck = detail?.bottleneck;

			return h('div', null,
				h('div', { style: S.form },
					h(Field, { label: translate('serialNo') },
						h('input', {
							style: S.input,
							value: serialNo,
							placeholder: translate('traceIdPlaceholder'),
							onChange: (e) => setSerialNo(e.target.value),
							onKeyDown: (e) => { if (e.key === 'Enter') run(); },
						})),
					h('button', { style: S.button(true), onClick: () => run(), disabled: loading, type: 'button' },
						loading ? translate('searching') : translate('search'))),

				h(ErrorBox, { message: error }),

				detail === null
					? h('div', { style: S.empty }, translate('empty'))
					: h('div', null,
						bottleneck
							? h('div', { style: { ...S.card, marginBottom: 12, borderColor: COLORS.warn } },
								h('div', { style: S.cardLabel }, translate('bottleneck')),
								h('div', { style: { ...S.mono, color: COLORS.warn } },
									`${bottleneck.span?.service ?? '—'} ${bottleneck.span?.uri ?? ''} — ${fmtMs(bottleneck.durationMs)}（占 ${fmtPct(bottleneck.share)}）`))
							: null,
						h('div', { style: { display: 'flex', gap: 8, marginBottom: 8, alignItems: 'center' } },
							h('span', { style: S.chip }, `${translate('spans')} ${spans.length}`),
							h('button', {
								style: S.button(false),
								type: 'button',
								onClick: async () => {
									try {
										const res = await callRpc('export-trace', { serialNo: detail.serialNo, format: 'url' });
										if (res?.url) window.open(res.url, '_blank');
									} catch (e) {
										setError(String(e?.message ?? e));
									}
								},
							}, translate('openInPlatform'))),
						h('div', { style: { border: `1px solid ${COLORS.border1}`, borderRadius: 8, overflow: 'hidden' } },
							spans.map((span, idx) => {
								const isBottleneck = bottleneck && span.service === bottleneck.span?.service && span.durationMs === bottleneck.durationMs;
								const isError = span.type === 'exception';
								return h('div', {
									key: idx,
									style: {
										...S.row,
										paddingLeft: 10 + span.depth * 18,
										background: isBottleneck ? COLORS.layer2 : 'transparent',
									},
								},
									h('span', { style: { ...S.mono, color: COLORS.label2, flexShrink: 0, width: 150 } }, span.type),
									h('span', { style: { ...S.mono, color: isError ? COLORS.error : COLORS.label1, flexShrink: 0, width: 130, overflow: 'hidden', textOverflow: 'ellipsis' } }, span.service || '—'),
									h('span', { style: { ...S.mono, color: COLORS.label2, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, span.uri || ''),
									h('div', { style: S.bar }, h('div', { style: S.barFill((span.durationMs / maxDuration) * 100, isError ? COLORS.error : (isBottleneck ? COLORS.warn : COLORS.brand)) })),
									h('span', { style: { ...S.mono, width: 60, textAlign: 'right', flexShrink: 0, color: isBottleneck ? COLORS.warn : COLORS.label2 } }, fmtMs(span.durationMs)));
							})),
						isAnyError(spans) ? h('div', { style: S.hint }, spans.filter((x) => x.type === 'exception').map((x) => x.error).join(' | ')) : null));
		}

		/** 判断链路里是否含异常节点。 */
		function isAnyError(spans) {
			return spans.some((x) => x.type === 'exception');
		}

		/** 服务状态 Tab。 */
		function StatusTab() {
			const [service, setService] = useState('hall-restful');
			const [minutes, setMinutes] = useState(60);
			const [loading, setLoading] = useState(false);
			const [error, setError] = useState('');
			const [stats, setStats] = useState(null);

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
		//#endregion

		//#region shell
		/** 主面板：三个 Tab。 */
		function MainPanel() {
			const [tab, setTab] = useState('logs');
			const [pendingTrace, setPendingTrace] = useState('');

			const openTrace = useCallback((serialNo) => {
				setPendingTrace(serialNo);
				setTab('trace');
			}, []);

			const consumePending = useCallback(() => setPendingTrace(''), []);

			return h('div', { style: S.root },
				h('div', { style: S.header },
					h('span', { style: S.title }, translate('title')),
					h('div', { style: S.tabs },
						[['logs', 'tabLogs'], ['trace', 'tabTrace'], ['status', 'tabStatus']].map(([key, labelKey]) =>
							h('button', {
								key,
								style: S.tab(tab === key),
								onClick: () => setTab(key),
								type: 'button',
							}, translate(labelKey))))),
				h('div', { style: S.body },
					tab === 'logs' ? h(LogsTab, { onOpenTrace: openTrace }) : null,
					tab === 'trace' ? h(TraceTab, { initialSerialNo: pendingTrace, onConsumed: consumePending }) : null,
					tab === 'status' ? h(StatusTab, null) : null));
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
