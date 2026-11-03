import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { apply } from '../index.js';
import { settingsFile } from '../lib/settings.js';

/**
 * 用最小 ctx 启动 Host 半边，收集注册出来的 RPC 路由。
 * @param {object} patchConfig 模拟 cordis.patch.yml 的 config
 * @returns {{fetchers: Map<string, Function>, tools: object[]}} 注册结果
 */
function bootstrap(patchConfig) {
  const fetchers = new Map();
  const tools = [];
  const ctx = {
    tools: {
      register: (tool) => {
        tools.push(tool);
        return () => {};
      },
    },
    effect: (factory) => {
      const dispose = factory();
      if (typeof dispose === 'function') dispose();
    },
    connection: {
      fetch: {
        register: (spec) => {
          fetchers.set(spec.path, spec.fetch);
          return () => {};
        },
      },
    },
    llm: undefined,
  };
  apply(ctx, patchConfig);
  return { fetchers, tools };
}

/**
 * 模拟一次面板 RPC。
 * @param {Map<string, Function>} fetchers 路由表
 * @param {string} endpoint 端点名
 * @param {object} payload 载荷
 * @returns {Promise<object>} 响应体
 */
async function rpc(fetchers, endpoint, payload = {}) {
  const fetcher = fetchers.get(`/api/log-insight/${endpoint}`);
  assert.ok(fetcher !== undefined, `缺少端点 ${endpoint}`);
  const request = new Request('http://localhost/api', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: 'r1', method: endpoint, payload }),
  });
  const response = await fetcher(request);
  return response.json();
}

/** 临时 DSH_HOME，避免读写真实用户目录。必须 await，否则清理会早于用例执行。 */
async function withHome(run) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'log-insight-rpc-'));
  const previous = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  try {
    return await run(home);
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previous;
    fs.rmSync(home, { recursive: true, force: true });
  }
}

test('空模板启动时视为未配置，面板能读到配置文件路径', async () => {
  await withHome(async () => {
    const { fetchers, tools } = bootstrap({});
    assert.ok(tools.length > 0);
    const res = await rpc(fetchers, 'settings-get');
    assert.equal(res.result.ok, true);
    assert.equal(res.result.value.settings.kibana.baseUrl, '');
    assert.equal(res.result.value.settings.kibana.hasPassword, false);
    assert.ok(res.result.value.path.endsWith(path.join('log-insight', 'settings.json')));

    const ping = await rpc(fetchers, 'ping');
    assert.equal(ping.result.value.configured, false);
  });
});

test('patch 里的凭据能生效，但密码不会回传到面板', async () => {
  await withHome(async () => {
    const { fetchers } = bootstrap({
      kibana: { baseUrl: 'https://kibana.example', username: 'u1', password: 'p1' },
      governance: { baseUrl: 'http://gw.example/smgr', username: 'u2', password: 'p2', projectId: 176 },
    });
    const res = await rpc(fetchers, 'settings-get');
    const settings = res.result.value.settings;
    assert.equal(settings.kibana.baseUrl, 'https://kibana.example');
    assert.equal(settings.kibana.username, 'u1');
    assert.equal(settings.kibana.password, '');
    assert.equal(settings.kibana.hasPassword, true);
    assert.equal(settings.governance.password, '');
    assert.equal(settings.governance.hasPassword, true);
    assert.equal(settings.governance.projectId, 176);
  });
});

test('保存设置会落盘，密码留空则保持原值', async () => {
  await withHome(async () => {
    const { fetchers } = bootstrap({
      kibana: { baseUrl: 'https://old.example', username: 'u1', password: 'p1' },
    });
    const saved = await rpc(fetchers, 'settings-save', {
      settings: {
        kibana: { baseUrl: 'https://new.example', username: 'u1', password: '' },
        defaults: { env: 'uat', windowMinutes: '45' },
      },
    });
    assert.equal(saved.result.ok, true);
    assert.equal(saved.result.value.settings.kibana.baseUrl, 'https://new.example');
    assert.equal(saved.result.value.settings.kibana.hasPassword, true);
    assert.equal(saved.result.value.settings.defaults.windowMinutes, 45);
    assert.equal(saved.result.value.settings.defaults.env, 'uat');

    const raw = JSON.parse(fs.readFileSync(settingsFile(), 'utf8'));
    assert.equal(raw.settings.kibana.password, 'p1');
    assert.equal(raw.settings.kibana.baseUrl, 'https://new.example');
  });
});

test('保存后重启实例，配置仍然生效', async () => {
  await withHome(async () => {
    const first = bootstrap({});
    await rpc(first.fetchers, 'settings-save', {
      settings: {
        kibana: { baseUrl: 'https://saved.example', username: 'viewer', password: 'secret' },
        projects: { 'hall-user': '/tmp/hall-userver' },
        analyzeSessionId: 'session-abc',
        llm: { provider: 'p', model: 'm' },
      },
    });

    const second = bootstrap({});
    const res = await rpc(second.fetchers, 'settings-get');
    const settings = res.result.value.settings;
    assert.equal(settings.kibana.baseUrl, 'https://saved.example');
    assert.equal(settings.kibana.username, 'viewer');
    assert.equal(settings.kibana.hasPassword, true);
    assert.deepEqual(settings.projects, { 'hall-user': '/tmp/hall-userver' });
    assert.equal(settings.analyzeSessionId, 'session-abc');
    assert.equal(settings.llm.model, 'm');

    const ping = await rpc(second.fetchers, 'ping');
    assert.equal(ping.result.value.configured, true);
  });
});

test('未填地址时自检直接报未配置，不会去打网络', async () => {
  await withHome(async () => {
    const { fetchers } = bootstrap({});
    const res = await rpc(fetchers, 'settings-test');
    const value = res.result.value;
    assert.equal(value.ok, true);
    assert.equal(value.kibana.ok, false);
    assert.match(value.kibana.reason, /未配置 Kibana 地址/);
    assert.equal(value.governance.ok, false);
    assert.match(value.governance.reason, /未配置服务治理地址/);
  });
});
