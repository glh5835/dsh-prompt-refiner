// dsh-prompt-refiner — 动态模式 Host 半部（粘贴进 dsh「Cordis 动态插件」面板的 code.host）。
//
// 注意：本文件是动态面板求值的函数体（顶层允许 return，harness 为注入的全局），
// 不能 import，因此全部依赖内联。与静态版 lib/ 的差异：
//   - 模型跟随会话默认选择（动态面板没有可靠的自定义配置通道；成本路由请用静态版 config）
//   - 缓存为内存 Map（FNV 哈希），统计仅随 meta 返回、不落盘
//   - 思考档位固定 off（可用常量 REASONING_EFFORT 调整；null = 跟随模型默认）
const OPTIMIZE_SYSTEM = [
  '你是 DeepSeek Harness 的提示词精炼器。用户在对话输入框写了一段草稿并点击精炼按钮，你负责把它改写成一段更清晰、具体、可执行的提示词。改写结果会被直接应用为用户要发送的消息，因此必须是完整、独立、可直接发送的提示词正文。',
  '',
  '改写原则：',
  '1. 忠实：只重组用户已表达的意思，不得新增需求或事实，不得编造文件名、路径、版本号、数据、链接。',
  '2. 具体：把含糊表述落实为明确的任务与边界，补全执行所需背景（仅限草稿已提供的信息）。',
  '3. 精简：删除客套、重复与无效修饰；在完整传达任务的前提下尽量短，一般不超过 400 字；草稿本身信息量大时可放宽，但不得为凑篇幅而扩写。',
  '4. 保留：代码片段、命令、文件路径、标识符、数值、链接原样保留，不改写不翻译。',
  '5. 输出语言与草稿一致。',
  '',
  '输出格式（纯文本，小节按需取舍，没有内容的整节省略）：',
  '[目标] 一句话说明要做成什么、最终产出物是什么',
  '[背景] 执行所需的关键上下文（只来自草稿）',
  '[步骤] 按执行顺序编号列出关键步骤（很简单的任务可省略此节）',
  '[要求] 约束条件、输出格式、验收标准',
  '[假设] 仅当你为消除含糊而做了解释性补全时列出，每条以"假设："开头',
  '',
  '硬性规则：',
  '- 只输出改写结果本身，不要任何解释、前言、思考过程、代码块包裹或引号。',
  '- 一切解释性补全必须写进 [假设] 小节，不得悄悄混入其他小节；没有补全就省略该节。',
  '- 不使用第一人称，不出现"优化后""以下是""总结"等元话语。',
].join('\n')

const MAX_CHARS = 8000
const RESULT_MAX_CHARS = 4000
const MAX_TOKENS = 2048
const TEMPERATURE = 0.3
// 精炼是改写任务，思考 token 计入 output 计费却对结果没有贡献，因此默认关掉。
// 可选 'off' | 'low' | 'high' | 'max'（deepseek 适配器档位）；null = 跟随模型默认。
const REASONING_EFFORT = 'off'
/** 从省到贵；模型不支持请求档位时回退到它支持的最省档位。 */
const EFFORT_RANK = { off: 0, none: 0, disabled: 0, minimal: 1, low: 2, medium: 3, high: 4, xhigh: 5, max: 6 }

/** 剪除结果外的 ``` 围栏包裹（模型偶尔复犯）。 */
function stripFence(s) {
  const t = s.trim()
  if (t.startsWith('```') && t.endsWith('```')) {
    const inner = t.slice(3, t.length - 3).trim()
    const nl = inner.indexOf('\n')
    const body = nl >= 0 ? inner.slice(nl + 1).trim() : inner
    if (body !== '') return body
  }
  return t
}

/** 保守清洗：删除整行匹配的过程性话术。 */
function stripChainLines(s) {
  const kept = []
  for (const line of s.split('\n')) {
    const t = line.trim()
    if (t === '') { kept.push(line); continue }
    const isMeta = /^(好的|没问题|收到|我来|让我|首先|其次|然后|接下来|总结|总的来说|综上所述|我的思考|思考过程|推理过程|分析如下|优化后的提示词如下|精炼后的提示词如下|以下是优化结果|以下是精炼结果|结果如下)[,，:：、。！!？?`\s]*$/u.test(t)
    const isProcess = /^(我想|我认为|我觉得|让我|我先|我们可以|我们需要|我的思路|思路如下|简短分析|重写如下|正文如下)[\s\S]{0,40}$/u.test(t)
    if (isMeta || isProcess) continue
    kept.push(line)
  }
  return kept.join('\n').trim()
}

function fnv1a(s) {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return (h >>> 0).toString(16)
}

// 简单 LRU：键含草稿长度与前缀，降低碰撞影响
const CACHE_MAX = 100
const CACHE_TTL = 24 * 3600 * 1000
const cacheMap = new Map()

function cacheKey(provider, model, text, variant) {
  return fnv1a(text) + '-' + text.length + '-' + fnv1a(text.slice(0, 64)) + '-' + fnv1a(provider + '\u0000' + model + '\u0000' + variant)
}

function cacheGet(key) {
  const hit = cacheMap.get(key)
  if (!hit) return null
  if (Date.now() - hit.at > CACHE_TTL) { cacheMap.delete(key); return null }
  cacheMap.delete(key)
  cacheMap.set(key, hit)
  return hit.value
}

function cacheSet(key, value) {
  if (cacheMap.has(key)) cacheMap.delete(key)
  cacheMap.set(key, { value, at: Date.now() })
  if (cacheMap.size > CACHE_MAX) cacheMap.delete(cacheMap.keys().next().value)
}

/** 每个 provider/model 只解析一次思考档位并记住结论。 */
async function resolveEffort(llm, provider, model, memo) {
  const route = provider + '\u0000' + model
  if (memo.has(route)) return memo.get(route)
  let decision = { effective: REASONING_EFFORT, requested: REASONING_EFFORT, verified: false }
  if (REASONING_EFFORT !== null && typeof llm.resolveModelInfo === 'function') {
    try {
      const info = await llm.resolveModelInfo(provider, model)
      const efforts = info && info.reasoning && Array.isArray(info.reasoning.efforts)
        ? info.reasoning.efforts.map((e) => String(e.id))
        : []
      if (efforts.length === 0) decision = { effective: null, requested: REASONING_EFFORT, verified: true }
      else if (efforts.includes(REASONING_EFFORT)) decision = { effective: REASONING_EFFORT, requested: REASONING_EFFORT, verified: true }
      else {
        const ranked = efforts.filter((id) => EFFORT_RANK[id] !== undefined).sort((a, b) => EFFORT_RANK[a] - EFFORT_RANK[b])
        decision = { effective: ranked.length > 0 ? ranked[0] : null, requested: REASONING_EFFORT, verified: true }
      }
    } catch {
      // 能力查询不可用：按常量下发；不支持时 finish 会带回可读错误
    }
  }
  memo.set(route, decision)
  return decision
}

const effortMemo = new Map()

return {
  apply(ctx) {
    harness.handle('prompt-refine', async (args) => {
      const text = (args && typeof args.text === 'string') ? args.text.trim() : ''
      if (text === '') return { ok: false, error: '草稿为空' }
      if (text.length > MAX_CHARS) return { ok: false, error: '超过 ' + MAX_CHARS + ' 字上限，请手动编辑' }
      const model = ctx.get('agentDefaultModel')
      if (model === undefined) return { ok: false, error: '默认模型服务不可用' }
      const llm = ctx.get('llm')
      if (llm === undefined) return { ok: false, error: 'LLM 服务不可用' }
      let sel
      try {
        sel = model.currentSelection()
      } catch (err) {
        return { ok: false, error: '读取当前模型选择失败' }
      }
      if (!sel || typeof sel.provider !== 'string' || typeof sel.model !== 'string') {
        return { ok: false, error: '未配置可用的模型' }
      }
      const provider = sel.provider
      const useModel = sel.model
      const started = Date.now()
      const effort = await resolveEffort(llm, provider, useModel, effortMemo)
      const key = cacheKey(provider, useModel, text, effort.effective === null ? 'default' : effort.effective)
      const hit = cacheGet(key)
      if (hit) {
        return { ok: true, text: hit.text, meta: Object.assign({}, hit.meta, { cached: true, latencyMs: Date.now() - started }) }
      }
      try {
        const options = {
          provider,
          model: useModel,
          messages: [{
            role: 'user',
            content: [{ type: 'text', text: text }],
            source: { kind: 'plugin', plugin: 'prompt-refiner' },
          }],
          system: OPTIMIZE_SYSTEM,
          maxTokens: MAX_TOKENS,
          temperature: TEMPERATURE,
        }
        if (effort.effective !== null) options.reasoningEffort = effort.effective
        const stream = llm.stream(options)
        const parts = new Map()
        let failure = null
        let truncated = false
        let usage = null
        for await (const chunk of stream) {
          if (chunk.type === 'text-delta') {
            parts.set(chunk.index, (parts.get(chunk.index) || '') + chunk.text)
          } else if (chunk.type === 'usage' && chunk.usage) {
            usage = chunk.usage
          } else if (chunk.type === 'finish') {
            const kind = chunk.reason && chunk.reason.kind
            if (kind === 'error' || kind === 'aborted') {
              const f = chunk.reason.failure
              failure = (f && f.message) ? String(f.message) : ('模型调用失败(' + kind + ')')
            } else if (kind === 'max-tokens') {
              truncated = true
            }
          }
        }
        if (failure !== null) return { ok: false, error: String(failure) }
        // 只接受正文字段；reasoning-delta（思考内容）一律不作为结果
        let out = [...parts.keys()].sort((a, b) => a - b).map((i) => parts.get(i)).join('').trim()
        if (truncated) {
          return {
            ok: false,
            error: out === ''
              ? '模型在思考阶段用尽 maxTokens（' + MAX_TOKENS + '），未输出正文；请把 REASONING_EFFORT 设为 "off" 或提高 MAX_TOKENS'
              : '结果被 maxTokens（' + MAX_TOKENS + '）截断，已丢弃；请提高 MAX_TOKENS 或把 REASONING_EFFORT 设为 "off"',
          }
        }
        if (out === '') return { ok: false, error: '模型未输出优化文本（可能仅返回了思考内容），请重试或更换模型' }
        out = stripFence(out)
        if (out.length > RESULT_MAX_CHARS) return { ok: false, error: '优化结果过长（疑似混入思考内容），请重试' }
        out = stripChainLines(out)
        if (out === '') return { ok: false, error: '优化结果为空，请重试' }
        const meta = {
          provider,
          model: useModel,
          cached: false,
          latencyMs: Date.now() - started,
          chars: { before: text.length, after: out.length },
          reasoningEffort: effort.effective,
          reasoningEffortRequested: effort.requested,
          usage: usage
            ? {
                inputTokens: usage.inputTokens != null ? usage.inputTokens : null,
                outputTokens: usage.outputTokens != null ? usage.outputTokens : null,
                totalTokens: usage.totalTokens != null ? usage.totalTokens : null,
                reasoningTokens: usage.reasoningTokens != null ? usage.reasoningTokens : null,
              }
            : null,
        }
        cacheSet(key, { text: out, meta })
        return { ok: true, text: out, meta }
      } catch (err) {
        return { ok: false, error: '精炼失败: ' + ((err && err.message) ? String(err.message) : String(err)) }
      }
    })
  },
}
