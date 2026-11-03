import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  BUILTIN_DEFAULTS,
  applyIncoming,
  maskSecrets,
  mergeConfig,
  normalizeNumbers,
  readSettings,
  resolveConfig,
  settingsFile,
  writeSettings,
} from '../lib/settings.js';

/** 临时 DSH_HOME，避免读写真实用户目录。 */
function withHome(run) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'log-insight-home-'));
  const previous = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  try {
    return run(home);
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previous;
    fs.rmSync(home, { recursive: true, force: true });
  }
}

test('合并配置时对象递归覆盖，undefined 不覆盖', () => {
  const merged = mergeConfig(
    { kibana: { baseUrl: 'a', insecure: true }, defaults: { env: 'fat' } },
    { kibana: { baseUrl: 'b' }, extra: undefined },
  );
  assert.equal(merged.kibana.baseUrl, 'b');
  assert.equal(merged.kibana.insecure, true);
  assert.equal(merged.defaults.env, 'fat');
  assert.equal('extra' in merged, false);
});

test('合并结果不与入参共享引用', () => {
  const base = { kibana: { password: 'secret' } };
  const merged = mergeConfig(base, {});
  merged.kibana.password = 'changed';
  assert.equal(base.kibana.password, 'secret');
});

test('默认模板不含任何凭据', () => {
  const resolved = resolveConfig({}, {});
  assert.equal(resolved.kibana.username, '');
  assert.equal(resolved.kibana.password, '');
  assert.equal(resolved.governance.username, '');
  assert.equal(resolved.governance.password, '');
  assert.equal(resolved.governance.baseUrl, '');
  assert.deepEqual(resolved.projects, {});
  assert.equal(BUILTIN_DEFAULTS.kibana.insecure, true);
});

test('settings.json 覆盖 patch 配置', () => {
  const resolved = resolveConfig(
    { kibana: { baseUrl: 'https://from-patch', username: 'u1' } },
    { kibana: { baseUrl: 'https://from-file' } },
  );
  assert.equal(resolved.kibana.baseUrl, 'https://from-file');
  assert.equal(resolved.kibana.username, 'u1');
});

test('脱敏后密码为空且带 hasPassword 标记，原配置不被改写', () => {
  const config = { kibana: { password: 'p1' }, governance: { password: 'p2' } };
  const masked = maskSecrets(config);
  assert.equal(masked.kibana.password, '');
  assert.equal(masked.kibana.hasPassword, true);
  assert.equal(masked.governance.password, '');
  assert.equal(masked.governance.hasPassword, true);
  assert.equal(config.kibana.password, 'p1');
});

test('密码留空表示保持不变，clearSecrets 可显式清空', () => {
  const current = { kibana: { password: 'old-k' }, governance: { password: 'old-g' } };
  const kept = applyIncoming(current, { kibana: { password: '', baseUrl: 'https://x' } });
  assert.equal(kept.kibana.password, 'old-k');
  assert.equal(kept.kibana.baseUrl, 'https://x');
  assert.equal(kept.governance.password, 'old-g');

  const cleared = applyIncoming(current, { clearSecrets: ['kibana'] });
  assert.equal(cleared.kibana.password, '');
  assert.equal(cleared.governance.password, 'old-g');
  assert.equal('clearSecrets' in cleared, false);
});

test('新密码能覆盖旧值，且 hasPassword 不落盘', () => {
  const current = { kibana: { password: 'old' } };
  const next = applyIncoming(current, { kibana: { password: 'new', hasPassword: true } });
  assert.equal(next.kibana.password, 'new');
  assert.equal('hasPassword' in next.kibana, false);
  assert.equal(current.kibana.password, 'old');
});

test('数字字段归一：字符串转数字，非法值回落默认', () => {
  const body = normalizeNumbers({
    governance: { projectId: '176' },
    defaults: { windowMinutes: '60', maxHits: 'abc' },
  });
  assert.equal(body.governance.projectId, 176);
  assert.equal(body.defaults.windowMinutes, 60);
  assert.equal(body.defaults.maxHits, BUILTIN_DEFAULTS.defaults.maxHits);
});

test('设置文件落到 DSH_HOME 且可往返读写', () => {
  withHome(() => {
    const expected = settingsFile();
    assert.ok(expected.endsWith(path.join('log-insight', 'settings.json')));
    assert.deepEqual(readSettings(), {});

    writeSettings({ kibana: { baseUrl: 'https://k', password: 'p' } });
    const loaded = readSettings();
    assert.equal(loaded.kibana.baseUrl, 'https://k');
    assert.equal(loaded.kibana.password, 'p');
    const mode = fs.statSync(expected).mode & 0o777;
    assert.equal(mode, 0o600);
  });
});

test('设置文件损坏时回退为空对象，不影响启动', () => {
  withHome(() => {
    fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
    fs.writeFileSync(settingsFile(), '{ not json', 'utf8');
    assert.deepEqual(readSettings(), {});
  });
});
