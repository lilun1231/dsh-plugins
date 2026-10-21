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

## 关键机制

- **日志与链路用同一标识打通**：日志 `message` 里的 `lid` 就是链路的 `serialNo`，`log_search` 返回的 `traceId` 可直接喂给 `trace_detail`。
- **免认证链路查询**：`/hibbert/api/callchain/fetch` 不需要登录，所以看单条链路的成本极低。
- **会话自动重登**：Kibana 与 服务治理的登录态都在会话内缓存，失效时自动重登一次。
- **必须绕过环境代理**：Node 的 `NODE_USE_ENV_PROXY=1` 会让内置 HTTP 客户端走环境代理，而内网平台必须直连，因此 `lib/http.js` 显式指定 Agent。

## 配置

见 `cordis.patch.yml`：凭据、各环境命名空间、项目号、默认时间窗都在其中。

## 已知限制

1. 只有 restful 层日志带 `lid`，其他微服务层需靠时间窗与参数指纹近似关联。
2. 服务治理按时间搜索单次上限 24 小时，跨天查询需分段。
3. `service_status` 的耗时指标是采样聚合（受 limit 限制），错误率用平台总数计算。
4. 面板（Client 侧）尚未实现，当前只有 Host 工具。
