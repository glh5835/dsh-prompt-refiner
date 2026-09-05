// dsh-prompt-refiner — 动态模式 Client 半部（粘贴进 dsh「Cordis 动态插件」面板的 code.client）。
//
// 本文件同样是动态面板求值的函数体（顶层允许 return；React / host / styles 为注入的全局）。
// 与静态版 lib/client.js 的差异：host.call RPC、ctx.effect(styles.insert) 样式注入。
function createStore() {
  return {
    data: { loading: false, result: null, error: null, sessionId: null },
    subs: new Set(),
    get() { return this.data },
    set(patch) {
      this.data = Object.assign({}, this.data, patch)
      this.subs.forEach((fn) => fn())
    },
    subscribe(fn) {
      this.subs.add(fn)
      return () => { this.subs.delete(fn) }
    },
  }
}

function useStore(store) {
  const [state, setState] = React.useState(store.get())
  React.useEffect(() => store.subscribe(() => setState(store.get())), [])
  return state
}

/** 与静态版 lib/client.js 的 splitAssumptions 保持语义一致。 */
function splitAssumptions(s) {
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

function metaLine(m) {
  if (!m) return ''
  const parts = []
  if (m.model) parts.push(m.model)
  if (m.chars) parts.push(m.chars.before + '→' + m.chars.after + ' 字')
  if (typeof m.latencyMs === 'number') parts.push((m.latencyMs / 1000).toFixed(1) + 's')
  if (m.cached) parts.push('缓存命中')
  if (m.usage && m.usage.inputTokens != null && m.usage.outputTokens != null) {
    parts.push(m.usage.inputTokens + '+' + m.usage.outputTokens + ' tok')
  }
  return parts.join(' · ')
}

const CSS = '.prompt-refine-btn{display:inline-flex;align-items:center;justify-content:center;width:26px;height:26px;padding:0;border:1px solid transparent;border-radius:7px;background:transparent;color:var(--dsw-alias-label-secondary);font-size:14px;line-height:1;cursor:pointer;order:1}.prompt-refine-btn:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}.prompt-refine-btn:disabled{opacity:.45;cursor:default}.prompt-refine-btn.is-busy{color:var(--dsw-alias-brand-primary)}.prompt-refine-panel{position:absolute;bottom:calc(100% + 8px);left:0;box-sizing:border-box;display:flex;flex-direction:column;gap:6px;padding:8px 10px;border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font-size:12px;line-height:1.5;box-shadow:var(--dsw-shadow-lv2);overflow:hidden}.prompt-refine-panel.is-loading{justify-content:center;align-items:center;color:var(--dsw-alias-label-secondary)}.prompt-refine-panel.is-error{border-color:var(--dsw-alias-state-error-primary)}.prompt-refine-head{display:flex;flex:none;align-items:center;justify-content:space-between;gap:8px}.prompt-refine-title{font-weight:600;font-size:12px}.prompt-refine-actions{display:inline-flex;gap:6px}.prompt-refine-primary{padding:2px 8px;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);cursor:pointer;font-size:11px;line-height:1.4}.prompt-refine-primary:hover{border-color:var(--dsw-alias-brand-primary)}.prompt-refine-ghost{padding:2px 8px;border:1px solid transparent;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;font-size:11px;line-height:1.4}.prompt-refine-ghost:hover{background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary)}.prompt-refine-error-text{color:var(--dsw-alias-state-error-primary);flex:1}.prompt-refine-meta{flex:none;font-size:11px;color:var(--dsw-alias-label-secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.prompt-refine-assumptions{flex:none;padding:6px 8px;border-radius:8px;background:var(--dsw-alias-state-warning-bg,rgba(234,164,20,.14));color:var(--dsw-alias-label-primary);white-space:pre-wrap;word-break:break-word;font-size:12px;line-height:1.5}.prompt-refine-assume-label{display:block;margin-bottom:4px;font-weight:600;color:var(--dsw-alias-label-secondary)}.prompt-refine-result{max-height:320px;overflow-y:auto;padding:8px 10px;border-radius:8px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);white-space:pre-wrap;word-break:break-word;font-size:12px;line-height:1.5}.prompt-refine-orig-toggle{flex:none;font-size:11px;color:var(--dsw-alias-label-secondary)}.prompt-refine-orig-toggle summary{cursor:pointer;user-select:none;list-style-position:inside}.prompt-refine-orig-toggle summary:hover{color:var(--dsw-alias-label-primary)}.prompt-refine-orig{margin-top:6px;max-height:120px;overflow-y:auto;padding:6px 8px;border-radius:6px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);white-space:pre-wrap;word-break:break-word;font-size:12px;line-height:1.45}'

function PromptRefineButton(props) {
  const store = props.store
  const state = useStore(store)
  const input = props.useInput((s) => s)
  const draft = (input && typeof input.draft === 'string') ? input.draft : ''
  const can = draft.trim().length > 0 && !state.loading
  const onRefine = () => {
    if (!can) return
    store.set({ loading: true, error: null, result: null, sessionId: props.sessionId })
    host.call('prompt-refine', { text: draft.trim() }).then((reply) => {
      if (reply && reply.ok && typeof reply.text === 'string') {
        store.set({ loading: false, result: { original: draft, optimized: reply.text, meta: reply.meta || null } })
      } else {
        store.set({ loading: false, error: (reply && reply.error) ? String(reply.error) : '精炼失败' })
      }
    }).catch((err) => {
      store.set({ loading: false, error: '调用失败: ' + ((err && err.message) ? String(err.message) : String(err)) })
    })
  }
  return React.createElement(
    'button',
    {
      className: 'prompt-refine-btn' + (state.loading ? ' is-busy' : ''),
      title: '精炼提示词',
      'aria-label': '精炼提示词',
      disabled: !can,
      onClick: onRefine,
    },
    state.loading ? '…' : '✨',
  )
}

function PromptRefinePanel(props) {
  const store = props.store
  const state = useStore(store)
  const panelRef = React.useRef(null)
  const [width, setWidth] = React.useState(null)
  React.useEffect(() => {
    if (store.get().sessionId !== props.sessionId) {
      store.set({ loading: false, result: null, error: null, sessionId: props.sessionId })
    }
  }, [props.sessionId])
  React.useEffect(() => {
    if (!state.loading && !state.result && !state.error) return
    const el = panelRef.current
    if (!el) return
    const parent = el.parentElement
    const card = (parent && parent.closest) ? parent.closest('[data-composer-card]') : null
    const apply = () => {
      if (!card) {
        setWidth(680)
        return
      }
      const rect = card.getBoundingClientRect()
      setWidth(Math.round(rect.width))
    }
    apply()
    if (typeof ResizeObserver === 'undefined' || !card) return
    const observer = new ResizeObserver(apply)
    observer.observe(card)
    return () => observer.disconnect()
  }, [state.loading, state.result, state.error])
  if (!state.loading && !state.result && !state.error) return null
  const style = width ? { width: width + 'px' } : { visibility: 'hidden' }
  if (state.loading) {
    return React.createElement(
      'div',
      { ref: panelRef, className: 'prompt-refine-panel is-loading', style: style },
      React.createElement('span', null, '正在精炼提示词…'),
    )
  }
  if (state.error) {
    return React.createElement(
      'div',
      { ref: panelRef, className: 'prompt-refine-panel is-error', style: style },
      React.createElement('span', { className: 'prompt-refine-error-text' }, state.error),
      React.createElement(
        'button',
        { className: 'prompt-refine-ghost', onClick: () => store.set({ error: null }) },
        '关闭',
      ),
    )
  }
  const result = state.result
  const split = splitAssumptions(result.optimized)
  const meta = metaLine(result.meta)
  return React.createElement(
    'div',
    { ref: panelRef, className: 'prompt-refine-panel', style: style },
    React.createElement(
      'div',
      { className: 'prompt-refine-head' },
      React.createElement('span', { className: 'prompt-refine-title' }, '提示词精炼'),
      React.createElement(
        'span',
        { className: 'prompt-refine-actions' },
        React.createElement(
          'button',
          { className: 'prompt-refine-primary', onClick: () => {
            if (props.inputActions) props.inputActions.setDraft(result.optimized)
            store.set({ result: null })
          } },
          '应用',
        ),
        React.createElement(
          'button',
          { className: 'prompt-refine-ghost', onClick: () => store.set({ result: null }) },
          '放弃',
        ),
      ),
    ),
    meta ? React.createElement('div', { className: 'prompt-refine-meta' }, meta) : null,
    split.assumptions
      ? React.createElement(
          'div',
          { className: 'prompt-refine-assumptions' },
          React.createElement('span', { className: 'prompt-refine-assume-label' }, '以下假设由精炼器补全，应用前请确认：'),
          split.assumptions,
        )
      : null,
    React.createElement('div', { className: 'prompt-refine-result' }, split.body),
    React.createElement(
      'details',
      { className: 'prompt-refine-orig-toggle' },
      React.createElement('summary', null, '查看原草稿'),
      React.createElement('div', { className: 'prompt-refine-orig' }, result.original),
    ),
  )
}

return {
  apply(ctx) {
    const slots = ctx.get('slots')
    if (slots === undefined) return
    const store = createStore()
    slots.inject('conversation.input.right', () => slots.register(
      { name: 'conversation.input.right', id: 'prompt-refiner', order: 0, label: '精炼提示词' },
      (props) => React.createElement(PromptRefineButton, Object.assign({}, props, { store })),
    ))
    slots.inject('conversation.input.overlay', () => slots.register(
      { name: 'conversation.input.overlay', id: 'prompt-refiner-panel', order: 2, label: '提示词精炼面板' },
      (props) => React.createElement(PromptRefinePanel, Object.assign({}, props, { store })),
    ))
    ctx.effect(() => styles.insert(CSS))
  },
}
