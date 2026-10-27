# dsh-prompt-refiner

DeepSeek Harness（`dsh`）输入栏「提示词精炼」插件：点击 ✨ 把模糊草稿改写成**目标 / 背景 / 步骤 / 要求 / [假设]** 结构化的可执行提示词，并内置**成本路由、结果缓存、token 用量统计**。
本项目未授权任何第三方平台进行代金券/API额度赠送！
## 与 dsh-prompt-optimize-plugin 的差异

社区已有 [dsh-prompt-optimize-plugin](https://github.com/sakka6868/dsh-prompt-optimize-plugin)（MIT），本插件在其验证过的 UI 通道上补齐它没做的成本控制层：

| 能力 | dsh-prompt-optimize-plugin | dsh-prompt-refiner |
|---|---|---|
| 输入栏 ✨ 按钮 + 对比面板 + 应用/放弃 | ✅ | ✅（同一套槽位契约） |
| 输出形态 | 整段改写文本 | 结构化小节 + **[假设] 独立高亮**（补全的假设必须显式标注，面板单独展示，防意图漂移） |
| 优化器模型 | 固定跟随会话默认模型 | **可路由到便宜模型**（如 `deepseek-v4-flash`），provider 可指定 |
| 思考档位 | 跟随会话默认（deepseek 适配器默认 `high`，思考 token 照计费） | **默认 `off`**，并按模型声明的档位校验/回退 |
| 结果缓存 | 无 | **LRU 缓存**（键含 prompt 版本 + 模型 + 草稿 + 实际档位，重复精炼零成本） |
| token 用量 | 无 | 捕获流式 `usage` 块，面板展示 + **JSONL 落盘**（`$DSH_HOME/prompt-refiner/metrics.jsonl`）+ `/prompt-refine/stats` 汇总 |
| 结果清洗 | 围栏/思维链剥离 | 同等清洗 + 结果长度护栏 + **max-tokens 截断判失败** |

## 安装

### 方式一：动态模式（免安装尝鲜，约 1 分钟）

在 dsh 的「Cordis 动态插件」面板：

1. 新建插件；
2. `code.host` 粘贴 `src/host.js` 全文，`code.client` 粘贴 `src/client.js` 全文；
3. 激活并授权，输入栏出现 ✨ 按钮。

动态版限制：模型跟随会话默认选择、缓存仅内存、统计不落盘。完整功能请用方式二。

### 方式二：静态插件（npm 包，正式推荐）

```sh
npm publish          # 或先在本地 npm pack
dsh plugin --profile web add dsh-prompt-refiner
```

然后在 `~/.dsh/profiles/web/cordis.patch.yml` 注册插件行：

```yaml
- insert:
    - id: dsh-prompt-refiner
      name: 'dsh-prompt-refiner'
```

重启 dsh web 服务后生效。

> 本地路径挂载（不发布直接指向本目录）的 CLI 用法尚未验证，开发期建议先用动态模式。

## 配置

配置文件 `$DSH_HOME/prompt-refiner/config.json`（默认 `~/.dsh/prompt-refiner/config.json`），优先级：cordis 条目 config > config.json > 内置默认。

```jsonc
{
  "model": "deepseek-v4-flash", // 优化器模型；null = 跟随会话当前模型（省钱的关键开关）
  "provider": null,           // null = 跟随会话当前 provider
  "reasoningEffort": "off",   // 思考档位：'off'|'low'|'high'|'max'；null = 跟随模型默认
  "maxTokens": 2048,
  "temperature": 0.3,
  "minChars": 0,              // 手动模式不设下限；Phase A 自动模式建议 8
  "maxChars": 8000,
  "resultMaxChars": 4000,     // 结果长度护栏：超过视为混入思考内容
  "cacheMax": 200,
  "cacheTtlMs": 86400000,
  "metrics": true             // 统计落盘开关
}
```

### 成本：为什么 `reasoningEffort` 默认 `off`

DeepSeek 适配器把模型的 **thinking token 计在 `outputTokens` 里**（`TokenUsage.reasoningTokens` 不单列）。
不显式指定档位时，适配器默认走 `connection.defaults.reasoningEffort ?? 'high'`，于是「一键精炼」
每次都会先生成上千 token 的思考内容——这部分照样计费，却完全不进结果。实测同一会话下
137 字的草稿会产出 471 字结果 + 1624 output token，其中绝大部分是思考。

因此插件默认下发 `reasoningEffort: 'off'`：精炼是改写任务，不需要思考链。下发前会先用
`llm.resolveModelInfo(provider, model)` 读该模型声明的档位（每个 provider/model 只查一次并缓存）：

- 请求的档位受支持 → 原样下发；
- 不受支持 → 自动回退到该模型支持的最省档位（契约规定不支持的档位会在 provider I/O 之前 reject）；
- 模型未声明任何档位 / 能力查询失败 → 不下发该参数，避免硬报错。

面板信息行会显示实际生效的档位（如 `思考 off`，被回退时显示 `思考 off（请求 max）`）。

另外 `finish.reason.kind === 'max-tokens'`（结果被截断）会被判为失败并丢弃，绝不会把
半截提示词当成功结果应用回输入框——思考阶段吃满配额导致正文为空时也会给出可操作的提示。

## 统计

- 每次精炼追加一行 JSONL：`$DSH_HOME/prompt-refiner/metrics.jsonl`（时间、模型、是否缓存命中、是否门控跳过、实际思考档位、前后字符数、输入/输出/思考 token、耗时）。
- 汇总接口：`GET /prompt-refine/stats`（自宿主启动起的内存累计 + 落盘目录位置）。
- 面板信息行实时显示：`模型 · 原文→结果 字数 · 耗时 · 缓存命中 · 思考档位 · 入/出 token`。

计数口径（`calls` = 收到的精炼请求总数）：

| 计数器 | 含义 |
|---|---|
| `calls` | 请求总数 = `hits` + `skipped` + `failures` + 成功 |
| `hits` | 缓存命中（零模型费用） |
| `skipped` | 门控拦截（空草稿、超长草稿），未调用模型 |
| `failures` | 调用失败，或结果不可用（截断、混入思考、清洗后为空、服务未就绪） |
| `outputTokens` | **含思考 token**（DeepSeek 适配器把 thinking 计在 output 内） |

> 之前 `cacheMax` / `cacheTtlMs` 因为键名与 `ResultCache({ max, ttlMs })` 不匹配而被静默忽略，
> 配置改了不生效；现在两种键名都接受，且有端到端测试覆盖（`cacheMax=1` 时旧草稿必须被驱逐）。
> 缓存键同时包含 provider / model / 草稿全文 / **实际下发的思考档位**，换档位不会复用旧结果。

这套数据是 Phase A 决策的依据：自动模式值不值得默认开，由净节省（省下的返工 token − 优化器开销）说了算。

## 改动生效范围

- **client 半部**（`lib/client.js`）：宿主从磁盘实时 serve，刷新页面即生效。
- **host 半部**（`lib/index.js`、`lib/core/*`）：需要让宿主重新加载插件（重启 dsh / 桌面端，或触发插件重载）。
- 用 `file:` 安装的 profile（例如本机的 `web` profile）拿到的是**打包副本**，改工作区源码不会自动生效，
  需重新 `dsh plugin --profile <name> add dsh-prompt-refiner` 或 `pnpm install`；
  用 `link:` 安装的 profile（例如 `desktop`）直接指向工作区，只需重载插件。


## 架构

```
浏览器（client 半部 lib/client.js）
  conversation.input.right    ✨ 精炼按钮（list 槽）
  conversation.input.overlay  精炼面板（浮动锚，原文/结果对照 + 假设高亮 + 应用/放弃）
        │ POST /prompt-refine { text }
dsh 宿主（host 半部 lib/index.js + lib/core/*）
  gate 门控 → 选模型（成本路由）→ 解析思考档位 → 查缓存 → llm.stream → clean 清洗 → metrics 记账
  · usage 块捕获 TokenUsage；reasoning-delta 一律不作为结果
  · finish max-tokens（截断）判失败丢弃；error/aborted → 可读错误；落盘失败静默降级，绝不阻塞主流程
```

面板挂载契约（对着宿主 `dsh-client-ui-conversation` 的实际 DOM/CSS 核过）：

- `conversation.input.overlay` 的宿主容器是 `[data-composer-card]` 内第一个子元素，样式为
  `position:absolute; inset:0 0 auto; height:0`；因此 `bottom:calc(100% + 8px)` 等于「卡片上沿再往上 8px」，
  `left:0` + 按 `[data-composer-card]` 实测宽度对齐，不需要 portal。
- 面板 `z-index:60`：低于宿主 `/` 命令菜单的 `z-index:100`（菜单是瞬态交互，必须压住面板），
  高于卡片内未设 z-index 的内容。
- 面板 `max-height:min(70vh,560px)`，结果区/假设区均为 `flex:1 1 auto; min-height:0; overflow-y:auto`，
  长结果只滚动内部区域，不会把「应用/放弃」顶出视口。
- 输入栏在「活动态」（`conversation.input.activity` 被占用）时会给工具栏加 `hidden`，
  那时 ✨ 按钮与该行其它控件一起隐藏——这是宿主行为，不是本插件故障。


核心契约与 [dsh 官方文档](https://github.com/deepseek-ai/deepseek-harness) 对齐：`ctx.webServer.register`、`ctx.get('llm').stream()`、`ctx.get('agentDefaultModel').currentSelection()`、`ctx.get('slots')` 注入、`InputActions.setDraft()`。

## 测试

```sh
node tests/smoke.mjs
```

用假 ctx 驱动核心模块（门控、缓存命中/驱逐/TTL/cacheMax 接线、成本路由、思考档位解析与回退、
截断拒绝、用量捕获、失败透传、清洗、假设拆分、统计口径、HTTP 路由层），不需要 dsh 运行时。

## 已验证 / 未验证边界

- ✅ 已验证：核心模块 + 路由层冒烟测试全绿；宿主 `llm` Service（`GenerateOptions.reasoningEffort`、
  `FinishReasonMap.max-tokens`、`TokenUsage.reasoningTokens`、deepseek 适配器档位 `off/low/high/max`）、
  `webServer.register`、`conversation.input.*` / `conversation.input.overlay` 槽位与 composer DOM/CSS
  均已对着本机安装包逐条核对。
- ⚠️ 未验证：面板在真实浏览器里的观感（点 ✨ 后的视觉反馈、与 `/` 命令菜单同屏时的层次）需要人眼确认；
  本会话无法驱动 GUI。dsh 处于 developer preview，`llm.stream` chunk 形状如遇破坏性变更，只需改
  `lib/core/optimizer.js` 一处（动态版对应 `src/host.js`）。

## Phase A 路线（自动拦截）

1. 原生插件订阅 `agent/pre-step`（typed Decision 面）：仅在回合首个 step 且有新用户输入时介入，工具续步直接放行；
2. 复用 `gate.js` 叠加自动模式规则（长度下限、结构化特征跳过、与上轮输入去重）；
3. 检测到阻塞性歧义时走 `ctx.userQuestions` 问用户，而不是替用户猜；
4. 改写批次默认附带用户原话，保证审计日志不丢失原始意图；
5. `/opt-toggle` 开关 + 基于 metrics.jsonl 的净节省报告，数据决定默认开或关。

## License

MIT
