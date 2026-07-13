/**
 * AdGuardian AI - 设置页逻辑
 */

import {
  MSG_TYPE,
  STORAGE_KEYS,
  STRENGTH,
  API_CONFIG_KEYS,
} from '../lib/constants.js';

// 轻量 i18n 助手：浏览器语言为中文时用中文，否则用英文（由 Chrome _locales 自动选择）
const t = (key) => chrome.i18n.getMessage(key) || key;

// ============================================================
// DOM 引用
// ============================================================

const $ = (sel) => document.querySelector(sel);

// ============================================================
// 初始化
// ============================================================

document.addEventListener('DOMContentLoaded', init);

async function init() {
  // 先绑事件，再加载数据 — 避免因加载失败导致按钮无响应
  bindEvents();
  // 各步骤独立 try-catch，任一失败不影响其他步骤
  await safeLoad(loadSettings, '设置加载失败');
  await safeLoad(loadWhitelist, '白名单加载失败');
  await safeLoad(loadCustomRules, '自定义规则加载失败');
  await safeLoad(loadStats, '统计加载失败');
  await safeLoad(loadSubscriptions, '订阅列表加载失败');
}

async function safeLoad(fn, errorLabel) {
  try {
    await fn();
  } catch (err) {
    console.error(`[AdGuardian AI] ${errorLabel}:`, err.message || err);
  }
}

// ============================================================
// 加载设置
// ============================================================

async function loadSettings() {
  const settings = await sendMessage({ type: MSG_TYPE.GET_SETTINGS });

  // API Key
  const keyInput = $('#api-key-input');
  keyInput.value = settings.apiKey || '';

  // AI 开关
  $('#ai-enabled-toggle').checked = settings.aiEnabled;

  // 规则开关
  $('#rules-enabled-toggle').checked = settings.rulesEnabled;

  // 强度
  const strengthRadio = $(`input[name="strength"][value="${settings.strength}"]`);
  if (strengthRadio) strengthRadio.checked = true;

  // 隐私告知
  if (!settings.consentShown && !settings.aiEnabled) {
    // 还没同意过，等用户开启 AI 时再显示
  }

  // API 自定义配置
  $('#api-url-input').value = settings[API_CONFIG_KEYS.API_URL] || '';
  $('#api-model-input').value = settings[API_CONFIG_KEYS.API_MODEL] || '';
  $('#api-timeout-input').value = settings[API_CONFIG_KEYS.API_TIMEOUT] || '';
}

// ============================================================
// 保存 API 自定义配置
// ============================================================

async function saveApiConfig() {
  const url = $('#api-url-input').value.trim();
  const model = $('#api-model-input').value.trim();
  const timeout = parseInt($('#api-timeout-input').value, 10) || 0;

  // 简单验证 URL 格式（如果填写了的话）
  if (url && !/^https?:\/\/.+/.test(url)) {
    alert(t('opt_alert_api_url_invalid'));
    return;
  }

  await sendMessage({
    type: MSG_TYPE.SAVE_SETTINGS,
    settings: {
      [API_CONFIG_KEYS.API_URL]: url,
      [API_CONFIG_KEYS.API_MODEL]: model,
      [API_CONFIG_KEYS.API_TIMEOUT]: timeout,
    },
  });

  showToast(t('opt_toast_api_saved'));
}

// ============================================================
// API Key 管理
// ============================================================

async function saveApiKey() {
  const apiKey = $('#api-key-input').value.trim();
  if (!apiKey) {
    showTestResult(t('opt_test_enter_key'), 'error');
    return;
  }

  await sendMessage({
    type: MSG_TYPE.SAVE_SETTINGS,
    settings: { apiKey },
  });

  showTestResult(t('opt_key_saved'), 'success');

  // 如果 Key 保存且之前已同意隐私，自动启用 AI
  const settings = await sendMessage({ type: MSG_TYPE.GET_SETTINGS });
  if (settings.consentShown) {
    await sendMessage({
      type: MSG_TYPE.SAVE_SETTINGS,
      settings: { aiEnabled: true },
    });
    $('#ai-enabled-toggle').checked = true;
  }
}

async function testApiKey() {
  const apiKey = $('#api-key-input').value.trim();
  const resultEl = $('#key-test-result');

  if (!apiKey) {
    showTestResult(t('opt_test_no_key'), 'error');
    return;
  }

  resultEl.textContent = t('opt_testing');
  resultEl.className = 'test-result';

  const result = await sendMessage({
    type: MSG_TYPE.TEST_API_KEY,
    apiKey,
  });

  if (result.success) {
    showTestResult(`${t('opt_conn_success')} (${result.model || 'deepseek-chat'})`, 'success');
  } else {
    showTestResult(t('opt_conn_fail') + result.error, 'error');
  }
}

function showTestResult(text, type) {
  const el = $('#key-test-result');
  el.textContent = text;
  el.className = `test-result ${type}`;
}

// 显示/隐藏 Key
function toggleKeyVisibility() {
  const input = $('#api-key-input');
  input.type = input.type === 'password' ? 'text' : 'password';
}

// ============================================================
// AI 开关 + 隐私同意
// ============================================================

async function toggleAI(enabled) {
  if (enabled) {
    // 检查是否有 Key
    const settings = await sendMessage({ type: MSG_TYPE.GET_SETTINGS });
    if (!settings.apiKey) {
      showTestResult(t('opt_alert_config_key_first'), 'error');
      $('#ai-enabled-toggle').checked = false;
      return;
    }

    // 检查是否已同意隐私
    if (!settings.consentShown) {
      $('#consent-banner').hidden = false;
      return; // 不自动开启，等用户点"我知道了"
    }
  }

  await sendMessage({
    type: MSG_TYPE.SAVE_SETTINGS,
    settings: { aiEnabled: enabled },
  });
}

async function handleConsent() {
  await sendMessage({
    type: MSG_TYPE.SAVE_SETTINGS,
    settings: {
      aiEnabled: true,
      consentShown: true,
    },
  });

  $('#ai-enabled-toggle').checked = true;
  $('#consent-banner').hidden = true;
}

// ============================================================
// 拦截强度
// ============================================================

async function changeStrength(e) {
  const strength = e.target.value;
  await sendMessage({
    type: MSG_TYPE.SAVE_SETTINGS,
    settings: { strength },
  });
}

// ============================================================
// 规则引擎开关
// ============================================================

async function toggleRules(enabled) {
  await sendMessage({
    type: MSG_TYPE.SAVE_SETTINGS,
    settings: { rulesEnabled: enabled },
  });
}

// ============================================================
// 白名单
// ============================================================

async function loadWhitelist() {
  const settings = await sendMessage({ type: MSG_TYPE.GET_SETTINGS });
  const container = $('#whitelist-container');

  if (!settings.whitelist || settings.whitelist.length === 0) {
    container.innerHTML = '<div class="whitelist-empty">' + t('opt_whitelist_empty') + '</div>';
    return;
  }

  container.innerHTML = '';
  for (const domain of settings.whitelist) {
    const item = document.createElement('div');
    item.className = 'whitelist-item';
    item.innerHTML = `
      <span class="whitelist-domain">${escapeHtml(domain)}</span>
      <button class="btn-remove" data-domain="${escapeHtml(domain)}">${t('opt_remove')}</button>
    `;
    container.appendChild(item);
  }

  container.querySelectorAll('.btn-remove').forEach(btn => {
    btn.addEventListener('click', () => removeWhitelist(btn.dataset.domain));
  });
}

async function addWhitelist() {
  const input = $('#whitelist-input');
  const domain = input.value.trim().toLowerCase();

  if (!domain) return;

  // 简单验证
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(domain)) {
    alert(t('opt_alert_valid_domain'));
    return;
  }

  const settings = await sendMessage({ type: MSG_TYPE.GET_SETTINGS });
  const whitelist = settings.whitelist || [];

  if (whitelist.includes(domain)) {
    alert(t('opt_alert_domain_exists'));
    return;
  }

  whitelist.push(domain);
  await sendMessage({
    type: MSG_TYPE.SAVE_SETTINGS,
    settings: { whitelist },
  });

  input.value = '';
  await loadWhitelist();
}

async function removeWhitelist(domain) {
  const settings = await sendMessage({ type: MSG_TYPE.GET_SETTINGS });
  const whitelist = (settings.whitelist || []).filter(d => d !== domain);
  await sendMessage({
    type: MSG_TYPE.SAVE_SETTINGS,
    settings: { whitelist },
  });
  await loadWhitelist();
}

// ============================================================
// 自定义规则
// ============================================================

async function loadCustomRules() {
  const rules = await sendMessage({ type: MSG_TYPE.GET_CUSTOM_RULES });
  const listEl = $('#custom-rules-list');

  if (!rules || rules.length === 0) {
    listEl.innerHTML = '<div class="custom-rules-empty">' + t('opt_empty_custom_rules') + '</div>';
    return;
  }

  listEl.innerHTML = '';
  for (const rule of rules) {
    const item = document.createElement('div');
    item.className = 'custom-rule-item';
    const typeLabel = rule.type === 'domain' ? t('opt_rule_type_domain_label') : t('opt_rule_type_selector_label');
    const typeClass = rule.type === 'domain' ? 'domain' : 'selector';
    item.innerHTML = `
      <span class="custom-rule-type ${typeClass}">${typeLabel}</span>
      <div class="custom-rule-body">
        <div class="custom-rule-value">${escapeHtml(rule.value)}</div>
        ${rule.comment ? `<div class="custom-rule-comment">${escapeHtml(rule.comment)}</div>` : ''}
      </div>
      <button class="btn-remove-rule" data-id="${rule.id}" title="${t('opt_aria_remove_rule')}" aria-label="${t('opt_aria_remove_rule')}">✕</button>
    `;
    listEl.appendChild(item);
  }

  listEl.querySelectorAll('.btn-remove-rule').forEach(btn => {
    btn.addEventListener('click', () => removeCustomRule(parseInt(btn.dataset.id)));
  });
}

async function addCustomRule() {
  const type = $('#rule-type').value;
  const value = $('#rule-value').value.trim();
  const comment = $('#rule-comment').value.trim();

  if (!value) {
    alert(t('opt_alert_enter_rule'));
    return;
  }

  if (type === 'domain') {
    // 简单域名格式验证
    if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(value)) {
      alert(t('opt_alert_valid_domain_rule'));
      return;
    }
  }

  if (type === 'selector') {
    // 验证 CSS 选择器
    try {
      document.querySelector(value);
    } catch {
      alert(t('opt_alert_invalid_selector'));
      return;
    }
  }

  const result = await sendMessage({
    type: MSG_TYPE.ADD_CUSTOM_RULE,
    type,
    value,
    comment,
  });

  if (result.success) {
    $('#rule-value').value = '';
    $('#rule-comment').value = '';
    await loadCustomRules();
  } else {
    alert(t('opt_alert_add_rule_fail'));
  }
}

async function removeCustomRule(id) {
  if (!confirm(t('opt_confirm_delete_rule'))) return;
  await sendMessage({
    type: MSG_TYPE.REMOVE_CUSTOM_RULE,
    ruleId: id,
  });
  await loadCustomRules();
}

// ============================================================
// 统计（含域名规则库）
// ============================================================

async function loadStats() {
  const stats = await sendMessage({ type: MSG_TYPE.GET_STATS });

  $('#stat-rule-blocks').textContent = stats.ruleBlocks || 0;
  $('#stat-ai-blocks').textContent = stats.aiBlocks || 0;
  $('#stat-ai-calls').textContent = stats.aiCalls || 0;
  $('#stat-cache-hits').textContent = stats.cacheHits || 0;
  $('#stat-domain-hits').textContent = stats.domainRulesHits || 0;
  $('#stat-false-pos').textContent = stats.falsePositives || 0;
  $('#stat-pages').textContent = stats.pagesScanned || 0;
}

async function clearCache() {
  if (!confirm(t('opt_confirm_clear_cache'))) {
    return;
  }
  await sendMessage({ type: MSG_TYPE.CLEAR_CACHE });
  alert(t('opt_alert_cache_cleared'));
  await loadStats();
}

async function clearDomainRules() {
  if (!confirm(t('opt_confirm_clear_domain'))) {
    return;
  }
  await sendMessage({ type: MSG_TYPE.CLEAR_DOMAIN_RULES });
  alert(t('opt_alert_domain_cleared'));
  await loadStats();
}

async function resetStats() {
  if (!confirm(t('opt_confirm_reset_stats'))) {
    return;
  }
  await sendMessage({ type: MSG_TYPE.RESET_STATS });
  await loadStats();
}

// ============================================================
// 事件绑定
// ============================================================

function bindEvents() {
  $('#btn-save-key').addEventListener('click', saveApiKey);
  $('#btn-test-key').addEventListener('click', testApiKey);
  $('#btn-show-key').addEventListener('click', toggleKeyVisibility);

  $('#ai-enabled-toggle').addEventListener('change', (e) => toggleAI(e.target.checked));
  $('#btn-consent').addEventListener('click', handleConsent);

  // 强度选择
  document.querySelectorAll('input[name="strength"]').forEach(radio => {
    radio.addEventListener('change', changeStrength);
  });

  $('#rules-enabled-toggle').addEventListener('change', (e) => toggleRules(e.target.checked));

  $('#btn-add-whitelist').addEventListener('click', addWhitelist);
  $('#whitelist-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') addWhitelist();
  });

  // 自定义规则
  $('#btn-add-rule').addEventListener('click', addCustomRule);
  $('#rule-value').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') addCustomRule();
  });

  $('#btn-clear-cache').addEventListener('click', clearCache);
  $('#btn-clear-domain-rules').addEventListener('click', clearDomainRules);
  $('#btn-reset-stats').addEventListener('click', resetStats);

  // 规则订阅
  $('#btn-add-subscription').addEventListener('click', addCustomSubscription);
  $('#sub-url-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') addCustomSubscription();
  });
  $('#btn-update-all-subs').addEventListener('click', updateAllSubscriptions);

  // API 自定义配置
  $('#btn-save-api-config').addEventListener('click', saveApiConfig);
}

// ============================================================
// 规则订阅管理
// ============================================================

async function loadSubscriptions() {
  const listEl = $('#subscriptions-list');
  if (!listEl) return;

  let subs = [];
  try {
    subs = await sendMessage({ type: 'GET_SUBSCRIPTIONS' });
  } catch (err) {
    console.error('[AdGuardian AI] 获取订阅列表失败:', err.message || err);
    listEl.innerHTML = '<div class="subscriptions-empty">' + t('opt_sub_load_fail') + '</div>';
    return;
  }

  if (!subs || subs.length === 0) {
    listEl.innerHTML = '<div class="subscriptions-empty">' + t('opt_empty_subs') + '</div>';
    return;
  }
  listEl.innerHTML = '';
  for (const sub of subs) {
    const item = document.createElement('div');
    item.className = 'subscription-item';
    const isCustom = !!sub.isCustom;
    item.dataset.id = sub.id;
    item.innerHTML = `
      <div class="subscription-left">
        <label class="toggle subscription-toggle">
          <input type="checkbox" ${sub.enabled ? 'checked' : ''} data-id="${sub.id}">
          <span class="toggle-slider"></span>
        </label>
        <div class="subscription-info">
          <div class="subscription-name">
            ${escapeHtml(sub.name)}
            ${isCustom ? '<span class="subscription-tag">' + t('opt_sub_custom_tag') + '</span>' : '<span class="subscription-tag preset">' + t('opt_sub_preset_tag') + '</span>'}
          </div>
          <div class="subscription-desc">${escapeHtml(sub.description || '')}</div>
          <div class="subscription-meta">
            ${sub.ruleCount > 0 ? sub.ruleCount + ' ' + t('opt_sub_rules_unit') : t('opt_sub_not_downloaded')}
            ${sub.lastUpdated ? ` · ${t('opt_format_updated_at')} ${formatTime(sub.lastUpdated)}` : ''}
            ${sub.error ? ` · <span class="subscription-error">${t('opt_toast_update_fail')}${escapeHtml(sub.error)}</span>` : ''}
          </div>
        </div>
      </div>
      <div class="subscription-actions">
        <button class="btn btn-secondary btn-sm btn-update-sub" data-id="${sub.id}" title="${t('opt_update_btn')}">${t('opt_update_btn')}</button>
        <button class="btn-remove-sub" data-id="${sub.id}" title="${t('opt_aria_remove_sub')}" aria-label="${t('opt_aria_remove_sub')}">✕</button>
      </div>
    `;
    listEl.appendChild(item);
  }

  // 绑定事件
  listEl.querySelectorAll('.subscription-toggle input').forEach(cb => {
    cb.addEventListener('change', async (e) => {
      const id = e.target.dataset.id;
      const card = e.target.closest('.subscription-item');
      const name = card?.querySelector('.subscription-name')?.textContent?.trim() || id;
      e.target.disabled = true;
      try {
        await sendMessage({ type: 'TOGGLE_SUBSCRIPTION', subscriptionId: id, enabled: e.target.checked });
      } catch (err) {
        // 回滚 UI
        e.target.checked = !e.target.checked;
        alert(t('opt_toggle_fail') + err.message);
      } finally {
        e.target.disabled = false;
      }
    });
  });

  listEl.querySelectorAll('.btn-update-sub').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      const id = e.target.dataset.id;
      const original = btn.textContent;
      btn.textContent = t('opt_updating');
      btn.disabled = true;
      try {
        const result = await sendMessage({ type: 'UPDATE_SUBSCRIPTION', subscriptionId: id });
        if (result.success) {
          showToast(t('opt_toast_update_success').replace('{n}', result.ruleCount), 'success');
          // 只刷新元数据，不重建整个列表（避免输入框失焦）
          await refreshSubscriptionItem(id);
        } else {
          showToast(t('opt_toast_update_fail') + result.error, 'error');
        }
      } catch (err) {
        showToast(t('opt_toast_update_fail') + err.message, 'error');
      } finally {
        btn.textContent = original;
        btn.disabled = false;
      }
    });
  });

  // 所有订阅（包括预置）都能删除
  listEl.querySelectorAll('.btn-remove-sub').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      const id = e.target.dataset.id;
      const card = e.target.closest('.subscription-item');
      const name = card?.querySelector('.subscription-name')?.firstChild?.textContent?.trim() || id;
      if (!confirm(t('opt_confirm_delete_sub').replace('{name}', name))) return;
      btn.disabled = true;
      btn.textContent = '...';
      try {
        await sendMessage({ type: 'REMOVE_SUBSCRIPTION', subscriptionId: id });
        // 直接从 DOM 移除该条，避免重建整个列表
        card?.remove();
        // 如果删空了，显示空状态
        if (listEl.children.length === 0) {
          listEl.innerHTML = '<div class="subscriptions-empty">' + t('opt_empty_subs') + '</div>';
        }
        showToast(t('opt_toast_deleted_sub').replace('{name}', name), 'success');
      } catch (err) {
        showToast(t('opt_delete_fail') + err.message, 'error');
        btn.disabled = false;
        btn.textContent = '✕';
      }
    });
  });
}

/** 局部刷新单条订阅卡片（更新按钮调用后不重建整个列表） */
async function refreshSubscriptionItem(subscriptionId) {
  const subs = await sendMessage({ type: 'GET_SUBSCRIPTIONS' });
  const sub = subs.find(s => s.id === subscriptionId);
  if (!sub) return;
  const card = document.querySelector(`.subscription-item[data-id="${subscriptionId}"]`);
  if (!card) return;
  const meta = card.querySelector('.subscription-meta');
  if (meta) {
    meta.innerHTML = `
      ${sub.ruleCount > 0 ? sub.ruleCount + ' ' + t('opt_sub_rules_unit') : t('opt_sub_not_downloaded')}
      ${sub.lastUpdated ? ` · ${t('opt_format_updated_at')} ${formatTime(sub.lastUpdated)}` : ''}
      ${sub.error ? ` · <span class="subscription-error">${t('opt_toast_update_fail')}${escapeHtml(sub.error)}</span>` : ''}
    `;
  }
}

/** 简单 toast 提示（替代 alert 阻塞） */
function showToast(message, type = 'info') {
  const existing = document.querySelector('.toast-notification');
  if (existing) existing.remove();
  const toast = document.createElement('div');
  toast.className = `toast-notification toast-${type}`;
  toast.textContent = message;
  document.body.appendChild(toast);
  // 触发渐入
  requestAnimationFrame(() => toast.classList.add('show'));
  setTimeout(() => {
    toast.classList.remove('show');
    setTimeout(() => toast.remove(), 300);
  }, 2500);
}

async function addCustomSubscription() {
  const name = $('#sub-name-input').value.trim();
  const url = $('#sub-url-input').value.trim();

  if (!name || !url) {
    alert(t('opt_alert_enter_name_url'));
    return;
  }

  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    alert(t('opt_alert_valid_url'));
    return;
  }

  const result = await sendMessage({ type: 'ADD_CUSTOM_SUBSCRIPTION', name, url });
  if (result.success) {
    $('#sub-name-input').value = '';
    $('#sub-url-input').value = '';
    await loadSubscriptions();
  } else {
    alert(t('opt_alert_add_sub_fail') + result.error);
  }
}

async function updateAllSubscriptions() {
  const btn = $('#btn-update-all-subs');
  btn.textContent = t('opt_updating');
  btn.disabled = true;

  const results = await sendMessage({ type: 'UPDATE_ALL_SUBSCRIPTIONS' });

  btn.textContent = t('opt_update_all_sub');
  btn.disabled = false;

  if (results && results.length > 0) {
    const successCount = results.filter(r => r.success).length;
    alert(t('opt_update_complete').replace('{n}', successCount).replace('{m}', results.length));
  }

  await loadSubscriptions();
}

function formatTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const now = new Date();
  const diffMs = now - d;
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return t('opt_format_just_now');
  if (diffMins < 60) return t('opt_format_mins_ago').replace('{n}', diffMins);
  if (diffHours < 24) return t('opt_format_hours_ago').replace('{n}', diffHours);
  if (diffDays < 7) return t('opt_format_days_ago').replace('{n}', diffDays);

  return d.toLocaleDateString();
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

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}
