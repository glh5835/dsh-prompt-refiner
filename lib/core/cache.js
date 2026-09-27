// 优化结果 LRU 缓存。键 = PROMPT_VERSION + provider + model + 草稿全文 + 调用变体，
// 因此换模型、改 system prompt（递增版本号）、改思考档位都会自然失效。
// 进程内缓存即可覆盖绝大多数「同一草稿反复精炼」的场景；
// 跨重启持久化留到 Phase A 与统计一起做。

import { createHash } from 'node:crypto'
import { PROMPT_VERSION } from './system-prompt.js'

export class ResultCache {
  /**
   * 同时接受两种键名：{ max, ttlMs } 与插件配置里的 { cacheMax, cacheTtlMs }。
   * 后者曾因键名不匹配而被静默忽略，配置改了却不生效。
   */
  constructor({ max, ttlMs, cacheMax, cacheTtlMs } = {}) {
    const resolvedMax = max ?? cacheMax
    const resolvedTtl = ttlMs ?? cacheTtlMs
    this.max = Number.isSafeInteger(resolvedMax) && resolvedMax > 0 ? resolvedMax : 200
    this.ttlMs = Number.isFinite(resolvedTtl) && resolvedTtl > 0 ? resolvedTtl : 24 * 3600 * 1000
    this.map = new Map()
  }

  /** variant 承载影响结果的调用参数（如实际下发的思考档位）。 */
  key(provider, model, text, variant = '') {
    return createHash('sha256')
      .update(`${PROMPT_VERSION}\u0000${provider}\u0000${model}\u0000${variant}\u0000${text}`)
      .digest('hex')
  }

  get(key) {
    const hit = this.map.get(key)
    if (!hit) return null
    if (Date.now() - hit.at > this.ttlMs) {
      this.map.delete(key)
      return null
    }
    // 触碰即前移（LRU）
    this.map.delete(key)
    this.map.set(key, hit)
    return hit.value
  }

  set(key, value) {
    if (this.map.has(key)) this.map.delete(key)
    this.map.set(key, { value, at: Date.now() })
    if (this.map.size > this.max) this.map.delete(this.map.keys().next().value)
  }
}
