// 冒烟测试：node tests/smoke.mjs
// 用假 ctx 驱动 lib/core/*，不需要 dsh 运行时。
// 把 DSH_HOME 指到临时目录，统计落盘写进系统临时区，不碰用户真实 ~/.dsh。
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'

process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'dsh-prompt-refiner-test-'))

const { createOptimizer } = await import('../lib/core/optimizer.js')
const { evaluate } = await import('../lib/core/gate.js')
const { ResultCache } = await import('../lib/core/cache.js')
const { splitAssumptions, stripFence, stripChainLines } = await import('../lib/core/clean.js')
const { snapshot } = await import('../lib/core/metrics.js')

const GOOD_OUTPUT = '[目标] 实现一个把 CSV 转成 Markdown 表格的命令行工具，产物为单文件脚本 convert.mjs。\n[背景] 输入为逗号分隔的 UTF-8 CSV，路径由命令行参数给出。\n[步骤] 1. 解析参数；2. 逐行解析 CSV；3. 输出 Markdown 表。\n[要求] 处理带引号的字段；空文件输出空表；转换后打印行数。\n[假设] 假设：运行环境为 Node.js 20+。'

let streamCalls = 0
let resolveCalls = 0

function fakeCtx({
  output = GOOD_OUTPUT,
  usage = { inputTokens: 120, outputTokens: 88, totalTokens: 208 },
  fail = false,
  truncate = false,
  efforts = ['off', 'low', 'high', 'max'],
} = {}) {
  const ctx = {
    get(key) {
      if (key === 'llm') {
        return {
          async resolveModelInfo() {
            resolveCalls++
            return {
              provider: 'deepseek',
              id: 'deepseek-reasoner',
              reasoning: { efforts: efforts.map((id) => ({ id })), defaultEffort: 'high' },
            }
          },
          async *stream(opts) {
            streamCalls++
            ctx.lastOpts = opts
            yield { type: 'reasoning-delta', index: 0, text: '（思考内容不应进入结果）' }
            yield { type: 'text-delta', index: 0, text: output.slice(0, 10) }
            yield { type: 'text-delta', index: 0, text: output.slice(10) }
            if (usage) yield { type: 'usage', usage }
            yield {
              type: 'finish',
              reason: fail ? { kind: 'error', failure: { message: 'boom' } } : truncate ? { kind: 'max-tokens' } : { kind: 'stop' },
            }
          },
        }
      }
      if (key === 'agentDefaultModel') {
        return { currentSelection: () => ({ provider: 'deepseek', model: 'deepseek-reasoner' }) }
      }
      return undefined
    },
  }
  return ctx
}

const CFG = {
  metrics: true, minChars: 0, maxChars: 8000, resultMaxChars: 4000,
  cacheMax: 200, cacheTtlMs: 86400000, maxTokens: 2048, temperature: 0.3,
  reasoningEffort: 'off',
}

// 1. 门控
assert.equal(evaluate('', CFG).skip, true)
assert.equal(evaluate('   ', CFG).skip, true)
assert.equal(evaluate('x'.repeat(8001), CFG).skip, true)
assert.equal(evaluate(' 帮我写个脚本 ', CFG).skip, false)
assert.equal(evaluate(' 帮我写个脚本 ', CFG).text, '帮我写个脚本')
console.log('ok 1 gate')

// 2. 主流程 + 用量捕获 + 成本路由（默认跟随会话模型）
{
  const ctx = fakeCtx()
  const optimize = createOptimizer(CFG)
  const r = await optimize(ctx, '帮我写个把 CSV 转 Markdown 的工具')
  assert.equal(r.ok, true)
  assert.equal(r.meta.model, 'deepseek-reasoner')
  assert.equal(r.meta.provider, 'deepseek')
  assert.equal(r.meta.usage.inputTokens, 120)
  assert.equal(r.meta.usage.outputTokens, 88)
  assert.equal(r.meta.chars.before, '帮我写个把 CSV 转 Markdown 的工具'.length)
  assert.ok(r.meta.latencyMs >= 0)
  assert.ok(ctx.lastOpts.messages[0].source.kind === 'plugin')
  assert.ok(!r.text.includes('思考内容'), 'reasoning-delta 不得进入结果')
}
console.log('ok 2 happy path + usage')

// 3. 缓存命中：同输入第二次不触发 llm.stream
{
  const ctx = fakeCtx()
  const optimize = createOptimizer(CFG)
  const first = await optimize(ctx, '同样的草稿')
  assert.equal(first.ok, true)
  assert.equal(first.meta.cached, false)
  const callsAfterFirst = streamCalls
  const second = await optimize(ctx, '同样的草稿')
  assert.equal(second.ok, true)
  assert.equal(second.meta.cached, true)
  assert.equal(streamCalls, callsAfterFirst, '缓存命中不应再次调用模型')
  // 不同输入照常调用
  await optimize(ctx, '另一份草稿')
  assert.equal(streamCalls, callsAfterFirst + 1)
}
console.log('ok 3 cache')

// 4. 成本路由：配置 model 后走便宜模型，provider 沿用会话选择
{
  const ctx = fakeCtx()
  const optimize = createOptimizer({ ...CFG, model: 'deepseek-chat' })
  await optimize(ctx, '路由测试草稿')
  assert.equal(ctx.lastOpts.model, 'deepseek-chat')
  assert.equal(ctx.lastOpts.provider, 'deepseek')
  assert.equal(ctx.lastOpts.maxTokens, 2048)
  assert.ok(ctx.lastOpts.system.includes('提示词精炼器'))
}
console.log('ok 4 cost routing')

// 5. 失败路径：finish error 透传为可读错误
{
  const ctx = fakeCtx({ fail: true })
  const optimize = createOptimizer(CFG)
  const r = await optimize(ctx, '会失败的草稿')
  assert.equal(r.ok, false)
  assert.equal(r.error, 'boom')
}
console.log('ok 5 failure path')

// 6. 清洗：围栏、过程话术、假设拆分
assert.equal(stripFence('```\n[目标] x\n```'), '[目标] x')
assert.equal(stripFence('```text\n[目标] x\n```'), '[目标] x')
assert.equal(stripFence('[目标] x'), '[目标] x')
// 保守清洗：只剥整行话术；带实质内容的行（如"首先分析一下这个需求"）保留
assert.equal(stripChainLines('好的。\n[目标] x\n让我来分析一下这个需求'), '[目标] x')
assert.equal(stripChainLines('[目标] x\n首先解析参数'), '[目标] x\n首先解析参数')
{
  const { body, assumptions } = splitAssumptions(GOOD_OUTPUT)
  assert.ok(body.startsWith('[目标]'))
  assert.ok(!body.includes('[假设]'))
  assert.ok(assumptions.startsWith('[假设]'))
  assert.ok(assumptions.includes('假设：运行环境为 Node.js 20+'))
  // 无假设小节时原样返回
  const plain = splitAssumptions('[目标] 只有目标')
  assert.equal(plain.body, '[目标] 只有目标')
  assert.equal(plain.assumptions, '')
}
console.log('ok 6 clean/split')

// 7. LRU 驱逐与 TTL 过期
{
  const c = new ResultCache({ max: 2, ttlMs: 30 })
  const k1 = c.key('p', 'm', 'a')
  const k2 = c.key('p', 'm', 'b')
  const k3 = c.key('p', 'm', 'c')
  c.set(k1, { text: '1' }); c.set(k2, { text: '2' })
  c.get(k1) // 触碰 k1，使 k2 成为最旧
  c.set(k3, { text: '3' })
  assert.ok(c.get(k1), '最近使用的 k1 应存活')
  assert.equal(c.get(k2), null, '最旧的 k2 应被驱逐')
  await new Promise((r) => setTimeout(r, 40))
  assert.equal(c.get(k1), null, 'TTL 过期后应返回空')
}
console.log('ok 7 cache eviction/ttl')

// 8. 缓存配置键名：插件配置里的 cacheMax / cacheTtlMs 必须真的生效（曾被静默忽略）
{
  const aliased = new ResultCache({ cacheMax: 3, cacheTtlMs: 1234 })
  assert.equal(aliased.max, 3)
  assert.equal(aliased.ttlMs, 1234)
  const dflt = new ResultCache({})
  assert.equal(dflt.max, 200)
  assert.equal(dflt.ttlMs, 24 * 3600 * 1000)
  const bogus = new ResultCache({ cacheMax: 0, cacheTtlMs: -5 })
  assert.equal(bogus.max, 200, '非法值应回退默认')
  assert.equal(bogus.ttlMs, 24 * 3600 * 1000)

  // 端到端：cacheMax=1 时第一份草稿应被驱逐，再次精炼必须重新调用模型
  const ctx = fakeCtx()
  const optimize = createOptimizer({ ...CFG, cacheMax: 1 })
  await optimize(ctx, '草稿甲')
  const afterFirst = streamCalls
  await optimize(ctx, '草稿乙')
  await optimize(ctx, '草稿甲')
  assert.equal(streamCalls, afterFirst + 2, 'cacheMax=1 时甲应已被驱逐')
}
console.log('ok 8 cacheMax/cacheTtlMs wiring')

// 9. 思考档位：默认 off、能力校验、回退、null 表示不下发
{
  // 默认下发 off，且能力只解析一次
  const before = resolveCalls
  const ctx = fakeCtx()
  const optimize = createOptimizer(CFG)
  const r = await optimize(ctx, '档位测试草稿一')
  assert.equal(ctx.lastOpts.reasoningEffort, 'off')
  assert.equal(r.meta.reasoningEffort, 'off')
  assert.equal(r.meta.reasoningEffortRequested, 'off')
  await optimize(ctx, '档位测试草稿二')
  assert.equal(resolveCalls, before + 1, '同一 provider/model 只应解析一次能力')

  // 模型不支持 off 时回退到它支持的最省档位
  const weak = fakeCtx({ efforts: ['high', 'max'] })
  const optimizeWeak = createOptimizer({ ...CFG, reasoningEffort: 'off' })
  const rWeak = await optimizeWeak(weak, '档位回退草稿')
  assert.equal(weak.lastOpts.reasoningEffort, 'high', '不支持时应回退到最省档位')
  assert.equal(rWeak.meta.reasoningEffortRequested, 'off')
  assert.equal(rWeak.meta.reasoningEffort, 'high')

  // null = 不下发，跟随模型默认
  const off = fakeCtx()
  const optimizeOff = createOptimizer({ ...CFG, reasoningEffort: null })
  await optimizeOff(off, '不控制档位的草稿')
  assert.equal(Object.hasOwn(off.lastOpts, 'reasoningEffort'), false)

  // 模型未声明任何档位时不下发，避免 UNSUPPORTED_REASONING_EFFORT
  const none = fakeCtx({ efforts: [] })
  const optimizeNone = createOptimizer(CFG)
  await optimizeNone(none, '无档位声明的草稿')
  assert.equal(Object.hasOwn(none.lastOpts, 'reasoningEffort'), false)
}
console.log('ok 9 reasoning effort resolution')

// 10. 缓存键含档位：换档位不得复用旧结果
{
  const ctx = fakeCtx()
  const off = createOptimizer({ ...CFG, reasoningEffort: 'off' })
  const high = createOptimizer({ ...CFG, reasoningEffort: 'high' })
  const a = await off(ctx, '档位缓存草稿')
  const b = await off(ctx, '档位缓存草稿')
  assert.equal(b.meta.cached, true)
  const c = await high(ctx, '档位缓存草稿')
  assert.equal(c.meta.cached, false, '不同档位应各自缓存')
  assert.equal(a.meta.cached, false)
  assert.equal(ctx.lastOpts.reasoningEffort, 'high')
}
console.log('ok 10 cache key includes effort')

// 11. max-tokens 截断：不得当作成功结果应用回去
{
  const ctx = fakeCtx({ truncate: true })
  const optimize = createOptimizer(CFG)
  const r = await optimize(ctx, '会被截断的草稿')
  assert.equal(r.ok, false)
  assert.ok(r.error.includes('截断'), r.error)
  // 截断结果不入缓存
  const again = await optimize(ctx, '会被截断的草稿')
  assert.equal(again.ok, false)
}
console.log('ok 11 truncation rejected')

// 12. usage.reasoningTokens 透传（适配器单列时）
{
  const ctx = fakeCtx({ usage: { inputTokens: 100, outputTokens: 300, totalTokens: 400, reasoningTokens: 220 } })
  const optimize = createOptimizer(CFG)
  const r = await optimize(ctx, '思考 token 草稿')
  assert.equal(r.meta.usage.reasoningTokens, 220)
  assert.equal(r.meta.usage.outputTokens, 300)
}
console.log('ok 12 reasoning tokens passthrough')

// 13. 统计口径：calls = 命中 + 跳过 + 失败 + 成功
{
  const ctx = fakeCtx()
  const optimize = createOptimizer(CFG)
  await optimize(ctx, '')            // 门控跳过
  await optimize(ctx, '统计草稿甲')   // 成功
  await optimize(ctx, '统计草稿甲')   // 命中
  await optimize(ctx, '统计草稿乙')   // 成功
  const s = snapshot()
  assert.ok(s.skipped >= 1, `应记录门控跳过，实际 ${s.skipped}`)
  assert.ok(s.hits >= 1)
  assert.ok(s.calls >= 5, `应累计多次调用，实际 ${s.calls}`)
  assert.ok(s.failures >= 1)
  assert.equal(s.calls, s.hits + s.skipped + s.failures + (s.calls - s.hits - s.skipped - s.failures))
  assert.ok(s.inputTokens >= 120)
  assert.ok('reasoningTokens' in s)
  console.log(`    stats: calls=${s.calls} hits=${s.hits} skipped=${s.skipped} failures=${s.failures} in=${s.inputTokens}tok out=${s.outputTokens}tok → ${s.dataDir}`)
}

// 14. 路由层：POST /prompt-refine 与 GET /prompt-refine/stats 的接线与配置优先级
{
  const { apply: applyPlugin, DEFAULTS } = await import('../lib/index.js')
  assert.equal(DEFAULTS.reasoningEffort, 'off', '默认应关掉思考档位')

  const routes = new Map()
  const effects = []
  const pluginCtx = {
    effect(fn, label) { effects.push(label); const d = fn(); return typeof d === 'function' ? d : () => {} },
    webServer: { register(route) { routes.set(route.path, route); return () => routes.delete(route.path) } },
    get(key) {
      if (key === 'llm') {
        return {
          async resolveModelInfo() { return { reasoning: { efforts: [{ id: 'off' }, { id: 'high' }] } } },
          async *stream(opts) {
            this.lastOpts = opts
            yield { type: 'text-delta', index: 0, text: GOOD_OUTPUT }
            yield { type: 'usage', usage: { inputTokens: 11, outputTokens: 22, totalTokens: 33 } }
            yield { type: 'finish', reason: { kind: 'stop' } }
          },
        }
      }
      if (key === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'deepseek', model: 'deepseek-reasoner' }) }
      return undefined
    },
  }
  applyPlugin(pluginCtx, { metrics: false })
  assert.ok(routes.has('/prompt-refine'))
  assert.ok(routes.has('/prompt-refine/stats'))
  assert.equal(effects.length, 2)

  const { Readable } = await import('node:stream')
  function fakeRes() {
    const out = { status: null, body: '' }
    return {
      out,
      headersSent: false,
      writeHead(status) { out.status = status; this.headersSent = true },
      end(body) { out.body = body },
    }
  }
  async function call(route, method, payload) {
    const req = Readable.from(payload === undefined ? [] : [Buffer.from(JSON.stringify(payload), 'utf8')])
    req.method = method
    const res = fakeRes()
    await routes.get(route).handler(req, res)
    return { status: res.out.status, json: res.out.body === '' ? null : JSON.parse(res.out.body) }
  }

  const post = await call('/prompt-refine', 'POST', { text: '路由层草稿' })
  assert.equal(post.status, 200)
  assert.equal(post.json.ok, true)
  assert.equal(post.json.meta.reasoningEffort, 'off')
  assert.equal(post.json.meta.usage.inputTokens, 11)
  assert.ok(post.json.text.startsWith('[目标]'))

  const wrongMethod = await call('/prompt-refine', 'GET')
  assert.equal(wrongMethod.status, 405)

  const badJson = await call('/prompt-refine', 'POST', undefined)
  // 空 body 不是合法 JSON → 400
  assert.equal(badJson.status, 400)

  const stats = await call('/prompt-refine/stats', 'GET')
  assert.equal(stats.status, 200)
  assert.ok(stats.json.stats && typeof stats.json.stats.calls === 'number')
}
console.log('ok 14 http routes')

// 15. client 半部：静态版与动态版 CSS 必须一致，且关键防护不能回退
{
  const { readFileSync } = await import('node:fs')
  const stat = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  const dyn = readFileSync(new URL('../src/client.js', import.meta.url), 'utf8')
  const pick = (src) => {
    const m = /const CSS = '([^']*)'/.exec(src)
    assert.ok(m, 'client 里应能找到 CSS 常量')
    return m[1]
  }
  const cssStatic = pick(stat)
  const cssDynamic = pick(dyn)
  assert.equal(cssStatic, cssDynamic, '静态版与动态版的 CSS 必须逐字一致')

  assert.ok(cssStatic.includes('z-index:60'), '面板必须压过卡片内容，又不能盖住 z-index:100 的命令菜单')
  assert.ok(cssStatic.includes('max-height:min(70vh,560px)'), '面板需要视口上限')
  assert.ok(cssStatic.includes('.prompt-refine-panel{position:absolute;bottom:calc(100% + 8px);left:0;right:0;'),
    '面板宽度直接对齐宿主 overlayAnchor（= 卡片宽度），不再用 JS 测量')
  assert.ok(!stat.includes('ResizeObserver'), '静态版不应再依赖 JS 测量宽度')
  assert.ok(!dyn.includes('ResizeObserver'), '动态版不应再依赖 JS 测量宽度')
  assert.ok(stat.includes("props.useInput((s) => (s && typeof s.draft === 'string') ? s.draft : '')"),
    'draft 选择器应返回基本类型')
  assert.ok(/出 ' \+ outTok/.test(stat), 'meta 行应标注 output 含思考 token')
}
console.log('ok 15 client bundle invariants')

console.log('\n全部冒烟测试通过 ✔')
