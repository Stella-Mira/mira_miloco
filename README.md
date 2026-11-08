# mira_miloco

DSH 主机端插件：把本机 **Miloco**（小米 xiaomi-miloco 智能家居 AI 后端）的**全部能力**接管进 DSH agent，暴露 `miloco_*` MCP 工具集。

## 能力覆盖

| 域 | 工具 |
|---|---|
| 系统/管理 | `miloco_status` `miloco_health` `miloco_token_usage(_daily)` `miloco_debug(_set)` `miloco_log_pack` `miloco_omni_*(config/save/activate/delete/test/models)` |
| 米家 IoT | `miloco_miot_status/bind/authorize/unbind/login_status/user/home/devices/cameras/device_spec/device_status/device_history/control/scene_trigger/refresh/mips/notify/scope_homes/switch_home/scope_cameras/toggle_cameras/record_clip` |
| 感知 | `miloco_perception_status/start/stop/clear` `miloco_perceive`（自然语言问摄像头）`miloco_perception_logs/devices` |
| 事件 | `miloco_events` `miloco_event_clip`（下载剪辑） |
| 身份库 | `miloco_persons` `miloco_person_create/update/delete/samples/register_sample/extract/split` `miloco_persons_merge` `miloco_register_sessions` `miloco_pool_status/fetch` `miloco_register_from_cluster` |
| 自动化任务 | `miloco_task_create/list/summary/get/update/enable/disable/delete/add_link` |
| 规则引擎 | `miloco_rule_create/list/get/update/delete/trigger/logs` |
| 家庭画像 | `miloco_profile_entries/rendered/write/commit` |
| 监控 | `miloco_monitor` `miloco_monitor_resources/nodes/memory` |
| 逃生舱 | `miloco_api`（任意 method+path+body 直调后端） |

## 安装

```bash
# 1. 链接进 web profile
dsh plugin --profile web add link:/path/to/PluginDSH/mira_miloco
# 2. cordis.patch.yml 添加 insert 块（见下）
# 3. 重启 dsh web（见 PluginDSH/restart-dsh-web.sh）
```

## 配置

全部可选，默认开箱即用（token 自动读 `~/.openclaw/miloco/config.json` 的 `server.token`）。

**全部配置项（唯一配置入口是 `lib/index.js` 里的 `DEFAULTS`）：**

| 键 | 默认值 | 说明 |
|---|---|---|
| `enabled` | `true` | 插件总开关 |
| `baseUrl` | `http://127.0.0.1:1810` | Miloco 后端主 API（注意不是 OpenClaw 的 18789） |
| `token` | `""` | Bearer Token；留空自动读 `milocoConfig` 指向文件的 `server.token` |
| `timeoutMs` | `120000` | HTTP 超时（毫秒）；perceive 等长任务需要宽松上限 |
| `mediaDir` | `~/.dsh/miloco-media` | 录像/剪辑落盘目录（`~` 自动展开到用户主目录） |
| `milocoConfig` | `~/.openclaw/miloco/config.json` | 米家配置与 token 的读取位置 |

代码中其余地址（`/api/...` 端点）与数值（错误截断、参数上限）均为 Miloco
后端协议契约或逻辑细节，不属于部署配置。插件加载时若检测到未知配置键会
在日志里告警，方便发现拼写错误。

```yaml
- insert:
    - id: mira_miloco
      name: mira_miloco
      config:
        enabled: true
        baseUrl: http://127.0.0.1:1810   # Miloco 后端主 API（不是 OpenClaw 的 18789）
        token: ""                          # 留空自动读 miloco config.json
        timeoutMs: 120000                  # perceive 等长任务需要宽松上限
        mediaDir: ~/.dsh/miloco-media        # 录像/剪辑落盘目录（~ 自动展开到用户主目录）
        milocoConfig: ~/.openclaw/miloco/config.json
```

## 注意事项

- Miloco 后端必须运行中（`miloco-cli service start` 或 supervisord 管理）。
- 控制设备前先 `miloco_miot_device_spec` 查 iid 与取值；`miloco_miot_control` 的 type 支持 `set_property` / `set_properties` / `call_action`。
- `miloco_perceive` 的 sources（摄像头 did）从 `miloco_perception_devices` 拿，且感知引擎需已启动。
- 复杂请求体工具（rule/person/omni 等）为 body 透传设计，字段结构可先用 `miloco_api` 或对应 GET 工具摸清。
