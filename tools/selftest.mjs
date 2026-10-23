#!/usr/bin/env node
/**
 * selftest.mjs — 脱离 DSH 宿主验证插件的装配与查询行为。
 * 用 loader 把 @deepseek-ai/dsh-tools 换成桩，然后自己造一个 ctx。
 *
 * 用法：node tools/selftest.mjs
 */
import { register } from 'node:module'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

register('./stub-loader.mjs', import.meta.url)

const HERE = dirname(fileURLToPath(import.meta.url))
const NL = String.fromCharCode(10)
let failed = 0
const ok = (label, cond, detail) => {
  if (cond) {
    console.log('  PASS  ' + label)
  } else {
    failed += 1
    console.log('  FAIL  ' + label + (detail ? '  -> ' + detail : ''))
  }
}

// 用临时 DSH_HOME，别碰真实用户词库
const home = mkdtempSync(join(tmpdir(), 'dsh-slang-own-'))
process.env.DSH_HOME = home

const plugin = await import('../lib/index.js')
const tools = []
const hooks = {}
const ctx = {
  tools: { register: (def) => { tools.push(def); return () => {} } },
  on: (event, handler) => { (hooks[event] = hooks[event] || []).push(handler); return () => {} },
  effect: (fn) => { fn(); return () => {} },
  get: () => undefined,
}

plugin.apply(ctx, {})
console.log('装配：name=' + plugin.name + ' 工具=' + tools.map((t) => t.name).join(','))

const byName = Object.fromEntries(tools.map((t) => [t.name, t]))
ok('注册了三个工具', tools.length === 3, String(tools.length))
ok('注入依赖声明了 tools', plugin.inject.includes('tools'))

/* ---- 系统提示注入 ---- */
const assemble = hooks['system-prompt/assemble'] || []
ok('挂了 system-prompt/assemble', assemble.length === 1)
const next = async () => ({ sections: [], contexts: [], tools: [], variables: {} })
const assembled = await assemble[0]({}, {}, next)
const block = assembled.sections.map((s) => s.text).join(NL)
ok('注入块含规则段', block.indexOf('黑话与网络隐晦词') >= 0)
ok('注入块含速查表', block.indexOf('yyds') >= 0)
ok('注入块长度可控', block.length < 1600, String(block.length))
console.log('  注入块 ' + block.length + ' 字，前 120 字：' + block.slice(0, 120).split(NL).join(' / '))

/* ---- 查询 ---- */
const call = async (name, args) => byName[name].execute(args || {}, {})

const r1 = await call('slang_lookup', { term: 'yyds' })
ok('查 yyds 命中', r1.found > 0, r1.message)
const r2 = await call('slang_lookup', { term: '永远的神' })
ok('中文全称反查 yyds', r2.found > 0 && /yyds/.test(JSON.stringify(r2.entries || [])), r2.message)
const r3 = await call('slang_lookup', { term: '笑死我了' })
ok('中文反查 xswl', r3.found > 0 && /xswl/i.test(JSON.stringify(r3.entries || [])), r3.message)
const r4 = await call('slang_lookup', { term: '绷不住了' })
ok('查中文梗 绷不住了', r4.found > 0, r4.message)
const r5 = await call('slang_lookup', { term: '颗粒度' })
ok('查职场黑话 颗粒度', r5.found > 0, r5.message)
const r6 = await call('slang_lookup', { term: 'zzzz不存在词' })
ok('查不到时给出兜底说明', r6.found === 0 && /按字面理解/.test(r6.message), r6.message)

/* ---- 沉淀新词 ---- */
const r7 = await call('slang_add', {
  term: '哈基米',
  meaning: '网络上对猫的爱称，源自一首歌的谐音',
  aliases: '哈基米德,ha ji mi',
  field: '网络流行语',
})
ok('slang_add 成功', r7.ok === true, r7.message)
const userFile = join(home, '.dsh', 'slang-corpus', 'user.json')
ok('用户词条落盘', existsSync(userFile), userFile)
if (existsSync(userFile)) {
  const saved = JSON.parse(readFileSync(userFile, 'utf8'))
  ok('用户词条内容正确', saved.length === 1 && saved[0].term === '哈基米', JSON.stringify(saved).slice(0, 120))
}
const r8 = await call('slang_lookup', { term: '哈基米' })
ok('新词即刻可查', r8.found > 0, r8.message)
const r9 = await call('slang_lookup', { term: '哈基米德' })
ok('新词别名可查', r9.found > 0, r9.message)

/* ---- 自查 ---- */
const r10 = await call('slang_stats', {})
ok('slang_stats 返回规模', r10.ok === true && r10.total > 500, r10.message.split(NL)[0])
console.log('  ' + r10.message.split(NL).join(NL + '  '))

rmSync(home, { recursive: true, force: true })
console.log(NL + (failed === 0 ? '[selftest] 全部通过' : '[selftest] 失败 ' + failed + ' 项'))
process.exit(failed === 0 ? 0 : 1)
