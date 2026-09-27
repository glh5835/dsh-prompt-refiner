// dsh-prompt-refiner — Client 半部（静态模块加载器工厂 bundle）。
//
// 约定同 dsh client 模块体系：window.__ModuleLoader__.load + require('react')。
// 与动态版 src/client.js 的差异只有两点：host.call 换成 fetch('/prompt-refine')；
// 样式走 <style data-plugin-css> 官方模式而非 ctx.effect(styles.insert)。
//
// 槽位契约（与 dsh-prompt-optimize-plugin 验证过的一致）：
//   conversation.input.right   list 槽：输入栏 ✨ 按钮，props 含 useInput/inputActions/sessionId
//   conversation.input.overlay 浮动锚：输入框正上方面板，锚于 [data-composer-card]
window.__ModuleLoader__.load({
  id: 'dsh-prompt-refiner',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    var React = require('react')

    const STYLE_TAG_ID = 'dsh-prompt-refiner'

    const CSS = '.prompt-refine-btn{display:inline-flex;align-items:center;justify-content:center;width:26px;height:26px;padding:0;border:1px solid transparent;border-radius:7px;background:transparent;color:var(--dsw-alias-label-secondary);font-size:14px;line-height:1;cursor:pointer;order:1}.prompt-refine-btn:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}.prompt-refine-btn:disabled{opacity:.45;cursor:default}.prompt-refine-btn.is-busy{color:var(--dsw-alias-brand-primary)}.prompt-refine-panel{position:absolute;bottom:calc(100% + 8px);left:0;right:0;box-sizing:border-box;display:flex;flex-direction:column;gap:6px;padding:8px 10px;border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font-size:12px;line-height:1.5;box-shadow:var(--dsw-shadow-lv2);z-index:60;max-height:min(70vh,560px);overflow:hidden}.prompt-refine-panel.is-loading{justify-content:center;align-items:center;color:var(--dsw-alias-label-secondary)}.prompt-refine-panel.is-error{border-color:var(--dsw-alias-state-error-primary)}.prompt-refine-head{display:flex;flex:none;align-items:center;justify-content:space-between;gap:8px}.prompt-refine-title{font-weight:600;font-size:12px}.prompt-refine-actions{display:inline-flex;gap:6px}.prompt-refine-primary{padding:2px 8px;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);cursor:pointer;font-size:11px;line-height:1.4}.prompt-refine-primary:hover{border-color:var(--dsw-alias-brand-primary)}.prompt-refine-ghost{padding:2px 8px;border:1px solid transparent;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;font-size:11px;line-height:1.4}.prompt-refine-ghost:hover{background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary)}.prompt-refine-error-text{color:var(--dsw-alias-state-error-primary);flex:1}.prompt-refine-meta{flex:none;font-size:11px;color:var(--dsw-alias-label-secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.prompt-refine-assumptions{flex:0 1 auto;min-height:0;max-height:180px;overflow-y:auto;padding:6px 8px;border-radius:8px;background:var(--dsw-alias-state-warning-bg,rgba(234,164,20,.14));color:var(--dsw-alias-label-primary);white-space:pre-wrap;word-break:break-word;font-size:12px;line-height:1.5}.prompt-refine-assume-label{display:block;margin-bottom:4px;font-weight:600;color:var(--dsw-alias-label-secondary)}.prompt-refine-result{flex:1 1 auto;min-height:0;max-height:320px;overflow-y:auto;padding:8px 10px;border-radius:8px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);white-space:pre-wrap;word-break:break-word;font-size:12px;line-height:1.5}.prompt-refine-orig-toggle{flex:none;font-size:11px;color:var(--dsw-alias-label-secondary)}.prompt-refine-orig-toggle summary{cursor:pointer;user-select:none;list-style-position:inside}.prompt-refine-orig-toggle summary:hover{color:var(--dsw-alias-label-primary)}.prompt-refine-orig{margin-top:6px;max-height:120px;overflow-y:auto;padding:6px 8px;border-radius:6px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);white-space:pre-wrap;word-break:break-word;font-size:12px;line-height:1.45}'

    let styleTag = document.querySelector('style[data-plugin-css="' + STYLE_TAG_ID + '"]')
    if (styleTag === null) {
      styleTag = document.createElement('style')
      styleTag.dataset.pluginCss = STYLE_TAG_ID
      styleTag.textContent = CSS
      document.head.appendChild(styleTag)
    }

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

    /** 与 lib/core/clean.js 的 splitAssumptions 保持语义一致（client 不可 import node 模块）。 */
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

    /**
     * 面板信息行：模型 · 字数变化 · 耗时 · 缓存 · 思考档位 · token 用量。
     * 注意 deepseek 适配器把思考 token 计在 outputTokens 内且不单列 reasoningTokens，
     * 所以这里把 outputTokens 标注为「含思考」，避免看起来像结果本身的用量。
     */
    function metaLine(m) {
      if (!m) return ''
      const parts = []
      if (m.model) parts.push(m.model)
      if (m.chars) parts.push(m.chars.before + '→' + m.chars.after + ' 字')
      if (typeof m.latencyMs === 'number') parts.push((m.latencyMs / 1000).toFixed(1) + 's')
      if (m.cached) parts.push('缓存命中')
      if (m.reasoningEffortRequested !== undefined) {
        const requested = m.reasoningEffortRequested
        const effective = m.reasoningEffort
        parts.push('思考 ' + (effective === null || effective === undefined ? '默认' : effective) + (requested && effective && requested !== effective ? '（请求 ' + requested + '）' : ''))
      }
      if (m.usage) {
        const inTok = m.usage.inputTokens
        const outTok = m.usage.outputTokens
        const reasonTok = m.usage.reasoningTokens
        const segments = []
        if (inTok != null) segments.push('入 ' + inTok)
        if (outTok != null) segments.push('出 ' + outTok + (reasonTok == null ? '（含思考）' : ''))
        if (reasonTok != null && reasonTok > 0) segments.push('思考 ' + reasonTok)
        if (segments.length > 0) parts.push(segments.join('/') + ' tok')
      }
      return parts.join(' · ')
    }

    function callRefine(text) {
      return fetch('/prompt-refine', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text }),
      }).then((res) => res.json()).catch((err) => {
        return { ok: false, error: '调用失败: ' + ((err && err.message) ? String(err.message) : String(err)) }
      })
    }

    function RefineButton(props) {
      const store = props.store
      const state = useStore(store)
      // 选择器返回基本类型：避免返回整个 snapshot 对象时因引用不稳定触发重渲染循环
      const draft = props.useInput((s) => (s && typeof s.draft === 'string') ? s.draft : '')
      const can = draft.trim().length > 0 && !state.loading
      const onRefine = () => {
        if (!can) return
        store.set({ loading: true, error: null, result: null, sessionId: props.sessionId })
        callRefine(draft.trim()).then((reply) => {
          if (reply && reply.ok && typeof reply.text === 'string') {
            store.set({ loading: false, result: { original: draft, optimized: reply.text, meta: reply.meta || null } })
          } else {
            store.set({ loading: false, error: (reply && reply.error) ? String(reply.error) : '精炼失败' })
          }
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

    function RefinePanel(props) {
      const store = props.store
      const state = useStore(store)
      React.useEffect(() => {
        if (store.get().sessionId !== props.sessionId) {
          store.set({ loading: false, result: null, error: null, sessionId: props.sessionId })
        }
      }, [props.sessionId])
      if (!state.loading && !state.result && !state.error) return null
      if (state.loading) {
        return React.createElement(
          'div',
          { className: 'prompt-refine-panel is-loading' },
          React.createElement('span', null, '正在精炼提示词…'),
        )
      }
      if (state.error) {
        return React.createElement(
          'div',
          { className: 'prompt-refine-panel is-error' },
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
        { className: 'prompt-refine-panel' },
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
                // 应用完整文本（含 [假设] 小节），假设随消息一起发给模型
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

    function apply(ctx) {
      const slots = ctx.get('slots')
      if (slots === undefined) return
      const store = createStore()
      slots.inject('conversation.input.right', () => slots.register(
        { name: 'conversation.input.right', id: 'prompt-refiner', order: 0, label: '精炼提示词' },
        (props) => React.createElement(RefineButton, Object.assign({}, props, { store })),
      ))
      slots.inject('conversation.input.overlay', () => slots.register(
        { name: 'conversation.input.overlay', id: 'prompt-refiner-panel', order: 2, label: '提示词精炼面板' },
        (props) => React.createElement(RefinePanel, Object.assign({}, props, { store })),
      ))
    }

    exports.apply = apply
    exports.inject = ['slots']

    return module.exports
  },
})
