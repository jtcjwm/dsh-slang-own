/**
 * corpus.js — 语料装载、归一化、多键倒排与查询。
 *
 * 设计要点（为什么不直接上 BM25）：
 *   网络隐晦词的难点是「同一个词有多个字面化身」——
 *     yyds（首字母） / 永远的神（全称） / 永远滴神（谐音） / yyds永远的神（混写）
 *   这几种字面上毫无重叠，任何基于字面相似度的检索都命不中。
 *   所以装载期就把一个词条摊平成多个键，全部指向同一个 entry：
 *     term / aliases[] / initials / pinyin / homophones / full
 *   查询时无论用户给哪一种写法，都能落到同一条释义。
 *
 * 本文件零第三方依赖：link: 安装时模块解析不经过 profile 的 node_modules，
 * import 一个没装进本插件目录的包会直接让插件加载失败。
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'

/* ---------------- 归一化 ---------------- */

/** 全角 → 半角：只处理可打印区与全角空格。 */
function toHalfWidth(ch) {
  const code = ch.charCodeAt(0)
  if (code === 0x3000) return ' '
  if (code >= 0xff01 && code <= 0xff5e) return String.fromCharCode(code - 0xfee0)
  return ch
}

/** 保留哪些字符：数字、拉丁字母、汉字。 */
function keepChar(ch) {
  const code = ch.charCodeAt(0)
  if (code >= 0x30 && code <= 0x39) return true
  if (code >= 0x61 && code <= 0x7a) return true
  if (code >= 0x4e00 && code <= 0x9fff) return true
  if (code >= 0x3400 && code <= 0x4dbf) return true
  return false
}

/**
 * 归一化：全角转半角、小写、剥掉一切标点与空白。
 * "yyds！" / "YYDS" / "y y d s" 都收敛成 "yyds"。
 */
export function normalize(text) {
  if (typeof text !== 'string' || text.length === 0) return ''
  const out = []
  for (const raw of text) {
    const ch = toHalfWidth(raw).toLowerCase()
    if (keepChar(ch)) out.push(ch)
  }
  return out.join('')
}

/** 键是否值得进倒排：中文 ≥2 字、字母数字 ≥2 位。单字符只走精确查询。 */
function indexable(key) {
  if (!key || key.length < 2) return false
  if (key.length > 24) return false
  return true
}

/* ---------------- 拼音首字母 ---------------- */

/** 汉字 → 声母首字母表。装不到就退化成「只做字面匹配」，不影响启动。 */
export function loadPinyinTable(dir) {
  const path = join(dir, 'pinyin-initials.json')
  try {
    if (!existsSync(path)) return null
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

/**
 * 取一串文本的拼音首字母："永远的神" → "yyds"；"笑死我了" → "xswl"。
 * 字母数字原样保留，所以 "yyds永远的神" 也成立。
 * 表里没有的字跳过——结果串会变短导致不命中，这是有意的降级。
 */
export function initialsOf(text, table) {
  if (!table) return ''
  const out = []
  for (const ch of String(text || '')) {
    const code = ch.charCodeAt(0)
    if ((code >= 0x30 && code <= 0x39) || (code >= 0x61 && code <= 0x7a)) {
      out.push(ch)
      continue
    }
    if (code >= 0x41 && code <= 0x5a) {
      out.push(ch.toLowerCase())
      continue
    }
    const letter = table[ch]
    if (letter) out.push(letter)
  }
  return out.join('')
}

/** 是否纯字母数字（判断一个词条是不是首字母缩写）。 */
export function isAsciiWord(s) {
  if (!s) return false
  for (const ch of s) {
    const c = ch.charCodeAt(0)
    const ok =
      (c >= 0x30 && c <= 0x39) || (c >= 0x61 && c <= 0x7a) || (c >= 0x41 && c <= 0x5a) ||
      c === 0x2d || c === 0x5f || c === 0x2e || c === 0x2b || c === 0x23
    if (!ok) return false
  }
  return true
}

/* ---------------- 索引 ---------------- */

const EMPTY_TABLE = null

export class SlangCorpus {
  /** @param {object[]} entries 词条数组 */
  constructor(entries = [], pinyinTable = EMPTY_TABLE) {
    this.entries = []
    this.byId = new Map()
    /** @type {Map<string, Set<number>>} 归一化键 → entry 下标集合 */
    this.index = new Map()
    /** @type {Map<string, string[]>} 首字符 → 键列表，供 scan 稀疏扫描 */
    this.byFirstChar = new Map()
    this.pinyin = pinyinTable
    this.problems = []
    this.version = 0
    for (const entry of entries) this.add(entry)
  }

  /** 从若干 JSON 文件装载。缺文件跳过，坏文件记一条问题不抛。 */
  static fromFiles(files, pinyinTable = EMPTY_TABLE) {
    const entries = []
    const problems = []
    for (const file of files) {
      try {
        if (!existsSync(file)) continue
        const data = JSON.parse(readFileSync(file, 'utf8'))
        const list = Array.isArray(data) ? data : Array.isArray(data.entries) ? data.entries : []
        for (const item of list) entries.push(item)
      } catch (error) {
        problems.push(file + ': ' + (error && error.message ? error.message : String(error)))
      }
    }
    const corpus = new SlangCorpus(entries, pinyinTable)
    corpus.problems = problems
    return corpus
  }

  /** 目录下所有 *.json（拼音表自身除外）当语料文件。 */
  static filesIn(dir) {
    try {
      if (!existsSync(dir)) return []
      return readdirSync(dir)
        .filter((name) => name.endsWith('.json') && name !== 'pinyin-initials.json')
        .sort()
        .map((name) => join(dir, name))
    } catch {
      return []
    }
  }

  /** 一条词条摊平成全部检索键。 */
  keysOf(entry) {
    const keys = new Set()
    const push = (raw) => {
      const key = normalize(raw)
      if (indexable(key)) keys.add(key)
    }
    push(entry.term)
    push(entry.full)
    if (Array.isArray(entry.aliases)) for (const alias of entry.aliases) push(alias)
    if (Array.isArray(entry.homophones)) for (const hp of entry.homophones) push(hp)
    if (Array.isArray(entry.variants)) for (const v of entry.variants) push(v)
    // 首字母：显式给的优先，没给就按全称现算
    if (entry.initials && isAsciiWord(entry.initials)) push(entry.initials)
    else if (entry.full && this.pinyin) {
      const calc = initialsOf(entry.full, this.pinyin)
      if (isAsciiWord(calc)) push(calc)
    }
    if (entry.pinyin && isAsciiWord(entry.pinyin)) push(entry.pinyin)
    return keys
  }

  /** 追加一条词条；返回下标。同名（归一化后）的会合并别名，不重复占位。 */
  add(entry) {
    if (!entry || typeof entry !== 'object') return -1
    const term = normalize(entry.term || entry.full || '')
    if (!term) return -1
    const existing = this.byId.get(term)
    if (existing !== undefined) {
      // 同名词条：后加载的覆盖先加载的。
      // 加载顺序是「包内种子 → ~/.dsh/slang-corpus 用户层」，所以用户层永远赢——
      // 这是「数据存在 DSH 里」的实际含意：想改哪条默认释义，往用户目录写一条同名即可，
      // 不用动插件包，也不会多出一份重复词条。
      const target = this.entries[existing]
      for (const field of ['full', 'meaning', 'register', 'field', 'sample', 'kind', 'initials', 'pinyin']) {
        if (entry[field]) target[field] = entry[field]
      }
      for (const listField of ['aliases', 'homophones', 'variants']) {
        if (Array.isArray(entry[listField]) && entry[listField].length > 0) {
          target[listField] = [...new Set([...(target[listField] || []), ...entry[listField]])]
        }
      }
      if (entry.source === 'user') target.source = 'user'
      for (const key of this.keysOf(target)) this.linkKey(key, existing)
      return existing
    }
    const idx = this.entries.length
    this.entries.push(entry)
    this.byId.set(term, idx)
    for (const key of this.keysOf(entry)) this.linkKey(key, idx)
    this.version += 1
    return idx
  }

  /** 把一个键挂到某条词条上，并维护首字符分组。 */
  linkKey(key, idx) {
    let bucket = this.index.get(key)
    if (!bucket) {
      bucket = new Set()
      this.index.set(key, bucket)
      const first = key[0]
      let list = this.byFirstChar.get(first)
      if (!list) {
        list = []
        this.byFirstChar.set(first, list)
      }
      list.push(key)
    }
    bucket.add(idx)
  }

  get size() {
    return this.entries.length
  }

  /* ---------------- 查询 ---------------- */

  /**
   * 查一个词，返回 [{ entry, via }]，via 说明走的是哪条路（可解释）。
   * @param {string} query
   * @param {{limit?: number}} [opts]
   */
  lookup(query, opts = {}) {
    const limit = opts.limit || 5
    const q = normalize(query)
    if (!q) return []
    const hits = []
    const seen = new Set()
    const take = (idx, via) => {
      if (seen.has(idx) || hits.length >= limit) return
      seen.add(idx)
      const entry = this.entries[idx]
      if (entry) hits.push({ entry, via })
    }

    // 1) 精确：term / alias / initials / full 全在这张表里
    for (const idx of this.index.get(q) || []) take(idx, 'exact')

    // 2) 中文查询算首字母再查一次："永远的神" → yyds
    if (this.pinyin && hits.length < limit) {
      const calc = initialsOf(query, this.pinyin)
      if (calc && calc !== q) for (const idx of this.index.get(calc) || []) take(idx, 'initials')
    }

    // 3) 前缀（q 至少 2 位，否则太散）
    if (q.length >= 2 && hits.length < limit) {
      for (const [key, bucket] of this.index) {
        if (hits.length >= limit) break
        if (key !== q && key.startsWith(q)) for (const idx of bucket) take(idx, 'prefix')
      }
    }

    // 4) 互相包含：q 出现在键里，或键出现在 q 里（长句兜底）
    if (hits.length < limit) {
      for (const [key, bucket] of this.index) {
        if (hits.length >= limit) break
        if (key.length >= 2 && (key.indexOf(q) >= 0 || q.indexOf(key) >= 0)) {
          for (const idx of bucket) take(idx, 'contains')
        }
      }
    }
    return hits
  }

  /**
   * 长文本扫命中（「用户刚说的话里有没有黑话」）。
   * 用首字符分组做稀疏扫描，避免每次遍历全部键。
   * @param {string} text
   * @param {{limit?: number, minLength?: number}} [opts]
   */
  scan(text, opts = {}) {
    const limit = opts.limit || 6
    const minLength = opts.minLength || 2
    const q = normalize(text)
    if (!q) return []
    const hitKeys = new Set()
    const visited = new Set()
    for (const ch of q) {
      if (visited.has(ch)) continue
      visited.add(ch)
      const list = this.byFirstChar.get(ch)
      if (!list) continue
      for (const key of list) {
        if (key.length < minLength) continue
        if (q.indexOf(key) >= 0) hitKeys.add(key)
      }
    }
    // 长键优先："永远的神" 命中时不必再报 "神"
    const ordered = [...hitKeys].sort((a, b) => b.length - a.length)
    const out = []
    const seenEntries = new Set()
    for (const key of ordered) {
      for (const idx of this.index.get(key) || []) {
        if (seenEntries.has(idx)) continue
        seenEntries.add(idx)
        out.push({ entry: this.entries[idx], key })
        if (out.length >= limit) return out
      }
    }
    return out
  }

  /** 取前 N 条（用于注入精选速查表）。 */
  top(count = 24, filter) {
    const pool = filter ? this.entries.filter(filter) : this.entries
    return pool.slice(0, count)
  }
}

/* ---------------- 渲染 ---------------- */

/** 一条释义压成一行给模型看；meaning 超长截断，避免吃掉上下文。 */
export function formatEntry(entry, maxMeaning = 90) {
  const term = entry.term || entry.full || ''
  const full = entry.full && normalize(entry.full) !== normalize(term) ? entry.full : ''
  const head = full ? term + '（' + full + '）' : term
  let meaning = String(entry.meaning || '').trim()
  if (meaning.length > maxMeaning) meaning = meaning.slice(0, maxMeaning) + '…'
  const field = entry.field ? '[' + entry.field + ']' : ''
  const extra = Array.isArray(entry.more) && entry.more.length > 0
    ? '；另有 ' + entry.more.map((m) => (m.full ? m.full + '：' : '') + m.meaning).join(' / ')
    : ''
  return head + field + ' = ' + meaning + extra
}

/** 命中列表拼成注入块；超预算就砍（先砍后面那几条）。 */
export function renderBlock(hits, opts = {}) {
  const maxChars = opts.maxChars || 600
  const title = opts.title || '黑话速查（自动命中，仅供理解，不必复述）'
  if (!hits || hits.length === 0) return ''
  const lines = []
  let used = 0
  for (const hit of hits) {
    const line = '- ' + formatEntry(hit.entry)
    if (used + line.length > maxChars && lines.length > 0) break
    lines.push(line)
    used += line.length + 1
  }
  if (lines.length === 0) return ''
  return title + String.fromCharCode(10) + lines.join(String.fromCharCode(10))
}
