# dsh-slang-own — 网络黑话与隐晦词语料库

给 DeepSeek Harness 装一套**本地黑话语料库**：模型遇到 yyds / xswl / 绷不住了 / 颗粒度 / 优化（＝裁员）这类词，不再靠现场猜。

不联网、不调用模型、零第三方依赖。全部检索在本机完成。

## 它做三件事

1. **常驻注入一张小速查表**（默认 16 条最高频 + 使用规则，约 700 字，固定文本不破 prompt 前缀缓存）；
2. **`slang_lookup` 工具**：表外的词按需查，中文全称 / 拼音首字母 / 别名任意写法都能落到同一条释义；
3. **`slang_add` 工具**：查到的新词就地沉淀到用户词库，之后自动生效，升级不丢。

外加 `slang_stats` 自查词库规模与构成。

## 为什么不是「全文检索」

网络隐晦词的难点不是「查词义」，是**同一个词的多种字面化身**：

```
yyds / 永远的神 / 永远滴神 / yyds永远的神
```

这几串在字面上毫无重叠，BM25 之类的字面相似度检索全部命不中。所以本插件在**装载期**就把一条词条摊平成多个检索键，全部指向同一个 entry：

`term` · `full` · `aliases[]` · `initials`（拼音首字母） · `homophones[]` · `variants[]`

查询时无论用户写哪一种，都会落到同一条释义。反向也成立：输入「永远的神」会先算首字母 `yyds` 再查一次，所以中文全称能查回首字母缩写。

## 装

```powershell
dsh plugin --profile desktop add link:D:\DSH\plugins\dsh-slang-own
```

重启 DSH 生效（宿主启动是全有全无，插件加载失败会导致整个宿主起不来，装前可先跑自检）。

回滚：

```powershell
dsh plugin --profile desktop remove dsh-slang-own
```

## 自检（不依赖宿主）

```bash
node tools/selftest.mjs
```

用 loader 把 `@deepseek-ai/dsh-tools` 换成桩，自己造 ctx，验证：三个工具注册、钩子挂载、注入块长度、中文全称反查、首字母反查、查不到时的兜底话术、`slang_add` 落盘与即刻可查。

## 语料构成

| 文件 | 条数 | 内容 | 来源 |
|---|---|---|---|
| `corpus/core.json` | 145 | 谐音梗、抽象话、粗口、饭圈、二次元、游戏、职场暗语、平台规避写法、成人向隐晦词、英文缩写、数字梗 | 本插件自建 |
| `corpus/net.json` | 215 | 网络缩写、梗、职场/互联网黑话（带人话解释与例句） | [junaluo-222/slang-dictionary](https://github.com/junaluo-222/slang-dictionary) |
| `corpus/eve.json` | 322 | EVE Online 中文黑话（301 条精选 + 官方术语） | [yilifaer/eve-cn-slang](https://github.com/yilifaer/eve-cn-slang)，CC BY 4.0 |
| `corpus/pinyin-initials.json` | 20924 字 | 汉字 → 声母首字母 | [mozillazg/pinyin-data](https://github.com/mozillazg/pinyin-data)，MIT |

合计 682 条词条 / 2048 个倒排键。

> 各上游数据版权归其原作者；本项目只做格式归一与合并。若上游采用不同许可，以其仓库声明为准。

## 加词（三条路，按需选）

**1. 让模型记** — 对话里说「记住 xxxxx 是指…」，模型会调 `slang_add`，写进 `~/.dsh/slang-corpus/user.json`。

**2. 手改** — 直接编辑 `~/.dsh/slang-corpus/user.json`（JSON 数组），重启或重载插件后生效。

**3. 重跑构建** — 把新原料放进外部目录，改 `tools/build-corpus.mjs` 的解析段，再：

```bash
node tools/build-corpus.mjs <原料目录>
```

一条词条长这样：

```json
{
  "term": "蚌埠住了",
  "full": "绷不住了",
  "meaning": "「绷不住了」的谐音写法，同义：忍不住笑或哭",
  "register": "net",
  "field": "谐音梗",
  "aliases": ["蚌埠住", "蚌住"],
  "homophones": [],
  "kind": "word",
  "source": "core"
}
```

`register` 取值：`net`（网络）/ `pro`（行业黑话）/ `vulg`（粗俗）/ `adult`（成人向）。写小说时按语境挑，别把 `vulgar` 的词用在正式场合。

## 配置

设置写在 `~/.dsh/dsh-slang-own.json`，缺省值：

```json
{
  "enabled": true,
  "promptEnabled": true,
  "topCount": 16,
  "maxInjectedChars": 900,
  "lookupLimit": 5
}
```

- `promptEnabled: false` — 关掉系统提示注入，只留工具（省 token）；
- `topCount: 0` — 只注入规则不注入词条；
- `maxInjectedChars` — 注入正文硬上限，超了就少放几条。

## 已知边界

- **拼音表只到声母首字母**，不做全拼检索：「yongyuandeshen」查不到 yyds；
- **单字词条不参与长文本扫命中**（「乐」「典」「赢」在正常中文里出现太频繁，会误报），但精确查询能查到；
- **不做共现自动挖词**：新词靠 `slang_add` 或重跑构建，符合「黑话寿命只有几个月、人工确认比自动猜更可靠」的取舍；
- **EVE 词条占比大**（322/682），速查表刻意跳过游戏术语，避免占满 token。

## 文件

```
dsh-slang-own/
├── lib/
│   ├── corpus.js     归一化 / 多键倒排 / 查询 / 渲染（零依赖）
│   └── index.js      插件主体：钩子注入 + 三个工具
├── corpus/           语料（随包分发）
├── tools/
│   ├── build-corpus.mjs   从外部原料生成 corpus/
│   └── selftest.mjs       脱离宿主自检
├── cordis.patch.yml
└── package.json
```
