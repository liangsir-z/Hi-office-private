# Hi-office

**AI 原生办公四件套** — 文档、表格、幻灯片、PDF,四个编辑器 + 一套自研引擎层,
AI 不是挂在边上的聊天框,而是能真正动手改文档的智能体。

![License](https://img.shields.io/badge/license-Apache--2.0-blue)
![Platforms](https://img.shields.io/badge/platforms-macOS%20%7C%20Windows%20%7C%20Linux-lightgrey)
![Languages](https://img.shields.io/badge/UI-19%20languages-green)

---

## 核心优势

### 1. 打开 → 编辑 → 保存,排版永不回退

市面上的网页版办公套件,打开复杂文档再保存,格式或多或少会"变味"。Hi-office 把
**原文件当作唯一事实源**:编辑以最窄补丁落盘,没动过的内容**逐字节原样保留**。

- **文档**:`word/document.xml` 按顶层元素解析成块树,每块锚定原文 XML;保存时只有
  脏块重新生成 OOXML 片段并拼接回去,其余部分保持原始字节 —— 修订、批注、公式、
  样式引用一个不丢。
- **表格 / 幻灯片**:同一哲学 —— 打开 `.xlsx` / `.pptx` 不做"格式转换",而是解析
  → 编辑 → 窄补丁回写,母版、图表、主题链路完整往返。

```
open ─► 按内容寻址归档原件(永不改动)
      ─► 解析为块树(每块锚定 docxIndex + 原始 XML 切片)
      ─► 流式编辑器(人工 + AI,脏块追踪)
save ─► 脏块 → OOXML 片段(只引用文档已有样式)
      ─► 拼回原 document.xml(未动块保持原字节)
      ─► 重打包;其余 zip 条目逐字节复制
```

往返质量由引擎层 **3600+ 个单元测试**保证(docx/pptx/xlsx 引擎全部可无显示器跑 CI)。

### 2. AI 真正在改文档,不是给建议

- **文档**:按段落块粒度做 AI 改写,带版本快照与差异对比,不满意一键回滚。
- **表格 / 幻灯片 / PDF**:工具调用智能体直接操作文档状态 —— 读元素清单、移动缩放、
  改字体改颜色、增删页、插入图表/图片、整页重排,每一步可撤销。
- **自修复闭环**:确定性布局审计(越界 / 溢出 / 重叠 / 字号下限)先跑一遍,AI 拿着
  审计结果定向修复,而不是盲目重画。

### 3. 只要一个文本模型,就能做好幻灯片排版

这是 Hi-office 最硬的一块技术:**不需要视觉模型**,用确定性度量替代"眼睛"。

AI 美化幻灯片时,模型先产出整页 HTML 设计稿,本地转换器在沙箱浏览器里逐元素测量,
重建为**完全可编辑的原生 PPT 元素**。转换做到了像素级保真:

- 浏览器换行点"烤入"段落(每视觉行一段,`wrap=none`),PowerPoint 永不重新换行;
- 基线精确几何:字体度量、行高单位(CSS 与 OOXML 行距单位不同)、半行距全部对齐,
  回归测试测得**每行墨迹位置偏差 ≤ 1px**;
- 透明度合成、圆角半径、图片裁切填充(`object-fit: cover` → `srcRect`)逐项保真。

结果是:DeepSeek 这样的纯文本模型 + 本地引擎,达到了通常需要多模态模型 + 云端
排版服务的成品质量 —— 而且整个转换过程零网络依赖、元素全部可编辑。

### 4. 自研引擎,不是套壳

| 引擎 | 能力 |
| --- | --- |
| `docx-engine` | docx 解析→块树、OOXML 片段生成、字节级段落补丁 |
| `pptx-engine` / `pptx-render` | pptx 模型与渲染:母版、图表、裁切、墨迹、HarfBuzz 文本整形 |
| sheets xlsx sidecar | Rust(calamine + IronCalc)导入导出,配合数据透视表、切片器、条件格式、公式追踪 |
| 图表渲染 | 自研(Konva),不依赖工作表内嵌控件 |
| PDF | pdf.js + pdf-lib:批注、表单、大纲、图章、签名、页面操作、打印 |

所有引擎是纯 TypeScript / Rust 包,无 Electron 依赖,可独立测试复用。

### 5. 隐私即架构:数据不出本机,AI 自带钥匙

- 编辑、渲染、保存**全部本地完成**,离线可用;AI 是唯一的网络出口。
- **BYOK(自带密钥)**:在设置里填自己的 DeepSeek API Key,请求由应用**直连**
  `api.deepseek.com`,没有中间服务器,没有账号系统。
- API Key 用操作系统钥匙串加密存储(Electron safeStorage),不落明文。
- 渲染进程沙箱、IPC 入参校验、外链管控 —— 详见 [SECURITY.md](SECURITY.md)。

### 6. 技能系统:每个 App 一套,可自己写

AI 能力以 **Skill**(Markdown 编写,带 frontmatter)形式挂载,按 app 分类管理:
slides 的排版设计体系、docs 的写作技能、sheets 的建模技能……内置一批,用户可在
设置里新建、查看、启用/停用,保存即热更新,无需重启。

### 7. 19 种界面语言,AI 回复跟随界面语言

简/繁中文、英、日、韩、法、德、西、泰、印尼、俄、阿拉伯(含 RTL)、葡、意、波、
荷、马来、希伯来、印地 —— 切到哪种语言,AI 就用哪种语言回复(对提示词漂移到英文
做了系统性治理)。

---

## 应用一览

| 应用 | 格式 | 说明 |
| --- | --- | --- |
| **Hi-office Docs** | `.docx` | 字节保真往返的字处理;分页视图复现原文档行布局,支持修订、批注、样式、公式、墨迹 |
| **Hi-office Sheets** | `.xlsx` | 基于 Univer 核心(Apache-2.0)+ 大量自研扩展;Rust 导入导出、自研图表、透视表、切片器 |
| **Hi-office Slides** | `.pptx` | 自研解析/渲染/编辑引擎 + AI 整页美化管线(见核心优势 3) |
| **Hi-office PDF** | `.pdf` | 批注、表单、大纲、图章、签名、页面操作、打印 |
| **Hi-office**(Shell) | — | 套件主界面:主页、四编辑器标签页托管、全局设置、自动更新 |

## 从源码构建

```bash
npm install
npm run dist:mac   # macOS dmg (Apple Silicon)
npm run dist:win   # Windows nsis 安装包
npm run dist:linux # Linux AppImage
```

安装包未签名:macOS 首次打开请右键 → 打开。表格应用编译 xlsx sidecar 需要 Rust
工具链(`cargo` 在 PATH 上,`npm run build -w @genoffice/sheets` 自动编译)。

## 开发

```bash
npm install
npm run fixtures     # 生成测试 .docx 夹具
npm test             # 引擎 + 各应用单元测试(无需显示器)
npm run typecheck    # 全工作区 tsc --noEmit
npm run dev          # 四个编辑器 + shell 走 Vite 开发服
npm run dev:docs     # 单跑一个应用(每个工作区同款命令)
```

## 仓库结构

```
apps/       docs · sheets · slides · pdf · shell(五个 Electron 应用)
packages/   docx-engine · pptx-engine · pptx-render · agent-core ·
            ai-provider · ai-search · file-parse · i18n · ui ·
            project-store · electron-utils · skills-builtin
```

本地验收脚本(Playwright + Electron)放 [`scripts/drivers/`](scripts/drivers/README.md),
默认不提交。

## 安全

见 [SECURITY.md](SECURITY.md):进程安全姿态(渲染器沙箱、IPC 校验、外链管控)与
AI 生成内容的威胁模型。

## 第三方声明

`npm run notices` 重新生成第三方许可摘要(`tools/gen-third-party-notices.mjs`);
运行时依赖均为 MIT / Apache-2.0 / OFL,内置字体(Liberation、Carlito、Caladea、
Noto CJK 子集)为 OFL / Apache。

## 许可

Apache-2.0,见 [LICENSE](LICENSE);`ee/` 目录预留给未来企业模块,适用
[Hi-office Enterprise License](ee/LICENSE)。本项目为独立维护的重命名分支;
上游 GenOffice/Genspark 名称与标识为 Mainfunc, Inc. 商标,本项目不使用。

---

## English introduction

Hi-office is an AI-native office suite (word processor, spreadsheet,
presentations, PDF) — five Electron apps over a shared in-house engine layer,
with AI editing as a first-class workflow rather than a chat sidebar.

Highlights:

- **Byte-faithful round trip.** The original file is the source of truth; edits
  are applied as narrow patches and untouched content survives byte-for-byte.
  Opening and saving a complex `.docx`/`.xlsx`/`.pptx` never degrades it.
- **AI that edits, not advises.** Block-granular AI rewriting with snapshots
  and diffs in docs; a tool-calling agent that directly manipulates workbook /
  slide / PDF state in the others, with a deterministic layout audit feeding a
  self-correcting repair loop.
- **Slide design with a text-only model.** The beautify pipeline converts the
  model's page HTML into fully editable native elements with pixel-level
  fidelity (browser line breaks baked in, baseline-exact text geometry,
  measured ≤1px per-line ink drift) — no vision model, no cloud layout
  service, DeepSeek alone is enough.
- **In-house engines.** docx parsing/patching, pptx model + render (masters,
  charts, HarfBuzz shaping), a Rust xlsx sidecar (calamine + IronCalc),
  in-house chart rendering, pdf.js + pdf-lib editing — pure packages, covered
  by 3,600+ headless unit tests.
- **Private by architecture.** Everything is local except AI calls, which go
  straight from the app to the DeepSeek API with your own key (encrypted via
  the OS keychain). No accounts, no relay servers.
- **Per-app skill system** (Markdown skills, built-in + user-defined,
  hot-reload) and **19 UI languages** with AI replies following the interface
  language.

Build from source: `npm install && npm run dist:mac` (also `dist:win`,
`dist:linux`; sheets needs a Rust toolchain). See [SECURITY.md](SECURITY.md)
for the security posture. Apache-2.0 — see [LICENSE](LICENSE) and [NOTICE](NOTICE).
