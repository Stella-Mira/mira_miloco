/**
 * mira_miloco — DSH 主机端插件（接管本机小米 Miloco 后端）
 *
 * 职责：
 *   1. 通过 HTTP 连接本机 Miloco 后端（xiaomi-miloco FastAPI 服务，默认
 *      127.0.0.1:1810），Bearer Token 鉴权（默认自动读 ~/.openclaw/miloco/config.json）；
 *   2. 把 Miloco 的全部能力封装成模型可调用的 MCP 风格工具（前缀 miloco_，
 *      通过 ctx.tools 注册）：米家 IoT 设备/摄像头、主动感知、有意义事件、
 *      身份库、自动化任务、规则引擎、家庭画像、节点监控、系统管理；
 *   3. 二进制结果（摄像头录像 / 事件剪辑）落盘到本地 mediaDir，返回文件路径。
 *
 * 仅依赖 Node 内置能力（全局 fetch / fs / path / url / os），
 * 保证以 link 方式装入 profile 时无需解析第三方依赖。
 */

import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'

export const name = 'mira_miloco'
export const inject = ['tools']

// 插件根目录（本文件位于 <root>/lib/index.js）
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

// ── 唯一配置入口 ────────────────────────────────────────────────
// 所有可调项都收在这里（其余代码里出现的地址/路径/数值均为后端 API
// 契约或逻辑细节，不属于部署配置）。可用 cordis.patch.yml 覆盖任意键。
const DEFAULTS = {
  enabled: true,
  // Miloco 后端主 API 地址（FastAPI，/api/* 全部挂在这里；注意不是 OpenClaw 的 18789）
  baseUrl: 'http://127.0.0.1:1810',
  // Bearer Token。留空时自动读 ~/.openclaw/miloco/config.json 的 server.token
  token: '',
  // HTTP 请求超时（毫秒）。perceive 等长任务需要宽松上限
  timeoutMs: 120000,
  // 二进制结果（摄像头录像/事件剪辑）落盘目录（~ 开头自动展开到用户主目录）
  mediaDir: '~/.dsh/miloco-media',
  // 米家配置与 token 的读取位置
  milocoConfig: '~/.openclaw/miloco/config.json',
}

// ── 运行期状态 ──────────────────────────────────────────────────
let cfg = structuredClone(DEFAULTS)
let loggerRef = null
let lastError = null

function deepMerge(base, patch) {
  if (patch === undefined || patch === null) return base
  if (Array.isArray(base) || Array.isArray(patch)) return patch
  if (typeof base === 'object' && typeof patch === 'object') {
    const out = { ...base }
    for (const [k, v] of Object.entries(patch)) out[k] = deepMerge(base[k], v)
    return out
  }
  return patch
}

// ── 工具 schema helper（与 mira_qqbot 同款） ─────────────────────
function textTool(name, description, parameters, execute) {
  return {
    name,
    description,
    parameters,
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value ?? '') }],
    },
    async execute(args, exec) {
      try {
        return await execute(args, exec)
      } catch (e) {
        lastError = e && e.message ? e.message : String(e)
        return '(错误：' + lastError + ')'
      }
    },
  }
}

function obj(props, required = []) {
  return { type: 'object', properties: props, required }
}
function str(description) {
  return { type: 'string', description }
}
function num(description) {
  return { type: 'number', description }
}
function bool(description) {
  return { type: 'boolean', description }
}
// 字符串数组
function arr(description) {
  return { type: 'array', items: { type: 'string' }, description }
}
// 自由 JSON 透传体（复杂请求体原样转发给后端）
function freeObj(description) {
  return { type: 'object', additionalProperties: true, description }
}
function j(v) {
  return JSON.stringify(v, null, 2)
}

// ── HTTP 封装 ───────────────────────────────────────────────────
// 展开路径里的 ~（配置项默认值用 ~ 通配，避免在代码里硬编码用户主目录）
function expandHome(p) {
  if (typeof p === 'string' && p.startsWith('~')) return join(homedir(), p.slice(1))
  return p
}

function resolveToken() {
  if (cfg.token) return cfg.token
  const p = expandHome(cfg.milocoConfig)
  try {
    if (existsSync(p)) {
      const data = JSON.parse(readFileSync(p, 'utf8'))
      return (data && data.server && data.server.token) || ''
    }
  } catch (e) {
    lastError = '读取 miloco config 失败：' + (e && e.message ? e.message : String(e))
  }
  return ''
}

function buildUrl(path, query) {
  let url = cfg.baseUrl.replace(/\/+$/, '') + path
  if (query) {
    const qs = new URLSearchParams()
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null && v !== '') qs.set(k, v)
    }
    const s = qs.toString()
    if (s) url += (path.includes('?') ? '&' : '?') + s
  }
  return url
}

/**
 * 调用 Miloco 后端。返回解析后的 JSON（NormalResponse 原样返回，
 * 方便 agent 看 code/message/data）。
 */
async function api(method, path, { query, body, raw = false } = {}) {
  const url = buildUrl(path, query)
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: 'Bearer ' + resolveToken(),
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(cfg.timeoutMs),
  })
  if (raw) return res
  const text = await res.text()
  let data
  try {
    data = JSON.parse(text)
  } catch {
    data = text
  }
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${text.slice(0, 600)}`)
  }
  return data
}

/** 下载二进制响应到 mediaDir，返回本地文件路径。 */
async function downloadToMedia(path, query, hint) {
  const res = await api('GET', path, { query, raw: true })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`)
  }
  const ct = res.headers.get('content-type') || ''
  let ext = '.bin'
  if (ct.includes('video')) ext = '.mp4'
  else if (ct.includes('audio')) ext = '.m4a'
  else if (ct.includes('image')) ext = '.jpg'
  const buf = Buffer.from(await res.arrayBuffer())
  const dir = expandHome(cfg.mediaDir)
  mkdirSync(dir, { recursive: true })
  const ts = new Date().toISOString().replace(/[:.]/g, '-')
  const safe = String(hint || 'clip').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 60)
  const file = join(dir, `${safe}-${ts}${ext}`)
  writeFileSync(file, buf)
  return { file, bytes: buf.length, contentType: ct }
}

// 从 args 挑出非空字段组成 body（忽略 undefined/null/''）
function pickBody(args, fields) {
  const body = {}
  for (const f of fields) {
    if (args[f] !== undefined && args[f] !== null && args[f] !== '') body[f] = args[f]
  }
  return body
}

// ── 工具定义 ────────────────────────────────────────────────────
function registerTools(ctx) {
  const defs = []

  // ── 系统 / 管理 ────────────────────────────────────────────────
  defs.push(textTool(
    'miloco_status',
    '获取 Miloco 系统状态：miot / sqlite / perception / rule_engine 各部分健康度，以及规则引擎启用的规则数。',
    obj({}),
    async () => j(await api('GET', '/api/admin/status')),
  ))

  defs.push(textTool(
    'miloco_health',
    '轻量健康检查（无鉴权 /health 端点），确认 Miloco 后端进程存活。',
    obj({}),
    async () => j(await api('GET', '/health')),
  ))

  defs.push(textTool(
    'miloco_token_usage',
    '查询 Miloco 模型 Token 用量（原始事件，可按毫秒时间戳区间过滤）。',
    obj({
      since: num('起始 Unix 毫秒时间戳（含）'),
      until: num('结束 Unix 毫秒时间戳（不含）'),
    }),
    async (args) => j(await api('GET', '/api/admin/token-usage', { query: pickBody(args, ['since', 'until']) })),
  ))

  defs.push(textTool(
    'miloco_token_usage_daily',
    '查询 Miloco 模型 Token 用量（按 日期/模型/类型 的日聚合）。',
    obj({}),
    async () => j(await api('GET', '/api/admin/token-usage/daily')),
  ))

  defs.push(textTool(
    'miloco_debug',
    '查询 Miloco omni log 调试开关的当前状态。',
    obj({}),
    async () => j(await api('GET', '/api/admin/debug')),
  ))

  defs.push(textTool(
    'miloco_set_debug',
    '设置 Miloco 调试开关（同步 runtime override + 文件 flag）。',
    obj({ enabled: bool('true 打开 / false 关闭') }, ['enabled']),
    async (args) => j(await api('POST', '/api/admin/debug', { body: { enabled: args.enabled === true } })),
  ))

  defs.push(textTool(
    'miloco_log_pack',
    '打包 Miloco 的 trace 库 / jsonl / 日志到 $MILOCO_HOME/packs/（排查问题用）。',
    obj({}),
    async () => j(await api('POST', '/api/admin/debug/log-pack')),
  ))

  defs.push(textTool(
    'miloco_omni_config',
    '读取 Miloco 多模态（omni）模型当前生效配置与已存档案（api_key 打码）。',
    obj({}),
    async () => j(await api('GET', '/api/admin/omni-config')),
  ))

  defs.push(textTool(
    'miloco_omni_save',
    '保存一套 Miloco omni 模型配置（upsert 档案；activate=true 时设为当前生效，默认 true）。',
    obj({
      name: str('配置档案名'),
      model: str('模型标识，如 xiaomi/mimo-v2.5'),
      base_url: str('模型服务 Base URL'),
      api_key: str('模型服务 API Key'),
      activate: bool('是否设为当前生效（默认 true）'),
    }, ['name']),
    async (args) => j(await api('PUT', '/api/admin/omni-config', { body: pickBody(args, ['name', 'model', 'base_url', 'api_key', 'activate']) })),
  ))

  defs.push(textTool(
    'miloco_omni_activate',
    '切换 Miloco 当前生效的 omni 配置为某套已存档案。',
    obj({ profile_name: str('已存档案名') }, ['profile_name']),
    async (args) => j(await api('POST', '/api/admin/omni-config/activate', { body: { profile_name: args.profile_name } })),
  ))

  defs.push(textTool(
    'miloco_omni_delete',
    '删除一套 Miloco omni 配置档案（不影响当前生效配置）。',
    obj({ profile_name: str('要删除的档案名') }, ['profile_name']),
    async (args) => j(await api('POST', '/api/admin/omni-config/delete', { body: { profile_name: args.profile_name } })),
  ))

  defs.push(textTool(
    'miloco_omni_test',
    '测试一套 omni 配置连通性（GET /models 探测，不写库、不计用量）。',
    obj({
      model: str('模型标识'),
      base_url: str('Base URL'),
      api_key: str('API Key'),
    }, ['base_url']),
    async (args) => j(await api('POST', '/api/admin/omni-config/test', { body: pickBody(args, ['model', 'base_url', 'api_key']) })),
  ))

  defs.push(textTool(
    'miloco_omni_models',
    '拉取指定 Base URL 下可用的模型列表（供模型下拉）。',
    obj({
      base_url: str('模型服务 Base URL'),
      api_key: str('API Key（可选）'),
    }, ['base_url']),
    async (args) => j(await api('POST', '/api/admin/omni-config/models', { body: pickBody(args, ['base_url', 'api_key']) })),
  ))

  // ── 米家 IoT（miot） ───────────────────────────────────────────
  defs.push(textTool(
    'miloco_miot_status',
    '检查米家（MiOT）账号绑定状态：是否已绑定、已启用的摄像头数、米家账号信息。',
    obj({}),
    async () => j(await api('GET', '/api/miot/status')),
  ))

  defs.push(textTool(
    'miloco_miot_bind',
    '发起米家账号绑定：返回小米 OAuth 授权 URL，用户打开后把重定向页面的授权码交给 miloco_miot_authorize 完成绑定。',
    obj({}),
    async () => j(await api('POST', '/api/miot/bind')),
  ))

  defs.push(textTool(
    'miloco_miot_authorize',
    '提交从米家授权重定向页面获取的授权码，完成账号绑定（配合 miloco_miot_bind 两步走）。',
    obj({
      code: str('OAuth 授权码'),
      state: str('OAuth state token'),
    }, ['code', 'state']),
    async (args) => j(await api('POST', '/api/miot/authorize', { body: pickBody(args, ['code', 'state']) })),
  ))

  defs.push(textTool(
    'miloco_miot_unbind',
    '解除米家账号绑定，清空全部 MiOT 状态。',
    obj({}),
    async () => j(await api('POST', '/api/miot/unbind')),
  ))

  defs.push(textTool(
    'miloco_miot_login_status',
    '检查米家云登录状态。',
    obj({}),
    async () => j(await api('GET', '/api/miot/login_status')),
  ))

  defs.push(textTool(
    'miloco_miot_user',
    '获取米家账号用户信息。',
    obj({}),
    async () => j(await api('GET', '/api/miot/user_info')),
  ))

  defs.push(textTool(
    'miloco_miot_home',
    '获取米家家庭全量信息（设备、房间、场景、成员）；refresh=true 时先刷新云端设备/摄像头/场景。',
    obj({ refresh: bool('true = 先刷新云端数据（默认 false）') }),
    async (args) => j(await api('GET', '/api/miot/home', { query: pickBody(args, ['refresh']) })),
  ))

  defs.push(textTool(
    'miloco_miot_devices',
    '获取米家设备列表（全部设备，含离线）。',
    obj({}),
    async () => j(await api('GET', '/api/miot/device_list')),
  ))

  defs.push(textTool(
    'miloco_miot_cameras',
    '获取米家摄像头列表。',
    obj({}),
    async () => j(await api('GET', '/api/miot/camera_list')),
  ))

  defs.push(textTool(
    'miloco_miot_device_spec',
    '获取单台米家设备的完整 spec（服务/属性/动作定义，控制设备前先查它拿 iid 与取值）。',
    obj({ did: str('设备 did') }, ['did']),
    async (args) => j(await api('GET', `/api/miot/devices/${encodeURIComponent(args.did)}/spec`)),
  ))

  defs.push(textTool(
    'miloco_miot_device_status',
    '读取设备属性值。iid 为逗号分隔的属性 IID（如 prop.2.1,prop.2.2）；留空读全部。',
    obj({
      did: str('设备 did'),
      iid: str('属性 IID，逗号分隔（可选）'),
    }, ['did']),
    async (args) => j(await api('GET', `/api/miot/devices/${encodeURIComponent(args.did)}/status`, { query: pickBody(args, ['iid']) })),
  ))

  defs.push(textTool(
    'miloco_miot_device_history',
    '获取最近控制/读取过的设备属性历史快照（按 did 分组的 LRU）。',
    obj({}),
    async () => j(await api('GET', '/api/miot/device_history')),
  ))

  defs.push(textTool(
    'miloco_miot_control',
    '控制米家设备：set_property 设置单个属性、set_properties 批量设置、call_action 调用动作（如开关灯、调亮度）。iid/properties/params 结构先查 miloco_miot_device_spec。',
    obj({
      did: str('设备 did'),
      type: str('set_property / set_properties / call_action'),
      iid: str('属性 IID（set_property / call_action 用）'),
      value: freeObj('属性值（set_property 用）'),
      properties: freeObj('属性列表（set_properties 用），形如 [{iid, value}, ...]'),
      params: freeObj('动作入参列表（call_action 用），形如 [...]'),
    }, ['did', 'type']),
    async (args) => {
      const body = { type: args.type }
      if (args.iid !== undefined && args.iid !== '') body.iid = args.iid
      if (args.value !== undefined) body.value = args.value
      if (args.properties !== undefined) body.properties = args.properties
      if (args.params !== undefined) body.params = args.params
      return j(await api('POST', `/api/miot/devices/${encodeURIComponent(args.did)}/control`, { body }))
    },
  ))

  defs.push(textTool(
    'miloco_miot_scene_trigger',
    '触发米家手动场景（场景 id 从 miloco_miot_home 的 scenes 里拿）。',
    obj({ scene_id: str('场景 id') }, ['scene_id']),
    async (args) => j(await api('POST', `/api/miot/scenes/${encodeURIComponent(args.scene_id)}/trigger`)),
  ))

  defs.push(textTool(
    'miloco_miot_refresh',
    '刷新米家云端数据：all=全部、camera_online=轻量刷新摄像头在线状态（不动流）、cameras=摄像头、scenes=场景、user=用户、devices=设备。',
    obj({ target: str('all / camera_online / cameras / scenes / user / devices') }, ['target']),
    async (args) => {
      const paths = {
        all: '/api/miot/refresh_miot_all_info',
        camera_online: '/api/miot/refresh_camera_online',
        cameras: '/api/miot/refresh_miot_cameras',
        scenes: '/api/miot/refresh_miot_scenes',
        user: '/api/miot/refresh_miot_user_info',
        devices: '/api/miot/refresh_miot_devices',
      }
      const p = paths[args.target]
      if (!p) throw new Error('target 必须是 ' + Object.keys(paths).join('/'))
      return j(await api('GET', p))
    },
  ))

  defs.push(textTool(
    'miloco_miot_mips',
    '查看米家云端 MQTT（mips）订阅状态：实时设备绑定检测是否在线。',
    obj({}),
    async () => j(await api('GET', '/api/miot/mips_status')),
  ))

  defs.push(textTool(
    'miloco_miot_notify',
    '通过米家发送一条通知（推送到米家 App）。',
    obj({ notify: str('通知文本') }, ['notify']),
    async (args) => j(await api('POST', '/api/miot/send_notify', { body: { notify: args.notify } })),
  ))

  defs.push(textTool(
    'miloco_miot_scope_homes',
    '列出所有米家家庭及其 in_use 接入状态。',
    obj({}),
    async () => j(await api('GET', '/api/miot/scope/homes')),
  ))

  defs.push(textTool(
    'miloco_miot_switch_home',
    '切换 Miloco 当前接入的米家家庭（其余自动停用）。',
    obj({ home_id: str('要切换到的家庭 ID') }, ['home_id']),
    async (args) => j(await api('PUT', '/api/miot/scope/homes', { body: { home_id: args.home_id } })),
  ))

  defs.push(textTool(
    'miloco_miot_scope_cameras',
    '列出所有米家摄像头及 in_use / connected / is_online 状态。',
    obj({}),
    async () => j(await api('GET', '/api/miot/scope/cameras')),
  ))

  defs.push(textTool(
    'miloco_miot_toggle_cameras',
    '批量启用/停用米家摄像头的 Miloco 接入。',
    obj({
      items: freeObj('[{did, in_use}, ...]，in_use=true 启用'),
    }, ['items']),
    async (args) => j(await api('PUT', '/api/miot/scope/cameras', { body: { items: args.items } })),
  ))

  defs.push(textTool(
    'miloco_miot_record_clip',
    '让摄像头录一段视频（2–60 秒），mp4 落盘到本地 mediaDir 并返回文件路径。',
    obj({
      camera_id: str('摄像头 did'),
      channel: num('摄像头通道（默认 0）'),
      duration_ms: num('录像时长毫秒，2000–60000（默认 15000）'),
    }, ['camera_id']),
    async (args) => {
      const r = await downloadToMedia('/api/miot/record_clip', pickBody(args, ['camera_id', 'channel', 'duration_ms']), 'record_' + args.camera_id)
      return j(r)
    },
  ))

  // ── 感知（perception） ─────────────────────────────────────────
  defs.push(textTool(
    'miloco_perception_status',
    '获取感知引擎状态（是否就绪、实时引擎运行状态）。',
    obj({}),
    async () => j(await api('GET', '/api/perception/engine/status')),
  ))

  defs.push(textTool(
    'miloco_perception_start',
    '启动实时感知引擎（开始持续观察接入的摄像头）。',
    obj({}),
    async () => j(await api('POST', '/api/perception/engine/start')),
  ))

  defs.push(textTool(
    'miloco_perception_stop',
    '停止实时感知引擎。',
    obj({}),
    async () => j(await api('POST', '/api/perception/engine/stop')),
  ))

  defs.push(textTool(
    'miloco_perception_clear',
    '清空所有设备流缓冲。',
    obj({}),
    async () => j(await api('POST', '/api/perception/clear')),
  ))

  defs.push(textTool(
    'miloco_perceive',
    '主动感知：用自然语言问摄像头看到了什么（如“客厅现在有人吗”），多模态模型分析最近画面后回答。sources 为摄像头 did 列表（从 miloco_perception_devices 拿）。',
    obj({
      sources: arr('摄像头 did 列表（至少 1 个）'),
      query: str('自然语言问题'),
    }, ['sources', 'query']),
    async (args) => j(await api('POST', '/api/perception/perceive', { body: { sources: args.sources, query: args.query } })),
  ))

  defs.push(textTool(
    'miloco_perception_logs',
    '查询感知日志：limit 条数上限；after/before 为 ISO8601 时间游标；since 支持相对时间（如 1h、30m、2h30m）。',
    obj({
      limit: num('最多条数（1–1000）'),
      after: str('ISO 8601 时间游标（起始）'),
      before: str('ISO 8601 上界'),
      since: str('相对时间，如 1h / 30m'),
    }),
    async (args) => j(await api('GET', '/api/perception/logs', { query: pickBody(args, ['limit', 'after', 'before', 'since']) })),
  ))

  defs.push(textTool(
    'miloco_perception_devices',
    '列出支持感知的摄像头设备（did 列表，miloco_perceive 的 sources 从这里拿）。',
    obj({}),
    async () => j(await api('GET', '/api/perception/devices')),
  ))

  // ── 有意义事件（events） ───────────────────────────────────────
  defs.push(textTool(
    'miloco_events',
    '列出感知引擎产出的“有意义事件”（按时间倒序）：时间戳、来源设备、类型与描述。since/before 为 Unix 毫秒；limit≤200。',
    obj({
      since: num('起始 Unix 毫秒（含）'),
      before: num('结束 Unix 毫秒（不含）'),
      limit: num('每页条数，默认 50，上限 200'),
      offset: num('分页偏移'),
    }),
    async (args) => j(await api('GET', '/api/events', { query: pickBody(args, ['since', 'before', 'limit', 'offset']) })),
  ))

  defs.push(textTool(
    'miloco_event_clip',
    '下载某事件的媒体剪辑（摄像头看到的字节级 mp4/m4a）到本地 mediaDir，返回文件路径。event_id 与 device_id 从 miloco_events 结果拿。',
    obj({
      event_id: str('事件 ID'),
      device_id: str('设备 did'),
    }, ['event_id', 'device_id']),
    async (args) => {
      const r = await downloadToMedia(
        `/api/events/${encodeURIComponent(args.event_id)}/clip/${encodeURIComponent(args.device_id)}`,
        null,
        'event_' + args.event_id,
      )
      return j(r)
    },
  ))

  // ── 身份库（identity / persons） ───────────────────────────────
  defs.push(textTool(
    'miloco_persons',
    '列出身份库中的全部人员（家人/宠物）。',
    obj({}),
    async () => j(await api('GET', '/api/identity/persons')),
  ))

  defs.push(textTool(
    'miloco_person_create',
    '在身份库中创建人员。',
    obj({
      name: str('姓名'),
      role: str('角色/备注（可选）'),
    }, ['name']),
    async (args) => j(await api('POST', '/api/identity/persons', { body: pickBody(args, ['name', 'role']) })),
  ))

  defs.push(textTool(
    'miloco_person_update',
    '更新身份库中的人员信息。',
    obj({
      person_id: str('人员 ID'),
      name: str('新姓名（可选）'),
      role: str('新角色（可选）'),
    }, ['person_id']),
    async (args) => j(await api('PUT', `/api/identity/persons/${encodeURIComponent(args.person_id)}`, { body: pickBody(args, ['name', 'role']) })),
  ))

  defs.push(textTool(
    'miloco_person_delete',
    '删除身份库中的人员。',
    obj({ person_id: str('人员 ID') }, ['person_id']),
    async (args) => j(await api('DELETE', `/api/identity/persons/${encodeURIComponent(args.person_id)}`)),
  ))

  defs.push(textTool(
    'miloco_person_samples',
    '列出某人的 Tier A 样本文件（人脸/身体注册样本文件名）。',
    obj({ person_id: str('人员 ID') }, ['person_id']),
    async (args) => j(await api('GET', `/api/identity/persons/${encodeURIComponent(args.person_id)}/samples`)),
  ))

  defs.push(textTool(
    'miloco_person_register_sample',
    '给某人登记身份样本（Tier A）。body 原样透传给后端（单样本或 {samples:[...]} 批量）。',
    obj({
      person_id: str('人员 ID'),
      body: freeObj('样本请求体，原样转发（如图片路径/样本描述）'),
    }, ['person_id', 'body']),
    async (args) => j(await api('POST', `/api/identity/persons/${encodeURIComponent(args.person_id)}/samples`, { body: args.body })),
  ))

  defs.push(textTool(
    'miloco_person_extract',
    '从图片/视频中为某人抽取 body+face 候选样本（含算法预选）。body 原样透传。',
    obj({
      person_id: str('人员 ID'),
      body: freeObj('抽取请求体，原样转发'),
    }, ['person_id', 'body']),
    async (args) => j(await api('POST', `/api/identity/persons/${encodeURIComponent(args.person_id)}/extract`, { body: args.body })),
  ))

  defs.push(textTool(
    'miloco_persons_merge',
    '合并两个身份库人员。body 原样透传。',
    obj({ body: freeObj('合并请求体，原样转发') }, ['body']),
    async (args) => j(await api('POST', '/api/identity/persons/merge', { body: args.body })),
  ))

  defs.push(textTool(
    'miloco_person_split',
    '拆分一个身份库人员。body 原样透传。',
    obj({
      person_id: str('人员 ID'),
      body: freeObj('拆分请求体，原样转发'),
    }, ['person_id', 'body']),
    async (args) => j(await api('POST', `/api/identity/persons/${encodeURIComponent(args.person_id)}/split`, { body: args.body })),
  ))

  defs.push(textTool(
    'miloco_register_sessions',
    '列出身份注册会话（两步注册的中间状态）。',
    obj({}),
    async () => j(await api('GET', '/api/identity/register/sessions')),
  ))

  defs.push(textTool(
    'miloco_pool_status',
    '陌生人池状态（未识别人员的聚类与候选）。',
    obj({}),
    async () => j(await api('GET', '/api/identity/pool/status')),
  ))

  defs.push(textTool(
    'miloco_pool_fetch',
    '从陌生人池拉取注册候选。',
    obj({}),
    async () => j(await api('GET', '/api/identity/pool/fetch')),
  ))

  defs.push(textTool(
    'miloco_register_from_cluster',
    '按陌生人池 cluster_id 直接注册为人员。body 原样透传。',
    obj({ body: freeObj('注册请求体，原样转发') }, ['body']),
    async (args) => j(await api('POST', '/api/identity/register/from-cluster', { body: args.body })),
  ))

  // ── 自动化任务（tasks） ────────────────────────────────────────
  defs.push(textTool(
    'miloco_task_create',
    '创建自动化任务占位（task_id 为 snake_case 字母数字下划线≤32 字符；description≤200 字）。规则/记录通过后续端点挂载。',
    obj({
      task_id: str('任务 ID（[a-z0-9_]{1,32}）'),
      description: str('任务描述（≤200 字）'),
    }, ['task_id', 'description']),
    async (args) => j(await api('POST', '/api/tasks', { body: pickBody(args, ['task_id', 'description']) })),
  ))

  defs.push(textTool(
    'miloco_task_list',
    '列出全部自动化任务（去重视图）。',
    obj({}),
    async () => j(await api('GET', '/api/tasks')),
  ))

  defs.push(textTool(
    'miloco_task_summary',
    '自动化任务摘要。',
    obj({}),
    async () => j(await api('GET', '/api/tasks/summary')),
  ))

  defs.push(textTool(
    'miloco_task_get',
    '查询单个自动化任务详情。',
    obj({ task_id: str('任务 ID') }, ['task_id']),
    async (args) => j(await api('GET', `/api/tasks/${encodeURIComponent(args.task_id)}`)),
  ))

  defs.push(textTool(
    'miloco_task_update',
    '更新任务描述。body 原样透传（如 {description}）。',
    obj({
      task_id: str('任务 ID'),
      body: freeObj('更新体，原样转发'),
    }, ['task_id', 'body']),
    async (args) => j(await api('PATCH', `/api/tasks/${encodeURIComponent(args.task_id)}`, { body: args.body })),
  ))

  defs.push(textTool(
    'miloco_task_enable',
    '启用自动化任务。',
    obj({ task_id: str('任务 ID') }, ['task_id']),
    async (args) => j(await api('POST', `/api/tasks/${encodeURIComponent(args.task_id)}/enable`)),
  ))

  defs.push(textTool(
    'miloco_task_disable',
    '停用自动化任务。',
    obj({ task_id: str('任务 ID') }, ['task_id']),
    async (args) => j(await api('POST', `/api/tasks/${encodeURIComponent(args.task_id)}/disable`)),
  ))

  defs.push(textTool(
    'miloco_task_delete',
    '删除自动化任务。',
    obj({ task_id: str('任务 ID') }, ['task_id']),
    async (args) => j(await api('DELETE', `/api/tasks/${encodeURIComponent(args.task_id)}`)),
  ))

  defs.push(textTool(
    'miloco_task_add_link',
    '给任务追加一条 link（规则/定时/记忆关联）。body 原样透传。',
    obj({
      task_id: str('任务 ID'),
      body: freeObj('link 请求体，原样转发'),
    }, ['task_id', 'body']),
    async (args) => j(await api('POST', `/api/tasks/${encodeURIComponent(args.task_id)}/links`, { body: args.body })),
  ))

  // ── 规则引擎（rules） ──────────────────────────────────────────
  defs.push(textTool(
    'miloco_rule_create',
    '创建自动化规则（感知条件→动作）。body 原样透传：{name, task_id?, mode, condition, actions, ...}。',
    obj({ body: freeObj('规则请求体，原样转发') }, ['body']),
    async (args) => j(await api('POST', '/api/rules', { body: args.body })),
  ))

  defs.push(textTool(
    'miloco_rule_list',
    '列出全部自动化规则。',
    obj({}),
    async () => j(await api('GET', '/api/rules')),
  ))

  defs.push(textTool(
    'miloco_rule_get',
    '查询单条规则。',
    obj({ rule_id: str('规则 ID') }, ['rule_id']),
    async (args) => j(await api('GET', `/api/rules/${encodeURIComponent(args.rule_id)}`)),
  ))

  defs.push(textTool(
    'miloco_rule_update',
    '更新规则（body 原样透传；不传的字段保持不变）。',
    obj({
      rule_id: str('规则 ID'),
      body: freeObj('规则更新体，原样转发'),
    }, ['rule_id', 'body']),
    async (args) => j(await api('PUT', `/api/rules/${encodeURIComponent(args.rule_id)}`, { body: args.body })),
  ))

  defs.push(textTool(
    'miloco_rule_delete',
    '删除规则。',
    obj({ rule_id: str('规则 ID') }, ['rule_id']),
    async (args) => j(await api('DELETE', `/api/rules/${encodeURIComponent(args.rule_id)}`)),
  ))

  defs.push(textTool(
    'miloco_rule_trigger',
    '手动触发一次规则。',
    obj({ rule_id: str('规则 ID') }, ['rule_id']),
    async (args) => j(await api('POST', `/api/rules/${encodeURIComponent(args.rule_id)}/trigger`)),
  ))

  defs.push(textTool(
    'miloco_rule_logs',
    '查询规则执行日志。',
    obj({}),
    async () => j(await api('GET', '/api/rules/logs')),
  ))

  // ── 家庭画像（home-profile） ───────────────────────────────────
  defs.push(textTool(
    'miloco_profile_entries',
    '列出家庭画像条目（Miloco 对家人生活习惯的长期归纳）。',
    obj({}),
    async () => j(await api('GET', '/api/home-profile/entries')),
  ))

  defs.push(textTool(
    'miloco_profile_rendered',
    '获取渲染后的家庭画像全文。',
    obj({}),
    async () => j(await api('GET', '/api/home-profile/rendered')),
  ))

  defs.push(textTool(
    'miloco_profile_write',
    '写入家庭画像（body 原样透传）。',
    obj({ body: freeObj('画像写入体，原样转发') }, ['body']),
    async (args) => j(await api('POST', '/api/home-profile/profile:write', { body: args.body })),
  ))

  defs.push(textTool(
    'miloco_profile_commit',
    '提交家庭画像变更。',
    obj({}),
    async () => j(await api('POST', '/api/home-profile/commit')),
  ))

  // ── 节点监控（monitor） ────────────────────────────────────────
  defs.push(textTool(
    'miloco_monitor',
    'Miloco 分布式节点总览（各节点健康状态）。',
    obj({}),
    async () => j(await api('GET', '/api/monitor/')),
  ))

  defs.push(textTool(
    'miloco_monitor_resources',
    'Miloco 节点资源占用。',
    obj({}),
    async () => j(await api('GET', '/api/monitor/resources')),
  ))

  defs.push(textTool(
    'miloco_monitor_nodes',
    '列出 Miloco 全部节点。',
    obj({}),
    async () => j(await api('GET', '/api/monitor/nodes')),
  ))

  defs.push(textTool(
    'miloco_monitor_memory',
    'Miloco 节点内存状态。',
    obj({}),
    async () => j(await api('GET', '/api/monitor/memory')),
  ))

  // ── 通用逃生舱 ────────────────────────────────────────────────
  defs.push(textTool(
    'miloco_api',
    '通用 Miloco HTTP API 逃生舱：直接指定 method 与 path 调用后端（覆盖上面工具没细分的端点）。path 以 /api/ 开头；body 原样 JSON 转发。',
    obj({
      method: str('GET / POST / PUT / PATCH / DELETE'),
      path: str('API 路径，如 /api/miot/device_list'),
      query: freeObj('查询参数对象（可选）'),
      body: freeObj('请求体（可选，原样 JSON 转发）'),
    }, ['method', 'path']),
    async (args) => {
      const m = String(args.method || 'GET').toUpperCase()
      const r = await api(m, args.path, { query: args.query, body: args.body })
      return j(r)
    },
  ))

  const disposers = defs.map((d) => ctx.tools.register(d))
  ctx.effect(() => () => disposers.forEach((d) => d()))
}

// ── 插件入口 ────────────────────────────────────────────────────
export function apply(ctx, config) {
  loggerRef = ctx.logger || null
  // 未知配置键告警：所有可调项都收在 DEFAULTS 里，传错字段名时尽早暴露
  if (config && typeof config === 'object') {
    const unknown = Object.keys(config).filter((k) => !(k in DEFAULTS))
    if (unknown.length) {
      loggerRef?.warn?.('[mira_miloco] 未知配置项（已忽略，可能是拼写错误）：' + unknown.join(', ') + '。可用配置项：' + Object.keys(DEFAULTS).join(', '))
    }
  }
  cfg = deepMerge(structuredClone(DEFAULTS), config || {})

  if (cfg.enabled === false) return

  registerTools(ctx)

  const token = resolveToken()
  loggerRef?.info?.(
    '[mira_miloco] 已加载，后端 ' + cfg.baseUrl +
    (token ? '，鉴权 token 已就绪' : '，⚠ 未取到鉴权 token（配置 token 或检查 milocoConfig 路径）') +
    '，媒体目录 ' + cfg.mediaDir,
  )
}
