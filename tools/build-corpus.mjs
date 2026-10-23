#!/usr/bin/env node
/**
 * build-corpus.mjs — 从外部原料生成插件内置语料。
 *
 * 原料（不随包分发，放在外部 _check 目录）：
 *   1. slang.html          junaluo-222/slang-dictionary 的单页版，452 条
 *                          网络缩写 / 梗 / 职场黑话，带人话解释与例句
 *   2. eve.yaml            yilifaer/eve-cn-slang，301 条 EVE 黑话
 *   3. pinyin.txt          mozillazg/pinyin-data，汉字→拼音（只取声母首字母）
 *
 * 输出（corpus/ 下，随包分发）：
 *   net.json               网络词条
 *   eve.json               游戏圈词条
 *   pinyin-initials.json   {"一":"y",...} 供首字母反查
 *
 * 用法：node tools/build-corpus.mjs [原料目录]
 *
 * 注意：本文件刻意不出现任何反斜杠字面量——构建脚本常被各种 shell 转义
 * 层搬运，反斜杠是最容易在运输途中被吃掉的东西，用 indexOf/slice 代替正则。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const NL = String.fromCharCode(10)
const DQ = String.fromCharCode(34)

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const SRC = process.argv[2] || 'D:/DSH/dsh-插件/_check'

const read = (name) => readFileSync(join(SRC, name), 'utf8').split(NL).join(NL)
const write = (name, data) => {
  writeFileSync(join(ROOT, 'corpus', name), JSON.stringify(data, null, 0) + NL, 'utf8')
  return JSON.stringify(data).length
}

/* ---------- 通用：从 JS 字面量块里取 key:"value" ---------- */

function strField(block, key) {
  const needle = key + ':' + DQ
  const at = block.indexOf(needle)
  if (at < 0) return ''
  let i = at + needle.length
  const start = i
  while (i < block.length && block[i] !== DQ) i++
  let s = block.slice(start, i)
  while (s.indexOf(NL) >= 0) s = s.split(NL).join(' ')
  return s.trim()
}

/* ---------- 1. 拼音声母表 ---------- */

function stripTone(s) {
  return s
    .normalize('NFD')
    .split('')
    .filter((ch) => {
      const c = ch.charCodeAt(0)
      return c < 0x300 || c > 0x36f
    })
    .join('')
}

function firstLetter(pinyin) {
  const clean = stripTone(pinyin.split(',')[0].trim()).toLowerCase()
  for (const ch of clean) if (ch >= 'a' && ch <= 'z') return ch
  return ''
}

function buildPinyin() {
  const map = {}
  for (const line of read('pinyin.txt').split(NL)) {
    if (!line.startsWith('U+')) continue
    const colon = line.indexOf(':')
    if (colon < 0) continue
    const cp = parseInt(line.slice(2, colon).trim(), 16)
    if (!(cp >= 0x4e00 && cp <= 0x9fff)) continue
    const hash = line.indexOf('#')
    const py = (hash > colon ? line.slice(colon + 1, hash) : line.slice(colon + 1)).trim()
    const letter = firstLetter(py)
    if (letter) map[String.fromCodePoint(cp)] = letter
  }
  return map
}

/* ---------- 2. slang-dictionary ---------- */

function splitMeanings(block) {
  const out = []
  let pos = 0
  for (;;) {
    const at = block.indexOf('{type:', pos)
    if (at < 0) break
    const next = block.indexOf('{type:', at + 6)
    out.push(next < 0 ? block.slice(at) : block.slice(at, next))
    if (next < 0) break
    pos = next
  }
  return out
}

function buildNet() {
  const html = read('slang.html')
  const need = '{abbr:' + DQ
  const out = []
  const seen = new Set()
  let pos = 0
  for (;;) {
    const at = html.indexOf(need, pos)
    if (at < 0) break
    const termStart = at + need.length
    const termEnd = html.indexOf(DQ, termStart)
    if (termEnd < 0) break
    const term = html.slice(termStart, termEnd).trim()
    pos = termEnd

    const mAt = html.indexOf('meanings:[', termEnd)
    if (mAt < 0) continue
    const mEnd = html.indexOf(']}', mAt)
    if (mEnd < 0) continue
    const meaningsBlock = html.slice(mAt + 10, mEnd)
    pos = mEnd

    if (!term || seen.has(term)) continue
    seen.add(term)

    const parts = splitMeanings(meaningsBlock)
    const first = parts[0] || ''
    const typeAt = first.indexOf('type:' + DQ)
    const fieldAt = first.indexOf('field:' + DQ)
    let field = ''
    if (fieldAt >= 0) {
      const fStart = fieldAt + 7
      const fEnd = first.indexOf(DQ, fStart)
      if (fEnd > fStart) field = first.slice(fStart, fEnd).trim()
    }
    const full = strField(first, 'full')
    const plain = strField(first, 'plain')
    const sample = strField(first, 'example')
    const isAscii = /^[A-Za-z0-9.+#_-]+$/.test(term)
    const entry = {
      term,
      full,
      meaning: plain || full,
      register: /黑话|暗语|招聘/.test(field) ? 'pro' : 'net',
      field,
      sample,
      kind: isAscii ? 'abbr' : 'word',
      source: 'slang-dictionary',
    }
    if (isAscii) entry.initials = term.toLowerCase()
    if (parts.length > 1) {
      const more = []
      for (const p of parts.slice(1)) {
        const f = strField(p, 'full')
        const m = strField(p, 'plain') || f
        if (f || m) more.push({ full: f, meaning: m })
      }
      if (more.length) entry.more = more
    }
    if (typeAt < 0 && !field) {
      // 少数条目没有 type 字段，仍保留
    }
    out.push(entry)
  }
  return out
}

/* ---------- 3. eve-cn-slang ---------- */

function buildEve() {
  const text = read('eve.yaml')
  const blocks = []
  let cur = []
  for (const raw of text.split(NL)) {
    const line = raw.trimStart()
    if (line.startsWith('- ')) {
      if (cur.length) blocks.push(cur)
      cur = [line.slice(2)]
    } else if (line && !line.startsWith('#')) {
      if (cur.length) cur.push(line)
    }
  }
  if (cur.length) blocks.push(cur)

  const unquote = (s) => {
    if (s.length >= 2 && s.startsWith(DQ) && s.endsWith(DQ)) return s.slice(1, -1)
    return s
  }
  const out = []
  for (const block of blocks) {
    const map = {}
    for (const line of block) {
      const c = line.indexOf(':')
      if (c < 0) continue
      map[line.slice(0, c).trim()] = line.slice(c + 1).trim()
    }
    const arr = (key) => {
      const raw = map[key]
      if (!raw) return []
      try {
        const v = JSON.parse(raw)
        return Array.isArray(v) ? v.map(String) : []
      } catch {
        return []
      }
    }
    const zh = unquote(map.zh || '')
    const en = unquote(map.en || '')
    const note = unquote(map.note || '')
    const cat = unquote(map.category || '')
    if (!zh && !en) continue
    const aliases = [...new Set([en, ...arr('en_aliases'), ...arr('zh_aliases')].filter(Boolean))]
    out.push({
      term: zh || en,
      full: en && en !== zh ? en : '',
      meaning: note || (en !== zh ? en : ''),
      register: 'pro',
      field: ('游戏 / EVE ' + cat).trim(),
      aliases,
      kind: 'word',
      source: 'eve-cn-slang',
    })
  }
  return out
}

/* ---------- 输出 ---------- */

const pinyin = buildPinyin()
const net = buildNet()
const eve = buildEve()

for (const [name, data] of [
  ['pinyin-initials.json', pinyin],
  ['net.json', net],
  ['eve.json', eve],
]) {
  const size = write(name, data)
  const n = Array.isArray(data) ? data.length + ' 条' : Object.keys(data).length + ' 字'
  console.log(name.padEnd(22) + n.padEnd(10) + Math.round(size / 1024) + 'KB')
}
console.log('')
console.log('网络词条样例: ' + JSON.stringify(net[0]))
console.log('游戏词条样例: ' + JSON.stringify(eve[0]))
