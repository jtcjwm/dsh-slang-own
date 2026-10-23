/**
 * dsh-slang-own — 网络黑话 / 隐晦词语料库插件（宿主半边）。
 *
 * 解决的问题：模型对「yyds / xswl / 绷不住了 / 颗粒度 / 对齐」这类词的
 * 理解全靠现场猜，猜错时既不报错也不自知。这个插件把一批词条装进本地
 * 倒排索引，做三件事：
 *
 *   1. 常驻注入一小张「高频速查表」+ 使用规则（几行字，固定文本，不破
 *      prompt 前缀缓存）；
 *   2. 提供 slang_lookup 工具：遇到表外的缩写/谐音/圈内话，按中文全称、
 *      拼音首字母、别名任意写法都能查回同一条释义；
 *   3. 提供 slang_add 工具：查到的新词就地沉淀到用户词库，下次自动生效。
 *
 * 语料分两层：包内 corpus/*.json（随版本升级，只读）+ 用户
 * ~/.dsh/slang-corpus/*.json（slang_add 写入，永不被升级覆盖）。
 *
 * 零第三方依赖，理由见 corpus.js 顶部。
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import { readFileSync, writeFileSync, mkdirSync, existsSync, watch } from 'node:fs'
import { join, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import {
  SlangCorpus, loadPinyinTable, renderBlock, formatEntry, normalize,
} from './corpus.js'

const NL = String.fromCharCode(10)
const HERE = dirname(fileURLToPath(import.meta.url))
const PKG_ROOT = join(HERE, '..')
const PKG_CORPUS = join(PKG_ROOT, 'corpus')

/**
 * DSH 数据目录（默认 ~/.dsh）。
 *
 * 坑：桌面版的 DSH_HOME 直接指向 .dsh 本身（C:\Users\X\.dsh），不是用户主目录。
 * 第一版无条件在它后面再拼一层 '.dsh'，用户词库就落到了 .dsh/.dsh/slang-corpus，
 * 和 DSH 自己的目录结构对不上。所以先看末段是不是 .dsh，再决定要不要拼。
 */
function dataDir() {
  const raw = (process.env.DSH_HOME || '').trim()
  if (!raw) return join(homedir(), '.dsh')
  return basename(raw) === '.dsh' ? raw : join(raw, '.dsh')
}

const USER_CORPUS = () => join(dataDir(), 'slang-corpus')
const SETTINGS_FILE = () => join(dataDir(), 'slang.json')

/** 默认设置；设置页/手改 JSON 都能覆盖。 */
const DEFAULTS = {
  enabled: true,
  promptEnabled: true,
  /** 速查表条数；0 表示只注入规则，不注入词条。 */
  topCount: 16,
  /** 注入正文的字符上限，超了就少放几条。 */
  maxInjectedChars: 900,
  /** 工具返回的最大命中条数。 */
  lookupLimit: 5,
}

/** 速查表优先列的常用词：全网高频，缺了它们这份表现得很外行。 */
const PINNED_TERMS = ['yyds', 'xswl', 'awsl', '破防', 'emo', '绝绝子', '绷不住了', '蚌埠住了', '栓Q', '润', '典', '急了', '乐', '麻了', '摸鱼', '内卷']

const RULE_TEXT = [
  '【黑话与网络隐晦词】',
  '遇到缩写、谐音梗、圈内黑话、职场黑话（yyds / xswl / 绷不住了 / 颗粒度 / 对齐…）时，',
  '先看下面的速查表；表里没有就调 slang_lookup 查本地词库（中文全称 / 拼音首字母 / 别名可互查）。',
  '查不到就按字面正常理解，不要编造释义；确认了新词用 slang_add 记下，之后自动生效。',
].join(NL)

/* ---------------- 设置读写 ---------------- */

function readSettings() {
  try {
    const raw = readFileSync(SETTINGS_FILE(), 'utf8')
    const parsed = JSON.parse(raw)
    return { ...DEFAULTS, ...(parsed && typeof parsed === 'object' ? parsed : {}) }
  } catch {
    return { ...DEFAULTS }
  }
}

function writeSettings(patch) {
  try {
    mkdirSync(dirname(SETTINGS_FILE()), { recursive: true })
    const next = { ...readSettings(), ...patch }
    writeFileSync(SETTINGS_FILE(), JSON.stringify(next, null, 2), 'utf8')
    return true
  } catch {
    return false
  }
}

/* ---------------- 插件主体 ---------------- */

export const name = 'dsh-slang-own'

/** 只依赖工具注册表：语料是本地文件，系统提示靠 waterfall 挂钩。 */
export const inject = ['tools']

export function apply(ctx, config) {
  const pinyin = loadPinyinTable(PKG_CORPUS)

  /** 重新装载（包内 + 用户）全部语料。 */
  const load = () => {
    const files = [
      ...SlangCorpus.filesIn(PKG_CORPUS),
      ...SlangCorpus.filesIn(USER_CORPUS()),
    ]
    return SlangCorpus.fromFiles(files, pinyin)
  }

  let corpus = load()
  /** 注入块缓存：语料不变就不重算（每回合都跑 assemble，别做无用功）。 */
  let cachedBlock = { version: -1, settings: '', text: '' }

  const clip = (text, max) => {
    const s = String(text || '').trim()
    return s.length > max ? s.slice(0, max) + '…' : s
  }

  /** 紧凑速查表：一条一行，只留「词=全称（一句解释）」，省 token。 */
  const shortLine = (entry) => {
    const full = entry.full && normalize(entry.full) !== normalize(entry.term) ? entry.full : ''
    const gloss = clip(entry.meaning, 12)
    let line = entry.term
    if (full) line += '=' + full
    if (gloss) line += '（' + gloss + '）'
    return line
  }

  /** 组装注入文本：规则段 + 高频速查表。 */
  const buildPromptBlock = (settings) => {
    const stamp = JSON.stringify([settings.topCount, settings.maxInjectedChars, corpus.version])
    if (cachedBlock.version === corpus.version && cachedBlock.settings === stamp) return cachedBlock.text

    const parts = [RULE_TEXT]
    if (settings.topCount > 0) {
      const picked = []
      const added = new Set()
      const take = (entry) => {
        if (!entry || added.has(entry.term) || picked.length >= settings.topCount) return
        // 速查表不放游戏术语：命中面太窄，白占 token
        if (entry.register === 'pro' && String(entry.field || '').indexOf('EVE') >= 0) return
        if (!entry.meaning && !entry.full) return
        added.add(entry.term)
        picked.push(entry)
      }
      // 先放那几个全网最高频的，再按语料原序补满
      for (const term of PINNED_TERMS) take(corpus.entries[corpus.byId.get(normalize(term))])
      for (const entry of corpus.entries) {
        if (picked.length >= settings.topCount) break
        take(entry)
      }
      const lines = picked.map((entry) => '- ' + shortLine(entry))
      let table = lines.join(NL)
      if (table.length > settings.maxInjectedChars) {
        table = table.slice(0, settings.maxInjectedChars) + NL + '…（其余用 slang_lookup 查）'
      }
      if (table) parts.push('高频速查：' + NL + table)
    }
    const text = parts.join(NL + NL)
    cachedBlock = { version: corpus.version, settings: stamp, text }
    return text
  }

  // ---- 系统提示注入：固定文本，不随回合变化，前缀缓存友好 ----
  ctx.on('system-prompt/assemble', async (_assembly, _context, next) => {
    const assembled = await next()
    const settings = readSettings()
    if (!settings.enabled || !settings.promptEnabled) return assembled
    const text = buildPromptBlock(settings)
    if (!text) return assembled
    assembled.sections.push({ name: 'dsh-slang-own:corpus', text })
    return assembled
  })

  /** 重装序列号：保证写词后注入块缓存一定失效（两个 corpus 实例的 version 会撞号）。 */
  var reloadSerial = 0
  const reload = () => {
    corpus = load()
    reloadSerial += 1
    corpus.version = 1000000 + reloadSerial
    return corpus
  }

  // ---- 语料热加载：改 corpus/*.json 或 ~/.dsh/slang-corpus/*.json 即刻生效 ----
  // 代码改动仍然要重启（ESM 模块表缓存），但改词条是高频操作，不该为它重启宿主。
  // 用 600ms 防抖合并一次写入触发的多个事件（编辑器保存常常连发三次）。
  let reloadTimer = null
  const scheduleReload = (label) => {
    if (reloadTimer) clearTimeout(reloadTimer)
    reloadTimer = setTimeout(() => {
      reloadTimer = null
      try {
        const before = corpus.size
        reload()
        console.log('[dsh-slang] 语料重载（' + label + '）：' + before + ' → ' + corpus.size + ' 条')
      } catch (error) {
        console.error('[dsh-slang] 语料重载失败：', error && error.message ? error.message : error)
      }
    }, 600)
  }

  const watchDirs = [PKG_CORPUS, USER_CORPUS()]
  const watchers = []
  for (const dir of watchDirs) {
    try {
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
      const w = watch(dir, { persistent: false }, (_event, file) => {
        // 拼音表只在启动时用，改了也不影响已建的索引键，忽略它
        if (!file || String(file).endsWith('.json')) scheduleReload(String(file || dir))
      })
      watchers.push(w)
    } catch (error) {
      console.error('[dsh-slang] 监听 ' + dir + ' 失败：', error && error.message ? error.message : error)
    }
  }
  // 插件被卸载/热禁用时由宿主调用，关掉 watcher 别留句柄
  ctx.effect(() => () => {
    if (reloadTimer) clearTimeout(reloadTimer)
    for (const w of watchers) {
      try { w.close() } catch {}
    }
  })

  // ---- 工具 1：查词 ----
  ctx.tools.register(defineTool({
    name: 'slang_lookup',
    description:
      '查网络黑话 / 缩写 / 谐音梗 / 圈内话的释义（本地词库，550+ 条，覆盖网络流行语、饭圈、二次元、'
      + '电竞、职场黑话、招聘暗语、EVE 游戏术语）。中文全称、拼音首字母、别名可互查：'
      + 'yyds / 永远的神 / 笑死我了 / xswl 都能命中。'
      + '用户用了你没把握的缩写或梗、或对话里出现看不懂的圈内表达时调用。'
      + '查不到就按字面理解，别编释义。',
    parameters: {
      term: { type: 'string', description: '要查的词：缩写、谐音、中文全称或别名都行' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: value.message }],
    },
    async execute(args) {
      const term = String(args.term || '').trim()
      if (!term) return { ok: false, found: 0, message: 'term 不能为空' }
      const settings = readSettings()
      const hits = corpus.lookup(term, { limit: settings.lookupLimit })
      if (hits.length === 0) {
        const scanned = corpus.scan(term, { limit: settings.lookupLimit })
        if (scanned.length === 0) {
          return {
            ok: true,
            found: 0,
            message: '词库里没有「' + clip(term, 40) + '」。按字面理解；确认含义后用 slang_add 记下来。',
          }
        }
        return {
          ok: true,
          found: scanned.length,
          message: '词库里没有精确条目，但在本地' + '匹配到相近写法：' + NL
            + scanned.map((h) => '- ' + formatEntry(h.entry)).join(NL),
        }
      }
      const body = hits.map((h) => '- ' + formatEntry(h.entry) + '（命中的是 ' + h.entry.term + '）')
      return {
        ok: true,
        found: hits.length,
        entries: hits.map((h) => h.entry),
        message: '「' + clip(term, 40) + '」查到 ' + hits.length + ' 条：' + NL + body.join(NL),
      }
    },
  }))

  // ---- 工具 2：沉淀新词 ----
  ctx.tools.register(defineTool({
    name: 'slang_add',
    description:
      '把一条新的黑话 / 缩写 / 圈内表达存进用户词库，之后自动生效（常驻速查表与 slang_lookup 都能查到）。'
      + '仅当含义已经明确、且 slang_lookup 查不到时才写；用户明确说「记住这个词」时优先写。'
      + '写入 ~/.dsh/slang-corpus/user.json，不随插件升级丢失。',
    parameters: {
      term: { type: 'string', description: '词条本字，如 yyds / 绷不住了 / 颗粒度' },
      meaning: { type: 'string', description: '一句人话释义（必填）' },
      full: { type: 'string', description: '可选。全称或展开写法，如「永远的神」' },
      aliases: { type: 'string', description: '可选。别名/谐音/变体，逗号分隔' },
      register: { type: 'string', description: '可选。net（网络）/ pro（行业黑话）/ vulg（粗俗），缺省 net' },
      field: { type: 'string', description: '可选。领域，如「饭圈」「职场黑话」' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: value.message }],
    },
    async execute(args) {
      const term = String(args.term || '').trim()
      const meaning = String(args.meaning || '').trim()
      if (!term || !meaning) return { ok: false, message: 'term 与 meaning 都必须给' }
      const full = String(args.full || '').trim()
      const aliases = String(args.aliases || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
      const entry = {
        term,
        full,
        meaning,
        register: String(args.register || 'net').trim() || 'net',
        field: String(args.field || '').trim(),
        aliases,
        kind: /^[A-Za-z0-9.+#_-]+$/.test(term) ? 'abbr' : 'word',
        source: 'user',
      }
      if (entry.kind === 'abbr') entry.initials = term.toLowerCase()

      const dir = USER_CORPUS()
      const file = join(dir, 'user.json')
      let list = []
      try {
        if (existsSync(file)) {
          const parsed = JSON.parse(readFileSync(file, 'utf8'))
          if (Array.isArray(parsed)) list = parsed
        }
      } catch {
        list = []
      }
      const dupAt = list.findIndex((item) => normalize(item && item.term) === normalize(term))
      if (dupAt >= 0) {
        list[dupAt] = { ...list[dupAt], ...entry }
      } else {
        list.push(entry)
      }
      try {
        mkdirSync(dir, { recursive: true })
        writeFileSync(file, JSON.stringify(list, null, 2), 'utf8')
      } catch (error) {
        return { ok: false, message: '写入用户词库失败: ' + (error && error.message ? error.message : String(error)) }
      }
      reload()
      return {
        ok: true,
        total: corpus.size,
        message: '已收录「' + term + '」= ' + clip(meaning, 60) + NL
          + '用户词库现有 ' + list.length + ' 条，词库合计 ' + corpus.size + ' 条，本次会话即刻生效。',
      }
    },
  }))

  // ---- 工具 3：自查 ----
  ctx.tools.register(defineTool({
    name: 'slang_stats',
    description:
      '查看本地黑话语料库的规模与构成（总条数、按来源/领域分布、用户自建条数、索引键数）。'
      + '用户问「词库有多大 / 都收了些什么 / 怎么加词」时调用。',
    parameters: {},
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: value.message }],
    },
    async execute() {
      const bySource = {}
      const byField = {}
      for (const entry of corpus.entries) {
        const src = entry.source || 'unknown'
        bySource[src] = (bySource[src] || 0) + 1
        if (entry.field) byField[entry.field] = (byField[entry.field] || 0) + 1
      }
      const topFields = Object.entries(byField)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 8)
        .map(([k, v]) => k + ' ' + v)
      const lines = [
        '词库合计 ' + corpus.size + ' 条，倒排键 ' + corpus.index.size + ' 个'
          + (pinyin ? '，拼音首字母表已加载（' + Object.keys(pinyin).length + ' 字）' : '，拼音表缺失（仅字面匹配）'),
        '来源：' + Object.entries(bySource).map(([k, v]) => k + ' ' + v).join(' / '),
        topFields.length > 0 ? '领域 top: ' + topFields.join(' · ') : '',
        '用户目录：' + USER_CORPUS(),
        corpus.problems.length > 0 ? '装载告警：' + corpus.problems.join('；') : '',
      ].filter(Boolean)
      return { ok: true, total: corpus.size, keys: corpus.index.size, message: lines.join(NL) }
    },
  }))
}
