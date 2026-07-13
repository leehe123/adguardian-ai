/**
 * AdGuardian AI - Popup 面板逻辑
 */

import { MSG_TYPE, BLOCK_SOURCE } from '../lib/constants.js';
import { escapeHtml } from '../lib/utils.js';

// 轻量 i18n 助手：浏览器语言为中文时用中文，否则用英文（由 Chrome _locales 自动选择）
const t = (key) => chrome.i18n.getMessage(key) || key;

// ============================================================
// DOM 引用
// ============================================================

const $ = (sel) => document.querySelector(sel);
const els = {
  aiStatusBar: $('#ai-status-bar'),
  aiStatusIcon: $('#ai-status-icon'),
  aiStatusText: $('#ai-status-text'),
  btnSetupKey: $('#btn-setup-key'),
  btnSettings: $('#btn-settings'),
  statRule: $('#stat-rule'),
  statAi: $('#stat-ai'),
  statDomain: $('#stat-domain'),
  detailCount: $('#detail-count'),
  detailsList: $('#details-list'),
  btnPausePage: $('#btn-pause-page'),
  btnPauseSite: $('#btn-pause-site'),
  strengthIndicator: $('#strength-indicator'),
  linkOptions: $('#link-options'),
};

// ============================================================
// 初始化
// ============================================================

document.addEventListener('DOMContentLoaded', init);

async function init() {
  // 先绑定事件，防止后续加载失败导致按钮无响应
  bindEvents();
  // 各步骤独立 try-catch，互不影响
  try { await loadAIStatus(); } catch (e) { console.warn('[AdGuardian AI] loadAIStatus:', e.message); }
  try { await loadPageStats(); } catch (e) { console.warn('[AdGuardian AI] loadPageStats:', e.message); }
  try { await loadBlockedElements(); } catch (e) { console.warn('[AdGuardian AI] loadBlockedElements:', e.message); }
  try { await loadStrength(); } catch (e) { console.warn('[AdGuardian AI] loadStrength:', e.message); }
}

// ============================================================
// AI 状态
// ============================================================

async function loadAIStatus() {
  const settings = await sendMessage({ type: MSG_TYPE.GET_SETTINGS });

  // 优先级：AI 开启且 Key 存在 → 完全正常，隐藏状态栏
  if (settings.aiEnabled && settings.apiKey) {
    els.aiStatusBar.hidden = true;
    return;
  }

  // 以下情况需要显示状态栏
  els.aiStatusBar.hidden = false;
  els.aiStatusBar.classList.remove('active');
  els.aiStatusIcon.style.background = 'var(--warning)';

  if (!settings.apiKey) {
    // 没有配置 Key（无论 aiEnabled 是什么状态）
    els.aiStatusText.textContent = t('popup_ai_no_key');
    els.btnSetupKey.hidden = false;
  } else if (!settings.aiEnabled) {
    // 有 Key 但 AI 被手动关闭
    els.aiStatusBar.classList.add('active');
    els.aiStatusIcon.style.background = 'var(--accent)';
    els.aiStatusText.textContent = t('popup_ai_closed');
    els.btnSetupKey.hidden = true;
  }
}

// ============================================================
// 页面统计
// ============================================================

async function loadPageStats() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) return;

    // 本页统计
    const pageStats = await sendMessage({
      type: MSG_TYPE.GET_PAGE_STATS,
      tabId: tab.id,
    }).catch(() => null);

    if (pageStats) {
      els.statRule.textContent = pageStats.ruleBlocks || 0;
      els.statAi.textContent = pageStats.aiBlocks || 0;
      els.detailCount.textContent = pageStats.total || 0;
    }

    // 全局统计（域名规则命中数）
    const globalStats = await sendMessage({ type: 'GET_STATS' }).catch(() => null);
    if (globalStats) {
      els.statDomain.textContent = globalStats.domainRulesHits || 0;
    }
  } catch (err) {
    console.log('[AdGuardian AI] 无法获取页面统计:', err.message);
  }
}

// ============================================================
// 拦截明细
// ============================================================

async function loadBlockedElements() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) return;

    const response = await chrome.tabs.sendMessage(tab.id, {
      type: 'GET_BLOCKED_ELEMENTS',
    }).catch(() => null);

    if (!response || !response.elements || response.elements.length === 0) {
      renderEmpty();
      return;
    }

    renderDetails(response.elements);
  } catch (err) {
    renderEmpty();
  }
}

function renderDetails(elements) {
  els.detailsList.innerHTML = '';

  for (const el of elements) {
    const item = document.createElement('div');
    item.className = 'detail-item';

    const sourceMap = {
      [BLOCK_SOURCE.AI]: { label: t('source_ai'), cls: 'ai' },
      [BLOCK_SOURCE.RULE]: { label: t('source_rule'), cls: 'rule' },
      [BLOCK_SOURCE.CACHE]: { label: t('source_cache'), cls: 'cache' },
      [BLOCK_SOURCE.DOMAIN_RULE]: { label: t('source_domain'), cls: 'domain' },
    };
    const sourceInfo = sourceMap[el.source] || { label: t('popup_unknown_source'), cls: 'rule' };
    const sourceClass = sourceInfo.cls;
    const sourceLabel = sourceInfo.label;

    const adTypeKey = { display: 'adtype_display', search: 'adtype_search', native: 'adtype_native', video: 'adtype_video' }[el.adType] || 'adtype_unknown';
    const typeLabel = t(adTypeKey);

    item.innerHTML = `
      <div class="detail-icon ${sourceClass}"></div>
      <div class="detail-content">
        <div class="detail-type">${sourceLabel} · ${typeLabel}</div>
        ${el.reason ? `<div class="detail-reason">${escapeHtml(el.reason)}</div>` : ''}
        <div class="detail-meta">
          ${el.confidence ? `<span class="detail-confidence">${t('popup_confidence_prefix')}${(el.confidence * 100).toFixed(0)}%</span>` : ''}
        </div>
        <button class="btn-unblock" data-element-id="${el.elementId}">${t('popup_unblock_btn')}</button>
      </div>
    `;

    els.detailsList.appendChild(item);
  }

  // 绑定误报按钮
  els.detailsList.querySelectorAll('.btn-unblock').forEach(btn => {
    btn.addEventListener('click', handleFalsePositive);
  });
}

function renderEmpty() {
  els.detailsList.innerHTML = `
    <div class="empty-state">
      <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="#ccc" stroke-width="1.5">
        <path d="M12 2L4 5v6c0 5 3.5 9.5 8 11 4.5-1.5 8-6 8-11V5l-8-3z"/>
      </svg>
      <p>${t('popup_empty_state')}</p>
    </div>
  `;
}

// ============================================================
// 误杀反馈
// ============================================================

async function handleFalsePositive(e) {
  const elementId = e.target.dataset.elementId;
  if (!elementId) return;

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    await chrome.tabs.sendMessage(tab.id, {
      type: 'REPORT_FALSE_POSITIVE',
      elementId,
    });

    // 刷新列表
    await loadBlockedElements();
    await loadPageStats();
  } catch (err) {
    console.error('[AdGuardian AI] 误报处理失败:', err);
  }
}

// ============================================================
// 暂停拦截
// ============================================================

async function pausePage() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    await chrome.tabs.sendMessage(tab.id, { type: 'RESTORE_ALL' });
    window.close();
  } catch (err) {
    console.error('[AdGuardian AI] 暂停页面失败:', err);
  }
}

async function pauseSite() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    await sendMessage({
      type: MSG_TYPE.PAUSE_SITE,
      url: tab.url,
    });

    // 刷新页面使白名单生效
    chrome.tabs.reload(tab.id);
    window.close();
  } catch (err) {
    console.error('[AdGuardian AI] 添加白名单失败:', err);
  }
}

// ============================================================
// 拦截强度
// ============================================================

async function loadStrength() {
  const settings = await sendMessage({ type: MSG_TYPE.GET_SETTINGS });
  els.strengthIndicator.textContent = t('strength_' + settings.strength) + t('strength_mode_suffix');
}

// ============================================================
// 事件绑定
// ============================================================

function bindEvents() {
  els.btnSettings.addEventListener('click', openOptions);
  els.linkOptions.addEventListener('click', (e) => { e.preventDefault(); openOptions(); });
  els.btnSetupKey.addEventListener('click', openOptions);
  els.btnPausePage.addEventListener('click', pausePage);
  els.btnPauseSite.addEventListener('click', pauseSite);
}

function openOptions() {
  chrome.runtime.openOptionsPage();
}

// ============================================================
// 工具
// ============================================================

function sendMessage(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve(response);
      }
    });
  });
}
