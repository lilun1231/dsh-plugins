import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** 审计日志的目录，与 DSH 数据目录放在一起。 */
function auditDir() {
  const dir = path.join(os.homedir(), '.dsh', 'log-insight');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** 审计文件路径。 */
function auditFile() {
  return path.join(auditDir(), 'audit.jsonl');
}

/**
 * 追加一条操作记录。写入失败不影响主流程。
 * @param {{source: string, action: string, params?: string, ok: boolean, durationMs?: number, total?: number, returned?: number, error?: string}} entry 记录内容
 * @returns {void}
 */
export function appendAudit(entry) {
  const line = JSON.stringify({ time: new Date().toISOString(), ...entry });
  try {
    fs.appendFileSync(auditFile(), `${line}\n`, 'utf8');
  } catch (error) {
    // 审计属于旁路能力，磁盘异常时只告警不阻断查询
    console.warn(`[log-insight] 审计写入失败: ${String(error?.message ?? error)}`);
  }
}

/**
 * 读取最近的操作记录，最新的在前。
 * @param {number} limit 最多返回条数
 * @returns {object[]} 记录列表
 */
export function readAudit(limit = 100) {
  try {
    if (!fs.existsSync(auditFile())) return [];
    const lines = fs.readFileSync(auditFile(), 'utf8').split('\n').filter((line) => line.trim() !== '');
    return lines.slice(-limit).map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        // 跳过损坏行，避免一条坏记录让整个历史不可用
        return null;
      }
    }).filter((item) => item !== null).reverse();
  } catch (error) {
    console.warn(`[log-insight] 审计读取失败: ${String(error?.message ?? error)}`);
    return [];
  }
}

/**
 * 把查询参数压成一行摘要，避免审计文件膨胀。
 * @param {object} payload 原始参数
 * @returns {string} 摘要
 */
export function summarizeParams(payload) {
  if (payload === null || payload === undefined) return '';
  const parts = [];
  const pick = (key, label) => {
    const value = payload[key];
    if (value === undefined || value === null || value === '') return;
    const text = Array.isArray(value) ? value.join(',') : String(value);
    parts.push(`${label}=${text.length > 60 ? `${text.slice(0, 60)}…` : text}`);
  };
  pick('keyword', 'kw');
  pick('services', 'svc');
  pick('service', 'svc');
  pick('level', 'lvl');
  pick('traceId', 'trace');
  pick('serialNo', 'serial');
  pick('uri', 'uri');
  pick('env', 'env');
  if (payload.limit !== undefined) parts.push(`limit=${payload.limit}`);
  return parts.join(' ');
}
