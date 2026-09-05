// 用量统计：内存累计（自宿主启动起）+ JSONL 落盘（跨重启可分析）。
// 落盘位置：$DSH_HOME/prompt-refiner/metrics.jsonl，默认 ~/.dsh/prompt-refiner/。
// 任何落盘失败都只静默降级一次，绝不能影响精炼主流程。

import { appendFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'

export const counters = {
  calls: 0,        // 请求总数（含缓存命中与失败）
  hits: 0,         // 缓存命中数
  failures: 0,     // 失败数
  inputChars: 0,   // 草稿字符数累计（不含命中/失败）
  outputChars: 0,  // 结果字符数累计（不含命中/失败）
  inputTokens: 0,
  outputTokens: 0,
}

export function dataDir() {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(home, 'prompt-refiner')
}

let diskDisabled = false

function bump(entry) {
  counters.calls++
  if (entry.cached) counters.hits++
  else if (entry.ok === false) counters.failures++
  else {
    counters.inputChars += entry.charsBefore ?? 0
    counters.outputChars += entry.charsAfter ?? 0
    counters.inputTokens += entry.inputTokens ?? 0
    counters.outputTokens += entry.outputTokens ?? 0
  }
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
