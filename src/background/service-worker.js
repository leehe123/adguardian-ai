/**
 * AdGuardian AI - Background Service Worker
 * 职责：规则引擎管理、AI 调度（批量/缓存/降级）、消息通信、统计
 */

import {
  DEEPSEEK_API,
  AI_SCHEDULER,
  STRENGTH_THRESHOLD,
  STORAGE_KEYS,
  MSG_TYPE,
  BLOCK_SOURCE,
} from '../lib/constants.js';
import {
  getSettings,
  getApiKey,
  setApiKey,
  addToWhitelist,
  isWhitelisted,
  batchGetCache,
  batchSetCache,
  clearCache,
  getStats,
  updateStats,
  resetStats,
  getCache,
  setCache,
  makeFingerprint,
  addFalsePositive,
  isFalsePositive,
  getDomainRules,
  addDomainRule,
  clearDomainRules,
  getDomainRulesStats,
  removeDomainRuleBySelector,
  getCustomRules,
  buildDynamicRules,
  getExistingDynamicRuleIds,
} from '../lib/storage.js';
import { buildPrompt, parseAIResponse, extractFeatures, textHash } from '../lib/ai-prompt.js';

import {
  getSubscriptions,
  updateSubscription,
  updateAllSubscriptions,
  checkAndUpdateSubscriptions,
  toggleSubscription,
  addCustomSubscription,
  removeSubscription,
  rebuildSubscriptionDynamicRules,
  getAllSubscriptionElementHideRules,
} from '../lib/rules-subscription.js';

// i18n 助手：取当前浏览器语言文案，缺失时回退原文
const t = (key) => chrome.i18n.getMessage(key) || key;

// ============================================================
// 1. 初始化
// ============================================================

/** 启动时加载自定义规则到 dynamicRules */
async function loadCustomRulesToDynamic() {
  try {
    const existingIds = await getExistingDynamicRuleIds();
    const { add } = await buildDynamicRules();
    if (existingIds.length > 0) {
      await chrome.declarativeNetRequest.updateDynamicRules({
        removeRuleIds: existingIds,
      });
    }
    if (add.length > 0) {
      await chrome.declarativeNetRequest.updateDynamicRules({ add });
      console.log(`[AdGuardian AI] 已加载 ${add.length} 条自定义规则到动态规则`);
    }
  } catch (err) {
    console.error('[AdGuardian AI] 加载自定义规则失败:', err.message);
  }
}

chrome.runtime.onInstalled.addListener(async () => {
  console.log('[AdGuardian AI] 插件已安装');
  await loadCustomRulesToDynamic();
  await rebuildSubscriptionDynamicRules();

  // 创建右键菜单
  chrome.contextMenus.create({
    id: 'toggle-ai-block',
    title: chrome.i18n.getMessage('menu_toggle_ai'),
    contexts: ['page'],
  });

  chrome.contextMenus.create({
    id: 'block-element',
    title: chrome.i18n.getMessage('menu_block_element'),
    contexts: ['page'],
  });

  // 设置定期更新订阅的闹钟
  chrome.alarms.create('update-subscriptions', {
    delayInMinutes: 5, // 安装后5分钟首次更新
    periodInMinutes: 24 * 60, // 每24小时更新一次
  });

  // 首次更新订阅
  updateAllSubscriptions().catch(err => {
    console.warn('[AdGuardian AI] 首次更新订阅失败:', err.message);
  });
});

// 每次 SW 启动时也加载（MV3 SW 会被休眠后重启）
// 用 Promise.resolve().then 包裹 try/catch，避免启动时抛错导致 SW 整体失败
loadCustomRulesToDynamic().catch(err => {
  console.warn('[AdGuardian AI] 加载自定义规则失败:', err.message);
});
rebuildSubscriptionDynamicRules().catch(err => {
  console.warn('[AdGuardian AI] 加载订阅规则失败:', err.message);
});

// ============================================================
// 2. 消息路由
// ============================================================

// ============================================================
// 2. 消息路由
// ============================================================

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handle(message, sender).then(sendResponse).catch(err => {
    console.error('[AdGuardian AI] 消息处理错误:', err);
    sendResponse({ error: err.message });
  });
  return true; // 异步响应
});

async function handle(message, sender) {
  const tabId = sender.tab?.id;
  const tabUrl = sender.tab?.url;

  switch (message.type) {
    case MSG_TYPE.PAGE_LOADED:
      await updateStats({ pagesScanned: 1 });
      return { ok: true };

    case MSG_TYPE.CANDIDATES_FOUND:
      return await handleCandidates(message.candidates, tabId, tabUrl);

    case MSG_TYPE.GET_PAGE_STATS:
      return await getPageStats(message.tabId || tabId);

    case MSG_TYPE.FALSE_POSITIVE:
      return await handleFalsePositive(message, tabId);

    case MSG_TYPE.PAUSE_PAGE:
      return await pausePage(tabId);

    case MSG_TYPE.PAUSE_SITE:
      return await pauseSite(tabUrl);

    case MSG_TYPE.TEST_API_KEY:
      return await testApiKey(message.apiKey);

    case MSG_TYPE.GET_SETTINGS:
      return await getSettings();

    case MSG_TYPE.SAVE_SETTINGS:
      return await saveSettings(message.settings);

    case MSG_TYPE.CLEAR_CACHE:
      await clearCache();
      return { success: true };

    case MSG_TYPE.GET_STATS:
      return await getStats();

    case MSG_TYPE.RESET_STATS:
      await resetStats();
      return { success: true };

    case MSG_TYPE.GET_DOMAIN_RULES_STATS:
      return await getDomainRulesStats();

    case MSG_TYPE.CLEAR_DOMAIN_RULES:
      await clearDomainRules();
      return { success: true };

    // ============================================================
    // 自定义规则
    // ============================================================
    case MSG_TYPE.GET_CUSTOM_RULES: {
      return await getCustomRules();
    }

    case MSG_TYPE.ADD_CUSTOM_RULE: {
      const { type, value, comment } = message;
      const entry = await addCustomRule(type, value, comment);
      // 刷新 dynamicRules
      const existingIds = await getExistingDynamicRuleIds();
      const { add } = await buildDynamicRules();
      await chrome.declarativeNetRequest.updateDynamicRules({
        removeRuleIds: existingIds,
        add,
      });
      return { success: true, rule: entry };
    }

    case MSG_TYPE.REMOVE_CUSTOM_RULE: {
      const removed = await removeCustomRule(message.ruleId);
      // 刷新 dynamicRules
      const existingIds = await getExistingDynamicRuleIds();
      const { add } = await buildDynamicRules();
      await chrome.declarativeNetRequest.updateDynamicRules({
        removeRuleIds: existingIds,
        add,
      });
      return { success: removed };
    }

    case MSG_TYPE.CLEAR_CUSTOM_RULES: {
      await clearCustomRules();
      const existingIds = await getExistingDynamicRuleIds();
      if (existingIds.length > 0) {
        await chrome.declarativeNetRequest.updateDynamicRules({
          removeRuleIds: existingIds,
        });
      }
      return { success: true };
    }

    // ============================================================
    // 规则订阅
    // ============================================================
    case 'GET_SUBSCRIPTIONS': {
      return await getSubscriptions();
    }

    case 'UPDATE_SUBSCRIPTION': {
      return await updateSubscription(message.subscriptionId);
    }

    case 'UPDATE_ALL_SUBSCRIPTIONS': {
      return await updateAllSubscriptions();
    }

    case 'TOGGLE_SUBSCRIPTION': {
      await toggleSubscription(message.subscriptionId, message.enabled);
      return { success: true };
    }

    case 'ADD_CUSTOM_SUBSCRIPTION': {
      return await addCustomSubscription(message.name, message.url);
    }

    case 'REMOVE_SUBSCRIPTION': {
      await removeSubscription(message.subscriptionId);
      return { success: true };
    }

    // ============================================================
    // 元素选择器（右键屏蔽此元素）
    // ============================================================
    case 'START_ELEMENT_PICKER': {
      if (tabId) {
        try {
          await chrome.tabs.sendMessage(tabId, {
            type: 'START_ELEMENT_PICKER',
          });
          return { success: true };
        } catch (err) {
          return { success: false, error: err.message };
        }
      }
      return { success: false, error: t('err_no_valid_tab') };
    }

    case 'ADD_SELECTOR_RULE': {
      const { selector, comment } = message;
      const entry = await addCustomRule('selector', selector, comment || '右键屏蔽');
      // 刷新动态规则（虽然 selector 规则是 content script 处理的，但保持一致性）
      const existingIds2 = await getExistingDynamicRuleIds();
      const { add: add2 } = await buildDynamicRules();
      await chrome.declarativeNetRequest.updateDynamicRules({
        removeRuleIds: existingIds2,
        add: add2,
      });
      return { success: true, rule: entry };
    }

    default:
      return { error: t('err_unknown_msg') };
  }
}

// ============================================================
// 3. AI 调度核心
// ============================================================

/** 批量处理候选元素（域名规则 → 指纹缓存 → AI，三层渐进） */
async function handleCandidates(candidates, tabId, tabUrl) {
  if (!candidates || candidates.length === 0) {
    return { blocked: 0 };
  }

  const settings = await getSettings();

  // 白名单检查
  let hostname = '';
  if (tabUrl) {
    try { hostname = new URL(tabUrl).hostname; } catch {}
    if (hostname && await isWhitelisted(hostname)) {
      return { blocked: 0, reason: 'whitelisted' };
    }
  }

  // AI 未启用
  if (!settings.aiEnabled || !settings.apiKey) {
    return { blocked: 0, reason: 'ai_disabled' };
  }

  const threshold = STRENGTH_THRESHOLD[settings.strength] || 0.8;
  const now = Date.now();

  // ============================================================
  // 第1层：域名规则库（按域名直接匹配 selector）
  // ============================================================
  let domainRulesHitCount = 0;
  const domainBlocked = [];
  const remainingCandidates = [];

  if (hostname) {
    const domainEntry = await getDomainRules(hostname);
    if (domainEntry && domainEntry.rules && domainEntry.rules.length > 0) {
      const domainRules = domainEntry.rules;
      for (const candidate of candidates) {
        const matchedRule = domainRules.find(r => r.selector === candidate.selector);
        if (matchedRule && matchedRule.confidence >= threshold) {
          domainBlocked.push({
            elementId: candidate.elementId,
            selector: candidate.selector,
            source: BLOCK_SOURCE.DOMAIN_RULE,
            reason: matchedRule.reason || '域名规则库命中',
            adType: matchedRule.adType || '',
            confidence: matchedRule.confidence || 0.8,
          });
          domainRulesHitCount++;
        } else {
          remainingCandidates.push(candidate);
        }
      }
    } else {
      remainingCandidates.push(...candidates);
    }
  } else {
    remainingCandidates.push(...candidates);
  }

  // ============================================================
  // 第2层：指纹缓存（跨域名，基于元素特征指纹）
  // ============================================================
  let cacheHitCount = 0;
  const cachedBlocked = [];
  const toAI = [];

  const enrichedRemaining = remainingCandidates.map(c => ({
    ...c,
    fingerprint: makeFingerprint({
      hostname: c.hostname || '',
      tagClass: `${c.tagName}.${c.className}`.slice(0, 200),
      textHash: textHash((c.text || '').slice(0, 300)),
      linkDomain: c.linkDomain || '',
    }),
  }));

  const fingerprints = enrichedRemaining.map(c => c.fingerprint);
  const cached = await batchGetCache(fingerprints);

  for (const candidate of enrichedRemaining) {
    if (await isFalsePositive(candidate.fingerprint)) continue;

    if (cached[candidate.fingerprint]) {
      const decision = cached[candidate.fingerprint];
      if (decision.is_ad && decision.confidence >= threshold) {
        cachedBlocked.push({
          elementId: candidate.elementId,
          selector: candidate.selector,
          source: BLOCK_SOURCE.CACHE,
          reason: decision.reason || '缓存命中',
          adType: decision.ad_type || '',
          confidence: decision.confidence || 0,
        });
        cacheHitCount++;
      }
      continue;
    }
    // 限制 toAI 数组长度，防止一次发送过多请求到 DeepSeek API
    if (toAI.length >= 50) {
      console.log(`[AdGuardian AI] 候选元素已达 50 条上限，截断剩余 ${enrichedRemaining.length - i} 条`);
      break;
    }
    toAI.push(candidate);
  }

  // ============================================================
  // 第3层：调用 AI API
  // ============================================================
  const aiBlocked = [];

  if (toAI.length > 0) {
    const batches = chunkArray(toAI, AI_SCHEDULER.MAX_BATCH_SIZE);
    let allAIResults = [];

    for (const batch of batches) {
      try {
        const batchResults = await callDeepSeekAPI(batch, settings.apiKey);
        allAIResults.push(...batchResults);
      } catch (err) {
        console.error('[AdGuardian AI] API 调用失败，降级:', err.message);
        break;
      }
    }

    for (const { candidate, decision } of allAIResults) {
      if (!decision) continue;

      // 写入指纹缓存
      await setCache(candidate.fingerprint, {
        is_ad: decision.is_ad,
        confidence: decision.confidence,
        reason: decision.reason,
        ad_type: decision.ad_type,
      });

      if (decision.is_ad && decision.confidence >= threshold) {
        aiBlocked.push({
          elementId: candidate.elementId,
          selector: candidate.selector,
          source: BLOCK_SOURCE.AI,
          reason: decision.reason || '',
          adType: decision.ad_type || '',
          confidence: decision.confidence || 0,
        });

        // 写回域名规则库
        if (hostname) {
          await addDomainRule(hostname, {
            selector: candidate.selector,
            reason: decision.reason || '',
            adType: decision.ad_type || '',
            confidence: decision.confidence || 0,
          });
        }
      }
    }
  }

  // ============================================================
  // 汇总结果，通知 content script
  // ============================================================
  const allBlocked = [...domainBlocked, ...cachedBlocked, ...aiBlocked];
  const domainRulesHits = domainRulesHitCount;
  const cacheHits = cacheHitCount;
  const aiBlocks = aiBlocked.length;
  const aiCalls = toAI.length > 0 ? Math.ceil(toAI.length / AI_SCHEDULER.MAX_BATCH_SIZE) : 0;

  await updateStats({ aiBlocks, aiCalls, cacheHits, domainRulesHits });

  // 记录到 tabBlockLogs（供 popup 显示明细）
  if (tabId && allBlocked.length > 0) {
    for (const block of allBlocked) {
      recordBlock(tabId, {
        source: block.source,
        selector: block.selector,
        reason: block.reason,
        adType: block.adType,
        confidence: block.confidence,
      });
    }
  }

  if (tabId && allBlocked.length > 0) {
    try {
      await chrome.tabs.sendMessage(tabId, {
        type: MSG_TYPE.AI_RESULT,
        blockedElements: allBlocked,
      });
    } catch (err) {}
  }

  return { blocked: allBlocked.length, domainRulesHits, cacheHits, aiCalls };
}

// ============================================================
// 4. DeepSeek API 调用
// ============================================================

async function callDeepSeekAPI(candidates, apiKey) {
  // 读取用户自定义 API 配置（Nit #7：可从设置页覆盖默认值）
  const settings = await getSettings();
  const apiUrl = (settings[API_CONFIG_KEYS.API_URL] || '').trim();
  const apiModel = (settings[API_CONFIG_KEYS.API_MODEL] || '').trim();
  const apiTimeout = parseInt(settings[API_CONFIG_KEYS.API_TIMEOUT], 10) || DEEPSEEK_API.TIMEOUT_MS;

  const features = candidates.map(c => extractFeatures({
    tagName: c.tagName,
    className: c.className,
    text: c.text,
    linkDomain: c.linkDomain,
    pageType: c.pageType,
  }));

  const prompt = buildPrompt(features);

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), apiTimeout);

  let response;
  try {
    response = await fetch(apiUrl || DEEPSEEK_API.BASE_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: apiModel || DEEPSEEK_API.MODEL,
        messages: [
          { role: 'system', content: '你是广告识别专家，只返回JSON格式结果。' },
          { role: 'user', content: prompt },
        ],
        max_tokens: DEEPSEEK_API.MAX_TOKENS,
        temperature: DEEPSEEK_API.TEMPERATURE,
        stream: false,
      }),
      signal: controller.signal,
    });
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error(t('err_api_timeout'));
    }
    throw new Error(t('err_api_network') + err.message);
  } finally {
    clearTimeout(timeoutId);
  }

  if (!response.ok) {
    const errorBody = await response.text().catch(() => '');
    throw new Error(t('err_api_status').replace('{status}', response.status).replace('{body}', errorBody.slice(0, 200)));
  }

  const data = await response.json();
  const content = data.choices?.[0]?.message?.content;
  const parsed = parseAIResponse(content);

  if (!parsed) {
    console.warn('[AdGuardian AI] 无法解析 AI 返回:', content);
    return [];
  }

  // 将结果与候选元素对齐
  return parsed.map(item => {
    const candidate = candidates[item.index - 1];
    if (!candidate) return null;
    return {
      candidate,
      decision: {
        is_ad: item.is_ad,
        confidence: item.confidence,
        reason: item.reason,
        ad_type: item.ad_type,
      },
      source: 'ai',
    };
  }).filter(Boolean);
}

// ============================================================
// 5. 页面统计
// ============================================================

// 按标签页存储拦截记录（内存中，非持久化）
const tabBlockLogs = new Map();

function recordBlock(tabId, blockInfo) {
  if (!tabBlockLogs.has(tabId)) {
    tabBlockLogs.set(tabId, []);
  }
  tabBlockLogs.get(tabId).push(blockInfo);
}

async function getPageStats(tabId) {
  const logs = tabBlockLogs.get(tabId) || [];
  const ruleBlocks = logs.filter(l => l.source === BLOCK_SOURCE.RULE).length;
  const aiBlocks = logs.filter(l => l.source === BLOCK_SOURCE.AI).length;

  return {
    ruleBlocks,
    aiBlocks,
    total: logs.length,
    details: logs.slice(-50), // 最近 50 条
  };
}

// 标签页关闭时清理
chrome.tabs.onRemoved.addListener(tabId => {
  tabBlockLogs.delete(tabId);
});

// 记录 declarativeNetRequest 拦截
chrome.declarativeNetRequest.onRuleMatchedDebug.addListener(async (info) => {
  const tabId = info.request.tabId;
  if (tabId < 0) return;

  const blockInfo = {
    source: BLOCK_SOURCE.RULE,
    url: info.request.url,
    type: info.request.type,
    timestamp: Date.now(),
  };
  recordBlock(tabId, blockInfo);
  await updateStats({ ruleBlocks: 1 });
});

// ============================================================
// 6. 误杀与暂停
// ============================================================

async function handleFalsePositive(message, tabId) {
  const { fingerprint, selector } = message;
  await addFalsePositive(fingerprint, selector);
  await updateStats({ falsePositives: 1 });

  // 从当前页拦截记录中移除
  const logs = tabBlockLogs.get(tabId) || [];
  const filtered = logs.filter(l => l.selector !== selector);
  tabBlockLogs.set(tabId, filtered);

  // 同时从域名规则库清除该 selector（避免下次再误杀）
  if (tabId != null) {
    try {
      const tab = await chrome.tabs.get(tabId);
      if (tab && tab.url) {
        const host = new URL(tab.url).hostname;
        await removeDomainRuleBySelector(host, selector);
      }
    } catch {}
  }

  return { success: true };
}

async function pausePage(tabId) {
  // 通知 content script 恢复所有元素
  try {
    await chrome.tabs.sendMessage(tabId, {
      type: 'RESTORE_ALL',
    });
  } catch (err) {
    // ignore
  }
  return { success: true };
}

async function pauseSite(url) {
  if (!url) return { success: false };
  const hostname = new URL(url).hostname;
  await addToWhitelist(hostname);
  return { success: true, domain: hostname };
}

// ============================================================
// 7. 设置管理
// ============================================================

async function saveSettings(settings) {
  if (settings.apiKey !== undefined) {
    await setApiKey(settings.apiKey);
  }
  if (settings.strength !== undefined) {
    await chrome.storage.local.set({ [STORAGE_KEYS.STRENGTH]: settings.strength });
  }
  if (settings.aiEnabled !== undefined) {
    await chrome.storage.local.set({ [STORAGE_KEYS.AI_ENABLED]: settings.aiEnabled });
  }
  if (settings.rulesEnabled !== undefined) {
    await chrome.storage.local.set({ [STORAGE_KEYS.RULES_ENABLED]: settings.rulesEnabled });
    // 动态启用/禁用规则集
    await chrome.declarativeNetRequest.updateEnabledRulesets({
      enableRulesetIds: settings.rulesEnabled ? ['default_rules'] : [],
      disableRulesetIds: settings.rulesEnabled ? [] : ['default_rules'],
    });
  }
  if (settings.consentShown !== undefined) {
    await chrome.storage.local.set({ [STORAGE_KEYS.CONSENT_SHOWN]: settings.consentShown });
  }
  return { success: true };
}

// ============================================================
// 8. API Key 测试
// ============================================================

async function testApiKey(apiKey) {
  if (!apiKey) {
    return { success: false, error: t('err_enter_api_key') };
  }

  // 读取用户自定义 API 配置
  const settings = await getSettings();
  const apiUrl = (settings[API_CONFIG_KEYS.API_URL] || '').trim();
  const apiModel = (settings[API_CONFIG_KEYS.API_MODEL] || '').trim();
  const apiTimeout = parseInt(settings[API_CONFIG_KEYS.API_TIMEOUT], 10) || 10000;

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), apiTimeout);

    const response = await fetch(apiUrl || DEEPSEEK_API.BASE_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: apiModel || DEEPSEEK_API.MODEL,
        messages: [{ role: 'user', content: '回复"ok"' }],
        max_tokens: 10,
        stream: false,
      }),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (response.ok) {
      const data = await response.json();
      return { success: true, model: data.model };
    } else {
      const errorText = await response.text().catch(() => '');
      let errorMsg = `HTTP ${response.status}`;
      if (response.status === 401) errorMsg = t('err_api_401');
      else if (response.status === 429) errorMsg = t('err_api_429');
      return { success: false, error: errorMsg };
    }
  } catch (err) {
    if (err.name === 'AbortError') {
      return { success: false, error: t('err_timeout') };
    }
    return { success: false, error: err.message };
  }
}

// ============================================================
// 9. 右键菜单
// ============================================================

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === 'toggle-ai-block') {
    const settings = await getSettings();
    await saveSettings({ aiEnabled: !settings.aiEnabled });
    console.log(`[AdGuardian AI] AI 拦截已${!settings.aiEnabled ? '开启' : '关闭'}`);
  }

  if (info.menuItemId === 'block-element') {
    // 向 content script 发送消息，启动元素选择器
    if (tab && tab.id) {
      try {
        await chrome.tabs.sendMessage(tab.id, {
          type: 'START_ELEMENT_PICKER',
        });
      } catch (err) {
        console.warn('[AdGuardian AI] 启动元素选择器失败:', err.message);
      }
    }
  }
});

// ============================================================
// 10. 定期更新订阅
// ============================================================

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'update-subscriptions') {
    console.log('[AdGuardian AI] 开始定期更新订阅规则...');
    try {
      const results = await checkAndUpdateSubscriptions();
      console.log(`[AdGuardian AI] 订阅更新完成: ${results} 个已更新`);
    } catch (err) {
      console.warn('[AdGuardian AI] 订阅更新失败:', err.message);
    }
  }
});

// ============================================================
// 10. 工具函数
// ============================================================

function chunkArray(arr, size) {
  const chunks = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}
