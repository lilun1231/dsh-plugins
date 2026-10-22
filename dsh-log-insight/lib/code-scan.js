/**
 * 代码扫描：在本地 Java 仓库里按接口路径定位 Controller，并提取上下文片段，
 * 供模型分析接口执行逻辑。
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';

/**
 * 在仓库里按固定字符串搜索 Java 文件，返回命中位置。
 * @param {string} root 仓库根目录
 * @param {string} keyword 关键字
 * @param {number} limit 最多返回条数
 * @returns {Array<{file: string, line: number, text: string}>} 命中列表
 */
export function searchJava(root, keyword, limit = 20) {
  if (typeof root !== 'string' || root === '' || !existsSync(root)) return [];
  if (typeof keyword !== 'string' || keyword.trim() === '') return [];
  try {
    const out = execFileSync('grep', ['-rn', '--include=*.java', '-F', keyword, root, '-m', '20'], {
      encoding: 'utf8',
      timeout: 20000,
      maxBuffer: 8 * 1024 * 1024,
    });
    const hits = [];
    for (const line of out.split('\n')) {
      if (hits.length >= limit) break;
      const matched = line.match(/^(.+?):(\d+):(.*)$/);
      if (matched !== null) {
        hits.push({ file: matched[1], line: Number(matched[2]), text: matched[3].trim() });
      }
    }
    return hits;
  } catch {
    // grep 无命中时以非 0 退出，属于正常情况
    return [];
  }
}

/**
 * 读取命中行附近的代码片段。
 * @param {string} file 文件绝对路径
 * @param {number} line 命中行号（1 基）
 * @param {number} before 向上取多少行
 * @param {number} after 向下取多少行
 * @returns {{snippet: string, totalLines: number, startLine: number}} 片段与行数
 */
export function readSnippet(file, line, before = 10, after = 140) {
  const text = readFileSync(file, 'utf8');
  const lines = text.split('\n');
  const start = Math.max(0, line - 1 - before);
  const end = Math.min(lines.length, line + after);
  return {
    snippet: lines.slice(start, end).join('\n'),
    totalLines: lines.length,
    startLine: start + 1,
  };
}

/**
 * 按接口路径生成一组由严到宽的搜索关键字。
 * @param {string} uri 接口路径
 * @returns {string[]} 关键字列表
 */
export function buildKeywords(uri) {
  const trimmed = String(uri ?? '').trim();
  if (trimmed === '') return [];
  const noLeading = trimmed.replace(/^\/+/, '');
  const segments = trimmed.split('/').filter((part) => part !== '');
  const tail = segments.length >= 2 ? segments.slice(-2).join('/') : (segments[segments.length - 1] ?? '');
  return [...new Set([trimmed, noLeading, tail].filter((item) => item !== ''))];
}

/**
 * 挑选最像接口入口的命中项：优先 Controller，其次带 Mapping 注解的行。
 * @param {Array<{file: string, line: number, text: string}>} hits 命中列表
 * @returns {{file: string, line: number, text: string} | null} 选中项
 */
export function pickEndpoint(hits) {
  if (!Array.isArray(hits) || hits.length === 0) return null;
  const annotated = hits.filter((hit) => /Mapping\(|RequestMapping|PostMapping|GetMapping/.test(hit.text));
  const pool = annotated.length > 0 ? annotated : hits;
  const controller = pool.filter((hit) => hit.file.includes('Controller'));
  return (controller.length > 0 ? controller : pool)[0] ?? null;
}
