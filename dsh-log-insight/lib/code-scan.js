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
  const tails = [];
  for (const size of [4, 3, 2]) {
    if (segments.length >= size) tails.push(segments.slice(-size).join('/'));
  }
  return [...new Set([trimmed, noLeading, ...tails].filter((item) => item !== ''))];
}

/**
 * 挑选最像接口入口的命中项：优先 Controller，其次带 Mapping 注解的行。
 * @param {Array<{file: string, line: number, text: string}>} hits 命中列表
 * @returns {{file: string, line: number, text: string} | null} 选中项
 */
export function pickEndpoint(hits, uri = '') {
  if (!Array.isArray(hits) || hits.length === 0) return null;
  const annotated = hits.filter((hit) => /Mapping\(|RequestMapping|PostMapping|GetMapping/.test(hit.text));
  const pool = annotated.length > 0 ? annotated : hits;
  const controllers = pool.filter((hit) => hit.file.includes('Controller'));
  const candidates = controllers.length > 0 ? controllers : pool;

  // 用 URI 里的路径词给候选打分，避免选到只是恰巧含相同尾段的其它 Controller
  const tokens = String(uri)
    .split(/[^A-Za-z0-9]+/)
    .map((token) => token.toLowerCase())
    .filter((token) => token.length >= 4);
  const scoreOf = (hit) => tokens.filter((token) => hit.file.toLowerCase().includes(token)).length;
  let best = candidates[0];
  let bestScore = scoreOf(best);
  for (const hit of candidates) {
    const score = scoreOf(hit);
    if (score > bestScore) {
      best = hit;
      bestScore = score;
    }
  }
  return best;
}

/**
 * 从变量名推测实现类文件名，并在仓库里定位它。
 * 例如 hPageItemEntranceService → 搜 *HPageItemEntrance*Service.java。
 * @param {string} root 仓库根目录
 * @param {string} varName 变量名或接口名
 * @returns {string | null} 文件绝对路径
 */
/** 每个仓库只遍历一次 Java 文件清单，后续匹配走内存。 */
const javaFileCache = new Map();

/**
 * 取仓库内全部 Java 文件（排除测试目录），带缓存。
 * @param {string} root 仓库根目录
 * @returns {string[]} 文件绝对路径列表
 */
export function listJavaFiles(root) {
  if (javaFileCache.has(root)) return javaFileCache.get(root);
  let files = [];
  try {
    const out = execFileSync('find', [root, '-name', '*.java', '-not', '-path', '*/test/*'], {
      encoding: 'utf8',
      timeout: 25000,
      maxBuffer: 32 * 1024 * 1024,
    });
    files = out.split('\n').filter((file) => file.endsWith('.java'));
  } catch {
    files = [];
  }
  javaFileCache.set(root, files);
  return files;
}

export function findClassFile(root, varName) {
  if (typeof varName !== 'string' || varName === '') return null;
  const base = varName.replace(/^I(?=[A-Z])/, '').replace(/Service$/, '');
  const camel = base.charAt(0).toUpperCase() + base.slice(1);
  if (camel === '') return null;
  const files = listJavaFiles(root).filter((file) => file.includes(camel));
  const impl = files.find((file) => /(Impl|Service)\.java$/.test(file) && !/Abstract/.test(file));
  return impl ?? files[0] ?? null;
}

/**
 * 从代码片段提取被调用的服务变量名与注入的接口名。
 * @param {string} snippet 代码片段
 * @returns {string[]} 变量名/接口名列表
 */
export function extractServiceVars(snippet) {
  const names = new Set();
  const called = /\b(\w+Service)\.(\w+)\(/g;
  let matched;
  while ((matched = called.exec(snippet)) !== null) {
    names.add(matched[1]);
    if (names.size >= 6) break;
  }
  const injected = /\b(I[A-Z]\w+Service)\s+\w+/g;
  while ((matched = injected.exec(snippet)) !== null) {
    names.add(matched[1]);
    if (names.size >= 10) break;
  }
  return [...names];
}

/**
 * 提取代码里声明的 Lisa/Dubbo 服务名（@LisaService(name = "...")）。
 * @param {string} snippet 代码片段
 * @returns {string[]} 服务名列表
 */
export function extractLisaNames(snippet) {
  const names = new Set();
  const pattern = /@LisaService\s*\(\s*name\s*=\s*"([^"]+)"/g;
  let matched;
  while ((matched = pattern.exec(snippet)) !== null) {
    names.add(matched[1]);
    if (names.size >= 6) break;
  }
  return [...names];
}

/**
 * 从服务名推导可搜索的短名，用于定位生成配置或实现类。
 * hall_app_newShareListInfoQryEntranceService → newShareListInfoQryEntranceService
 * @param {string} name 完整服务名
 * @returns {string} 短名
 */
export function shortServiceName(name) {
  return String(name ?? '').replace(/^hall_(app|user|acct|biz)_/, '');
}

/**
 * 一次搜索多个关键字，避免重复遍历仓库。
 * @param {string} root 仓库根目录
 * @param {string[]} keywords 关键字列表
 * @param {number} limit 最多返回条数
 * @returns {Array<{file: string, line: number, text: string}>} 命中列表
 */
export function searchJavaMany(root, keywords, limit = 30) {
  if (typeof root !== 'string' || root === '' || !existsSync(root)) return [];
  const usable = keywords.filter((item) => typeof item === 'string' && item.trim() !== '');
  if (usable.length === 0) return [];
  try {
    const out = execFileSync('grep', ['-rn', '--include=*.java', '-F', ...usable.flatMap((k) => ['-e', k]), root], {
      encoding: 'utf8',
      timeout: 25000,
      maxBuffer: 8 * 1024 * 1024,
    });
    const hits = [];
    for (const line of out.split('\n')) {
      if (hits.length >= limit) break;
      const matched = line.match(/^(.+?):(\d+):(.*)$/);
      if (matched !== null) hits.push({ file: matched[1], line: Number(matched[2]), text: matched[3].trim() });
    }
    return hits;
  } catch {
    return [];
  }
}
