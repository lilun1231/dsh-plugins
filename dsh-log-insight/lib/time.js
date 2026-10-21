/** 时间范围解析与格式化。 */

const DEFAULT_WINDOW_MINUTES = 30;

/**
 * 把文本解析为 Date。
 * @param {string} text 待解析文本
 * @returns {Date} 解析结果
 */
function toDate(text) {
  const d = new Date(text);
  if (Number.isNaN(d.getTime())) {
    throw new Error(`无法解析时间：${text}`);
  }
  return d;
}

/**
 * 解析查询时间范围。缺省 from 时按默认窗口回退。
 * @param {{from?: string, to?: string, windowMinutes?: number}} input 时间参数
 * @param {Date} [now] 当前时间，测试注入
 * @returns {{from: Date, to: Date}} 起止时间
 */
export function parseRange(input, now = new Date()) {
  const to = input.to ? toDate(input.to) : now;
  const windowMinutes = input.windowMinutes ?? DEFAULT_WINDOW_MINUTES;
  const from = input.from
    ? toDate(input.from)
    : new Date(to.getTime() - windowMinutes * 60 * 1000);
  if (from.getTime() > to.getTime()) {
    throw new Error('起始时间不能晚于结束时间');
  }
  return { from, to };
}

/**
 * 按指定时区格式化为服务治理要求的 yyyy/MM/dd HH:mm:ss。
 * @param {Date} date 时间
 * @param {string} timeZone IANA 时区，如 Asia/Shanghai
 * @returns {string} 格式化结果
 */
export function formatGovernanceTime(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
    hourCycle: 'h23',
  }).formatToParts(date);
  const get = (type) => parts.find((p) => p.type === type)?.value ?? '00';
  return `${get('year')}/${get('month')}/${get('day')} ${get('hour')}:${get('minute')}:${get('second')}`;
}
