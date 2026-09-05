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

function fakeCtx({ output = GOOD_OUTPUT, usage = { inputTokens: 120, outputTokens: 88, totalTokens: 208 }, fail = false } = {}) {
  const ctx = {
    get(key) {
      if (key === 'llm') {
        return {
          async *stream(opts) {
            streamCalls++
            ctx.lastOpts = opts
            yield { type: 'text-delta', index: 0, text: output.slice(0, 10) }
            yield { type: 'text-delta', index: 0, text: output.slice(10) }
            if (usage) yield { type: 'usage', usage }
            yield { type: 'finish', reason: fail ? { kind: 'error', failure: { message: 'boom' } } : { kind: 'stop' } }
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

const CFG = { metrics: true, minChars: 0, maxChars: 8000, resultMaxChars: 4000, cacheMax: 200, cacheTtlMs: 86400000, maxTokens: 2048, temperature: 0.3 }

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

// 8. 统计：内存计数与落盘
{
  const s = snapshot()
  assert.ok(s.calls >= 5, `应累计多次调用，实际 ${s.calls}`)
  assert.ok(s.hits >= 1)
  assert.ok(s.failures >= 1)
  assert.ok(s.inputTokens >= 120)
  console.log(`    stats: calls=${s.calls} hits=${s.hits} failures=${s.failures} in=${s.inputTokens}tok out=${s.outputTokens}tok → ${s.dataDir}`)
}

console.log('\n全部冒烟测试通过 ✔')
