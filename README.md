# dsh-plugins

DSH（DeepSeek Harness）插件集合，每个插件一个目录。

| 插件 | 说明 |
|---|---|
| [`dsh-log-insight`](./dsh-log-insight) | 日志洞察：查 Kibana 日志、拉调用链树、聚合服务状态、导出；面板含设置页 |

## 约定

- **仓库里不放任何真实凭据。** 内网地址、账号密码、本机路径由插件自己的设置页写到
  `$DSH_HOME/<plugin>/settings.json`（权限 0600），或由使用者在 profile 的 `cordis.patch.yml`
  里按 id 覆盖；插件自带的 `cordis.patch.yml` 只保留空模板。
- 每个插件目录自成一体：`package.json`（含 `dsh.bundle.patch` 与 `dsh.client`）、
  `cordis.patch.yml`、`index.js`（Host）、`client.js`（Web 面板）、`lib/`、`test/`。

## 安装某个插件

```bash
dsh plugin --profile <profile> add link:/path/to/dsh-plugins/<plugin>
```

随后在该 profile 的 `package.json` 里把包名加入 `dsh.profile.bundles`。
