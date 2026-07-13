/**
 * AdGuardian AI - 规则订阅管理模块
 * 职责：订阅公开规则列表、ABP 格式解析、自动更新、DNR 规则转换
 */

import {
  SUBSCRIPTION_KEYS,
  PRESET_SUBSCRIPTIONS,
  SUBSCRIPTION_UPDATE_INTERVAL_HOURS,
} from './constants.js';

// ============================================================
// 存储操作
// ============================================================

/** 获取所有订阅配置 */
export async function getSubscriptions() {
  let data = {};
  try {
    data = await chrome.storage.local.get(SUBSCRIPTION_KEYS.SUBSCRIPTIONS);
  } catch (err) {
    console.warn('[AdGuardian AI] 读取订阅存储失败:', err.message);
    return [];
  }
  let subs = data[SUBSCRIPTION_KEYS.SUBSCRIPTIONS];

  if (!subs || !Array.isArray(subs) || subs.length === 0) {
    // 首次使用，初始化预置订阅
    subs = PRESET_SUBSCRIPTIONS.map(s => ({
      ...s,
      lastUpdated: 0,
      enabled: s.enabled !== false,
      ruleCount: 0,
      error: '',
    }));
    try {
      await saveSubscriptions(subs);
    } catch (err) {
      console.warn('[AdGuardian AI] 初始化订阅存储失败:', err.message);
    }
  }

  return subs;
}

/** 保存订阅配置 */
async function saveSubscriptions(subs) {
  await chrome.storage.local.set({ [SUBSCRIPTION_KEYS.SUBSCRIPTIONS]: subs });
}

/** 获取某订阅的已下载规则文本 */
async function getSubscriptionRules(subscriptionId) {
  const key = `subRules_${subscriptionId}`;
  const data = await chrome.storage.local.get(key);
  return data[key] || '';
}

/** 保存某订阅的规则文本 */
async function saveSubscriptionRules(subscriptionId, rulesText) {
  const key = `subRules_${subscriptionId}`;
  await chrome.storage.local.set({ [key]: rulesText });
}

// ============================================================
// 规则更新
// ============================================================

/**
 * 更新单个订阅规则
 * 返回 { success, ruleCount, error }
 */
export async function updateSubscription(subscriptionId) {
  const subs = await getSubscriptions();
  const sub = subs.find(s => s.id === subscriptionId);
  if (!sub) return { success: false, error: '订阅不存在' };

  try {
    const response = await fetch(sub.url, {
      method: 'GET',
      headers: { 'User-Agent': 'AdGuardianAI/1.0' },
      signal: AbortSignal.timeout(30000),
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const rulesText = await response.text();
    if (!rulesText || rulesText.length < 100) {
      throw new Error('规则内容为空或过小');
    }

    // 解析规则
    const parsed = parseABPRules(rulesText);

    // 保存规则文本和解析结果
    await saveSubscriptionRules(subscriptionId, rulesText);
    await saveParsedRules(subscriptionId, parsed);

    // 更新订阅信息
    sub.lastUpdated = Date.now();
    sub.ruleCount = parsed.networkRules.length + parsed.elementHideRules.length;
    sub.error = '';
    await saveSubscriptions(subs);

    // 刷新动态规则
    await rebuildSubscriptionDynamicRules();

    return { success: true, ruleCount: sub.ruleCount };
  } catch (err) {
    sub.error = err.message;
    await saveSubscriptions(subs);
    return { success: false, error: err.message };
  }
}

/**
 * 更新所有启用的订阅
 */
export async function updateAllSubscriptions() {
  const subs = await getSubscriptions();
  const results = [];

  for (const sub of subs) {
    if (!sub.enabled) continue;
    const result = await updateSubscription(sub.id);
    results.push({ id: sub.id, name: sub.name, ...result });
  }

  return results;
}

/**
 * 检查并自动更新过期的订阅
 */
export async function checkAndUpdateSubscriptions() {
  const subs = await getSubscriptions();
  const now = Date.now();
  const intervalMs = SUBSCRIPTION_UPDATE_INTERVAL_HOURS * 60 * 60 * 1000;
  let updated = 0;

  for (const sub of subs) {
    if (!sub.enabled) continue;
    if (!sub.lastUpdated || now - sub.lastUpdated > intervalMs) {
      await updateSubscription(sub.id);
      updated++;
    }
  }

  return updated;
}

// ============================================================
// ABP 规则解析
// ============================================================

/**
 * 解析 ABP 格式规则文本
 * 返回 { networkRules: [...], elementHideRules: [...] }
 */
function parseABPRules(rulesText) {
  const lines = rulesText.split('\n');
  const networkRules = [];
  const elementHideRules = [];

  let inElementHide = false;
  let currentHideDomain = '';

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    // 跳过注释和空行
    if (!line || line.startsWith('!') || line.startsWith('[')) continue;

    // 元素隐藏规则：domain##selector
    const hideMatch = line.match(/^([^#]*)##(.+)$/);
    if (hideMatch) {
      const domain = hideMatch[1];
      const selector = hideMatch[2];
      elementHideRules.push({ domain, selector });
      continue;
    }

    // 元素隐藏例外：domain#@#selector
    const hideException = line.match(/^([^#]*)#@#(.+)$/);
    if (hideException) continue; // 暂不支持

    // 网络请求规则
    if (!line.startsWith('@@')) {
      const parsed = parseNetworkRule(line);
      if (parsed) networkRules.push(parsed);
    }
    // 例外规则暂不支持（@@）
  }

  return { networkRules, elementHideRules };
}

/**
 * 解析单条网络请求规则（ABP 格式）
 * 返回 { urlFilter, resourceTypes, excludeResourceTypes } 或 null
 */
function parseNetworkRule(rule) {
  if (!rule || rule.length < 2) return null;

  let urlFilter = rule;
  let resourceTypes = ['script', 'image', 'sub_frame', 'xmlhttprequest', 'stylesheet', 'font', 'media', 'websocket'];
  let excludeResourceTypes = [];

  // 去掉规则选项：||example.com^$script,image
  let options = '';
  const optionsMatch = rule.match(/\$(.+)$/);
  if (optionsMatch) {
    options = optionsMatch[1];
    urlFilter = rule.substring(0, rule.indexOf('$'));
  }

  // 解析选项
  if (options) {
    const opts = options.split(',');
    for (const opt of opts) {
      if (opt === 'script') resourceTypes = ['script'];
      else if (opt === 'image') resourceTypes = ['image'];
      else if (opt === 'stylesheet') resourceTypes = ['stylesheet'];
      else if (opt === 'subdocument') resourceTypes = ['sub_frame'];
      else if (opt === 'third-party') { /* 默认已限制第三方 */ }
      else if (opt === 'domain=~') { /* 例外域名，暂跳过 */ return null; }
    }
  }

  // 转换 ABP 格式到 DNR urlFilter
  // ||example.com^ → ||example.com^
  // |https://example.com → |https://example.com
  // /regex/ → /regex/

  if (urlFilter.startsWith('||')) {
    // 域名锚点：||example.com^ 匹配 http://example.com/* 等
    urlFilter = urlFilter.replace(/^\|\|/, '||');
  } else if (urlFilter.startsWith('|')) {
    // 地址栏锚点
    urlFilter = urlFilter.replace(/^\|/, '');
  }

  // 去掉末尾的 ^
  if (urlFilter.endsWith('^')) {
    urlFilter = urlFilter.slice(0, -1);
  }

  // 验证 urlFilter 不为空
  if (!urlFilter || urlFilter === '||' || urlFilter === '|') return null;

  return { urlFilter, resourceTypes, excludeResourceTypes };
}

// ============================================================
// 解析结果存储
// ============================================================

/** 保存解析后的规则（网络规则 + 元素隐藏规则） */
async function saveParsedRules(subscriptionId, parsed) {
  const key = `subParsed_${subscriptionId}`;
  await chrome.storage.local.set({ [key]: parsed });
}

/** 获取解析后的规则 */
async function getParsedRules(subscriptionId) {
  const key = `subParsed_${subscriptionId}`;
  const data = await chrome.storage.local.get(key);
  return data[key] || { networkRules: [], elementHideRules: [] };
}

/**
 * 获取所有启用订阅的网络规则（用于构建 DNR 动态规则）
 */
export async function getAllSubscriptionNetworkRules() {
  const subs = await getSubscriptions();
  const allRules = [];

  for (const sub of subs) {
    if (!sub.enabled) continue;
    const parsed = await getParsedRules(sub.id);
    if (parsed && parsed.networkRules) {
      allRules.push(...parsed.networkRules);
    }
  }

  return allRules;
}

/**
 * 获取所有启用订阅的元素隐藏规则（用于 content script）
 */
export async function getAllSubscriptionElementHideRules() {
  const subs = await getSubscriptions();
  const allRules = [];

  for (const sub of subs) {
    if (!sub.enabled) continue;
    const parsed = await getParsedRules(sub.id);
    if (parsed && parsed.elementHideRules) {
      allRules.push(...parsed.elementHideRules);
    }
  }

  return allRules;
}

// ============================================================
// 重建动态规则
// ============================================================

let subscriptionRuleIdBase = 20000; // 与自定义规则 ID 区分

/**
 * 重建所有订阅规则到 DNR 动态规则
 */
export async function rebuildSubscriptionDynamicRules() {
  // 先移除现有订阅动态规则
  const existingIds = await getExistingSubscriptionRuleIds();
  if (existingIds.length > 0) {
    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: existingIds,
    });
  }

  // 获取所有网络规则
  const networkRules = await getAllSubscriptionNetworkRules();

  // 转换为 DNR 格式
  const dnrRules = [];
  let ruleId = subscriptionRuleIdBase;

  for (const rule of networkRules) {
    try {
      dnrRules.push({
        id: ruleId++,
        priority: 1,
        action: { type: 'block' },
        condition: {
          urlFilter: rule.urlFilter,
          resourceTypes: rule.resourceTypes || ['script', 'image', 'sub_frame', 'xmlhttprequest'],
        },
      });
    } catch {
      // 跳过无效规则
    }
  }

  // 分批添加（每次最多 1000 条）
  const batchSize = 1000;
  for (let i = 0; i < dnrRules.length; i += batchSize) {
    const batch = dnrRules.slice(i, i + batchSize);
    try {
      await chrome.declarativeNetRequest.updateDynamicRules({ add: batch });
    } catch (err) {
      console.error('[AdGuardian AI] 添加订阅规则失败:', err.message);
    }
  }

  console.log(`[AdGuardian AI] 已加载 ${dnrRules.length} 条订阅网络规则`);
  return dnrRules.length;
}

/** 获取现有订阅动态规则 ID 列表 */
function getExistingSubscriptionRuleIds() {
  return new Promise((resolve) => {
    try {
      chrome.declarativeNetRequest.getDynamicRules((rules) => {
        try {
          const ids = rules
            .map(r => r.id)
            .filter(id => id >= subscriptionRuleIdBase && id < subscriptionRuleIdBase + 100000);
          resolve(ids);
        } catch {
          resolve([]);
        }
      });
    } catch (err) {
      console.warn('[AdGuardian AI] getDynamicRules 失败:', err.message);
      resolve([]);
    }
    // 兜底超时：500ms 后强制 resolve
    setTimeout(() => resolve([]), 500);
  });
}

// ============================================================
// 订阅管理
// ============================================================

/** 切换订阅启用状态 */
export async function toggleSubscription(subscriptionId, enabled) {
  const subs = await getSubscriptions();
  const sub = subs.find(s => s.id === subscriptionId);
  if (!sub) return false;

  sub.enabled = enabled;
  await saveSubscriptions(subs);

  // 重建动态规则
  await rebuildSubscriptionDynamicRules();

  return true;
}

/** 添加自定义订阅 */
export async function addCustomSubscription(name, url) {
  const subs = await getSubscriptions();

  // 严格去重：URL 相同或名称相同都算重复
  if (subs.some(s => s.url === url)) {
    return { success: false, error: '该订阅 URL 已存在' };
  }
  if (subs.some(s => s.name === name)) {
    return { success: false, error: `已存在同名订阅「${name}」，请换个名字` };
  }

  const id = `custom_${Date.now()}`;
  subs.push({
    id,
    name,
    description: '自定义订阅',
    url,
    enabled: true,
    lastUpdated: 0,
    ruleCount: 0,
    error: '',
    isCustom: true,
  });

  await saveSubscriptions(subs);
  return { success: true, id };
}

/** 删除订阅（任何订阅都可以删，包括预置的） */
export async function removeSubscription(subscriptionId) {
  const subs = await getSubscriptions();
  const idx = subs.findIndex(s => s.id === subscriptionId);
  if (idx < 0) return false;

  const sub = subs[idx];
  subs.splice(idx, 1);
  await saveSubscriptions(subs);

  // 清除存储的规则
  await chrome.storage.local.remove(`subRules_${subscriptionId}`);
  await chrome.storage.local.remove(`subParsed_${subscriptionId}`);

  // 重建动态规则
  await rebuildSubscriptionDynamicRules();

  return true;
}

/** 获取订阅最后更新时间 */
export async function getLastUpdateTime() {
  const data = await chrome.storage.local.get(SUBSCRIPTION_KEYS.LAST_UPDATE);
  return data[SUBSCRIPTION_KEYS.LAST_UPDATE] || 0;
}

/** 设置最后更新时间 */
async function setLastUpdateTime(time) {
  await chrome.storage.local.set({ [SUBSCRIPTION_KEYS.LAST_UPDATE]: time });
}
