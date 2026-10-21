/** Cookie 管理、HTML 实体解码与表单值提取。 */

/** 极简 Cookie 容器，按名去重，保持插入顺序。 */
export class CookieJar {
  constructor() {
    /** @type {Map<string, string>} */
    this.store = new Map();
  }

  /**
   * 从 Set-Cookie 响应头收集 Cookie。
   * @param {string[]} setCookies 响应头数组
   */
  collect(setCookies) {
    for (const raw of setCookies ?? []) {
      const [pair] = raw.split(';');
      const idx = pair.indexOf('=');
      if (idx <= 0) continue;
      const key = pair.slice(0, idx).trim();
      const value = pair.slice(idx + 1).trim();
      this.store.set(key, value);
    }
  }

  /**
   * 序列化为 Cookie 请求头。
   * @returns {string} 形如 a=1; b=2
   */
  header() {
    return [...this.store.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  /**
   * 读取单个 Cookie 值。
   * @param {string} key Cookie 名
   * @returns {string|undefined} 值
   */
  get(key) {
    return this.store.get(key);
  }
}

/** 需要解码的 HTML 实体表。 */
const ENTITIES = new Map([
  ['amp', '&'],
  ['lt', '<'],
  ['gt', '>'],
  ['quot', '"'],
  ['#39', "'"],
  ['#x27', "'"],
  ['#43', '+'],
  ['#x2B', '+'],
]);

/**
 * 解码 HTML 实体。OAuth 流程里 &#43; 未解码会污染 state 参数。
 * @param {string} text 原始文本
 * @returns {string} 解码结果
 */
export function decodeHtml(text) {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body) => {
    const hit = ENTITIES.get(body) ?? ENTITIES.get(body.toLowerCase());
    return hit ?? whole;
  });
}

/**
 * 提取指定 name 的 input 元素 value，并做实体解码。
 * @param {string} html 页面内容
 * @param {string} name input 的 name
 * @returns {string|null} 值，未找到返回 null
 */
export function extractInputValue(html, name) {
  const re = new RegExp(`<input[^>]*name=["']${name}["'][^>]*>`, 'i');
  const tag = html.match(re);
  if (!tag) return null;
  const valueMatch = tag[0].match(/value=["']([^"']*)["']/i);
  return valueMatch ? decodeHtml(valueMatch[1]) : null;
}
