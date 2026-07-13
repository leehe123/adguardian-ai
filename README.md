<h1 align="center">AdGuardian AI</h1>

<p align="center">
  <img alt="Manifest" src="https://img.shields.io/badge/Manifest-V3-blue">
  <img alt="Platform" src="https://img.shields.io/badge/Platform-Chrome-brightgreen">
  <img alt="AI" src="https://img.shields.io/badge/AI-DeepSeek-ff69b4">
  <img alt="License" src="https://img.shields.io/badge/License-MIT-yellow">
</p>

<p align="center">
  <b>规则引擎 + DeepSeek AI 双层智能广告拦截插件</b><br>
  <i>A Chrome (Manifest V3) ad blocker that combines a rule engine with DeepSeek AI for native-ad &amp; feed-promotion detection.</i>
</p>

---

# 中文说明

## 项目简介

AdGuardian AI 是一款基于 **Manifest V3** 的 Chrome 广告拦截插件。它采用「规则引擎 + AI」双层架构：

- **规则引擎层**：基于 `declarativeNetRequest`，毫秒级拦截已知广告域名，零成本、零隐私外传。
- **AI 拦截层**：接入 DeepSeek 大模型，识别规则覆盖不到的**原生广告、信息流推广、搜索广告**，给出「广告 / 非广告」判定、置信度与理由。

两级配合，既保证已知广告的极速拦截，又补上了传统拦截器最薄弱的「原生广告」盲区。

## 核心特性

- **双层拦截**：规则秒杀已知广告，AI 识别原生广告 / 信息流推广 / 搜索广告。
- **拦截透明**：弹出面板可查看每一条拦截的来源、广告类型、AI 判定理由与置信度；一键恢复误杀元素。
- **强度可调**：保守（≥95%）/ 标准（≥80%，默认）/ 激进（≥60%）三档，平衡拦截率与误杀。
- **白名单**：支持「本页暂停」与「整站白名单」。
- **订阅规则**：支持添加第三方规则订阅源（如 EasyList、AdBlock Plus 公开列表），一键更新。
- **自定义规则**：可手动添加「域名规则」或「CSS 选择器规则」。
- **多语言**：内置中文（zh_CN）与英文（en）。浏览器语言为中文时显示中文，否则自动回退英文。
- **隐私优先**：API Key 仅存本地；发送给 AI 的仅为疑似广告元素的文本与结构特征，不发送 Cookie、浏览历史或个人身份信息。

## 工作原理

```
页面加载
  └─> 规则引擎拦截已知广告（declarativeNetRequest，毫秒级，0 成本）
  └─> Content Script 扫描 DOM，提取「疑似广告候选元素」
        （命中广告关键词 / 搜索广告标签 / 信息流"推广" / iframe / banner 图片）
  └─> 同一页面最多 10 个候选合并为一次 DeepSeek API 调用
  └─> AI 返回：广告 / 非广告 + 置信度 + 理由
  └─> 置信度 ≥ 阈值 -> 隐藏元素（display:none）
  └─> 决策缓存：以「域名 + 结构 + 文本哈希」为 key 缓存，相同结构不重复调用
```

**降级策略**：API 超时或报错时自动降级为纯规则模式，绝不阻塞页面渲染。

## 安装

> 当前为 MVP，仅支持 Chrome 系浏览器（Chrome / Edge / Brave 等基于 Chromium 的浏览器）。Firefox / Safari 暂不支持。

1. 打开 Chrome，地址栏输入 `chrome://extensions/`
2. 右上角打开「**开发者模式**」开关
3. 点击「**加载已解压的扩展程序**」
4. 选择本项目根目录（`adguardian-ai/`）
5. 工具栏出现 AdGuardian AI 图标即表示加载成功

（未来计划上架 Chrome 网上应用店，届时可直接搜索安装。）

## 配置

### 1. 配置 DeepSeek API Key

1. 点击工具栏 AdGuardian AI 图标 → 点击「设置」（齿轮图标）
2. 在「DeepSeek API Key」区域填入你的 Key（获取地址：<https://platform.deepseek.com/api_keys>）
3. 点击「测试连接」确认 Key 有效
4. 点击「保存 Key」
5. 开启「AI 智能拦截」开关，阅读隐私提示并**同意**后生效

### 2. 自定义 API 端点（可选）

设置页支持填写自定义的 API 地址、模型名与超时时间。例如指向本地部署的兼容 OpenAI 协议的服务（如 Ollama / vLLM），此时 Key 会发往你填写的地址。

> ⚠️ 注意：自定义端点时，你的 Key 与请求内容会发送到该地址，请仅填写你信任的服务。

### 3. 拦截强度

| 档位 | AI 置信度阈值 | 适用场景 |
|------|-------------|---------|
| 保守 | ≥ 95% | 极少误杀，适合对准确性要求极高的用户 |
| 标准 | ≥ 80% | 平衡拦截率与误杀（默认） |
| 激进 | ≥ 60% | 最大化拦截，可能伴随误杀 |

### 4. 白名单

- **本页暂停**：恢复当前页所有被拦截的元素（不写入持久白名单）。
- **本站白名单**：将当前域名加入白名单，该域名下所有页面不再被 AI 拦截。

### 5. 订阅规则 & 自定义规则

- 订阅源：填写名称 + 规则 URL（公开列表），点击「更新全部」拉取最新规则。
- 自定义规则：支持「域名规则」（整域放行/拦截）与「CSS 选择器规则」（按选择器隐藏元素）。

## 隐私说明

- **API Key**：仅存储在本地 `chrome.storage.local`，**不同步到 Google 账号**，不会出现在任何同步数据中。
- **发送给 AI 的数据**：仅限**疑似广告元素**的可见文本（最多 500 字符，且受广告关键词过滤）与结构特征（标签 / class / 广告链接域名 / 图片尺寸等）。
- **不会发送**：Cookie、完整 URL、页面 hostname、浏览历史、表单 / 密码 / 输入框内容。
- **本地存储**：API Key、设置、白名单（仅域名）、AI 缓存（仅存「决策 + 文本哈希指纹」，原始文本已被哈希，不落库）、域名规则、自定义规则、统计数据（仅计数，无内容）。
- **出站请求**：仅 3 类 —— DeepSeek 广告判定、DeepSeek 连接测试、订阅规则拉取。无埋点、无遥测、无第三方外传。
- 首次启用 AI 拦截时会明确弹窗告知数据使用方式，需用户主动同意。

> 诚实声明：所谓「文本」是*疑似广告元素*的可见文本。极端情况下，若某元素被误判为广告、又恰好包含用户输入内容（如带「推广」字样的用户评论），那段文本会被发往 AI。概率极低（受「广告关键词 + 500 字符」双重过滤），但严格说并非 100% 零 PII。我们不会主动抓取表单 / 密码框。

## 项目结构

```
adguardian-ai/
├── manifest.json                 # Manifest V3 配置（含 default_locale）
├── _locales/                     # 国际化语言包
│   ├── en/messages.json          # 英文
│   └── zh_CN/messages.json       # 中文
├── rules/
│   └── default-rules.json        # declarativeNetRequest 规则集
├── icons/                        # 插件图标（16/48/128px）
├── scripts/
│   └── generate-icons.js         # 图标生成脚本
├── src/
│   ├── background/
│   │   └── service-worker.js     # 后台：规则管理、AI 调度、缓存、统计、右键菜单
│   ├── content/
│   │   ├── content-script.js     # 页面脚本：DOM 扫描、候选提取、元素隐藏、元素选择器
│   │   └── content-styles.css    # 隐藏样式
│   ├── popup/
│   │   ├── popup.html / .js / .css  # 弹出面板（拦截明细 / 强度 / 白名单）
│   ├── options/
│   │   ├── options.html / .js / .css # 设置页（API Key / 强度 / 订阅 / 自定义规则 / 统计）
│   └── lib/
│       ├── constants.js          # 全局常量
│       ├── storage.js            # 存储管理
│       ├── ai-prompt.js          # AI Prompt 构建与解析
│       ├── rules-subscription.js # 订阅规则拉取与管理
│       └── utils.js              # 工具函数
└── README.md
```

## 国际化

插件使用 Chrome 原生 i18n 机制（`_locales` + `default_locale: "en"`）：

- 浏览器语言为中文 → 显示中文（zh_CN）
- 浏览器语言为非中文 → 自动回退显示英文（en）

静态文案通过 `__MSG_key__` 占位符在 HTML 中自动替换（无闪烁）；动态注入的文案通过 `chrome.i18n.getMessage('key')` 获取。无需任何自定义语言检测代码。

## 开发调试

### 重新生成图标

```bash
node scripts/generate-icons.js
```

### 调试入口

- **Service Worker**：`chrome://extensions/` → AdGuardian AI →「Service Worker」链接
- **Content Script**：打开任意网页 → F12 → Console（可看到 `[AdGuardian AI]` 开头的日志）
- **Popup**：右键点击工具栏图标 →「检查弹出内容」

### 添加更多规则

编辑 `rules/default-rules.json`，按以下格式追加：

```json
{
  "id": 31,
  "priority": 1,
  "action": { "type": "block" },
  "condition": {
    "urlFilter": "||example-ad-domain.com^",
    "resourceTypes": ["script", "image", "sub_frame", "xmlhttprequest"]
  }
}
```

## 已知限制

- 视频前贴片广告（YouTube / B 站等）将在后续阶段实现。
- 不支持 Firefox / Safari（MVP 仅支持 Chromium 系浏览器）。
- Content Script 在 `chrome://` 等浏览器内部页面不生效。
- 部分动态加载的广告可能在页面完全渲染后才被识别（已通过 MutationObserver 持续监听缓解）。

## 许可证

[MIT](#license) © 2026 leehe123

## 贡献

欢迎 Issue 与 Pull Request。提交前请确认：

1. 代码通过 `node --check` 语法校验；
2. 新增文案已同步到 `_locales/en` 与 `_locales/zh_CN`；
3. 不引入任何埋点 / 遥测 / 第三方数据外传。

---

# English Documentation

## Introduction

**AdGuardian AI** is a Chrome ad blocker built on **Manifest V3**, using a two-layer architecture — a **rule engine** plus **DeepSeek AI**:

- **Rule engine layer**: Powered by `declarativeNetRequest`, it blocks known ad domains in milliseconds — zero cost, zero privacy leakage.
- **AI layer**: Integrates the DeepSeek model to detect **native ads, in-feed promotions, and search ads** that rule lists miss, returning an *ad / not-ad* verdict with a confidence score and reasoning.

Together they deliver instant blocking of known ads while closing the gap on the hardest category: native advertising.

## Features

- **Dual-layer blocking** — rules for known ads, AI for native ads / feed promotions / search ads.
- **Transparency** — the popup shows, per blocked item, its source, ad type, AI reasoning, and confidence; one-click restore for false positives.
- **Adjustable strength** — Conservative (≥95%) / Standard (≥80%, default) / Aggressive (≥60%).
- **Whitelist** — per-page pause and per-site whitelist.
- **Rule subscriptions** — add third-party subscription sources (e.g. EasyList, AdBlock Plus public lists) with one-click update.
- **Custom rules** — manually add domain rules or CSS-selector rules.
- **i18n** — ships Chinese (zh_CN) and English (en). Shows Chinese when the browser language is Chinese, otherwise falls back to English.
- **Privacy-first** — API Key stored locally only; only suspected-ad element text + structural features are sent to the AI; no cookies, history, or PII.

## How it works

```
Page load
  └─> Rule engine blocks known ads (declarativeNetRequest, ms-level, 0 cost)
  └─> Content Script scans DOM, extracts "suspected ad candidate elements"
        (ad-keyword hits / search-ad labels / feed "promotion" / iframe / banner images)
  └─> Up to 10 candidates per page merged into one DeepSeek API call
  └─> AI returns: ad / not-ad + confidence + reasoning
  └─> confidence >= threshold -> hide element (display:none)
  └─> Decision cache: keyed by "domain + structure + text hash"; same structure not re-called
```

**Graceful degradation**: on API timeout/error it silently falls back to rule-only mode and never blocks page rendering.

## Installation

> MVP supports Chromium-based browsers only (Chrome / Edge / Brave). Firefox / Safari are not yet supported.

1. Open Chrome and go to `chrome://extensions/`
2. Toggle on **Developer mode** (top-right)
3. Click **Load unpacked**
4. Select the project root directory (`adguardian-ai/`)
5. The AdGuardian AI toolbar icon indicates a successful load

(Planned: publish to the Chrome Web Store for one-click install.)

## Configuration

### 1. DeepSeek API Key

1. Click the AdGuardian AI toolbar icon → **Settings** (gear icon)
2. Enter your Key in the "DeepSeek API Key" section (get one at <https://platform.deepseek.com/api_keys>)
3. Click **Test connection** to verify
4. Click **Save Key**
5. Toggle on **AI blocking**, read the privacy notice, and **consent** to activate

### 2. Custom API endpoint (optional)

The settings page lets you specify a custom API URL, model name, and timeout — e.g. pointing at a locally deployed OpenAI-compatible service (Ollama / vLLM). In that case your Key and requests go to the address you provide.

> ⚠️ With a custom endpoint, your Key and request contents are sent to that address — only use services you trust.

### 3. Blocking strength

| Mode | AI confidence threshold | Use case |
|------|------------------------|----------|
| Conservative | ≥ 95% | Minimal false positives; for accuracy-critical users |
| Standard | ≥ 80% | Balanced blocking vs. false positives (default) |
| Aggressive | ≥ 60% | Max blocking; may incur false positives |

### 4. Whitelist

- **Pause this page** — restores all blocked elements on the current page (not persisted).
- **Site whitelist** — adds the current domain to the whitelist; no AI blocking on any of its pages.

### 5. Subscriptions & custom rules

- Subscriptions: enter a name + rules URL (public list), click **Update all** to fetch the latest.
- Custom rules: domain rules (allow/block a whole domain) or CSS-selector rules (hide by selector).

## Privacy

- **API Key** — stored only in local `chrome.storage.local`, **never synced to a Google account**.
- **Data sent to AI** — only the visible text of **suspected ad elements** (max 500 chars, ad-keyword filtered) and structural features (tag / class / ad-link domain / image size, etc.).
- **Never sent** — cookies, full URL, page hostname, browsing history, or form / password / input values.
- **Local storage** — API Key, settings, whitelist (domains only), AI cache (stores *decision + text-hash fingerprint*; raw text is hashed, not persisted), domain rules, custom rules, and stats (counters only, no content).
- **Outbound requests** — only 3 kinds: DeepSeek ad judgment, DeepSeek connection test, subscription fetch. No analytics, no telemetry, no third-party exfiltration.
- On first enabling AI blocking, a modal clearly explains data usage and requires explicit consent.

> Honest note: "text" means the visible text of *suspected ad elements*. In an edge case where an element is misclassified as an ad yet contains user input (e.g. a comment containing the word "promotion"), that snippet would be sent to the AI. The probability is very low (guarded by the "ad-keyword + 500-char" filters), but it is not strictly 100% PII-free. We never proactively scrape form / password fields.

## Project structure

```
adguardian-ai/
├── manifest.json                 # Manifest V3 config (with default_locale)
├── _locales/                     # i18n message packs
│   ├── en/messages.json          # English
│   └── zh_CN/messages.json       # Chinese
├── rules/
│   └── default-rules.json        # declarativeNetRequest rule set
├── icons/                        # Extension icons (16/48/128px)
├── scripts/
│   └── generate-icons.js         # Icon generation script
├── src/
│   ├── background/
│   │   └── service-worker.js     # Background: rules, AI scheduling, cache, stats, context menu
│   ├── content/
│   │   ├── content-script.js     # Page script: DOM scan, candidate extraction, hiding, element picker
│   │   └── content-styles.css    # Hiding styles
│   ├── popup/
│   │   ├── popup.html / .js / .css  # Popup (block details / strength / whitelist)
│   ├── options/
│   │   ├── options.html / .js / .css # Options (API Key / strength / subscriptions / custom rules / stats)
│   └── lib/
│       ├── constants.js          # Global constants
│       ├── storage.js            # Storage manager
│       ├── ai-prompt.js          # AI prompt builder & parser
│       ├── rules-subscription.js # Subscription fetch & management
│       └── utils.js              # Utility functions
└── README.md
```

## Internationalization

The extension uses Chrome's native i18n (`_locales` + `default_locale: "en"`):

- Browser language is Chinese → shows Chinese (zh_CN)
- Browser language is non-Chinese → automatically falls back to English (en)

Static strings use `__MSG_key__` placeholders auto-substituted in HTML (no flicker); dynamically injected strings use `chrome.i18n.getMessage('key')`. No custom language-detection code is needed.

## Development & debugging

### Regenerate icons

```bash
node scripts/generate-icons.js
```

### Debug entry points

- **Service Worker**: `chrome://extensions/` → AdGuardian AI → "Service Worker" link
- **Content Script**: open any page → F12 → Console (logs prefixed with `[AdGuardian AI]`)
- **Popup**: right-click the toolbar icon → "Inspect popup"

### Add more rules

Edit `rules/default-rules.json` and append entries like:

```json
{
  "id": 31,
  "priority": 1,
  "action": { "type": "block" },
  "condition": {
    "urlFilter": "||example-ad-domain.com^",
    "resourceTypes": ["script", "image", "sub_frame", "xmlhttprequest"]
  }
}
```

## Known limitations

- Pre-roll video ads (YouTube / Bilibili, etc.) are planned for a later stage.
- Firefox / Safari unsupported (MVP is Chromium-only).
- Content Script does not run on internal pages such as `chrome://`.
- Some dynamically loaded ads may be detected only after full render (mitigated via MutationObserver).

## License

[MIT](#license) © 2026 leehe123

## Contributing

Issues and Pull Requests are welcome. Before submitting, please ensure:

1. Code passes `node --check` syntax validation;
2. New strings are synced to both `_locales/en` and `_locales/zh_CN`;
3. No analytics / telemetry / third-party data exfiltration is introduced.

---

## License

```
MIT License

Copyright (c) 2026 leehe123

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
