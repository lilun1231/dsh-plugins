import http from 'node:http';
import https from 'node:https';

/**
 * 显式 Agent。
 * Node 的 NODE_USE_ENV_PROXY=1 会让内置 HTTP 客户端走环境代理，
 * 而内网平台（Kibana、服务治理）必须直连，因此这里显式指定 Agent 绕开。
 */
const HTTPS_AGENT_SECURE = new https.Agent({ rejectUnauthorized: true });
const HTTPS_AGENT_INSECURE = new https.Agent({ rejectUnauthorized: false });
const HTTP_AGENT = new http.Agent();

/**
 * 发起一次 HTTP(S) 请求，不自动跟随重定向，便于精确控制认证流程。
 * @param {string} url 完整地址
 * @param {{method?: string, headers?: Record<string,string>, body?: string|Buffer, timeoutMs?: number, insecure?: boolean}} [options] 请求选项
 * @returns {Promise<{status: number, headers: Record<string, any>, body: string}>} 响应
 */
export function request(url, options = {}) {
  const {
    method = 'GET',
    headers = {},
    body,
    timeoutMs = 20000,
    insecure = false,
  } = options;

  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const isHttps = target.protocol === 'https:';
    const mod = isHttps ? https : http;
    const agent = isHttps
      ? (insecure ? HTTPS_AGENT_INSECURE : HTTPS_AGENT_SECURE)
      : HTTP_AGENT;

    const req = mod.request(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port || (isHttps ? 443 : 80),
        path: `${target.pathname}${target.search}`,
        method,
        headers,
        agent,
        timeout: timeoutMs,
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          });
        });
      },
    );
    req.on('timeout', () => req.destroy(new Error(`请求超时：${url}`)));
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}
