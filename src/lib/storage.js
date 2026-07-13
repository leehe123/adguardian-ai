/**
 * AdGuardian AI - 存储管理模块
 * 封装 chrome.storage.local 的读写操作
 * 被 Service Worker 和 Popup/Options 共享
 */

import {
  STORAGE_KEYS,
  DEFAULT_SETTINGS,
  AI_SCHEDULER,
  FALSE_POSITIVE_TTL_MS,
} from './constants.js';

/** 读取单个值 */
export async function get(key) {
  const result = await chrome.storage.local.get(key);
  return result[key];
}

/** 写入单个值 */
export async function set(key, value) {
  await chrome.storage.local.set({ [key]: value });
}

/** 读取所有设置 */
export async function getSettings() {
  const keys = [
    STORAGE_KEYS.API_KEY,
    STORAGE_KEYS.STRENGTH,
    STORAGE_KEYS.AI_ENABLED,
    STORAGE_KEYS.RULES_ENABLED,
    STORAGE_KEYS.WHITELIST,
    STORAGE_KEYS.CONSENT_SHOWN,
  ];
  const data = await chrome.storage.local.get(keys);
  return {
    apiKey: data[STORAGE_KEYS.API_KEY] || '',
    strength: data[STORAGE_KEYS.STRENGTH] || DEFAULT_SETTINGS[STORAGE_KEYS.STRENGTH],
    aiEnabled: data[STORAGE_KEYS.AI_ENABLED] ?? DEFAULT_SETTINGS[STORAGE_KEYS.AI_ENABLED],
    rulesEnabled: data[STORAGE_KEYS.RULES_ENABLED] ?? DEFAULT_SETTINGS[STORAGE_KEYS.RULES_ENABLED],
    whitelist: data[STORAGE_KEYS.WHITELIST] || [],
    consentShown: data[STORAGE_KEYS.CONSENT_SHOWN] || false,
  };
}

/** 保存 API Key */
export async function setApiKey(key) {
  await set(STORAGE_KEYS.API_KEY, key);
}

/** 获取 API Key */
export async function getApiKey() {
  return await get(STORAGE_KEYS.API_KEY) || '';
}

/** 添加域名到白名单 */
export async function addToWhitelist(domain) {
  const whitelist = await get(STORAGE_KEYS.WHITELIST) || [];
  if (!whitelist.includes(domain)) {
    whitelist.push(domain);
    await set(STORAGE_KEYS.WHITELIST, whitelist);
  }
}

/** 从白名单移除域名 */
export async function removeFromWhitelist(domain) {
  const whitelist = await get(STORAGE_KEYS.WHITELIST) || [];
  const updated = whitelist.filter(d => d !== domain);
  await set(STORAGE_KEYS.WHITELIST, updated);
}

/** 检查域名是否在白名单中 */
export async function isWhitelisted(domain) {
  const whitelist = await get(STORAGE_KEYS.WHITELIST) || [];
  return whitelist.some(d => domain === d || domain.endsWith('.' + d));
}

// ========== AI 决策缓存 ==========

/** 生成元素特征指纹 */
export function makeFingerprint(features) {
  const parts = [
    features.hostname || '',
    features.tagClass || '',
    features.textHash || '',
    features.linkDomain || '',
  ];
  return parts.join('::');
}

/** 查询 AI 缓存 */
export async function getCache(fingerprint) {
  const cacheData = await chrome.storage.local.get(STORAGE_KEYS.AI_CACHE);
  const cache = cacheData[STORAGE_KEYS.AI_CACHE] || {};
  const entry = cache[fingerprint];
  if (!entry) return null;

  // 过期检查
  if (Date.now() - entry.timestamp > AI_SCHEDULER.CACHE_TTL_MS) {
    delete cache[fingerprint];
    await chrome.storage.local.set({ [STORAGE_KEYS.AI_CACHE]: cache });
    return null;
  }
  return entry;
}

/** 批量查询 AI 缓存 */
export async function batchGetCache(fingerprints) {
  const results = {};
  for (const fp of fingerprints) {
    const cached = await getCache(fp);
    if (cached) results[fp] = cached;
  }
  return results;
}

/** 写入 AI 缓存 */
export async function setCache(fingerprint, decision) {
  const cacheData = await chrome.storage.local.get(STORAGE_KEYS.AI_CACHE);
  const cache = cacheData[STORAGE_KEYS.AI_CACHE] || {};

  cache[fingerprint] = {
    ...decision,
    timestamp: Date.now(),
  };

  // 淘汰最旧的条目
  const keys = Object.keys(cache);
  if (keys.length > AI_SCHEDULER.CACHE_MAX_ENTRIES) {
    keys
      .sort((a, b) => cache[a].timestamp - cache[b].timestamp)
      .slice(0, keys.length - AI_SCHEDULER.CACHE_MAX_ENTRIES)
      .forEach(k => delete cache[k]);
  }

  await chrome.storage.local.set({ [STORAGE_KEYS.AI_CACHE]: cache });
}

/** 批量写入 AI 缓存 */
export async function batchSetCache(entries) {
  const cacheData = await chrome.storage.local.get(STORAGE_KEYS.AI_CACHE);
  const cache = cacheData[STORAGE_KEYS.AI_CACHE] || {};
  const now = Date.now();

  for (const [fp, decision] of Object.entries(entries)) {
    cache[fp] = { ...decision, timestamp: now };
  }

  // 淘汰
  const keys = Object.keys(cache);
  if (keys.length > AI_SCHEDULER.CACHE_MAX_ENTRIES) {
    keys
      .sort((a, b) => cache[a].timestamp - cache[b].timestamp)
      .slice(0, keys.length - AI_SCHEDULER.CACHE_MAX_ENTRIES)
      .forEach(k => delete cache[k]);
  }

  await chrome.storage.local.set({ [STORAGE_KEYS.AI_CACHE]: cache });
}

/** 清空 AI 缓存 */
export async function clearCache() {
  await chrome.storage.local.set({ [STORAGE_KEYS.AI_CACHE]: {} });
}

// ========== 误杀记录 ==========

/** 记录误杀反馈（加入临时白名单） */
export async function addFalsePositive(fingerprint, elementSelector) {
  const key = 'falsePositives';
  const data = await chrome.storage.local.get(key);
  const fps = data[key] || {};
  fps[fingerprint] = {
    selector: elementSelector,
    timestamp: Date.now(),
  };
  await chrome.storage.local.set({ [key]: fps });
}

/** 检查元素是否被标记为误杀 */
export async function isFalsePositive(fingerprint) {
  const key = 'falsePositives';
  const data = await chrome.storage.local.get(key);
  const fps = data[key] || {};
  const entry = fps[fingerprint];
  if (!entry) return false;
  // 过期清理
  if (Date.now() - entry.timestamp > FALSE_POSITIVE_TTL_MS) {
    delete fps[fingerprint];
    await chrome.storage.local.set({ [key]: fps });
    return false;
  }
  return true;
}

// ========== 统计 ==========

/** 获取全局统计 */
export async function getStats() {
  const data = await chrome.storage.local.get(STORAGE_KEYS.STATS);
  return data[STORAGE_KEYS.STATS] || {
    ruleBlocks: 0,
    aiBlocks: 0,
    aiCalls: 0,
    cacheHits: 0,
    domainRulesHits: 0,
    falsePositives: 0,
    pagesScanned: 0,
  };
}

/** 更新统计 */
export async function updateStats(updates) {
  const stats = await getStats();
  const newStats = { ...stats };
  for (const [key, value] of Object.entries(updates)) {
    newStats[key] = (newStats[key] || 0) + value;
  }
  await chrome.storage.local.set({ [STORAGE_KEYS.STATS]: newStats });
  return newStats;
}

/** 重置统计 */
export async function resetStats() {
  await chrome.storage.local.set({ [STORAGE_KEYS.STATS]: {} });
}

// ============================================================
// 域名规则库（按域名缓存 AI 判定结果，省 token）
// ============================================================

import {
  DOMAIN_RULES_KEY,
  DOMAIN_RULES_MAX_PER_DOMAIN,
  DOMAIN_RULES_TTL_MS,
  DOMAIN_RULES_MAX_DOMAINS,
} from './constants.js';

/**
 * 获取某域名的缓存规则
 * 返回 { rules: [...], lastUpdated } 或 null（过期/不存在）
 */
export async function getDomainRules(hostname) {
  const data = await chrome.storage.local.get(DOMAIN_RULES_KEY);
  const allRules = data[DOMAIN_RULES_KEY] || {};
  const entry = allRules[hostname];

  if (!entry) return null;

  // TTL 检查
  const now = Date.now();
  if (now - entry.lastUpdated > DOMAIN_RULES_TTL_MS) {
    // 过期，异步清理（不阻塞返回）
    delete allRules[hostname];
    chrome.storage.local.set({ [DOMAIN_RULES_KEY]: allRules });
    return null;
  }

  return entry;
}

/**
 * 向某域名添加一条规则
 * rule: { selector, reason, adType, confidence, source: 'ai' | 'cache' }
 */
export async function addDomainRule(hostname, rule) {
  const data = await chrome.storage.local.get(DOMAIN_RULES_KEY);
  const allRules = data[DOMAIN_RULES_KEY] || {};

  if (!allRules[hostname]) {
    allRules[hostname] = {
      rules: [],
      lastUpdated: Date.now(),
    };
  }

  const entry = allRules[hostname];

  // 去重：同 selector 已存在则更新命中次数和时间
  const existingIdx = entry.rules.findIndex(r => r.selector === rule.selector);
  if (existingIdx >= 0) {
    entry.rules[existingIdx].hitCount = (entry.rules[existingIdx].hitCount || 0) + 1;
    entry.rules[existingIdx].lastSeen = Date.now();
    entry.lastUpdated = Date.now();
  } else {
    entry.rules.push({
      selector: rule.selector,
      reason: rule.reason || '',
      adType: rule.adType || '',
      confidence: rule.confidence || 0,
      firstSeen: Date.now(),
      lastSeen: Date.now(),
      hitCount: 1,
    });
    entry.lastUpdated = Date.now();
  }

  // 单域名规则数上限
  if (entry.rules.length > DOMAIN_RULES_MAX_PER_DOMAIN) {
    // 淘汰命中次数最少、最旧的规则
    entry.rules.sort((a, b) => (a.hitCount || 0) - (b.hitCount || 0) || a.firstSeen - b.firstSeen);
    entry.rules = entry.rules.slice(-DOMAIN_RULES_MAX_PER_DOMAIN);
  }

  // 总域名数上限（LRU 淘汰）
  const domains = Object.keys(allRules);
  if (domains.length > DOMAIN_RULES_MAX_DOMAINS) {
    // 按 lastUpdated 排序，淘汰最旧的
    const sorted = domains.sort((a, b) => allRules[a].lastUpdated - allRules[b].lastUpdated);
    const toRemove = sorted.slice(0, domains.length - DOMAIN_RULES_MAX_DOMAINS);
    toRemove.forEach(d => delete allRules[d]);
  }

  await chrome.storage.local.set({ [DOMAIN_RULES_KEY]: allRules });
}

/** 清空域名规则库 */
export async function clearDomainRules() {
  await chrome.storage.local.set({ [DOMAIN_RULES_KEY]: {} });
}

/**
 * 从指定域名规则中删除某个 selector（误杀反馈时调用）
 * 返回 true 表示确实删除了某条规则
 */
export async function removeDomainRuleBySelector(hostname, selector) {
  if (!hostname || !selector) return false;
  const data = await chrome.storage.local.get(DOMAIN_RULES_KEY);
  const allRules = data[DOMAIN_RULES_KEY] || {};
  const entry = allRules[hostname];
  if (!entry || !entry.rules) return false;

  const before = entry.rules.length;
  entry.rules = entry.rules.filter(r => r.selector !== selector);
  if (entry.rules.length === before) return false;

  if (entry.rules.length === 0) {
    delete allRules[hostname];
  } else {
    entry.lastUpdated = Date.now();
  }
  await chrome.storage.local.set({ [DOMAIN_RULES_KEY]: allRules });
  return true;
}

/** 获取域名规则库统计 */
export async function getDomainRulesStats() {
  const data = await chrome.storage.local.get(DOMAIN_RULES_KEY);
  const allRules = data[DOMAIN_RULES_KEY] || {};
  const domains = Object.keys(allRules);
  let totalRules = 0;
  for (const d of domains) {
    totalRules += (allRules[d].rules || []).length;
  }
  return {
    domains: domains.length,
    totalRules,
    entries: allRules,
  };
}

// ============================================================
// 自定义规则（用户添加，通过 dynamicRules 生效）
// ============================================================

/**
 * 自定义规则结构：
 * { id: number, type: 'domain'|'selector', value: string, comment: string }
 * type=domain  → 拦截该域名的请求（updateDynamicRules）
 * type=selector → content script 隐藏匹配的元素
 */
const CUSTOM_RULES_KEY = 'customRules';
const CUSTOM_RULE_NEXT_ID_KEY = 'customRuleNextId';
let customRuleNextId = 10000; // 与动态规则 ID 对齐（会从 storage 恢复）

export async function getCustomRules() {
  const data = await chrome.storage.local.get([CUSTOM_RULES_KEY, CUSTOM_RULE_NEXT_ID_KEY]);
  const rules = data[CUSTOM_RULES_KEY] || [];
  // 从 storage 恢复 nextId（优先），否则从已有规则计算
  if (data[CUSTOM_RULE_NEXT_ID_KEY] > 0) {
    customRuleNextId = Math.max(customRuleNextId, data[CUSTOM_RULE_NEXT_ID_KEY]);
  } else if (rules.length > 0) {
    const maxId = rules.reduce((max, r) => Math.max(max, r.id || 0), 0);
    customRuleNextId = Math.max(customRuleNextId, maxId + 1);
  }
  return rules;
}

/** 持久化 customRuleNextId 到 storage（每次添加规则后调用） */
async function persistCustomRuleNextId() {
  await chrome.storage.local.set({ [CUSTOM_RULE_NEXT_ID_KEY]: customRuleNextId });
}

export async function addCustomRule(type, value, comment) {
  const rules = await getCustomRules();
  // 去重：同类型+同值不重复添加
  if (rules.some(r => r.type === type && r.value === value.trim())) {
    return null; // 返回 null 表示重复
  }
  const entry = {
    id: customRuleNextId++,
    type,       // 'domain' | 'selector'
    value: value.trim(),
    comment: (comment || '').trim(),
    createdAt: Date.now(),
  };
  rules.push(entry);
  await chrome.storage.local.set({ [CUSTOM_RULES_KEY]: rules });
  // 持久化 nextId，防止 SW 重启后 ID 冲突
  await persistCustomRuleNextId();
  return entry;
}

export async function removeCustomRule(id) {
  const rules = await getCustomRules();
  const filtered = rules.filter(r => r.id !== id);
  await chrome.storage.local.set({ [CUSTOM_RULES_KEY]: filtered });
  return rules.length !== filtered.length;
}

export async function clearCustomRules() {
  await chrome.storage.local.set({ [CUSTOM_RULES_KEY]: [] });
}

/**
 * 把 domain 类型规则转为 declarativeNetRequest 动态规则
 * 返回 { add: [...], remove: [...] }（remove 用现有动态规则 ID）
 */
export async function buildDynamicRules() {
  const rules = await getCustomRules();
  const domainRules = rules.filter(r => r.type === 'domain');
  const nruleIds = domainRules.map(r => r.id);

  return {
    add: domainRules.map(r => ({
      id: r.id,
      priority: 2, // 高于静态规则（priority:1）
      action: { type: 'block' },
      condition: {
        urlFilter: `||${r.value}^`,
        resourceTypes: ['script', 'image', 'sub_frame', 'xmlhttprequest', 'stylesheet', 'font'],
      },
    })),
    remove: [], // 由调用方通过 getExistingDynamicRuleIds() 决定
  };
}

/** 获取当前已存在的动态规则 ID 列表 */
export async function getExistingDynamicRuleIds() {
  return new Promise((resolve) => {
    chrome.declarativeNetRequest.getDynamicRules((rules) => {
      resolve(rules.map(r => r.id));
    });
  });
}
