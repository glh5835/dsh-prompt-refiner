// 精炼主流程：门控 → 选模型（成本路由）→ 查缓存 → llm.stream → 清洗 → 记账。
// llm/agentDefaultModel 的调用契约与官方 llm-streaming 文档对齐：
//   stream 块：{type:'text-delta',index,text} | {type:'usage',usage} |
//              {type:'finish',reason:{kind,failure}}
//   TokenUsage：{inputTokens,outputTokens,totalTokens?,cacheReadTokens?,...}

import { evaluate } from './gate.js'
import { ResultCache } from './cache.js'
import { SYSTEM_PROMPT } from './system-prompt.js'
import { stripFence, stripChainLines } from './clean.js'
import { record } from './metrics.js'

export function createOptimizer(cfg) {
  const cache = new ResultCache(cfg)

  return async function optimize(ctx, rawText) {
    const gate = evaluate(rawText, cfg)
    if (gate.skip) return { ok: false, error: gate.reason }
    const text = gate.text

    const model = ctx.get('agentDefaultModel')
    if (model === undefined) return { ok: false, error: '默认模型服务不可用' }
    const llm = ctx.get('llm')
    if (llm === undefined) return { ok: false, error: 'LLM 服务不可用' }
    let sel
    try {
      sel = model.currentSelection()
    } catch {
      return { ok: false, error: '读取当前模型选择失败' }
    }
    if (!sel || typeof sel.provider !== 'string' || typeof sel.model !== 'string') {
      return { ok: false, error: '未配置可用的模型' }
    }
    // 成本路由：优化器默认跟随会话模型；配置 model/provider 后改走便宜的模型
    const provider = cfg.provider || sel.provider
    const useModel = cfg.model || sel.model
    const started = Date.now()
    const key = cache.key(provider, useModel, text)

    const hit = cache.get(key)
    if (hit) {
      const meta = { ...hit.meta, cached: true, latencyMs: Date.now() - started }
      if (cfg.metrics !== false) {
        record({
          ok: true, cached: true, provider, model: useModel,
          charsBefore: meta.chars ? meta.chars.before : null,
          charsAfter: meta.chars ? meta.chars.after : null,
        })
      }
      return { ok: true, text: hit.text, meta }
    }

    try {
      const stream = llm.stream({
        provider,
        model: useModel,
        messages: [{
          role: 'user',
          content: [{ type: 'text', text }],
          source: { kind: 'plugin', plugin: 'prompt-refiner' },
        }],
        system: SYSTEM_PROMPT,
        maxTokens: cfg.maxTokens,
        temperature: cfg.temperature,
      })
      const parts = new Map()
      let failure = null
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
            failure = (f && f.message) ? String(f.message) : `模型调用失败(${kind})`
          }
        }
      }
      if (failure !== null) {
        if (cfg.metrics !== false) record({ ok: false, provider, model: useModel, error: failure })
        return { ok: false, error: failure }
      }
      // 只接受正文字段；reasoning-delta（思考内容）一律不作为结果
      let out = [...parts.keys()].sort((a, b) => a - b).map((i) => parts.get(i)).join('').trim()
      if (out === '') {
        return { ok: false, error: '模型未输出优化文本（可能仅返回了思考内容），请重试或更换模型' }
      }
      out = stripFence(out)
      if (out.length > cfg.resultMaxChars) {
        return { ok: false, error: '优化结果过长（疑似混入思考内容），请重试' }
      }
      out = stripChainLines(out)
      if (out === '') return { ok: false, error: '优化结果为空，请重试' }

      const meta = {
        provider,
        model: useModel,
        cached: false,
        latencyMs: Date.now() - started,
        chars: { before: text.length, after: out.length },
        usage: usage
          ? {
              inputTokens: usage.inputTokens ?? null,
              outputTokens: usage.outputTokens ?? null,
              totalTokens: usage.totalTokens ?? null,
            }
          : null,
      }
      cache.set(key, { text: out, meta })
      if (cfg.metrics !== false) {
        record({
          ok: true, cached: false, provider, model: useModel,
          charsBefore: meta.chars.before, charsAfter: meta.chars.after,
          inputTokens: meta.usage ? meta.usage.inputTokens : null,
          outputTokens: meta.usage ? meta.usage.outputTokens : null,
          latencyMs: meta.latencyMs,
        })
      }
      return { ok: true, text: out, meta }
    } catch (err) {
      const msg = '优化失败: ' + ((err && err.message) ? String(err.message) : String(err))
      if (cfg.metrics !== false) record({ ok: false, provider, model: useModel, error: msg })
      return { ok: false, error: msg }
    }
  }
}
