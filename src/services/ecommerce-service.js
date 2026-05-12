/**
 * 跨境电商需求挖掘 — 电商平台数据采集
 * 数据源: Amazon, AliExpress, Shopee, eBay
 * 
 * 目标: 发现热卖产品 + 差评中的未满足需求信号
 * 技术: 原生 fetch + 正则解析 HTML, 无需额外依赖
 */
import { getDb } from '../db/init.js';

const USER_AGENT = process.env.ECOMMERCE_USER_AGENT ||
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

const TIMEOUT_MS = 15000; // 15秒超时
const DELAY_MS = 1200;    // 请求间隔1.2秒

/** 带超时的 fetch */
async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: {
        'User-Agent': USER_AGENT,
        'Accept': 'text/html,application/json,*/*',
        'Accept-Language': 'en-US,en;q=0.9',
        ...(options.headers || {})
      }
    });
    return res;
  } finally {
    clearTimeout(timer);
  }
}

/** 请求间隔延迟 */
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/** 安全获取文本: 清理HTML实体和多余空白 */
function cleanText(s) {
  if (!s) return '';
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 解析数字: "1,234" -> 1234 */
function parseNum(s) {
  if (!s) return 0;
  const n = parseInt(String(s).replace(/[^0-9]/g, ''), 10);
  return isNaN(n) ? 0 : n;
}

/** 解析价格: "$12.99" -> 12.99 */
function parsePrice(s) {
  if (!s) return 0;
  const m = String(s).match(/[\d,.]+/);
  return m ? parseFloat(m[0].replace(/,/g, '')) : 0;
}

/** 垃圾信号过滤：判断内容是否为网页元素而非真实商品 */
const GARBAGE_PATTERNS = [
  /^pagination$/i, /^next page$/i, /^previous/i, /^page \d/i,
  /^sort by/i, /^filter by/i, /^results for/i, /^search/i,
  /^browse by/i, /^categories$/i, /^department$/i,
  /^back to top$/i, /^back to results$/i, /^add to cart$/i,
  /^\d+\s*(results|items|products)\s*(found|available)/i,
  /^best sellers in/i, /^new releases in/i,
];

function isGarbageSignal(title, body) {
  if (!title || title.trim().length < 5) return true;
  const combined = (title + ' ' + (body || '')).toLowerCase();
  for (const p of GARBAGE_PATTERNS) {
    if (p.test(combined)) return true;
  }
  return false;
}

/** 统一入库 */
function insertItems(db, items) {
  const insertPost = db.prepare(`
    INSERT OR IGNORE INTO demand_posts (source, source_url, subreddit, title, body, author, upvotes, comments_count, posted_at, raw_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  let newCount = 0;
  for (const item of items) {
    if (!item.title) continue;
    if (isGarbageSignal(item.title, item.body || '')) {
      console.log(`  🗑️ 垃圾信号过滤: "${item.title.substring(0, 50)}"`);
      continue;
    }
    const result = insertPost.run(
      item.source,
      item.source_url || '',
      item.subreddit || '',
      item.title.substring(0, 500),
      (item.body || '').substring(0, 5000),
      item.author || '',
      item.upvotes || 0,
      item.comments_count || 0,
      item.posted_at || new Date().toISOString(),
      item.raw_json || '{}'
    );
    if (result.changes > 0) newCount++;
  }
  return newCount;
}

// ============================================================
//  Amazon 数据源
// ============================================================

/**
 * 爬取 Amazon Best Sellers 页面
 * 按品类逐个采集
 */
const AMAZON_CATEGORIES = [
  { name: 'Electronics', url: 'https://www.amazon.com/Best-Sellers-Electronics/zgbs/electronics' },
  { name: 'Home & Kitchen', url: 'https://www.amazon.com/Best-Sellers-Home-Kitchen/zgbs/home-garden' },
  { name: 'Sports & Outdoors', url: 'https://www.amazon.com/Best-Sellers-Sports-Outdoors/zgbs/sporting-goods' },
  { name: 'Toys & Games', url: 'https://www.amazon.com/Best-Sellers-Toys-Games/zgbs/toys-and-games' },
  { name: 'Health & Personal Care', url: 'https://www.amazon.com/Best-Sellers-Health-Personal-Care/zgbs/hpc' },
  { name: 'Beauty', url: 'https://www.amazon.com/Best-Sellers-Beauty/zgbs/beauty' },
  { name: 'Pet Supplies', url: 'https://www.amazon.com/Best-Sellers-Pet-Supplies/zgbs/pet-supplies' },
  { name: 'Baby', url: 'https://www.amazon.com/Best-Sellers-Baby/zgbs/baby-products' },
  { name: 'Clothing', url: 'https://www.amazon.com/Best-Sellers-Clothing/zgbs/fashion' },
  { name: 'Garden & Outdoor', url: 'https://www.amazon.com/Best-Sellers-Garden-Outdoor/zgbs/lawn-garden' },
];

/**
 * 爬取 Amazon Movers & Shakers 页面
 */
const AMAZON_MOVERS_CATEGORIES = [
  { name: 'Electronics', url: 'https://www.amazon.com/gp/movers-and-shakers/electronics' },
  { name: 'Home & Kitchen', url: 'https://www.amazon.com/gp/movers-and-shakers/home-garden' },
  { name: 'Sports & Outdoors', url: 'https://www.amazon.com/gp/movers-and-shakers/sporting-goods' },
  { name: 'Toys & Games', url: 'https://www.amazon.com/gp/movers-and-shakers/toys-and-games' },
];

/**
 * 从 Amazon HTML 中提取产品信息
 * Amazon 的页面结构: p13n-sc-truncate-desktop-type2 包含标题, a-link-normal 等
 */
function parseAmazonProducts(html, categoryName, sourceUrl) {
  const items = [];

  // 策略1: 匹配 product grid items (Best Sellers 格式)
  // 每个产品通常在 <div> 中包含 data-asin 属性
  const productBlocks = html.split(/<div[^>]*role="listitem"[^>]*>/i);
  
  if (productBlocks.length < 2) {
    // 回退策略: 用 data-asin 分割
    const asinBlocks = [];
    const asinRe = /data-asin="([A-Z0-9]{10})"/g;
    let m;
    while ((m = asinRe.exec(html)) !== null) {
      // 找到周围5000字符作为产品上下文
      const idx = m.index;
      const context = html.substring(Math.max(0, idx - 500), Math.min(html.length, idx + 3000));
      asinBlocks.push({ asin: m[1], context });
    }

    for (const block of asinBlocks) {
      const item = extractAmazonItem(block.context, categoryName, `https://www.amazon.com/dp/${block.asin}`);
      if (item) items.push(item);
    }
    return items;
  }

  for (let i = 1; i < productBlocks.length; i++) {
    const block = productBlocks[i];
    const asinMatch = block.match(/data-asin="([A-Z0-9]{10})"/);
    const asin = asinMatch ? asinMatch[1] : null;
    const url = asin ? `https://www.amazon.com/dp/${asin}` : sourceUrl;

    const item = extractAmazonItem(block, categoryName, url);
    if (item) items.push(item);
  }

  return items;
}

function extractAmazonItem(html, categoryName, url) {
  // 提取标题
  let title = '';
  // 多种标题提取策略
  const titlePatterns = [
    /<img[^>]*alt="([^"]{10,200})"/i,
    /aria-label="([^"]{10,200})"/i,
    /class="[^"]*p13n-sc-truncate[^"]*"[^>]*>([\s\S]*?)<\/span>/i,
    /class="[^"]*a-text-normal[^"]*"[^>]*>([\s\S]*?)<\/span>/i,
  ];
  for (const pat of titlePatterns) {
    const m = html.match(pat);
    if (m && m[1] && m[1].length > 5) {
      title = cleanText(m[1]);
      break;
    }
  }
  if (!title) return null;

  // 提取评分
  const ratingMatch = html.match(/(\d+\.?\d*)\s*out of\s*5/i);
  const rating = ratingMatch ? parseFloat(ratingMatch[1]) : 0;

  // 提取评论数
  const reviewsMatch = html.match(/([\d,]+)\s*(ratings?|reviews?|global reviews)/i);
  const reviewsCount = reviewsMatch ? parseNum(reviewsMatch[1]) : 0;

  // 提取价格
  const priceMatch = html.match(/\$([\d,.]+)/);
  const price = priceMatch ? parsePrice(priceMatch[0]) : 0;

  // 提取品牌/卖家
  let brand = '';
  const brandMatch = html.match(/(?:by|Brand:|Visit the)\s+([A-Z][A-Za-z0-9\s&]{2,30})(?:Store|<\/)/i);
  if (brandMatch) brand = cleanText(brandMatch[1]);

  // 构建 body: 包含价格、评分、评论的辅助信息
  let body = '';
  if (price > 0) body += `Price: $${price}`;
  if (rating > 0) body += `${body ? ' | ' : ''}Rating: ${rating}/5`;
  if (reviewsCount > 0) body += `${body ? ' | ' : ''}Reviews: ${reviewsCount}`;
  if (brand) body += `${body ? ' | ' : ''}Brand: ${brand}`;

  // 计算销量代理值: 用评论数估算 (通常评论数 ≈ 销量的 1-5%)
  const estimatedSales = reviewsCount > 0 ? Math.round(reviewsCount * 20) : 0;

  return {
    source: 'amazon',
    source_url: url,
    subreddit: `Amazon/${categoryName}`,
    title,
    body,
    author: brand || 'Unknown',
    upvotes: estimatedSales,     // 估算销量
    comments_count: reviewsCount, // 真实评论数
    posted_at: new Date().toISOString(),
    raw_json: JSON.stringify({ rating, price, brand, estimatedSales })
  };
}

export async function collectAmazon(limit = 50) {
  console.log('\n🛒 ===== Amazon 数据采集 =====');
  const db = getDb();
  let allItems = [];

  // 1. Best Sellers
  const bsCount = Math.min(limit, 30);
  const categories = AMAZON_CATEGORIES.slice(0, Math.ceil(bsCount / 5));
  
  for (const cat of categories) {
    console.log(`  📡 Amazon Best Sellers - ${cat.name} ...`);
    try {
      await sleep(DELAY_MS);
      const res = await fetchWithTimeout(cat.url, {
        headers: { 'Accept': 'text/html' }
      });
      if (res.ok) {
        const html = await res.text();
        const items = parseAmazonProducts(html, cat.name, cat.url);
        console.log(`     ✅ 解析到 ${items.length} 个产品`);
        allItems.push(...items.slice(0, 5));
      } else {
        console.log(`     ⚠️ HTTP ${res.status}`);
      }
    } catch (e) {
      console.log(`     ⚠️ 失败: ${e.message}`);
    }
    if (allItems.length >= limit) break;
  }

  // 2. Movers & Shakers
  if (allItems.length < limit) {
    const moversCats = AMAZON_MOVERS_CATEGORIES;
    for (const cat of moversCats) {
      console.log(`  📡 Amazon Movers & Shakers - ${cat.name} ...`);
      try {
        await sleep(DELAY_MS);
        const res = await fetchWithTimeout(cat.url, {
          headers: { 'Accept': 'text/html' }
        });
        if (res.ok) {
          const html = await res.text();
          const items = parseAmazonProducts(html, `${cat.name} (Trending)`, cat.url);
          console.log(`     ✅ 解析到 ${items.length} 个产品`);
          allItems.push(...items.slice(0, 3));
        } else {
          console.log(`     ⚠️ HTTP ${res.status}`);
        }
      } catch (e) {
        console.log(`     ⚠️ 失败: ${e.message}`);
      }
      if (allItems.length >= limit) break;
    }
  }

  // 限制数量
  allItems = allItems.slice(0, limit);

  // 入库
  const newCount = insertItems(db, allItems);
  console.log(`  📊 Amazon 总计: ${allItems.length} 条, 新增 ${newCount} 条`);

  return { source: 'amazon', total: allItems.length, new: newCount, items: allItems };
}

// ============================================================
//  AliExpress 数据源
// ============================================================

/**
 * AliExpress 热卖产品采集
 * 使用公开的搜索 API (按销量排序)
 */
const ALIEXPRESS_CATEGORIES = [
  { name: 'Electronics', keyword: 'smart watch' },
  { name: 'Home & Garden', keyword: 'home decor' },
  { name: 'Sports', keyword: 'fitness' },
  { name: 'Toys', keyword: 'toys' },
  { name: 'Beauty', keyword: 'makeup' },
];

async function fetchAliExpressSearch(keyword, categoryName) {
  // AliExpress 搜索 API: 按订单数排序
  const url = `https://www.aliexpress.com/wholesale?SearchText=${encodeURIComponent(keyword)}&SortType=total_tranpro_desc&page=1&g=y`;
  
  const res = await fetchWithTimeout(url, {
    headers: {
      'Accept': 'text/html',
      'Referer': 'https://www.aliexpress.com/'
    }
  });

  if (!res.ok) return [];

  const html = await res.text();
  const items = [];

  // 策略: 尝试从嵌入的 JSON (window.runParams) 中提取
  // AliExpress 在页面中嵌入产品数据的常见模式
  const jsonMatch = html.match(/window\.runParams\s*=\s*(\{[\s\S]*?\});/);
  if (jsonMatch) {
    try {
      const data = JSON.parse(jsonMatch[1]);
      const products = data?.mods?.itemList?.content || data?.resultList || data?.items || [];
      for (const p of products) {
        const title = cleanText(p.title || p.subject || '');
        if (!title || title.length < 5) continue;
        
        items.push({
          source: 'aliexpress',
          source_url: p.productDetailUrl || p.itemUrl || `https://www.aliexpress.com/item/${p.productId}.html`,
          subreddit: `AliExpress/${categoryName}`,
          title,
          body: `Orders: ${p.orders || 0} | Rating: ${p.averageStar || p.rating || 0}/5 | Price: $${p.minPrice || p.price || '?'}`,
          author: p.storeName || p.sellerName || 'Unknown',
          upvotes: parseNum(p.orders) || 0,
          comments_count: parseNum(p.feedbackCount || p.evaluationCount) || 0,
          posted_at: new Date().toISOString(),
          raw_json: JSON.stringify({ rating: p.averageStar, price: p.minPrice, orders: p.orders })
        });
      }
      return items;
    } catch {}
  }

  // 策略2: 正则提取产品卡片
  // 匹配产品标题和订单数
  const cardPattern = /<a[^>]*href="[^"]*\/item\/\d+\.html"[^>]*>([\s\S]*?)<\/a>/gi;
  const orderPattern = /(\d+)\s*sold/gi;
  const pricePattern = /US\s*\$([\d,.]+)/gi;

  // 简单正则提取 (降级策略)
  const titleMatches = html.match(/<h1[^>]*>([^<]{10,200})<\/h1>/gi) || [];
  for (const tm of titleMatches) {
    const title = cleanText(tm.replace(/<[^>]+>/g, ''));
    if (title.length > 10 && title.length < 200 && !title.includes('html')) {
      items.push({
        source: 'aliexpress',
        source_url: '',
        subreddit: `AliExpress/${categoryName}`,
        title,
        body: '',
        author: 'Unknown',
        upvotes: 0,
        comments_count: 0,
        posted_at: new Date().toISOString(),
        raw_json: '{}'
      });
    }
  }

  return items.slice(0, 5);
}

export async function collectAliExpress(limit = 30) {
  console.log('\n🛒 ===== AliExpress 数据采集 =====');
  const db = getDb();
  let allItems = [];

  const cats = ALIEXPRESS_CATEGORIES.slice(0, Math.ceil(limit / 5));
  for (const cat of cats) {
    console.log(`  📡 AliExpress - ${cat.name} (关键词: ${cat.keyword}) ...`);
    try {
      await sleep(DELAY_MS);
      const items = await fetchAliExpressSearch(cat.keyword, cat.name);
      console.log(`     ✅ 解析到 ${items.length} 个产品`);
      allItems.push(...items);
    } catch (e) {
      console.log(`     ⚠️ 失败: ${e.message}`);
    }
    if (allItems.length >= limit) break;
  }

  allItems = allItems.slice(0, limit);
  const newCount = insertItems(db, allItems);
  console.log(`  📊 AliExpress 总计: ${allItems.length} 条, 新增 ${newCount} 条`);

  return { source: 'aliexpress', total: allItems.length, new: newCount, items: allItems };
}

// ============================================================
//  Shopee 数据源
// ============================================================

/**
 * Shopee 多个站点热门商品采集
 */
const SHOPEE_REGIONS = [
  { name: 'Malaysia', domain: 'shopee.com.my', currency: 'MYR' },
  { name: 'Indonesia', domain: 'shopee.co.id', currency: 'IDR' },
  { name: 'Philippines', domain: 'shopee.ph', currency: 'PHP' },
  { name: 'Singapore', domain: 'shopee.sg', currency: 'SGD' },
  { name: 'Thailand', domain: 'shopee.co.th', currency: 'THB' },
  { name: 'Vietnam', domain: 'shopee.vn', currency: 'VND' },
  { name: 'Brazil', domain: 'shopee.com.br', currency: 'BRL' },
];

async function fetchShopeeRegion(region) {
  const items = [];

  // 策略1: 使用 Shopee 公开的推荐/搜索 API
  const apiUrls = [
    `https://${region.domain}/api/v4/recommend/search?limit=20&offset=0`,
    `https://${region.domain}/api/v4/search/search_items?by=pop&keyword=&limit=20&newest=0&order=desc&page_type=search`,
  ];

  for (const apiUrl of apiUrls) {
    try {
      const res = await fetchWithTimeout(apiUrl, {
        headers: {
          'Accept': 'application/json',
          'Referer': `https://${region.domain}/`,
          'X-Requested-With': 'XMLHttpRequest',
        }
      });

      if (!res.ok) continue;

      const data = await res.json();
      const products = data?.data?.sections?.[0]?.data?.item ||
                       data?.items ||
                       data?.data?.items ||
                       data?.data?.recommend_info ||
                       [];

      for (const p of products) {
        const name = cleanText(p.name || p.title || '');
        if (!name || name.length < 3) continue;

        const price = p.price ? (p.price / 100000).toFixed(2) : '?';
        const sold = p.sold || p.historical_sold || p.sold_count || 0;
        const rating = p.item_rating?.rating_star || p.rating_star || p.rating || 0;
        const shopName = p.shop_name || p.shop_name || 'Unknown';
        const reviewCount = p.cmt_count || p.item_rating?.rating_count?.[0] || p.review_count || 0;
        const itemId = p.itemid || p.item_id || p.shopid + '.' + p.itemid;
        const url = `https://${region.domain}/product/${itemId}`;

        items.push({
          source: 'shopee',
          source_url: url,
          subreddit: `Shopee/${region.name}`,
          title: name,
          body: `Price: ${price} ${region.currency} | Sold: ${sold} | Rating: ${rating}/5 | Reviews: ${reviewCount}`,
          author: shopName,
          upvotes: parseNum(sold),
          comments_count: parseNum(reviewCount),
          posted_at: new Date().toISOString(),
          raw_json: JSON.stringify({ price, rating, sold: parseNum(sold), shop: shopName })
        });
      }

      if (items.length > 0) break;
    } catch {
      continue;
    }
  }

  return items.slice(0, 5);
}

export async function collectShopee(limit = 35) {
  console.log('\n🛒 ===== Shopee 数据采集 =====');
  const db = getDb();
  let allItems = [];

  const regions = SHOPEE_REGIONS.slice(0, Math.ceil(limit / 5));
  for (const region of regions) {
    console.log(`  📡 Shopee ${region.name} (${region.domain}) ...`);
    try {
      await sleep(DELAY_MS);
      const items = await fetchShopeeRegion(region);
      console.log(`     ✅ 解析到 ${items.length} 个产品`);
      allItems.push(...items);
    } catch (e) {
      console.log(`     ⚠️ 失败: ${e.message}`);
    }
    if (allItems.length >= limit) break;
  }

  allItems = allItems.slice(0, limit);
  const newCount = insertItems(db, allItems);
  console.log(`  📊 Shopee 总计: ${allItems.length} 条, 新增 ${newCount} 条`);

  return { source: 'shopee', total: allItems.length, new: newCount, items: allItems };
}

// ============================================================
//  eBay 数据源
// ============================================================

/**
 * eBay Trending / Best Selling 产品采集
 */
const EBAY_CATEGORIES = [
  { name: 'Electronics', id: '293', url: 'https://www.ebay.com/b/Electronics/bn_7000259124' },
  { name: 'Fashion', id: '11450', url: 'https://www.ebay.com/b/Fashion/bn_7000259853' },
  { name: 'Home & Garden', id: '11700', url: 'https://www.ebay.com/b/Home-Garden/bn_7000259562' },
  { name: 'Sporting Goods', id: '888', url: 'https://www.ebay.com/b/Sporting-Goods/bn_7000260281' },
  { name: 'Toys', id: '220', url: 'https://www.ebay.com/b/Toys-Hobbies/bn_7000259629' },
];

async function fetchEbayCategory(cat) {
  const items = [];

  // 策略1: eBay Trending 页面 (服务器渲染)
  const urls = [
    cat.url,
    `https://www.ebay.com/b/${cat.name.replace(/\s+/g, '-')}/bn_${cat.id}`,
  ];

  for (const pageUrl of urls) {
    try {
      const res = await fetchWithTimeout(pageUrl, {
        headers: { 'Accept': 'text/html' }
      });

      if (!res.ok) continue;
      const html = await res.text();

      // 提取产品列表项
      // eBay 商品通常在 <li> 或 <div> 中包含 s-item 类
      const itemBlocks = html.split(/<li[^>]*class="[^"]*s-item[^"]*"[^>]*>/i);
      
      if (itemBlocks.length > 1) {
        for (let i = 1; i < itemBlocks.length; i++) {
          const block = itemBlocks[i];
          if (i > 10) break; // 每页最多10个

          // 提取标题
          const titleMatch = block.match(/class="[^"]*s-item__title[^"]*"[^>]*>([^<]{10,200})</i);
          if (!titleMatch) continue;
          const title = cleanText(titleMatch[1]);
          if (!title || title.toLowerCase().includes('shop on ebay') || title.toLowerCase().includes('new listing')) continue;

          // 提取链接
          const linkMatch = block.match(/href="([^"]*\d{8,}[^"]*)"/i);
          const url = linkMatch ? linkMatch[1] : pageUrl;

          // 提取价格
          const priceMatch = block.match(/\$([\d,.]+)/);
          const price = priceMatch ? parsePrice(priceMatch[0]) : 0;

          // 提取已售数量
          const soldMatch = block.match(/([\d,]+)\s*sold/i);
          const sold = soldMatch ? parseNum(soldMatch[1]) : 0;

          // 提取卖家
          const sellerMatch = block.match(/class="[^"]*s-item__seller[^"]*"[^>]*>([^<]+)</i);
          const seller = sellerMatch ? cleanText(sellerMatch[1]) : 'Unknown';

          items.push({
            source: 'ebay',
            source_url: url,
            subreddit: `eBay/${cat.name}`,
            title,
            body: `Price: $${price || '?'} | Sold: ${sold || 0} | Seller: ${seller}`,
            author: seller,
            upvotes: sold,
            comments_count: 0, // eBay 没有评论数，用已售数
            posted_at: new Date().toISOString(),
            raw_json: JSON.stringify({ price, sold, seller })
          });
        }
        break;
      }

      // 策略2: 简单的正则提取
      const titleMatches = [...html.matchAll(/<h3[^>]*class="[^"]*s-item__title[^"]*"[^>]*>([^<]+)<\/h3>/gi)];
      for (const m of titleMatches.slice(0, 10)) {
        const title = cleanText(m[1]);
        if (!title || title.length < 10) continue;
        items.push({
          source: 'ebay',
          source_url: pageUrl,
          subreddit: `eBay/${cat.name}`,
          title,
          body: '',
          author: 'Unknown',
          upvotes: 0,
          comments_count: 0,
          posted_at: new Date().toISOString(),
          raw_json: '{}'
        });
      }
      if (items.length > 0) break;
    } catch {
      continue;
    }
  }

  return items.slice(0, 5);
}

export async function collectEbay(limit = 25) {
  console.log('\n🛒 ===== eBay 数据采集 =====');
  const db = getDb();
  let allItems = [];

  const cats = EBAY_CATEGORIES.slice(0, Math.ceil(limit / 5));
  for (const cat of cats) {
    console.log(`  📡 eBay - ${cat.name} ...`);
    try {
      await sleep(DELAY_MS);
      const items = await fetchEbayCategory(cat);
      console.log(`     ✅ 解析到 ${items.length} 个产品`);
      allItems.push(...items);
    } catch (e) {
      console.log(`     ⚠️ 失败: ${e.message}`);
    }
    if (allItems.length >= limit) break;
  }

  allItems = allItems.slice(0, limit);
  const newCount = insertItems(db, allItems);
  console.log(`  📊 eBay 总计: ${allItems.length} 条, 新增 ${newCount} 条`);

  return { source: 'ebay', total: allItems.length, new: newCount, items: allItems };
}

// ============================================================
//  统一采集入口
// ============================================================

/**
 * 采集所有电商平台数据
 * @param {number} limit - 每个平台上限 (总上限约为 limit*4)
 */
export async function collectAllEcommerce(limit = 25) {
  console.log('\n╔══════════════════════════════════════╗');
  console.log('║   🛒 电商需求挖掘引擎启动             ║');
  console.log('╚══════════════════════════════════════╝');

  const perPlatform = Math.max(10, Math.floor(limit / 2));
  const results = {};

  // Amazon暂禁用（fetch反爬只产垃圾，需Playwright升级）
  results.amazon = { source: 'amazon', total: 0, new: 0, items: [], note: 'Amazon暂时禁用（需Playwright升级）' };

  // try {
  //   results.amazon = await collectAmazon(perPlatform);
  // } catch (e) {
  //   console.error('Amazon 采集失败:', e.message);
  //   results.amazon = { source: 'amazon', total: 0, new: 0, items: [], error: e.message };
  // }

  try {
    results.aliexpress = await collectAliExpress(perPlatform);
  } catch (e) {
    console.error('AliExpress 采集失败:', e.message);
    results.aliexpress = { source: 'aliexpress', total: 0, new: 0, items: [], error: e.message };
  }

  try {
    results.shopee = await collectShopee(perPlatform);
  } catch (e) {
    console.error('Shopee 采集失败:', e.message);
    results.shopee = { source: 'shopee', total: 0, new: 0, items: [], error: e.message };
  }

  try {
    results.ebay = await collectEbay(perPlatform);
  } catch (e) {
    console.error('eBay 采集失败:', e.message);
    results.ebay = { source: 'ebay', total: 0, new: 0, items: [], error: e.message };
  }

  const totalItems = (results.amazon?.total || 0) + (results.aliexpress?.total || 0) +
                     (results.shopee?.total || 0) + (results.ebay?.total || 0);
  const totalNew = (results.amazon?.new || 0) + (results.aliexpress?.new || 0) +
                   (results.shopee?.new || 0) + (results.ebay?.new || 0);

  console.log(`\n╔══════════════════════════════════════╗`);
  console.log(`║ 📊 电商采集汇总                      ║`);
  console.log(`║ 总计: ${totalItems} 条 | 新增: ${totalNew} 条   ║`);
  console.log(`║ Amazon: ${results.amazon?.total || 0} AliExpress: ${results.aliexpress?.total || 0} ║`);
  console.log(`║ Shopee: ${results.shopee?.total || 0} eBay: ${results.ebay?.total || 0} ║`);
  console.log(`╚══════════════════════════════════════╝`);

  return {
    total: totalItems,
    new: totalNew,
    results
  };
}
