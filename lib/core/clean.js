// 结果清洗与展示拆分。与动态版 src/host.js 中的同名实现保持语义一致。

/** 剪除结果外的 ``` 围栏包裹（模型偶尔复犯）。 */
export function stripFence(s) {
  const t = s.trim()
  if (t.startsWith('```') && t.endsWith('```')) {
    const inner = t.slice(3, t.length - 3).trim()
    // 去掉可能的语言标注行
    const nl = inner.indexOf('\n')
    const body = nl >= 0 ? inner.slice(nl + 1).trim() : inner
    if (body !== '') return body
  }
  return t
}

/** 保守清洗：删除整行匹配的过程性话术。 */
export function stripChainLines(s) {
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

/**
 * 拆出 [假设] 小节：返回 { body, assumptions }。
 * body 是去掉假设小节后的正文（仅供面板主显示区展示），
 * assumptions 是含 "[假设]" 头的假设全文（无则空串）。
 * 应用回输入框的始终是完整文本（含假设），此处只影响面板展示。
 */
export function splitAssumptions(s) {
  const lines = s.split('\n')
  let start = -1
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*\[假设\]/.test(lines[i])) { start = i; break }
  }
  if (start === -1) return { body: s, assumptions: '' }
  let end = lines.length
  for (let i = start + 1; i < lines.length; i++) {
    if (/^\s*\[.+\]/.test(lines[i])) { end = i; break }
  }
  const assumptions = lines.slice(start, end).join('\n').trim()
  const rest = lines.slice(0, start).concat(lines.slice(end)).join('\n').trim()
  return { body: rest, assumptions }
}
