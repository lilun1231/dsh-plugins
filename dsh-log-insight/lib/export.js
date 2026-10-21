import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { buildSearchBody, searchLogs } from './kibana-query.js';

/**
 * 解析导出目录，未配置时落到系统临时目录。
 * @param {string|undefined} configured 配置的目录
 * @returns {string} 实际目录，确保存在
 */
export function resolveExportDir(configured) {
  const dir = configured && configured.length > 0
    ? configured
    : path.join(os.tmpdir(), 'dsh-log-exports');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * 分段拉取日志，突破单次返回条数限制。
 * @param {import('./kibana-auth.js').KibanaSession} session Kibana 会话
 * @param {{index: string, namespace: string, keyword?: string, services?: string[], level?: string, traceId?: string, from: Date, to: Date, limit: number}} input 查询条件
 * @returns {Promise<object[]>} 日志条目
 */
export async function fetchAllLogs(session, input) {
  const pageSize = Math.min(input.limit, 200);
  const collected = [];
  for (let offset = 0; offset < input.limit; offset += pageSize) {
    const size = Math.min(pageSize, input.limit - offset);
    const body = buildSearchBody({ ...input, limit: size });
    body.from = offset;
    const result = await searchLogs(session, { index: input.index, body });
    collected.push(...result.hits);
    if (result.hits.length < size) break;
  }
  return collected.slice(0, input.limit);
}

/**
 * CSV 字段转义。
 * @param {unknown} value 原始值
 * @returns {string} 转义后的字段
 */
function csvCell(value) {
  const text = value === undefined || value === null ? '' : String(value);
  return `"${text.replace(/"/g, '""').replace(/\r?\n/g, ' ')}"`;
}

/**
 * 写日志导出文件。
 * @param {{dir: string, env: string, keyword?: string, from: Date, to: Date, hits: object[], format: string}} input 导出参数
 * @returns {{path: string, exported: number}} 导出结果
 */
export function writeLogExport(input) {
  const stamp = (d) => d.toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const base = `${input.env}-${(input.keyword ?? 'all').replace(/[^\w-]/g, '_')}-${stamp(input.from)}-${stamp(input.to)}`;
  const file = path.join(input.dir, `${base}.${input.format === 'jsonl' ? 'jsonl' : 'csv'}`);

  if (input.format === 'jsonl') {
    const lines = input.hits.map((hit) => JSON.stringify(hit));
    fs.writeFileSync(file, `${lines.join('\n')}\n`, 'utf8');
  } else {
    const header = 'timestamp,service,level,traceId,message';
    const rows = input.hits.map((hit) => [
      csvCell(hit.timestamp),
      csvCell(hit.service),
      csvCell(hit.level),
      csvCell(hit.traceId),
      csvCell(hit.message),
    ].join(','));
    fs.writeFileSync(file, `${header}\n${rows.join('\n')}\n`, 'utf8');
  }
  return { path: file, exported: input.hits.length };
}
