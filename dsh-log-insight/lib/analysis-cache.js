/**
 * 接口分析结果的本地缓存。按「项目 + 接口路径」为键，保留最近若干条，
 * 命中后直接复用，不必每次都去问分析会话。
 * @module lib/analysis-cache
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/** 默认保留条数。 */
export const MAX_ENTRIES = 10;

/**
 * 缓存文件位置。
 * @returns {string} 绝对路径
 */
export function cachePath() {
  return join(homedir(), '.dsh', 'log-insight', 'analysis-cache.json');
}

/**
 * 读取全部缓存条目，按更新时间从新到旧。
 * @returns {Array<object>} 条目列表
 */
export function readAnalysisCache() {
  const file = cachePath();
  if (!existsSync(file)) return [];
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    return Array.isArray(parsed?.items) ? parsed.items : [];
  } catch {
    return [];
  }
}

/**
 * 按项目和接口查缓存。
 * @param {string} project 项目名
 * @param {string} uri 接口路径
 * @returns {object|null} 命中的条目
 */
export function findCachedAnalysis(project, uri) {
  const target = String(uri ?? '').trim();
  return readAnalysisCache().find((item) => item.project === project && item.uri === target) ?? null;
}

/**
 * 保存一条分析结果，同键覆盖并置顶，超出上限截断。
 * @param {object} entry 分析结果
 * @param {number} limit 保留条数
 * @returns {Array<object>} 保存后的条目列表
 */
export function saveAnalysis(entry, limit = MAX_ENTRIES) {
  const now = new Date().toISOString();
  const rest = readAnalysisCache().filter(
    (item) => !(item.project === entry.project && item.uri === entry.uri),
  );
  const merged = {
    ...entry,
    updatedAt: now,
    createdAt: entry.createdAt ?? now,
    hits: Number(entry.hits ?? 0),
  };
  const items = [merged, ...rest].slice(0, Math.max(1, limit));
  const file = cachePath();
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ items }, null, 2), 'utf8');
  } catch {
    // 写盘失败（权限、磁盘满）只是没有历史记录，不能因此让分析结果丢失
    return readAnalysisCache();
  }
  return items;
}

/**
 * 记录一次命中（用于展示使用次数）。
 * @param {string} project 项目名
 * @param {string} uri 接口路径
 * @returns {object|null} 更新后的条目
 */
export function touchCachedAnalysis(project, uri) {
  const items = readAnalysisCache();
  const target = items.find((item) => item.project === project && item.uri === uri);
  if (target === undefined) return null;
  const updated = { ...target, hits: Number(target.hits ?? 0) + 1, lastUsedAt: new Date().toISOString() };
  const next = [updated, ...items.filter((item) => item !== target)];
  const file = cachePath();
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ items: next }, null, 2), 'utf8');
  } catch {
    return target;
  }
  return updated;
}

/**
 * 清空缓存。
 * @returns {boolean} 是否已清空
 */
export function clearAnalysisCache() {
  const file = cachePath();
  if (!existsSync(file)) return true;
  try {
    writeFileSync(file, JSON.stringify({ items: [] }, null, 2), 'utf8');
    return true;
  } catch {
    return false;
  }
}
