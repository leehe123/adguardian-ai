/**
 * AdGuardian AI - 全局常量定义
 * 被 Service Worker 和 Popup/Options 共享
 */

// 拦截方式
export const BLOCK_SOURCE = {
  RULE: 'rule',
  AI: 'ai',
  CACHE: 'cache',
  DOMAIN_RULE: 'domain_rule',
};

// 广告类型
export const AD_TYPE = {
  DISPLAY: 'display',
  SEARCH: 'search',
  NATIVE: 'native',
  VIDEO: 'video',
};

export const AD_TYPE_LABEL = {
  display: '展示广告',
  search: '搜索广告',
  native: '原生广告',
  video: '视频广告',
};

// 拦截强度档位
export const STRENGTH = {
  CONSERVATIVE: 'conservative',
  STANDARD: 'standard',
  AGGRESSIVE: 'aggressive',
};

export const STRENGTH_LABEL = {
  conservative: '保守',
  standard: '标准',
  aggressive: '激进',
};

// 各档位对应的 AI 置信度阈值
export const STRENGTH_THRESHOLD = {
  conservative: 0.95,
  standard: 0.8,
  aggressive: 0.6,
};

// 存储键名
export const STORAGE_KEYS = {
  API_KEY: 'apiKey',
  STRENGTH: 'strength',
  WHITELIST: 'whitelist',
  AI_CACHE: 'aiCache',
  STATS: 'stats',
  AI_ENABLED: 'aiEnabled',
  RULES_ENABLED: 'rulesEnabled',
  CONSENT_SHOWN: 'consentShown',
  CUSTOM_RULES: 'customRules',
};

// DeepSeek API 配置
export const DEEPSEEK_API = {
  BASE_URL: 'https://api.deepseek.com/v1/chat/completions',
  MODEL: 'deepseek-chat',
  MAX_TOKENS: 1024,
  TEMPERATURE: 0.1,
  TIMEOUT_MS: 8000,
};

// 用户可自定义的 API 配置（覆盖上面的默认值）
// 存储在 storage 的键名
export const API_CONFIG_KEYS = {
  API_URL: 'apiUrl',      // 自定义 API 地址（如 Ollama 本地地址）
  API_MODEL: 'apiModel',  // 自定义模型名
  API_TIMEOUT: 'apiTimeout', // 自定义超时 ms
};

// AI 调度参数
export const AI_SCHEDULER = {
  MAX_BATCH_SIZE: 10,
  BATCH_INTERVAL_MS: 500,
  MAX_RETRIES: 1,
  CACHE_MAX_ENTRIES: 2000,
  CACHE_TTL_MS: 7 * 24 * 60 * 60 * 1000,
};

// 候选元素检测：class/id 中含这些关键词视为疑似广告
export const AD_KEYWORDS = [
  'ad', 'ads', 'advert', 'adbox', 'ad-container', 'ad-wrapper',
  'banner', 'sponsor', 'sponsored', 'promo', 'promotion',
  'commercial', 'prbox', '推广', '广告', '赞助', '推广链接',
];

// 搜索结果页广告标签关键词
export const SEARCH_AD_LABELS = [
  '广告', '推广', '赞助商', 'AD', 'Sponsored', 'Ad',
  'Promoted', 'Sponsored Content',
];

// 信息流广告标签关键词
export const NATIVE_AD_LABELS = [
  '推广', '赞助', '广告', 'Sponsored', 'Promoted',
  '赞助内容', '品牌合作', '广告推荐',
];

// 消息类型
export const MSG_TYPE = {
  PAGE_LOADED: 'PAGE_LOADED',
  CANDIDATES_FOUND: 'CANDIDATES_FOUND',
  AI_RESULT: 'AI_RESULT',
  GET_PAGE_STATS: 'GET_PAGE_STATS',
  PAGE_STATS: 'PAGE_STATS',
  FALSE_POSITIVE: 'FALSE_POSITIVE',
  PAUSE_PAGE: 'PAUSE_PAGE',
  PAUSE_SITE: 'PAUSE_SITE',
  TEST_API_KEY: 'TEST_API_KEY',
  GET_SETTINGS: 'GET_SETTINGS',
  SAVE_SETTINGS: 'SAVE_SETTINGS',
  CLEAR_CACHE: 'CLEAR_CACHE',
  GET_STATS: 'GET_STATS',
  RESET_STATS: 'RESET_STATS',
  // 域名规则库
  GET_DOMAIN_RULES_STATS: 'GET_DOMAIN_RULES_STATS',
  CLEAR_DOMAIN_RULES: 'CLEAR_DOMAIN_RULES',
  // 自定义规则
  GET_CUSTOM_RULES: 'GET_CUSTOM_RULES',
  ADD_CUSTOM_RULE: 'ADD_CUSTOM_RULE',
  REMOVE_CUSTOM_RULE: 'REMOVE_CUSTOM_RULE',
  CLEAR_CUSTOM_RULES: 'CLEAR_CUSTOM_RULES',
};

// 默认设置
export const DEFAULT_SETTINGS = {
  [STORAGE_KEYS.STRENGTH]: STRENGTH.STANDARD,
  [STORAGE_KEYS.AI_ENABLED]: false,
  [STORAGE_KEYS.RULES_ENABLED]: true,
  [STORAGE_KEYS.WHITELIST]: [],
  // API 可自定义配置（用户可在设置页覆盖默认值）
  [API_CONFIG_KEYS.API_URL]: '',
  [API_CONFIG_KEYS.API_MODEL]: '',
  [API_CONFIG_KEYS.API_TIMEOUT]: 0,
};

// 误杀恢复后该元素的存活时间（ms），过期后重新参与检测
export const FALSE_POSITIVE_TTL_MS = 24 * 60 * 60 * 1000;

// ============================================================
// 域名规则库配置
// ============================================================

// 存储键名
export const DOMAIN_RULES_KEY = 'domainRules';

// 每个域名最多保存的规则条数（防止单个域名规则爆炸）
export const DOMAIN_RULES_MAX_PER_DOMAIN = 50;

// 域名规则 TTL（ms），超过后下次访问重新用 AI 验证（默认 30 天）
export const DOMAIN_RULES_TTL_MS = 30 * 24 * 60 * 60 * 1000;

// 最多缓存多少个域名的规则（LRU 淘汰）
export const DOMAIN_RULES_MAX_DOMAINS = 500;

// ============================================================
// 规则订阅配置
// ============================================================

// 存储键名
export const SUBSCRIPTION_KEYS = {
  SUBSCRIPTIONS: 'ruleSubscriptions',
  LAST_UPDATE: 'subscriptionsLastUpdate',
};

// 预置公开规则列表
export const PRESET_SUBSCRIPTIONS = [
  {
    id: 'easylist',
    name: 'EasyList',
    description: '国际通用广告过滤规则，Adblock Plus 官方维护',
    url: 'https://easylist.to/easylist/easylist.txt',
    enabled: true,
    updateInterval: 24 * 60 * 60 * 1000, // 24小时
  },
  {
    id: 'easylist-china',
    name: 'EasyList China',
    description: '中文网站广告过滤规则，补充 EasyList',
    url: 'https://easylist-downloads.adblockplus.org/easylistchina.txt',
    enabled: true,
    updateInterval: 24 * 60 * 60 * 1000,
  },
  {
    id: 'chengfeng',
    name: '乘风规则',
    description: '国内广告过滤规则，覆盖百度、淘宝等中文网站',
    url: 'https://raw.githubusercontent.com/xinggsf/Adblock-Plus-Rule/master/rule.txt',
    enabled: false,
    updateInterval: 24 * 60 * 60 * 1000,
  },
  {
    id: 'anti-adblock',
    name: 'Anti-Adblock Killer',
    description: '绕过反广告拦截检测',
    url: 'https://easylist-downloads.adblockplus.org/antiadblockfilters.txt',
    enabled: false,
    updateInterval: 24 * 60 * 60 * 1000,
  },
];

// 订阅规则更新间隔（小时）
export const SUBSCRIPTION_UPDATE_INTERVAL_HOURS = 24;
