// 用量统计：内存累计（自宿主启动起）+ JSONL 落盘（跨重启可分析）。
// 落盘位置：$DSH_HOME/prompt-refiner/metrics.jsonl，默认 ~/.dsh/prompt-refiner/。
// 任何落盘失败都只静默降级一次，绝不能影响精炼主流程。
//
// 口径说明（面板与 /prompt-refine/stats 都读这里）：
//   calls     = 收到的精炼请求总数 = 命中 + 跳过 + 失败 + 成功
//   hits      = 缓存命中（未产生模型费用）
//   skipped   = 门控拦截（空草稿/超长等，未调用模型）
//   failures  = 真的调用了模型但失败，或被判定不可用（截断/结果为空/混入思考）
//   *Tokens   = 仅统计真实调用的用量；outputTokens 已含模型的思考 token（DeepSeek 适配器
//               把 thinking 计在 output 内，且不单列 reasoningTokens）

import { appendFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'

export const counters = {
  calls: 0,        // 请求总数（含缓存命中、门控跳过与失败）
  hits: 0,         // 缓存命中数
  skipped: 0,      // 门控跳过数（未调用模型）
  failures: 0,     // 失败数（已调用模型或结果不可用）
  inputChars: 0,   // 草稿字符数累计（不含命中/跳过/失败）
  outputChars: 0,  // 结果字符数累计（不含命中/跳过/失败）
  inputTokens: 0,
  outputTokens: 0, // 含思考 token
  reasoningTokens: 0, // 仅当适配器单列 reasoningTokens 时非零
}

export function dataDir() {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(home, 'prompt-refiner')
}

let diskDisabled = false

function bump(entry) {
  counters.calls++
  if (entry.cached) {
    counters.hits++
    return
  }
  if (entry.skipped) {
    counters.skipped++
    return
  }
  if (entry.ok === false) {
    counters.failures++
    return
  }
  counters.inputChars += entry.charsBefore ?? 0
  counters.outputChars += entry.charsAfter ?? 0
  counters.inputTokens += entry.inputTokens ?? 0
  counters.outputTokens += entry.outputTokens ?? 0
  counters.reasoningTokens += entry.reasoningTokens ?? 0
}

/** 记录一条精炼事件；同步更新内存计数，异步追加 JSONL。 */
export function record(entry) {
  bump(entry)
  if (diskDisabled) return Promise.resolve()
  const line = JSON.stringify({ ts: new Date().toISOString(), ...entry })
  return mkdir(dataDir(), { recursive: true })
    .then(() => appendFile(join(dataDir(), 'metrics.jsonl'), line + '\n', 'utf8'))
    .catch(() => { diskDisabled = true })
}

export function snapshot() {
  return { ...counters, dataDir: dataDir(), diskDisabled }
}
