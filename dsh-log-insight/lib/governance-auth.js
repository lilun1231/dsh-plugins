import crypto from 'node:crypto';
import { request } from './http.js';
import { CookieJar } from './io.js';

/**
 * 把裸 base64 公钥包装成 PEM。
 * @param {string} base64 公钥内容
 * @param {'spki'|'pkcs1'} kind 公钥格式
 * @returns {string} PEM 文本
 */
function toPem(base64, kind = 'spki') {
  const lines = base64.replace(/\s+/g, '').match(/.{1,64}/g) ?? [];
  const label = kind === 'pkcs1' ? 'RSA PUBLIC KEY' : 'PUBLIC KEY';
  return `-----BEGIN ${label}-----\n${lines.join('\n')}\n-----END ${label}-----`;
}

/** 服务治理会话：RSA 登录、nonce 管理、请求封装。 */
export class GovernanceSession {
  /**
   * @param {{baseUrl: string, username: string, password: string, datacenterHeader?: string}} config 连接配置
   */
  constructor(config) {
    this.config = config;
    this.jar = new CookieJar();
    this.nonce = null;
  }

  /**
   * 用公钥加密密码，兼容 SPKI 与 PKCS#1 两种公钥格式。
   * @param {string} publicKey 裸 base64 公钥
   * @param {string} password 明文密码
   * @returns {string} base64 密文
   */
  encryptPassword(publicKey, password) {
    for (const kind of ['spki', 'pkcs1']) {
      try {
        return crypto.publicEncrypt(
          { key: toPem(publicKey, kind), padding: crypto.constants.RSA_PKCS1_PADDING },
          Buffer.from(password),
        ).toString('base64');
      } catch {
        // 换下一种格式重试
      }
    }
    throw new Error('公钥格式无法识别，密码加密失败');
  }

  /** 完成登录，获取 nonce。 */
  async login() {
    const { baseUrl, username, password, datacenterHeader } = this.config;
    const baseHeaders = { 'x-fwzl-datacenter': datacenterHeader ?? 'bh' };

    const init = await request(`${baseUrl}/front/loginsession`, { method: 'POST', headers: baseHeaders });
    this.jar.collect(init.headers['set-cookie']);
    const initBody = JSON.parse(init.body);
    const publicKey = initBody.respbody?.publicKey;
    const uuid = initBody.respbody?.uuid;
    if (!publicKey || !uuid) throw new Error('服务治理未返回公钥或会话标识');

    const encrypted = this.encryptPassword(publicKey, password);
    const form = new URLSearchParams({ username, uuid, password: encrypted }).toString();
    const loginRes = await request(`${baseUrl}/front/pclogin`, {
      method: 'POST',
      headers: {
        ...baseHeaders,
        'Content-Type': 'application/x-www-form-urlencoded',
        cookie: this.jar.header(),
      },
      body: form,
    });
    this.jar.collect(loginRes.headers['set-cookie']);
    const loginBody = JSON.parse(loginRes.body);
    if (loginBody.resphead?.succeed !== true) {
      throw new Error(`服务治理登录失败：${loginBody.resphead?.message ?? '未知原因'}`);
    }
    this.nonce = loginBody.respbody?.nonce;
    if (!this.nonce) throw new Error('登录成功但未返回 nonce');
  }

  /**
   * 发起 GET 请求，自动带 nonce 与 Cookie，会话过期时自动重登一次。
   * @param {string} path 以 / 开头的路径
   * @param {Record<string, string|number>} query 查询参数
   * @returns {Promise<any>} 解析后的响应体
   */
  async get(path, query) {
    if (!this.nonce) await this.login();
    let payload = await this.send(path, query);
    if (payload.resphead?.succeed !== true && /登录|nonce|超时/i.test(payload.resphead?.message ?? '')) {
      this.nonce = null;
      await this.login();
      payload = await this.send(path, query);
    }
    return payload;
  }

  /**
   * 发送一次请求并解析 JSON。
   * @param {string} path 路径
   * @param {Record<string, string|number>} query 查询参数
   * @returns {Promise<any>} 响应体
   */
  async send(path, query) {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query ?? {})) {
      params.set(key, String(value));
    }
    params.set('nonce', this.nonce);
    const res = await request(`${this.config.baseUrl}${path}?${params.toString()}`, {
      headers: {
        'x-fwzl-datacenter': this.config.datacenterHeader ?? 'bh',
        cookie: this.jar.header(),
      },
    });
    try {
      return JSON.parse(res.body);
    } catch {
      throw new Error(`服务治理返回非 JSON：HTTP ${res.status} ${res.body.slice(0, 120)}`);
    }
  }
}
