// 优化结果 LRU 缓存。键 = PROMPT_VERSION + provider + model + 草稿全文，
// 因此换模型或改 system prompt（递增版本号）都会自然失效。
// 进程内缓存即可覆盖绝大多数「同一草稿反复精炼」的场景；
// 跨重启持久化留到 Phase A 与统计一起做。

import { createHash } from 'node:crypto'
import { PROMPT_VERSION } from './system-prompt.js'

export class ResultCache {
  constructor({ max = 200, ttlMs = 24 * 3600 * 1000 } = {}) {
    this.max = max
    this.ttlMs = ttlMs
    this.map = new Map()
  }

  key(provider, model, text) {
    return createHash('sha256')
      .update(`${PROMPT_VERSION}\u0000${provider}\u0000${model}\u0000${text}`)
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
