/**
 * AdGuardian AI - AI Prompt 模板与解析
 * 构建发送给 DeepSeek API 的 prompt，解析返回结果
 */

/**
 * 构建 AI 广告判定 prompt
 * @param {Array} candidates - 候选元素数组
 * @returns {string} 完整 prompt
 */
export function buildPrompt(candidates) {
  const items = candidates.map((c, i) => {
    let features = `[${i + 1}] 标签: ${c.tagClass}
文本: ${c.text}
链接域名: ${c.linkDomain || '无'}
页面类型: ${c.pageType}
匹配方式: ${c.matchType || 'unknown'}`;

    // 新增：img 标签的额外特征
    if (c.imgFeatures) {
      features += `
图片特征: ${c.imgFeatures}`;
    }

    return features;
  }).join('\n\n');

  return `你是广告识别专家。判断以下网页元素是否为广告。

候选元素：
${items}

判断标准：
1. 是否含明确的"广告""推广""赞助""AD"标识
2. 链接是否指向已知广告联盟或推广域名
3. 内容是否为推销性质（商品介绍+购买引导+价格）
4. 结构是否为独立广告位容器（与正文内容区隔）
5. 图片广告特征：
   - 横幅尺寸（如 728x90、960x80、300x250 等）
   - 懒惰加载属性（data-original、data-src、class含 lazy）
   - 图片来自第三方广告 CDN（非当前网站域名）
   - 图片 alt 属性含广告关键词

请对每个元素返回 JSON 数组，格式如下：
{"results":[{"index":1,"is_ad":true,"confidence":0.9,"reason":"该元素含'广告'标识且链接指向推广域名","ad_type":"search"},{"index":2,"is_ad":false,"confidence":0.95,"reason":"正常正文内容","ad_type":null}]}

注意：
- confidence 范围 0.0-1.0
- ad_type 取值: display/search/native/video/null
- reason 用中文一句话说明
- 只返回 JSON，不要其他文字`;
}

/**
 * 解析 AI 返回结果
 * @param {string} content - API 返回的 content
 * @returns {Array|null} 解析后的结果数组
 */
export function parseAIResponse(content) {
  if (!content) return null;

  // 先尝试直接解析整个内容
  let parsed;
  try {
    parsed = JSON.parse(content);
    // 成功解析，直接返回
    return normalizeResults(parsed);
  } catch {
    // 直接解析失败，尝试提取 JSON 块
  }

  // 尝试提取 ```json ... ``` 代码块（AI 常用格式）
  const codeBlockMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (codeBlockMatch) {
    try {
      parsed = JSON.parse(codeBlockMatch[1].trim());
      return normalizeResults(parsed);
    } catch {
      // 代码块解析失败，继续尝试
    }
  }

  // 尝试提取数组 [...]
  const arrayMatch = content.match(/\[([\s\S]*?)\]/);
  if (arrayMatch) {
    try {
      parsed = JSON.parse(`[${arrayMatch[1]}]`);
      return normalizeResults(parsed);
    } catch {
      // 数组解析失败，继续尝试
    }
  }

  // 最后尝试提取对象 {...}（非贪婪）
  const objectMatch = content.match(/\{[\s\S]*?\}/);
  if (objectMatch) {
    try {
      parsed = JSON.parse(objectMatch[0]);
      return normalizeResults(parsed);
    } catch {
      return null;
    }
  }

  return null;
}

/** 归一化结果格式（兼容 {results: [...]} 和直接数组） */
function normalizeResults(parsed) {
  if (Array.isArray(parsed)) return parsed;
  if (parsed && Array.isArray(parsed.results)) return parsed.results;
  // 如果是单个对象且包含 index，包装成数组
  if (parsed && typeof parsed.index === 'number') return [parsed];
  return null;
}

/**
 * 从单个元素提取特征
 * @param {Object} element - 候选元素特征
 * @returns {Object} 提炼后的特征
 */
export function extractFeatures(element) {
  return {
    tagClass: `${element.tagName}.${element.className}`.slice(0, 200),
    text: (element.text || '').slice(0, 500),
    linkDomain: element.linkDomain || '',
    pageType: element.pageType || 'unknown',
  };
}

/**
 * 简易文本哈希（用于缓存指纹）
 * 非加密用途，只需一致性
 */
export function textHash(text) {
  if (!text) return '';
  let hash = 0;
  for (let i = 0; i < text.length; i++) {
    const char = text.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & 0xFFFFFFFF;
  }
  return Math.abs(hash).toString(36);
}
