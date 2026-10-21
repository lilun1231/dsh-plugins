import { request } from './http.js';
import { CookieJar, extractInputValue } from './io.js';

/** Kibana OAuth 会话，负责登录与请求转发。 */
export class KibanaSession {
  /**
   * @param {{baseUrl: string, idp: string, username: string, password: string, insecure?: boolean}} config 连接配置
   */
  constructor(config) {
    this.config = config;
    this.jar = new CookieJar();
    this.loggedIn = false;
  }

  /**
   * 发起一次已认证请求，会话失效时自动重登一次。
   * @param {string} path 以 / 开头的路径
   * @param {string} body 请求体
   * @returns {Promise<{status: number, headers: Record<string, any>, body: string}>} 响应
   */
  async post(path, body) {
    if (!this.loggedIn) await this.login();
    let res = await this.send(path, body);
    if (res.status === 401 || this.looksLikeLoginPage(res)) {
      this.loggedIn = false;
      await this.login();
      res = await this.send(path, body);
    }
    return res;
  }

  /**
   * 判断响应是否被重定向到登录页。
   * @param {{status: number, headers: Record<string, any>}} res 响应
   * @returns {boolean} 是否为登录页
   */
  looksLikeLoginPage(res) {
    const location = String(res.headers?.location ?? '');
    return res.status === 302 && /oauth|login/i.test(location);
  }

  /**
   * 发送原始请求。
   * @param {string} path 路径
   * @param {string} body 请求体
   * @returns {Promise<{status: number, headers: Record<string, any>, body: string}>} 响应
   */
  send(path, body) {
    return request(`${this.config.baseUrl}${path}`, {
      method: 'POST',
      headers: {
        'kbn-xsrf': 'true',
        'Content-Type': 'application/json',
        cookie: this.jar.header(),
      },
      body,
      insecure: this.config.insecure !== false,
    });
  }

  /** 完成 OpenShift OAuth 登录。 */
  async login() {
    const { baseUrl, idp, username, password, insecure } = this.config;
    const opts = { insecure: insecure !== false };

    // 第一步：拿到授权地址
    const root = await request(`${baseUrl}/`, { ...opts, headers: { cookie: this.jar.header() } });
    this.jar.collect(root.headers['set-cookie']);
    const authorizeUrl = root.headers.location;
    if (!authorizeUrl) throw new Error('Kibana 未返回授权跳转地址');
    const oauthOrigin = new URL(authorizeUrl).origin;

    // 第二步：指定 IdP，并跟随跳转直到拿到真正的登录表单
    const idpUrl = `${authorizeUrl}&idp=${encodeURIComponent(idp)}`;
    let pageUrl = idpUrl;
    let page = await request(pageUrl, { ...opts, headers: { cookie: this.jar.header() } });
    this.jar.collect(page.headers['set-cookie']);

    for (let i = 0; i < 5 && page.status >= 300 && page.status < 400 && page.headers.location; i += 1) {
      pageUrl = new URL(page.headers.location, oauthOrigin).toString();
      page = await request(pageUrl, { ...opts, headers: { cookie: this.jar.header() } });
      this.jar.collect(page.headers['set-cookie']);
    }

    const csrf = extractInputValue(page.body, 'csrf');
    const then = extractInputValue(page.body, 'then');
    if (!csrf || !then) throw new Error('登录页缺少 csrf 或 then，可能是 IdP 配置变更');

    // 第三步：提交账号密码
    const form = new URLSearchParams({ csrf, then, username, password }).toString();
    const loginPost = await request(pageUrl, {
      ...opts,
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        cookie: this.jar.header(),
      },
      body: form,
    });
    this.jar.collect(loginPost.headers['set-cookie']);

    // 第四步：跟随回调，直到会话 Cookie 落地
    let next = loginPost.headers.location;
    let currentUrl = pageUrl;
    for (let i = 0; next && i < 8; i += 1) {
      currentUrl = new URL(next, oauthOrigin).toString();
      const hop = await request(currentUrl, { ...opts, headers: { cookie: this.jar.header() } });
      this.jar.collect(hop.headers['set-cookie']);
      next = hop.headers.location;
    }

    if (this.jar.store.size === 0) {
      throw new Error('Kibana 登录失败，未获得会话 Cookie');
    }
    this.loggedIn = true;
  }
}
