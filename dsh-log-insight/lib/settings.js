import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * 用户设置存储。
 *
 * 插件仓库里只带空模板：内网地址、账号、密码、个人路径这些都属于「本机私有配置」，
 * 一律不进代码仓库。真实值由面板「设置」页写入本文件（权限 0600）：
 *
 *   $DSH_HOME/log-insight/settings.json   默认 ~/.dsh/log-insight/settings.json
 *
 * 读取优先级：内置默认值 ← cordis.patch.yml 的 config ← settings.json。
 * 面板保存后 settings.json 成为快照，覆盖前两层的同名字段。
 */

/** DSH 数据目录：优先 DSH_HOME，否则 ~/.dsh。 */
function dshHome() {
  const fromEnv = typeof process.env.DSH_HOME === 'string' ? process.env.DSH_HOME.trim() : '';
  return fromEnv !== '' ? fromEnv : path.join(os.homedir(), '.dsh');
}

/** 本插件的数据目录。 */
export function settingsDir() {
  return path.join(dshHome(), 'log-insight');
}

/** 设置文件路径，面板会显示给用户。 */
export function settingsFile() {
  return path.join(settingsDir(), 'settings.json');
}

/** 内置默认值：所有凭据为空，保证仓库里的模板不会指向任何真实环境。 */
export const BUILTIN_DEFAULTS = Object.freeze({
  kibana: {
    baseUrl: '',
    idp: 'htpasswd-viewer',
    username: '',
    password: '',
    index: 'app-*',
    insecure: true,
    namespaceByEnv: { fat: '', uat: '', dev: '' },
  },
  governance: {
    baseUrl: '',
    hibbertBaseUrl: '',
    username: '',
    password: '',
    projectId: 0,
    projectName: '',
    datacenterHeader: '',
  },
  defaults: {
    env: 'fat',
    windowMinutes: 30,
    maxSpanHours: 168,
    maxHits: 200,
    exportLimit: 2000,
    exportDir: '',
    timezone: 'Asia/Shanghai',
  },
  projects: {},
  llm: { provider: '', model: '' },
  analyzeSessionId: '',
});

/** 需要脱敏展示的字段：[分组, 字段]。 */
const SECRET_FIELDS = [
  ['kibana', 'password'],
  ['governance', 'password'],
];

/** 判断是否为普通对象（不含数组）。 */
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * 深拷贝配置值，保证合并结果与原对象不共享引用（避免脱敏时改到生效配置本身）。
 * @param {any} value 任意配置值
 * @returns {any} 副本
 */
function deepClone(value) {
  if (Array.isArray(value)) return value.map((item) => deepClone(item));
  if (!isPlainObject(value)) return value;
  const out = {};
  for (const [key, item] of Object.entries(value)) out[key] = deepClone(item);
  return out;
}

/**
 * 深合并：`over` 覆盖 `base`，undefined 不覆盖。对象递归，其余整体替换，结果不与入参共享引用。
 * @param {object} base 基础值
 * @param {object} over 覆盖值
 * @returns {object} 合并结果
 */
export function mergeConfig(base, over) {
  const out = {};
  if (isPlainObject(base)) {
    for (const [key, value] of Object.entries(base)) out[key] = deepClone(value);
  }
  if (!isPlainObject(over)) return out;
  for (const [key, value] of Object.entries(over)) {
    if (value === undefined) continue;
    out[key] = isPlainObject(value) && isPlainObject(out[key]) ? mergeConfig(out[key], value) : deepClone(value);
  }
  return out;
}

/**
 * 读取 settings.json。文件不存在或损坏时返回空对象，不影响插件启动。
 * @returns {object} 已保存的设置
 */
export function readSettings() {
  try {
    const file = settingsFile();
    if (!fs.existsSync(file)) return {};
    const raw = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw);
    // 兼容两种落盘形态：直接存 settings，或包一层 { version, settings }
    const body = isPlainObject(parsed?.settings) ? parsed.settings : parsed;
    return isPlainObject(body) ? body : {};
  } catch (error) {
    console.warn(`[log-insight] 设置读取失败，回退到 patch 配置: ${String(error?.message ?? error)}`);
    return {};
  }
}

/**
 * 原子写入 settings.json，并以 0600 权限保存（内含明文密码）。
 * @param {object} settings 要保存的设置
 * @returns {{path: string}} 写入结果
 */
export function writeSettings(settings) {
  const dir = settingsDir();
  fs.mkdirSync(dir, { recursive: true });
  const file = settingsFile();
  const tmp = `${file}.tmp`;
  const body = JSON.stringify({ version: 1, updatedAt: new Date().toISOString(), settings }, null, 2);
  fs.writeFileSync(tmp, body, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, file);
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    // 某些文件系统不支持 chmod，写入本身已成功
  }
  return { path: file };
}

/**
 * 计算生效配置：默认值 ← patch config ← settings.json。
 * @param {object} patchConfig cordis.patch.yml 里的 config
 * @param {object} stored 已保存的设置
 * @returns {object} 生效配置
 */
export function resolveConfig(patchConfig, stored) {
  const withPatch = mergeConfig(BUILTIN_DEFAULTS, patchConfig ?? {});
  return mergeConfig(withPatch, stored ?? {});
}

/**
 * 生成可下发给面板的副本：密码清空并附带 hasPassword 标记，避免密码回流到浏览器。
 * @param {object} config 生效配置
 * @returns {object} 脱敏副本
 */
export function maskSecrets(config) {
  const out = mergeConfig({}, config);
  for (const [group, field] of SECRET_FIELDS) {
    const target = out[group];
    if (!isPlainObject(target)) continue;
    const hasValue = typeof target[field] === 'string' && target[field] !== '';
    target[field] = '';
    if (field === 'password') target.hasPassword = hasValue;
  }
  return out;
}

/**
 * 把面板提交的值合并进当前配置。
 *
 * 密码留空表示「保持不变」（面板不会拿到原密码，无法回填）；
 * 需要显式清空时由面板传 `clearSecrets: ['kibana']`。
 *
 * @param {object} current 当前生效配置
 * @param {object} incoming 面板提交的配置
 * @returns {object} 合并后的完整配置
 */
export function applyIncoming(current, incoming) {
  const clear = Array.isArray(incoming?.clearSecrets) ? incoming.clearSecrets : [];
  const body = mergeConfig({}, incoming ?? {});
  delete body.clearSecrets;
  for (const [group, field] of SECRET_FIELDS) {
    if (clear.includes(group)) {
      if (!isPlainObject(body[group])) body[group] = {};
      body[group][field] = '';
      continue;
    }
    const given = isPlainObject(body[group]) ? body[group][field] : undefined;
    if (typeof given !== 'string' || given === '') {
      const kept = isPlainObject(current?.[group]) ? current[group][field] : '';
      if (isPlainObject(body[group])) body[group][field] = typeof kept === 'string' ? kept : '';
    }
  }
  const next = mergeConfig(current, body);
  // hasPassword 只用于展示，不落盘
  for (const [group] of SECRET_FIELDS) {
    if (isPlainObject(next[group])) delete next[group].hasPassword;
  }
  return next;
}

/**
 * 数字字段归一：面板提交的是字符串，空值回落到默认值。
 * @param {object} incoming 面板提交的配置
 * @returns {object} 归一后的副本
 */
export function normalizeNumbers(incoming) {
  const body = mergeConfig({}, incoming ?? {});
  const numeric = [
    ['governance', 'projectId', 0],
    ['defaults', 'windowMinutes', BUILTIN_DEFAULTS.defaults.windowMinutes],
    ['defaults', 'maxSpanHours', BUILTIN_DEFAULTS.defaults.maxSpanHours],
    ['defaults', 'maxHits', BUILTIN_DEFAULTS.defaults.maxHits],
    ['defaults', 'exportLimit', BUILTIN_DEFAULTS.defaults.exportLimit],
  ];
  for (const [group, field, fallback] of numeric) {
    if (!isPlainObject(body[group])) continue;
    const raw = body[group][field];
    if (raw === undefined) continue;
    const num = Number(raw);
    body[group][field] = Number.isFinite(num) && num > 0 ? num : fallback;
  }
  if (isPlainObject(body.kibana) && body.kibana.insecure !== undefined) {
    body.kibana.insecure = body.kibana.insecure !== false && body.kibana.insecure !== 'false';
  }
  return body;
}
