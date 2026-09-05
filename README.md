# dsh-prompt-refiner

DeepSeek Harness（`dsh`）输入栏「提示词精炼」插件：点击 ✨ 把模糊草稿改写成**目标 / 背景 / 步骤 / 要求 / [假设]** 结构化的可执行提示词，并内置**成本路由、结果缓存、token 用量统计**。

## 与 dsh-prompt-optimize-plugin 的差异

社区已有 [dsh-prompt-optimize-plugin](https://github.com/sakka6868/dsh-prompt-optimize-plugin)（MIT），本插件在其验证过的 UI 通道上补齐它没做的成本控制层：

| 能力 | dsh-prompt-optimize-plugin | dsh-prompt-refiner |
|---|---|---|
| 输入栏 ✨ 按钮 + 对比面板 + 应用/放弃 | ✅ | ✅（同一套槽位契约） |
| 输出形态 | 整段改写文本 | 结构化小节 + **[假设] 独立高亮**（补全的假设必须显式标注，面板单独展示，防意图漂移） |
| 优化器模型 | 固定跟随会话默认模型 | **可路由到便宜模型**（如 `deepseek-chat`），provider 可指定 |
| 结果缓存 | 无 | **LRU 缓存**（键含 prompt 版本 + 模型，重复精炼零成本） |
| token 用量 | 无 | 捕获流式 `usage` 块，面板展示 + **JSONL 落盘**（`$DSH_HOME/prompt-refiner/metrics.jsonl`）+ `/prompt-refine/stats` 汇总 |
| 结果清洗 | 围栏/思维链剥离 | 同等清洗 + 结果长度护栏 |

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
  "model": "deepseek-chat",   // 优化器模型；null = 跟随会话当前模型（省钱的关键开关）
  "provider": null,           // null = 跟随会话当前 provider
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

## 统计

- 每次精炼追加一行 JSONL：`$DSH_HOME/prompt-refiner/metrics.jsonl`（时间、模型、是否缓存命中、前后字符数、输入/输出 token、耗时）。
- 汇总接口：`GET /prompt-refine/stats`（自宿主启动起的内存累计 + 落盘目录位置）。
- 面板信息行实时显示：`模型 · 原文→结果 字数 · 耗时 · 缓存命中 · 输入+输出 tok`。

这套数据是 Phase A 决策的依据：自动模式值不值得默认开，由净节省（省下的返工 token − 优化器开销）说了算。

## 架构

```
浏览器（client 半部 lib/client.js）
  conversation.input.right    ✨ 精炼按钮（list 槽）
  conversation.input.overlay  精炼面板（浮动锚，原文/结果对照 + 假设高亮 + 应用/放弃）
        │ POST /prompt-refine { text }
dsh 宿主（host 半部 lib/index.js + lib/core/*）
  gate 门控 → cache 查缓存 → llm.stream（成本路由）→ clean 清洗 → metrics 记账
  · usage 块捕获 TokenUsage；reasoning-delta 一律不作为结果
  · finish error/aborted → 可读错误；落盘失败静默降级，绝不阻塞主流程
```

核心契约与 [dsh 官方文档](https://github.com/deepseek-ai/deepseek-harness) 对齐：`ctx.webServer.register`、`ctx.get('llm').stream()`、`ctx.get('agentDefaultModel').currentSelection()`、`ctx.get('slots')` 注入、`InputActions.setDraft()`。

## 测试

```sh
node tests/smoke.mjs
```

用假 ctx 驱动核心模块（门控、缓存命中/驱逐/TTL、成本路由、用量捕获、失败透传、清洗、假设拆分、统计落盘），不需要 dsh 运行时。

## 已验证 / 未验证边界

- ✅ 已验证：核心模块冒烟测试全绿；llm/slots/webServer 调用契约与官方文档及可运行的社区插件逐字对齐。
- ⚠️ 未验证：真实 dsh 环境的端到端运行（需要你本机装好 dsh 并配置模型后按上面步骤安装）。dsh 处于 developer preview，`llm.stream` chunk 形状如遇破坏性变更，只需改 `lib/core/optimizer.js` 一处。

## Phase A 路线（自动拦截）

1. 原生插件订阅 `agent/pre-step`（typed Decision 面）：仅在回合首个 step 且有新用户输入时介入，工具续步直接放行；
2. 复用 `gate.js` 叠加自动模式规则（长度下限、结构化特征跳过、与上轮输入去重）；
3. 检测到阻塞性歧义时走 `ctx.userQuestions` 问用户，而不是替用户猜；
4. 改写批次默认附带用户原话，保证审计日志不丢失原始意图；
5. `/opt-toggle` 开关 + 基于 metrics.jsonl 的净节省报告，数据决定默认开或关。

## License

MIT
