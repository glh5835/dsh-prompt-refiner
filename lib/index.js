// dsh-prompt-refiner — Host 半部（静态 cordis 插件，ESM）。
//
// 职责：
//   POST /prompt-refine       { text } → { ok, text, meta } | { ok:false, error }
//   GET  /prompt-refine/stats → 累计统计（内存计数 + JSONL 落盘位置）
//
// 配置优先级：cordis 条目 config（apply 第二参） > config.json > 内置默认。
// config.json 位于 $DSH_HOME/prompt-refiner/config.json（默认 ~/.dsh/...），
// 字段见 DEFAULTS；改 optimizer.model 即把精炼调用路由到便宜模型。

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createOptimizer } from './core/optimizer.js'
import { dataDir, snapshot } from './core/metrics.js'

export const name = 'dsh-prompt-refiner'

/** 硬依赖：承载路由表的宿主 HTTP 面。 */
export const inject = ['webServer']

export const DEFAULTS = {
  /** 优化器模型；null = 跟随会话当前模型。省钱可设 'deepseek-v4-flash'。 */
  model: null,
  /** 优化器 provider；null = 跟随会话当前 provider。 */
  provider: null,
  /**
   * 思考档位：'off' | 'low' | 'high' | 'max'（deepseek 适配器支持档位），
   * null = 不下发、跟随模型默认。默认 off —— 精炼是改写任务，思考 token 计入
   * output 计费却对结果没有贡献，是这条链路最大的成本项。
   * 模型不支持所请求档位时会自动回退到它支持的最省档位。
   */
  reasoningEffort: 'off',
  maxTokens: 2048,
  temperature: 0.3,
  /** 手动按钮模式不设长度下限；Phase A 自动模式建议 8。 */
  minChars: 0,
  maxChars: 8000,
  /** 结果长度护栏：超过视为混入思考内容。 */
  resultMaxChars: 4000,
  cacheMax: 200,
  cacheTtlMs: 24 * 3600 * 1000,
  /** 统计落盘开关。 */
  metrics: true,
}

async function loadFileConfig() {
  try {
    const raw = await readFile(join(dataDir(), 'config.json'), 'utf8')
    return JSON.parse(raw)
  } catch {
    return {}
  }
}

/** Collect the request body as UTF-8 text (bounded to 256 KiB). */
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > 262144) {
        reject(new Error('body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function sendJson(res, status, data) {
  if (res.headersSent) return
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(data))
}

export function apply(ctx, config) {
  // 惰性初始化：apply 必须同步返回；首次请求时再解析配置并创建优化器。
  let ready = null
  const getRunner = () => {
    if (!ready) {
      ready = (async () => {
        const inline = (config && typeof config === 'object') ? config : null
        const fileCfg = inline ? {} : await loadFileConfig()
        const cfg = Object.assign({}, DEFAULTS, fileCfg, inline || {})
        return { cfg, optimize: createOptimizer(cfg) }
      })()
    }
    return ready
  }

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/prompt-refine',
    handler: async (req, res) => {
      if (req.method !== 'POST') {
        sendJson(res, 405, { ok: false, error: 'method not allowed' })
        return
      }
      let payload
      try {
        payload = JSON.parse(await readBody(req))
      } catch {
        sendJson(res, 400, { ok: false, error: 'invalid JSON body' })
        return
      }
      const text = (payload && typeof payload.text === 'string') ? payload.text : ''
      const { optimize } = await getRunner()
      const result = await optimize(ctx, text)
      sendJson(res, 200, result)
    },
  }), 'dsh-prompt-refiner: /prompt-refine route')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/prompt-refine/stats',
    handler: async (req, res) => {
      if (req.method !== 'GET') {
        sendJson(res, 405, { ok: false, error: 'method not allowed' })
        return
      }
      sendJson(res, 200, { ok: true, stats: snapshot() })
    },
  }), 'dsh-prompt-refiner: /prompt-refine/stats route')
}
