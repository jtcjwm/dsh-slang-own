#!/usr/bin/env node
/** probe.mjs — 打印当前会注入系统提示的完整文本，用于人工检查措辞与体积。 */
import { register } from 'node:module'
register('./stub-loader.mjs', import.meta.url)
const plugin = await import('../lib/index.js')
const c = {
  tools: { register: () => () => {} },
  on: (event, handler) => { c.handler = handler; return () => {} },
  effect: (fn) => { fn(); return () => {} },
  get: () => undefined,
}
plugin.apply(c, {})
const assembled = await c.handler({}, {}, async () => ({ sections: [], contexts: [], tools: [], variables: {} }))
const text = assembled.sections[0].text
console.log('=== 注入块 ' + text.length + ' 字（约 ' + Math.round(text.length / 1.6) + ' token）===')
console.log(text)
