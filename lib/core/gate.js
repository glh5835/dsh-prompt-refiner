// 提交前的门控。手动（按钮）模式只拦截空草稿与超长草稿；
// Phase A 自动模式（agent/pre-step）将复用本模块并叠加更多规则：
// 长度下限、结构化特征跳过、与上一轮相同的输入去重等。

export function evaluate(text, cfg) {
  const t = (text || '').trim()
  if (t.length === 0) return { skip: true, reason: '草稿为空' }
  const min = cfg.minChars ?? 0
  if (t.length < min) return { skip: true, reason: `短于 ${min} 字，无需精炼` }
  const max = cfg.maxChars ?? 8000
  if (t.length > max) return { skip: true, reason: `超过 ${max} 字上限，请手动编辑` }
  return { skip: false, text: t }
}
