/**
 * AdGuardian AI - Content Script
 * 职责：DOM 扫描、候选广告元素提取、元素隐藏/移除、拦截统计上报
 *
 * 注意：Content script 不支持 ES module import，所有依赖内联
 */

(function () {
  'use strict';

  // ============================================================
  // 常量（从 constants.js 内联，因为 content script 不能 import）
  // ============================================================

  const AD_KEYWORDS = [
    'ad', 'ads', 'advert', 'adbox', 'ad-container', 'ad-wrapper', 'ad-slot',
    'banner', 'sponsor', 'sponsored', 'promo', 'promotion',
    'commercial', 'prbox', '推广', '广告', '赞助', '推广链接',
  ];

  // 广告图片常见尺寸（宽×高），允许 ±15% 误差
  const BANNER_SIZES = [
    [728, 90], [960, 80], [960, 90], [970, 90], [980, 120],
    [300, 250], [300, 200], [320, 50], [320, 100],
    [468, 60], [234, 60], [180, 150], [120, 240],
    [336, 280], [300, 600], [160, 600],
    // 新增：常见横幅尺寸
    [1000, 80], [1000, 90], [1024, 80], [1024, 90],
    [750, 80], [750, 90], [800, 80], [800, 90],
  ];

  // 懒惰加载图片常见 class 名
  const LAZY_CLASS_KEYWORDS = [
    'lazy', 'lazyload', 'lazysizes', 'blazy', 'unveil',
  ];

  // 广告 CDN / 域名关键词（出现在 img src / data-original 里）
  const AD_CDN_KEYWORDS = [
    'adserv', 'adserver', 'adimg', 'adpic', 'adbanner',
    'doubleclick', 'googlesyndication', 'adsystem',
    'adx', 'adnxs', 'criteo', 'taboola', 'outbrain',
    'buysellads', 'adroll', 'rfksyndication',
    // 中文广告联盟常见域名片段
    'union', 'adimg', 'adcreative', 'admaterial',
    // 新增：从用户案例中提取
    'ah7907', 'x545', 'alicdn', 'bdydns',
  ];

  const SEARCH_AD_LABELS = [
    '广告', '推广', '赞助商', 'AD', 'Sponsored', 'Ad', 'Promoted',
  ];

  const NATIVE_AD_LABELS = [
    '推广', '赞助', '广告', 'Sponsored', 'Promoted',
    '赞助内容', '品牌合作',
  ];

  const MSG_CANDIDATES_FOUND = 'CANDIDATES_FOUND';
  const MSG_AI_RESULT = 'AI_RESULT';
  const MSG_PAGE_LOADED = 'PAGE_LOADED';

  // i18n 助手：取当前浏览器语言文案，缺失时回退原文
  const t = (key) => (chrome.i18n && chrome.i18n.getMessage(key)) || key;
  const MSG_FALSE_POSITIVE = 'FALSE_POSITIVE';
  const MSG_GET_PAGE_STATS = 'GET_PAGE_STATS';
  const MSG_PAUSE_PAGE = 'PAUSE_PAGE';
  const MSG_PAUSE_SITE = 'PAUSE_SITE';

  // 被拦截元素的 data 属性前缀
  const HIDDEN_ATTR = 'data-adguardian-hidden';
  const ELEMENT_ID_ATTR = 'data-adguardian-id';

  // ============================================================
  // 状态
  // ============================================================

  let elementIdCounter = 0;
  let scanTimer = null;
  let isPaused = false;
  const blockedElementsMap = new Map(); // elementId -> { element, info }

  // ============================================================
  // 入口
  // ============================================================

  init();

  function init() {
    // 先应用自定义 selector 规则
    applyCustomSelectorRules();

    // 等页面空闲后开始扫描
    if (document.readyState === 'complete' || document.readyState === 'interactive') {
      scheduleScan();
    } else {
      window.addEventListener('DOMContentLoaded', scheduleScan);
    }

    // 监听 DOM 变化（动态加载的广告）
    observeDOM();

    // 监听来自 background 的消息
    chrome.runtime.onMessage.addListener(handleMessage);

    // 监听来自 picker 的消息
    window.addEventListener('message', handlePickerMessage);

    // 通知 background 页面已加载
    chrome.runtime.sendMessage({ type: MSG_PAGE_LOADED }).catch(() => {});

    // 注意：不在这里调用 startElementPicker()
    // 元素选择器只通过右键菜单（background → content script）触发
  }

  /** 应用用户自定义的 CSS selector 规则 */
  async function applyCustomSelectorRules() {
    try {
      const rules = await chrome.runtime.sendMessage({ type: MSG_GET_CUSTOM_RULES });
      if (!Array.isArray(rules)) return;
      const selectorRules = rules.filter(r => r.type === 'selector');
      for (const rule of selectorRules) {
        try {
          const els = document.querySelectorAll(rule.value);
          for (const el of els) {
            el.style.setProperty('display', 'none', 'important');
            el.setAttribute(HIDDEN_ATTR, 'custom-rule');
          }
        } catch {
          // 无效 selector，忽略
        }
      }
    } catch {
      // background 未就绪，忽略
    }
  }

  // ============================================================
  // DOM 扫描与候选提取
  // ============================================================

  function scheduleScan() {
    if (scanTimer) clearTimeout(scanTimer);
    scanTimer = setTimeout(scanAndReport, 800);
  }

  function scanAndReport() {
    if (isPaused) return;

    // 策略6（前置）：连续多个超长横幅 = 广告条带，直接删，不经过 AI
    findBannerCluster();

    const candidates = extractCandidates();
    if (candidates.length === 0) return;

    // 发送给 background 进行 AI 判定
    chrome.runtime.sendMessage({
      type: MSG_CANDIDATES_FOUND,
      candidates,
    }).catch(err => {
      // background 可能未就绪，忽略
    });
  }

  /** 从 DOM 提取疑似广告的候选元素 */
  function extractCandidates() {
    const candidates = [];
    const hostname = location.hostname;
    const pageType = detectPageType();

    // 策略1：class/id 含广告关键词的元素
    const keywordMatches = findElementsByKeywords();
    for (const el of keywordMatches) {
      if (isAlreadyProcessed(el)) continue;
      candidates.push(buildCandidate(el, hostname, pageType, 'keyword'));
    }

    // 策略2：搜索结果页带"广告"标签的条目
    if (pageType === 'search') {
      const searchAds = findSearchAds();
      for (const el of searchAds) {
        if (isAlreadyProcessed(el)) continue;
        candidates.push(buildCandidate(el, hostname, pageType, 'search_ad'));
      }
    }

    // 策略3：信息流中带"推广"标签的内容
    const nativeAds = findNativeAds();
    for (const el of nativeAds) {
      if (isAlreadyProcessed(el)) continue;
      candidates.push(buildCandidate(el, hostname, pageType, 'native_ad'));
    }

    // 策略4：第三方 iframe（非同源）
    const iframes = findAdIframes();
    for (const el of iframes) {
      if (isAlreadyProcessed(el)) continue;
      candidates.push(buildCandidate(el, hostname, pageType, 'iframe'));
    }

    // 策略5：广告图片（alt含广告词 / 来自广告CDN / banner尺寸）
    const bannerImgs = findBannerImages();
    for (const el of bannerImgs) {
      if (isAlreadyProcessed(el)) continue;
      candidates.push(buildCandidate(el, hostname, pageType, 'banner_img'));
    }

    return candidates.slice(0, 50); // 放宽至 50，策略5 会新增候选
  }

  /** 通过 class/id/alt/src 关键词查找 */
  function findElementsByKeywords() {
    const results = [];
    // 增加 img 标签；同时对 img 额外检查 alt、src、data-* 属性
    const allElements = document.querySelectorAll('div, section, aside, iframe, ins, nav, span, img, a, figure, figcaption');

    for (const el of allElements) {
      // 基础：检查 className + id
      const classId = `${el.className} ${el.id}`.toLowerCase();
      let matched = false;

      for (const keyword of AD_KEYWORDS) {
        const regex = new RegExp(`(^|[-_\\s])${escapeRegex(keyword)}([-_\\s]|$)`, 'i');
        if (classId && regex.test(classId)) {
          matched = true;
          break;
        }
      }

      // 对 img 标签额外检查 alt、src、data-original、data-src
      if (!matched && el.tagName === 'IMG') {
        const alt = (el.getAttribute('alt') || '').toLowerCase();
        const src = (el.getAttribute('src') || '').toLowerCase();
        const dataOriginal = (el.getAttribute('data-original') || '').toLowerCase();
        const dataSrc = (el.getAttribute('data-src') || '').toLowerCase();
        const checkText = `${alt} ${src} ${dataOriginal} ${dataSrc}`;

        for (const keyword of AD_KEYWORDS) {
          if (checkText.includes(keyword.toLowerCase())) {
            matched = true;
            break;
          }
        }
      }

      // 对 a / figure 标签检查内部文本是否含广告关键词（短文本广告链接）
      if (!matched && (el.tagName === 'A' || el.tagName === 'FIGURE' || el.tagName === 'FIGCAPTION')) {
        const text = (el.textContent || '').trim().toLowerCase();
        for (const keyword of AD_KEYWORDS) {
          if (text === keyword.toLowerCase() || text.startsWith(keyword.toLowerCase() + '：') || text.startsWith(keyword.toLowerCase() + ':')) {
            matched = true;
            break;
          }
        }
      }

      if (!matched) continue;

      // 排除过小或不可见的元素
      if (el.offsetWidth > 50 && el.offsetHeight > 30) {
        results.push(el);
      }
    }

    return results;
  }

  /** 搜索结果页广告 */
  function findSearchAds() {
    const results = [];
    const allElements = document.querySelectorAll('div, span, em, a, li');

    for (const el of allElements) {
      const text = (el.textContent || '').trim();
      if (text.length > 20) continue; // 标签通常很短

      for (const label of SEARCH_AD_LABELS) {
        if (text === label || (text.length < 10 && text.includes(label))) {
          // 找到广告标签后，向上找到包含整个广告条目的容器
          const adContainer = findAdContainer(el);
          if (adContainer && adContainer.offsetHeight > 50) {
            results.push(adContainer);
          }
          break;
        }
      }
    }

    return results;
  }

  /** 信息流/原生广告 */
  function findNativeAds() {
    const results = [];
    const allElements = document.querySelectorAll('div, span, a, em, i, label');

    for (const el of allElements) {
      const text = (el.textContent || '').trim();
      if (text.length > 15) continue;

      for (const label of NATIVE_AD_LABELS) {
        if (text === label || (text.length < 12 && text.includes(label))) {
          const adContainer = findAdContainer(el);
          if (adContainer && adContainer.offsetHeight > 80) {
            results.push(adContainer);
          }
          break;
        }
      }
    }

    return results;
  }

  /** 第三方广告 iframe */
  function findAdIframes() {
    const results = [];
    const iframes = document.querySelectorAll('iframe');

    for (const iframe of iframes) {
      const src = iframe.src || '';
      if (!src) continue;

      // 非同源 iframe
      try {
        const iframeUrl = new URL(src);
        if (iframeUrl.hostname !== location.hostname) {
          results.push(iframe);
        }
      } catch {
        // 无效 URL，跳过
      }
    }

    return results;
  }

  /** 广告图片检测：alt含广告词 / 来自广告CDN / banner尺寸 / 懒惰加载 */
  function findBannerImages() {
    const results = [];
    const allImgs = document.querySelectorAll('img');

    for (const img of allImgs) {
      if (isAlreadyProcessed(img)) continue;

      const alt = (img.getAttribute('alt') || '').trim();
      const src = (img.getAttribute('src') || '').toLowerCase();
      const dataOriginal = (img.getAttribute('data-original') || '').toLowerCase();
      const dataSrc = (img.getAttribute('data-src') || '').toLowerCase();
      const urlToCheck = src + ' ' + dataOriginal + ' ' + dataSrc;

      let matched = false;
      let matchReason = '';
      // 是否属于"强特征"广告（满足任一：CDN关键词命中 + 超长横幅比例 / 懒惰加载）
      // 强特征 = 无需经过 AI 判定，直接秒删
      let isStrongSignal = false;

      // 检查0：class 含懒惰加载关键词（如 lazy、lazyload）
      const imgClass = (img.className || '').toLowerCase();
      let isLazyClass = false;
      for (const kw of LAZY_CLASS_KEYWORDS) {
        if (imgClass.includes(kw)) {
          isLazyClass = true;
          break;
        }
      }

      // 检查1：alt 含广告关键词
      if (alt) {
        for (const kw of AD_KEYWORDS) {
          if (alt.includes(kw)) {
            matched = true;
            matchReason = 'alt-keyword';
            break;
          }
        }
      }

      // 检查2：src/data-original 含广告CDN关键词
      let hitCdn = false;
      if (!matched) {
        for (const kw of AD_CDN_KEYWORDS) {
          if (urlToCheck.includes(kw)) {
            matched = true;
            matchReason = 'cdn-keyword';
            hitCdn = true;
            break;
          }
        }
      }

      // 检查3：父元素含广告关键词（向上追溯3层）
      if (!matched) {
        let parent = img.parentElement;
        for (let i = 0; i < 4 && parent; i++, parent = parent.parentElement) {
          if (!parent) break;
          const parentClassId = `${parent.className} ${parent.id}`.toLowerCase();
          if (!parentClassId || parentClassId === 'nan') continue;
          for (const kw of AD_KEYWORDS) {
            const regex = new RegExp(`(^|[-_\\s])${escapeRegex(kw)}([-_\\s]|$)`, 'i');
            if (regex.test(parentClassId)) {
              matched = true;
              matchReason = 'parent-keyword';
              break;
            }
          }
          if (matched) break;
        }
      }

      // 检查4：banner 常见尺寸（改进：处理 width="100%" 的情况）
      let isBannerSize = false;
      if (!matched) {
        // 优先使用 naturalWidth/naturalHeight（图片实际尺寸）
        let w = img.naturalWidth || 0;
        let h = img.naturalHeight || 0;

        // 如果 naturalWidth 为 0（图片未加载），尝试从属性读取
        if (w === 0) {
          const attrW = img.getAttribute('width');
          if (attrW && !attrW.includes('%')) {
            w = parseInt(attrW) || 0;
          } else {
            // width 是百分比，使用 offsetWidth（渲染宽度）
            w = img.offsetWidth || 0;
          }
        }

        if (h === 0) {
          const attrH = img.getAttribute('height');
          if (attrH && !attrH.includes('%')) {
            h = parseInt(attrH) || 0;
          } else {
            h = img.offsetHeight || 0;
          }
        }

        if (w > 100 && h > 20) {
          for (const [bw, bh] of BANNER_SIZES) {
            const tolW = bw * 0.15;
            const tolH = bh * 0.15;
            if (Math.abs(w - bw) <= tolW && Math.abs(h - bh) <= tolH) {
              // 同时要求图片来自第三方CDN（非本域名）或图片有广告特征
              if (urlToCheck && !urlToCheck.includes(location.hostname)) {
                matched = true;
                matchReason = 'banner-size';
                isBannerSize = true;
                break;
              }
            }
          }
        }
      }

      if (!matched) continue;

      // ★ 强特征直删：满足以下任一强组合直接隐藏，不走 AI
      // 1. CDN 关键词命中 + 横幅尺寸（最稳：ah7907/双击广告联盟等）
      // 2. CDN 关键词命中 + 懒惰加载 class（中小联盟常用）
      // 3. 超长横幅（宽高比 > 8:1 + 宽 ≥ 400）单独出现也算
      if (hitCdn && (isBannerSize || isLazyClass)) {
        isStrongSignal = true;
      } else if (isLazyClass && hitCdn) {
        isStrongSignal = true;
      } else {
        // 检查图片尺寸：超长横幅（宽高比 > 8:1，宽 ≥ 400）= 广告
        const checkW = img.naturalWidth || img.offsetWidth || 0;
        const checkH = img.naturalHeight || img.offsetHeight || 0;
        if (checkW >= 400 && checkH > 10 && checkH < 150) {
          const ratio = checkW / checkH;
          if (ratio > 8 && (isLazyClass || hitCdn)) {
            isStrongSignal = true;
          }
        }
      }

      if (isStrongSignal) {
        // 直接隐藏，不走 AI
        img.setAttribute(HIDDEN_ATTR, 'banner-strong-signal');
        img.style.setProperty('display', 'none', 'important');
        img.style.setProperty('visibility', 'hidden', 'important');
        continue; // 不加入 candidates，避免重复发给 AI
      }

      // 弱特征：发给 AI 判定
      // 找到图片的容器（通常是整个广告条），向上找合适的容器
      const container = findAdContainer(img);
      results.push(container || img);
    }

    return results;
  }

  /**
   * 策略6：连续多个超长横幅 / 陌生链接集群 = 广告条带，直接删除
   *
   * 核心启发式规则：
   * - 场景A：超长横幅图（宽高比 > 8:1，宽 > 400px，高 < 150px）
   *   - 同一父容器内 ≥ 2 个 → 99.9% 是广告位
   * - 场景B：纯链接集群（同一容器内 ≥ 5 个 target="_blank"）
   *   - 链接 hostname 命中 "非主流知名站点" 白名单以外 → 99% 是广告位
   *   - 容器尺寸必须合理（高度 < 视口 1.5 倍）
   * - 直接隐藏整个容器（不经过 AI 判定）
   */
  function findBannerCluster() {
    // 场景A：超长横幅图片集群
    const hiddenByImages = findImgBannerCluster();
    // 场景B：陌生链接集群
    const hiddenByLinks = findBlankLinkCluster();
    const total = hiddenByImages + hiddenByLinks;
    if (total > 0) {
      console.log(`[AdGuardian AI] 🎯 集群检测：隐藏 ${hiddenByImages} 个横幅 + ${hiddenByLinks} 个链接集群`);
    }
  }

  /**
   * 场景A：超长横幅图片集群（原有逻辑）
   */
  function findImgBannerCluster() {
    const MIN_BANNERS_IN_CLUSTER = 2;   // 集群内最少几个 banner 才触发
    const ASPECT_RATIO_THRESHOLD = 8;    // 宽高比阈值（宽/高 > 8 视为超长）
    const MIN_WIDTH = 400;              // 最小宽度
    const MAX_HEIGHT = 150;             // 最大高度

    // 收集所有可见的 img 元素及其尺寸
    const allImgs = document.querySelectorAll('img');
    const bannerMap = new Map();        // parentId → [bannerElements]

    for (const img of allImgs) {
      // 集群检测：只跳过"已被隐藏"的元素，不跳过候选元素
      // 候选元素只是被打了 ID 标记，并不是真的隐藏，需要让集群检测能继续处理
      if (img.hasAttribute(HIDDEN_ATTR)) continue;

      // 使用 naturalWidth/naturalHeight 或 offsetWidth/offsetHeight
      let w = img.naturalWidth || img.offsetWidth || 0;
      let h = img.naturalHeight || img.offsetHeight || 0;

      // 处理 width="100%" 等百分比情况
      if (w === 0 || w === 100) {
        w = img.offsetWidth || parseInt(img.getAttribute('width')) || 0;
      }
      if (h === 0) {
        h = img.offsetHeight || parseInt(img.getAttribute('height')) || 0;
      }

      if (w < MIN_WIDTH || h < 10 || h > MAX_HEIGHT) continue;

      const ratio = w / h;
      if (ratio < ASPECT_RATIO_THRESHOLD) continue;

      // 这个图片是超长横幅，记录它的父容器
      const parent = img.parentElement;
      if (!parent) continue;

      // 避免误删页面主内容区
      if (parent.tagName === 'BODY' || parent.tagName === 'HTML') continue;

      if (!bannerMap.has(parent)) {
        bannerMap.set(parent, []);
      }
      bannerMap.get(parent).push({ el: img, w, h, ratio });
    }

    // 遍历每个容器，如果内有 ≥ N 个超长横幅，直接隐藏容器
    let hiddenCount = 0;
    for (const [parent, banners] of bannerMap) {
      if (banners.length < MIN_BANNERS_IN_CLUSTER) continue;

      // 额外安全检查：容器高度不应超过视口 1.5 倍
      const viewportHeight = window.innerHeight || document.documentElement.clientHeight;
      if (parent.offsetHeight > viewportHeight * 1.5) continue;

      // 隐藏整个容器（或逐个隐藏 banner）
      // 如果容器的子节点大部分都是 banner 图片，隐藏容器；否则只隐藏单个图片
      const totalChildren = parent.children.length;
      const bannerRatio = banners.length / totalChildren;

      if (bannerRatio >= 0.5) {
        // 容器一半以上都是 banner → 隐藏整个容器
        parent.setAttribute(HIDDEN_ATTR, 'banner-cluster');
        parent.style.setProperty('display', 'none', 'important');
        parent.style.setProperty('visibility', 'hidden', 'important');
        hiddenCount += banners.length;
      } else {
        // 只隐藏 banner 图片本身
        for (const { el } of banners) {
          el.setAttribute(HIDDEN_ATTR, 'banner-cluster-img');
          el.style.setProperty('display', 'none', 'important');
          el.style.setProperty('visibility', 'hidden', 'important');
          hiddenCount++;
        }
      }
    }

    if (hiddenCount > 0) {
      console.log(`[AdGuardian AI] 🎯 Banner 集群检测：直接隐藏 ${hiddenCount} 个超长横幅（连续堆叠广告）`);
    }
    return hiddenCount;
  }

  /**
   * 场景B：陌生链接集群（target="_blank" 推广墙）
   *
   * 启发式：
   * - 同一父容器（或祖父级）内 ≥ 5 个 target="_blank" 链接
   * - 链接 hostname 不在"已知常用站点"白名单内
   * - 容器高度 < 视口 1.5 倍（防误杀主内容）
   * - 链接的文本没有实质性内容（纯链接推广）
   */
  function findBlankLinkCluster() {
    // 已知主流站点白名单（这些链接不视为广告）
    const TRUSTED_DOMAINS = [
      // 搜索/门户
      'baidu.com', 'google.com', 'bing.com', 'so.com', 'sogou.com',
      'sina.com.cn', 'sohu.com', '163.com', 'qq.com', 'weibo.com',
      'douban.com', 'zhihu.com', 'bilibili.com', 'youtube.com',
      // 电商（避免误杀淘宝、京东等真实商品链接）
      'taobao.com', 'tmall.com', 'jd.com', 'pinduoduo.com', 'amazon.com',
      'amazonaws.com', 'amzn.to',
      // 社交
      'weixin.qq.com', 'wechat.com', 'qq.com', 'qzone.qq.com',
      'twitter.com', 'x.com', 'facebook.com', 'instagram.com', 't.me',
      // 工具
      'github.com', 'gitee.com', 'csdn.net', 'cnblogs.com', 'jianshu.com',
      'juejin.cn', 'segmentfault.com', 'oschina.net',
      // 政府/教育
      'gov.cn', 'edu.cn', 'moe.gov.cn',
      // 视频/媒体
      'youku.com', 'iqiyi.com', 'v.qq.com', 'mgtv.com', 'tv.sohu.com',
      // 站主自有域（避免误杀同站导航）
      location.hostname,
    ];

    const MIN_LINKS = 5;                    // 集群内最少链接数
    const MAX_CONTAINER_HEIGHT_RATIO = 1.5; // 容器高度上限（视口倍数）

    // 找出所有 target="_blank" 链接，按父容器分组
    const allBlankLinks = document.querySelectorAll('a[target="_blank"]');
    const parentMap = new Map(); // parentElement → [a elements]

    for (const a of allBlankLinks) {
      // 集群检测：只跳过"已被隐藏"的元素，不跳过候选元素
      // 候选元素只是被打了 ID 标记（extractCandidates 走过的元素），
      // 不是真的被隐藏，需要让集群检测能处理这些链接
      if (a.hasAttribute(HIDDEN_ATTR)) continue;

      // 必须有 href，且指向外站
      const href = a.getAttribute('href');
      if (!href || href.startsWith('#') || href.startsWith('javascript:')) continue;

      let hostname = '';
      try {
        hostname = new URL(href, location.href).hostname.toLowerCase();
      } catch {
        continue;
      }
      if (!hostname) continue;

      // 跳过同站链接（导航/侧边栏正常情况）
      if (hostname === location.hostname) continue;

      // 跳过白名单站点（真实商品/服务）
      const isTrusted = TRUSTED_DOMAINS.some(d => hostname === d || hostname.endsWith('.' + d));
      if (isTrusted) continue;

      // 找共同父容器（优先使用 a 的父元素）
      const parent = a.parentElement;
      if (!parent) continue;
      if (parent.tagName === 'BODY' || parent.tagName === 'HTML') continue;

      if (!parentMap.has(parent)) {
        parentMap.set(parent, []);
      }
      parentMap.get(parent).push(a);
    }

    // 遍历每个容器，链接数 ≥ MIN_LINKS 就隐藏整个容器
    let hiddenContainerCount = 0;
    const viewportHeight = window.innerHeight || document.documentElement.clientHeight;
    const maxContainerHeight = viewportHeight * MAX_CONTAINER_HEIGHT_RATIO;

    for (const [parent, links] of parentMap) {
      if (links.length < MIN_LINKS) continue;

      // 安全检查：容器高度不能太大
      if (parent.offsetHeight > maxContainerHeight) continue;
      if (parent.offsetHeight < 20) continue; // 太小也不太对劲

      // 再次确认：容器内大部分链接都命中"陌生外站"
      const allLinksInContainer = parent.querySelectorAll('a[target="_blank"]');
      let strangeCount = 0;
      for (const link of allLinksInContainer) {
        // 二次校验时也只看"被隐藏"的元素
        if (link.hasAttribute(HIDDEN_ATTR)) continue;
        const href = link.getAttribute('href');
        if (!href) continue;
        try {
          const h = new URL(href, location.href).hostname.toLowerCase();
          if (h && h !== location.hostname &&
              !TRUSTED_DOMAINS.some(d => h === d || h.endsWith('.' + d))) {
            strangeCount++;
          }
        } catch { /* ignore */ }
      }

      // 陌生链接数 ≥ MIN_LINKS 且占容器总链接 ≥ 60% → 视为广告墙
      const ratio = allLinksInContainer.length > 0
        ? strangeCount / allLinksInContainer.length
        : 0;
      if (strangeCount < MIN_LINKS || ratio < 0.6) continue;

      // 命中！直接隐藏整个容器
      parent.setAttribute(HIDDEN_ATTR, 'link-cluster');
      parent.style.setProperty('display', 'none', 'important');
      parent.style.setProperty('visibility', 'hidden', 'important');
      hiddenContainerCount++;
    }

    if (hiddenContainerCount > 0) {
      console.log(`[AdGuardian AI] 🎯 链接集群检测：隐藏 ${hiddenContainerCount} 个推广墙（陌生 target="_blank" 链接堆叠）`);
    }
    return hiddenContainerCount;
  }

  /** 从标签元素向上找到广告容器 */
  function findAdContainer(labelEl) {
    let current = labelEl;
    const viewportHeight = window.innerHeight || document.documentElement.clientHeight;
    const maxSafeHeight = Math.max(800, viewportHeight * 1.5); // 超过视口 1.5 倍视为风险容器

    for (let i = 0; i < 5; i++) {
      current = current.parentElement;
      if (!current) break;

      // 保护：到达主内容根节点立即停手，绝不隐藏整个页面骨架
      if (current.tagName === 'MAIN' ||
          current.tagName === 'BODY' ||
          current.tagName === 'HTML' ||
          current.id === 'app' || current.id === 'root' ||
          current.getAttribute('role') === 'main') {
        return labelEl.parentElement;
      }

      // 保护：容器高度超过安全上限（视口 1.5 倍），不要整体隐藏
      if (current.offsetHeight > maxSafeHeight) {
        return labelEl.parentElement;
      }

      // 容器应该比标签大很多
      if (current.offsetHeight > labelEl.offsetHeight * 3 &&
          current.offsetWidth > 200) {
        return current;
      }
    }
    return labelEl.parentElement;
  }

  /** 构建候选元素信息 */
  function buildCandidate(el, hostname, pageType, matchType) {
    const id = `ag-${++elementIdCounter}`;
    el.setAttribute(ELEMENT_ID_ATTR, id);

    const linkEl = el.querySelector('a[href]') || (el.tagName === 'A' ? el : null);
    let linkDomain = '';
    if (linkEl) {
      try {
        linkDomain = new URL(linkEl.href).hostname;
      } catch {
        linkDomain = '';
      }
    }

    // 对 img 标签，额外提取特征
    let imgFeatures = '';
    if (el.tagName === 'IMG') {
      const dataOriginal = el.getAttribute('data-original') || '';
      const dataSrc = el.getAttribute('data-src') || '';
      const imgClass = el.className || '';
      const naturalW = el.naturalWidth || 0;
      const naturalH = el.naturalHeight || 0;
      const offsetW = el.offsetWidth || 0;
      const offsetH = el.offsetHeight || 0;

      imgFeatures = [
        dataOriginal ? `data-original: ${dataOriginal}` : '',
        dataSrc ? `data-src: ${dataSrc}` : '',
        imgClass ? `class: ${imgClass}` : '',
        naturalW > 0 ? `natural-size: ${naturalW}x${naturalH}` : '',
        offsetW > 0 ? `render-size: ${offsetW}x${offsetH}` : '',
      ].filter(Boolean).join('; ');
    }

    return {
      elementId: id,
      selector: generateSelector(el),
      tagName: el.tagName.toLowerCase(),
      className: typeof el.className === 'string' ? el.className.slice(0, 200) : '',
      id: el.id || '',
      text: ((el.textContent || '') + ' ' + (el.getAttribute('alt') || '')).trim().slice(0, 500),
      linkDomain,
      hostname,
      pageType,
      matchType,
      rect: {
        width: el.offsetWidth,
        height: el.offsetHeight,
      },
      // 新增：img 标签的额外特征
      imgFeatures: imgFeatures || undefined,
    };
  }

  // ============================================================
  // 页面类型检测
  // ============================================================

  function detectPageType() {
    const url = location.href;
    const hostname = location.hostname;

    // 搜索引擎
    if (/google\.\w+\/search/.test(url) ||
        /baidu\.com\/s/.test(url) ||
        /bing\.com\/search/.test(url) ||
        /sogou\.com\/web/.test(url) ||
        /yandex\.com\/search/.test(url)) {
      return 'search';
    }

    // 视频平台
    if (/youtube\.com\/watch/.test(url) ||
        /bilibili\.com\/video/.test(url) ||
        /youku\.com\/v/.test(url)) {
      return 'video';
    }

    // 社交/信息流
    if (/weibo\.com/.test(hostname) ||
        /zhihu\.com/.test(hostname) ||
        /xiaohongshu\.com/.test(hostname) ||
        /toutiao\.com/.test(hostname) ||
        /facebook\.com/.test(hostname) ||
        /twitter\.com|x\.com/.test(hostname)) {
      return 'social';
    }

    // 新闻/文章
    const articleEl = document.querySelector('article');
    if (articleEl && articleEl.offsetHeight > 500) {
      return 'article';
    }

    return 'unknown';
  }

  // ============================================================
  // DOM 变化监听
  // ============================================================

  function observeDOM() {
    const observer = new MutationObserver((mutations) => {
      if (isPaused) return;

      let hasNewContent = false;
      for (const mutation of mutations) {
        if (mutation.addedNodes.length > 0) {
          hasNewContent = true;
          break;
        }
      }

      if (hasNewContent) {
        scheduleScan();
      }
    });

    // 只观察子节点新增，不观察属性变化（减少性能开销）
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: false,
      characterData: false,
    });
  }

  // ============================================================
  // 元素拦截/恢复
  // ============================================================

  /** 隐藏元素 */
  function hideElement(elementId, blockInfo) {
    const el = document.querySelector(`[${ELEMENT_ID_ATTR}="${elementId}"]`);
    if (!el) return;

    el.setAttribute(HIDDEN_ATTR, 'true');
    el.style.setProperty('display', 'none', 'important');
    el.style.setProperty('visibility', 'hidden', 'important');
    el.style.setProperty('opacity', '0', 'important');
    el.style.setProperty('height', '0', 'important');
    el.style.setProperty('overflow', 'hidden', 'important');

    blockedElementsMap.set(elementId, { element: el, info: blockInfo });
  }

  /** 恢复元素 */
  function restoreElement(elementId) {
    const entry = blockedElementsMap.get(elementId);
    if (!entry) return;

    const { element: el } = entry;
    el.removeAttribute(HIDDEN_ATTR);
    el.style.removeProperty('display');
    el.style.removeProperty('visibility');
    el.style.removeProperty('opacity');
    el.style.removeProperty('height');
    el.style.removeProperty('overflow');

    blockedElementsMap.delete(elementId);
  }

  /** 恢复所有元素 */
  function restoreAll() {
    for (const elementId of blockedElementsMap.keys()) {
      restoreElement(elementId);
    }
    isPaused = true;
  }

  // ============================================================
  // 消息处理
  // ============================================================

  function handleMessage(message, sender, sendResponse) {
    switch (message.type) {
      case MSG_AI_RESULT:
        handleAIResult(message.blockedElements);
        break;

      case 'RESTORE_ALL':
        restoreAll();
        break;

      case 'RESTORE_ELEMENT':
        if (message.elementId) {
          restoreElement(message.elementId);
        }
        break;

      case 'START_ELEMENT_PICKER':
        startElementPicker();
        sendResponse({ success: true });
        return true;
    }
    return true;
  }

  /** 处理 AI 拦截结果 */
  function handleAIResult(blockedElements) {
    for (const block of blockedElements) {
      hideElement(block.elementId, block);
    }
  }

  // ============================================================
  // 工具函数
  // ============================================================

  function isAlreadyProcessed(el) {
    return el.hasAttribute(HIDDEN_ATTR) || el.hasAttribute(ELEMENT_ID_ATTR);
  }

  function generateSelector(el) {
    if (el.id) {
      return `#${CSS.escape(el.id)}`;
    }

    const parts = [];
    let current = el;
    while (current && current !== document.body) {
      let selector = current.tagName.toLowerCase();
      if (current.className && typeof current.className === 'string') {
        const classes = current.className.trim().split(/\s+/).slice(0, 3);
        if (classes.length > 0) {
          selector += '.' + classes.map(CSS.escape).join('.');
        }
      }
      const parent = current.parentElement;
      if (parent) {
        const siblings = Array.from(parent.children).filter(c => c.tagName === current.tagName);
        if (siblings.length > 1) {
          const index = siblings.indexOf(current) + 1;
          selector += `:nth-of-type(${index})`;
        }
      }
      parts.unshift(selector);
      current = current.parentElement;
    }

    return parts.join(' > ');
  }

  function escapeRegex(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function textHashLocal(text) {
    if (!text) return '';
    let hash = 0;
    for (let i = 0; i < text.length; i++) {
      hash = ((hash << 5) - hash) + text.charCodeAt(i);
      hash = hash & 0xFFFFFFFF;
    }
    return Math.abs(hash).toString(36);
  }

  // ============================================================
  // 误杀反馈（通过 popup 触发）
  // ============================================================

  // 暴露给 popup 通过 chrome.tabs.sendMessage 调用
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'GET_BLOCKED_ELEMENTS') {
      const elements = [];
      for (const [id, entry] of blockedElementsMap) {
        elements.push({
          elementId: id,
          selector: entry.info?.selector || '',
          reason: entry.info?.reason || '',
          source: entry.info?.source || '',
          adType: entry.info?.ad_type || '',
          confidence: entry.info?.confidence || 0,
        });
      }
      sendResponse({ elements });
      return true;
    }

    if (message.type === 'REPORT_FALSE_POSITIVE') {
      const { elementId } = message;
      const entry = blockedElementsMap.get(elementId);
      if (entry) {
        const selector = entry.info?.selector || '';
        const fingerprint = textHashLocal(selector + location.hostname);
        restoreElement(elementId);

        // 通知 background 记录误杀
        chrome.runtime.sendMessage({
          type: MSG_FALSE_POSITIVE,
          fingerprint,
          selector,
        }).catch(() => {});
      }
      sendResponse({ success: true });
      return true;
    }
  });

  // ============================================================
  // 元素选择器（右键屏蔽此元素）
  // ============================================================

  let pickerActive = false;
  let pickerOverlay = null;
  let pickerHighlight = null;
  let pickerUI = null;
  let selectedElement = null;
  let selectedSelector = '';

  /** 启动元素选择器 */
  function startElementPicker() {
    if (pickerActive) return;
    pickerActive = true;

    // 创建高亮层
    pickerHighlight = document.createElement('div');
    pickerHighlight.id = 'adguardian-picker-highlight';
    pickerHighlight.style.cssText = `
      position: fixed;
      pointer-events: none;
      z-index: 2147483647;
      background: rgba(255, 0, 0, 0.2);
      border: 2px solid #ff0000;
      border-radius: 2px;
      display: none;
    `;
    document.body.appendChild(pickerHighlight);

    // 创建操作提示
    const pickerTip = document.createElement('div');
    pickerTip.id = 'adguardian-picker-tip';
    pickerTip.style.cssText = `
      position: fixed;
      top: 10px;
      left: 50%;
      transform: translateX(-50%);
      z-index: 2147483647;
      background: #333;
      color: #fff;
      padding: 8px 16px;
      border-radius: 6px;
      font-size: 13px;
      font-family: sans-serif;
      box-shadow: 0 2px 8px rgba(0,0,0,0.3);
    `;
    pickerTip.textContent = t('picker_tip');
    document.body.appendChild(pickerTip);

    // 鼠标移动：高亮元素
    document.addEventListener('mousemove', pickerOnMouseMove, true);
    document.addEventListener('click', pickerOnClick, true);
    document.addEventListener('keydown', pickerOnKeyDown, true);

    // 初始高亮
    pickerTip.style.display = 'block';
  }

  /** 鼠标移动：高亮当前元素 */
  function pickerOnMouseMove(e) {
    if (!pickerActive) return;

    const el = document.elementFromPoint(e.clientX, e.clientY);
    if (!el || el.id === 'adguardian-picker-highlight' || el.id === 'adguardian-picker-tip' || el.id === 'adguardian-picker-ui') {
      pickerHighlight.style.display = 'none';
      return;
    }

    const rect = el.getBoundingClientRect();
    pickerHighlight.style.display = 'block';
    pickerHighlight.style.left = `${rect.left + window.scrollX}px`;
    pickerHighlight.style.top = `${rect.top + window.scrollY}px`;
    pickerHighlight.style.width = `${rect.width}px`;
    pickerHighlight.style.height = `${rect.height}px`;

    e.preventDefault();
    e.stopPropagation();
  }

  /** 点击元素：生成选择器并显示预览 */
  function pickerOnClick(e) {
    if (!pickerActive) return;

    e.preventDefault();
    e.stopPropagation();

    const el = document.elementFromPoint(e.clientX, e.clientY);
    if (!el || el.id === 'adguardian-picker-highlight' || el.id === 'adguardian-picker-tip' || el.id === 'adguardian-picker-ui') {
      return;
    }

    selectedElement = el;
    selectedSelector = generateUniqueSelector(el);

    // 预览：隐藏该元素
    el.style.setProperty('outline', '3px dashed #ff0000', 'important');
    el.style.setProperty('opacity', '0.3', 'important');

    // 显示确认 UI
    showPickerUI(el);

    // 移除高亮层
    pickerHighlight.style.display = 'none';
  }

  /** 显示确认 UI */
  function showPickerUI(el) {
    // 移除旧 UI
    if (pickerUI) pickerUI.remove();

    pickerUI = document.createElement('div');
    pickerUI.id = 'adguardian-picker-ui';
    pickerUI.style.cssText = `
      position: fixed;
      z-index: 2147483647;
      background: #fff;
      border: 1px solid #ccc;
      border-radius: 8px;
      padding: 14px;
      box-shadow: 0 4px 16px rgba(0,0,0,0.3);
      font-family: sans-serif;
      font-size: 13px;
      max-width: 400px;
      min-width: 280px;
    `;

    // 定位在元素附近
    const rect = el.getBoundingClientRect();
    let left = rect.left + window.scrollX;
    let top = rect.bottom + window.scrollY + 10;
    if (left + 400 > window.innerWidth) left = window.innerWidth - 420;
    if (top + 200 > window.innerHeight + window.scrollY) top = rect.top + window.scrollY - 210;
    pickerUI.style.left = `${Math.max(10, left)}px`;
    pickerUI.style.top = `${Math.max(10, top)}px`;

    pickerUI.innerHTML = `
      <div style="font-weight: 600; margin-bottom: 8px; color: #333;">${t('picker_block_title')}</div>
      <div style="color: #666; margin-bottom: 10px; font-size: 12px; word-break: break-all;">${escapeHtml(selectedSelector)}</div>
      <div style="display: flex; gap: 8px; justify-content: flex-end;">
        <button id="picker-cancel" style="padding: 6px 14px; border: 1px solid #ccc; border-radius: 4px; background: #fff; cursor: pointer; font-size: 13px;">${t('picker_cancel')}</button>
        <button id="picker-confirm" style="padding: 6px 14px; border: none; border-radius: 4px; background: #1d9e75; color: #fff; cursor: pointer; font-size: 13px;">${t('picker_confirm')}</button>
      </div>
    `;

    document.body.appendChild(pickerUI);

    // 绑定按钮事件
    pickerUI.querySelector('#picker-cancel').addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      cancelPicker();
    }, true);

    pickerUI.querySelector('#picker-confirm').addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      confirmPicker();
    }, true);
  }

  /** 确认屏蔽：保存规则 */
  async function confirmPicker() {
    if (!selectedSelector) return;

    try {
      const result = await chrome.runtime.sendMessage({
        type: 'ADD_SELECTOR_RULE',
        selector: selectedSelector,
        comment: `右键屏蔽 ${location.hostname}`,
      });

      if (result.success) {
        // 立即应用规则
        selectedElement.style.setProperty('display', 'none', 'important');
        selectedElement.removeAttribute('style');
      }
    } catch (err) {
      console.warn('[AdGuardian AI] 保存规则失败:', err.message);
    }

    exitPicker();
  }

  /** 取消选择 */
  function cancelPicker() {
    if (selectedElement) {
      selectedElement.removeAttribute('style');
    }
    exitPicker();
  }

  /** 退出选择器模式 */
  function exitPicker() {
    pickerActive = false;

    // 移除事件监听
    document.removeEventListener('mousemove', pickerOnMouseMove, true);
    document.removeEventListener('click', pickerOnClick, true);
    document.removeEventListener('keydown', pickerOnKeyDown, true);

    // 移除 UI
    if (pickerHighlight) { pickerHighlight.remove(); pickerHighlight = null; }
    if (pickerUI) { pickerUI.remove(); pickerUI = null; }
    const tip = document.getElementById('adguardian-picker-tip');
    if (tip) tip.remove();

    selectedElement = null;
    selectedSelector = '';
  }

  /** ESC 键退出 */
  function pickerOnKeyDown(e) {
    if (e.key === 'Escape') {
      if (pickerUI) {
        cancelPicker();
      } else {
        exitPicker();
      }
    }
  }

  /** 生成唯一 CSS 选择器 */
  function generateUniqueSelector(el) {
    if (el.id) {
      return `#${CSS.escape(el.id)}`;
    }

    // 尝试用 class + tag 组合
    if (el.className && typeof el.className === 'string') {
      const classes = el.className.trim().split(/\s+/);
      if (classes.length > 0) {
        const selector = `${el.tagName.toLowerCase()}.${classes.map(c => CSS.escape(c)).join('.')}`;
        if (document.querySelectorAll(selector).length === 1) {
          return selector;
        }
      }
    }

    // 回退：生成路径选择器
    const parts = [];
    let current = el;
    while (current && current !== document.body) {
      let selector = current.tagName.toLowerCase();
      if (current.className && typeof current.className === 'string') {
        const classes = current.className.trim().split(/\s+/).slice(0, 2);
        if (classes.length > 0) {
          selector += '.' + classes.map(CSS.escape).join('.');
        }
      }
      const parent = current.parentElement;
      if (parent) {
        const siblings = Array.from(parent.children).filter(c => c.tagName === current.tagName);
        if (siblings.length > 1) {
          const index = siblings.indexOf(current) + 1;
          selector += `:nth-of-type(${index})`;
        }
      }
      parts.unshift(selector);
      current = current.parentElement;
    }

    return parts.join(' > ');
  }

})();
