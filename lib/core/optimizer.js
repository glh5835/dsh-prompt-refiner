// 精炼主流程：门控 → 选模型（成本路由）→ 解析思考档位 → 查缓存 → llm.stream → 清洗 → 记账。
// llm/agentDefaultModel 的调用契约与官方 llm-streaming 文档对齐：
//   stream 块：{type:'text-delta',index,text} | {type:'reasoning-delta',index,text} |
//              {type:'usage',usage} | {type:'finish',reason:{kind,failure}}
//   GenerateOptions：{ provider, model, reasoningEffort?, messages, system, maxTokens, temperature, signal? }
//   FinishReason.kind：'stop' | 'tool-calls' | 'max-tokens' | 'aborted' | 'error'
//   TokenUsage：{inputTokens,outputTokens,totalTokens?,cacheReadTokens?,cacheWriteTokens?,reasoningTokens?}

import { evaluate } from './gate.js'
import { ResultCache } from './cache.js'
import { SYSTEM_PROMPT } from './system-prompt.js'
import { stripFence, stripChainLines } from './clean.js'
import { record } from './metrics.js'

/**
 * 思考档位按「从省到贵」排序。模型声明的档位里若不含用户请求的档位，
 * 就回退到它支持的最省档位——绝不能把请求原样下发，因为契约规定
 * 不支持的档位会在 provider I/O 之前直接 reject。
 */
const EFFORT_RANK = { off: 0, none: 0, disabled: 0, minimal: 1, low: 2, medium: 3, high: 4, xhigh: 5, max: 6 }

export function createOptimizer(cfg) {
  const cache = new ResultCache({ max: cfg.cacheMax, ttlMs: cfg.cacheTtlMs })
  /** route → { effective: string|null, requested: string|null, verified: boolean } */
  const effortByRoute = new Map()

  /**
   * 解析本次调用实际下发的思考档位。精炼是改写任务，默认 off：思考 token 也计入
   * output 计费，却对结果没有贡献，是这条链路最大的成本项。
   * 每个 provider/model 只查一次模型能力并缓存结论。
   */
  async function resolveEffort(llm, provider, model) {
    const route = provider + '\u0000' + model
    const memo = effortByRoute.get(route)
    if (memo !== undefined) return memo

    const requested = (typeof cfg.reasoningEffort === 'string' && cfg.reasoningEffort !== '') ? cfg.reasoningEffort : null
    let decision = { effective: requested, requested, verified: false }
    if (requested !== null && typeof llm.resolveModelInfo === 'function') {
      try {
        const info = await llm.resolveModelInfo(provider, model)
        const efforts = info && info.reasoning && Array.isArray(info.reasoning.efforts)
          ? info.reasoning.efforts.map((e) => String(e.id))
          : []
        if (efforts.length === 0) {
          // 该模型未声明思考档位：不下发，避免 UNSUPPORTED_REASONING_EFFORT
          decision = { effective: null, requested, verified: true }
        } else if (efforts.includes(requested)) {
          decision = { effective: requested, requested, verified: true }
        } else {
          const ranked = efforts
            .filter((id) => EFFORT_RANK[id] !== undefined)
            .sort((a, b) => EFFORT_RANK[a] - EFFORT_RANK[b])
          decision = { effective: ranked.length > 0 ? ranked[0] : null, requested, verified: true }
        }
      } catch {
        // 能力查询不可用：按用户配置下发；若不支持，finish 会带回可读错误
        decision = { effective: requested, requested, verified: false }
      }
    }
    effortByRoute.set(route, decision)
    return decision
  }

  return async function optimize(ctx, rawText) {
    const gate = evaluate(rawText, cfg)
    if (gate.skip) {
      if (cfg.metrics !== false) record({ ok: false, skipped: true, error: gate.reason })
      return { ok: false, error: gate.reason }
    }
    const text = gate.text

    // 预检失败也计入 calls，否则统计口径与「请求总数」不符
    const preflightFail = (error) => {
      if (cfg.metrics !== false) record({ ok: false, error })
      return { ok: false, error }
    }

    const model = ctx.get('agentDefaultModel')
    if (model === undefined) return preflightFail('默认模型服务不可用')
    const llm = ctx.get('llm')
    if (llm === undefined) return preflightFail('LLM 服务不可用')
    let sel
    try {
      sel = model.currentSelection()
    } catch {
      return preflightFail('读取当前模型选择失败')
    }
    if (!sel || typeof sel.provider !== 'string' || typeof sel.model !== 'string') {
      return preflightFail('未配置可用的模型')
    }
    // 成本路由：优化器默认跟随会话模型；配置 model/provider 后改走便宜的模型
    const provider = cfg.provider || sel.provider
    const useModel = cfg.model || sel.model
    const started = Date.now()

    const effort = await resolveEffort(llm, provider, useModel)
    const key = cache.key(provider, useModel, text, effort.effective ?? 'default')

    const hit = cache.get(key)
    if (hit) {
      const meta = { ...hit.meta, cached: true, latencyMs: Date.now() - started }
      if (cfg.metrics !== false) {
        record({
          ok: true, cached: true, provider, model: useModel,
          reasoningEffort: meta.reasoningEffort ?? null,
          charsBefore: meta.chars ? meta.chars.before : null,
          charsAfter: meta.chars ? meta.chars.after : null,
        })
      }
      return { ok: true, text: hit.text, meta }
    }

    const fail = (error, extra) => {
      if (cfg.metrics !== false) {
        record({ ok: false, provider, model: useModel, error, reasoningEffort: effort.effective, ...extra })
      }
      return { ok: false, error }
    }

    try {
      const options = {
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
            failure = (f && f.message) ? String(f.message) : `模型调用失败(${kind})`
          } else if (kind === 'max-tokens') {
            truncated = true
          }
        }
      }
      if (failure !== null) return fail(String(failure))

      // 只接受正文字段；reasoning-delta（思考内容）一律不作为结果
      let out = [...parts.keys()].sort((a, b) => a - b).map((i) => parts.get(i)).join('').trim()
      if (truncated) {
        // 截断的结果（尤其思考阶段就吃满配额、正文为空）绝不能当成功结果应用回去
        return fail(
          out === ''
            ? `模型在思考阶段用尽 maxTokens（${cfg.maxTokens}），未输出正文；请把 reasoningEffort 设为 "off" 或提高 maxTokens`
            : `结果被 maxTokens（${cfg.maxTokens}）截断，已丢弃；请提高 maxTokens 或把 reasoningEffort 设为 "off"`,
          { truncated: true },
        )
      }
      if (out === '') return fail('模型未输出优化文本（可能仅返回了思考内容），请重试或更换模型')
      out = stripFence(out)
      if (out.length > cfg.resultMaxChars) return fail('优化结果过长（疑似混入思考内容），请重试')
      out = stripChainLines(out)
      if (out === '') return fail('优化结果为空，请重试')

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
              inputTokens: usage.inputTokens ?? null,
              outputTokens: usage.outputTokens ?? null,
              totalTokens: usage.totalTokens ?? null,
              reasoningTokens: usage.reasoningTokens ?? null,
            }
          : null,
      }
      cache.set(key, { text: out, meta })
      if (cfg.metrics !== false) {
        record({
          ok: true, cached: false, provider, model: useModel,
          reasoningEffort: effort.effective,
          charsBefore: meta.chars.before, charsAfter: meta.chars.after,
          inputTokens: meta.usage ? meta.usage.inputTokens : null,
          outputTokens: meta.usage ? meta.usage.outputTokens : null,
          reasoningTokens: meta.usage ? meta.usage.reasoningTokens : null,
          latencyMs: meta.latencyMs,
        })
      }
      return { ok: true, text: out, meta }
    } catch (err) {
      const msg = '优化失败: ' + ((err && err.message) ? String(err.message) : String(err))
      if (cfg.metrics !== false) {
        record({ ok: false, provider, model: useModel, error: msg, reasoningEffort: effort.effective })
      }
      return { ok: false, error: msg }
    }
  }
}
