/**
 * 「问一问」问答历史的本地缓存。保留最近若干条，供重复查看与复用。
 * @module lib/ask-history
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/** 默认保留条数。 */
export const MAX_ENTRIES = 10;

/**
 * 历史文件位置。
 * @returns {string} 绝对路径
 */
export function askHistoryPath() {
  return join(homedir(), '.dsh', 'log-insight', 'ask-history.json');
}

/**
 * 读取全部历史，按时间从新到旧。
 * @returns {Array<object>} 历史条目
 */
export function readAskHistory() {
  const file = askHistoryPath();
  if (!existsSync(file)) return [];
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    return Array.isArray(parsed?.items) ? parsed.items : [];
  } catch {
    return [];
  }
}

/**
 * 保存一条问答记录。同一个问题重复问只保留最新一次。
 * @param {object} entry 问答记录
 * @param {number} limit 保留条数
 * @returns {Array<object>} 保存后的列表
 */
export function saveAsk(entry, limit = MAX_ENTRIES) {
  const question = String(entry?.question ?? '').trim();
  if (question === '') return readAskHistory();

  const rest = readAskHistory().filter((item) => item.question !== question);
  const merged = { ...entry, question, createdAt: new Date().toISOString() };
  const items = [merged, ...rest].slice(0, Math.max(1, limit));

  const file = askHistoryPath();
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ items }, null, 2), 'utf8');
    return items;
  } catch {
    // 写盘失败不影响问答本身，只是没留下历史
    return readAskHistory();
  }
}

/**
 * 清空历史。
 * @returns {boolean} 是否成功
 */
export function clearAskHistory() {
  const file = askHistoryPath();
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ items: [] }, null, 2), 'utf8');
    return true;
  } catch {
    return false;
  }
}
