# 日志洞察插件

在 DSH 对话里查询 Kibana 日志、拉取调用链树、聚合服务状态，并支持导出。

## 工具

| 工具 | 用途 | 是否需要登录 |
|---|---|---|
| `log_search` | 按关键字/服务/级别/流水号查日志 | Kibana OAuth |
| `trace_detail` | 按流水号拉完整链路树 | **否**（免认证） |
| `trace_search` | 按入参/返回值/服务名搜链路列表 | 服务治理 |
| `service_status` | 聚合调用量、错误率、耗时 | 服务治理 |
| `log_export` | 导出日志 CSV / JSONL | Kibana OAuth |
| `trace_export` | 导出链路（平台页面链接或离线快照） | url 模式免认证 |

## 典型用法

1. 查报错：「查一下 W100024 今天的报错」→ `log_search`
2. 追链路：「看下 hall-restful-2887722905-497936-13387 这条链路」→ `trace_detail`
3. 反查请求：「谁调用了这个手机号 15888888888」→ `trace_search`
4. 看整体：「hall-restful 近一小时状态怎么样」→ `service_status`
5. 导出：「把今天的 W100024 导出成 CSV」→ `log_export`

## 配置

**代码仓库里没有任何真实凭据**，`cordis.patch.yml` 只有空模板。所有需要对接的环境参数都在
DSH Web UI 里可视化填写：

> 打开「日志洞察」面板 →「设置」页 → 填写 → 保存

设置页可配置：

| 分组 | 内容 |
|---|---|
| Kibana 日志查询 | 地址、账号、密码、IdP、索引、自签证书、fat/uat/dev 命名空间 |
| 服务治理 | 地址、Hibbert 地址、账号、密码、项目号、项目名、数据中心头 |
| 查询默认值 | 默认环境、时区、时间窗、单次条数、导出上限 |
| 代码仓库 | 接口分析可用的仓库，一行一个「名称=绝对路径」 |
| 模型 | 自然语言问答使用的 provider / model |
| 其它 | 接口分析优先委派的会话 ID |

保存后写入本机私有文件：

```
$DSH_HOME/log-insight/settings.json      # 默认 ~/.dsh/log-insight/settings.json
```

- 权限 `0600`，内含明文密码，**不要提交到任何仓库**，也已被 `.gitignore` 覆盖。
- 密码回显为掩码；输入框留空表示保持原密码，勾选「清除该密码」才会清空。
- 保存后插件会丢弃旧登录会话，下一次查询即按新配置重登；「连通性自检」可先验证两层平台是否可达。

读取优先级：内置默认值 ← `cordis.patch.yml` 的 `config` ← `settings.json`。
需要给多台机器统一预置时，可在 profile 的 `cordis.patch.yml` 里按 `id: log-insight` 覆盖，
注意 loader 对 `config` 是整体替换、不深合并。

## 关键机制

- **日志与链路用同一标识打通**：日志 `message` 里的 `lid` 就是链路的 `serialNo`，`log_search` 返回的 `traceId` 可直接喂给 `trace_detail`。
- **免认证链路查询**：`/hibbert/api/callchain/fetch` 不需要登录，所以看单条链路的成本极低。
- **会话自动重登**：Kibana 与 服务治理的登录态都在会话内缓存，失效时自动重登一次。
- **必须绕过环境代理**：Node 的 `NODE_USE_ENV_PROXY=1` 会让内置 HTTP 客户端走环境代理，而内网平台必须直连，因此 `lib/http.js` 显式指定 Agent。

## 安装

```bash
dsh plugin --profile <profile> add link:/path/to/dsh-plugin
```

profile 的 `package.json` 里把包名加入 `dsh.profile.bundles` 即可挂载 Host 工具与面板。

## 测试

```bash
node --test test/*.test.js
```

## 已知限制

1. 只有 restful 层日志带 `lid`，其他微服务层需靠时间窗与参数指纹近似关联。
2. 服务治理按时间搜索单次上限 24 小时，跨天查询需分段。
3. `service_status` 的耗时指标是采样聚合（受 limit 限制），错误率用平台总数计算。
