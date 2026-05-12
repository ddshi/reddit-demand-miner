/**
 * Reddit需求矿工 — Reddit社区采集引擎
 * 数据源: Reddit JSON API (免费) — 电商选品相关子版块
 * 
 * 代理配置:
 *   设置环境变量 HTTP_PROXY=http://127.0.0.1:7890 即可通过代理访问Reddit
 *   国内用户用梯子代理端口即可抓取Reddit数据
 */
import { getDb } from '../db/init.js';
import { HttpsProxyAgent } from 'https-proxy-agent';

const USER_AGENT = process.env.REDDIT_USER_AGENT || 'RedditDemandMiner/1.0';
const PROXY_URL = process.env.HTTP_PROXY || process.env.HTTPS_PROXY || null;

/**
 * 智能fetch：被封的国外数据源走代理，国内可访问的直连
 */
function smartFetch(url, options = {}) {
  const opts = { ...options };

  // Reddit & Product Hunt 在国内被墙，需要代理
  const needsProxy = PROXY_URL && (
    url.includes('reddit.com') ||
    url.includes('producthunt.com')
  );

  if (needsProxy) {
    opts.dispatcher = new HttpsProxyAgent(PROXY_URL);
  }

  return fetch(url, opts);
}

/**
 * ============ Reddit 数据源 ============
 * 使用公开 JSON API，无需OAuth
 */

/** 垃圾信号过滤：判断Reddit帖子是否为真实选品信号 */
const GARBAGE_TITLES = [
  /^weekly.*(thread|discussion|chat)/i,
  /^(sticky|mod|announcement).*post/i,
  /^(daily|weekly|monthly).*(question|thread|post)/i,
  /come shop with me/i,
  /rate my store/i,
  /how do i start/i,
  /is (it|this) worth it\?$/i,
  /should i (sell|buy|start)/i,
];

function isRedditGarbage(title, body) {
  if (!title || title.trim().length < 8) return true;
  const t = title.toLowerCase();
  for (const p of GARBAGE_TITLES) {
    if (p.test(t)) return true;
  }
  return false;
}

// 电商选品相关子版块 — 跨境电商卖家需求信号
const REDDIT_SUBREDDITS = [
  'AmazonFBA',        // 亚马逊卖家讨论选品
  'ecommerce',        // 电商趋势
  'dropship',         // 代发货选品
  'BuyItForLife',     // 耐用品需求（反向工程）
  'shopify',          // 独立站卖家
  'smallbusiness',    // 小生意选品
  'Flipping',         // 二手转卖趋势
  'Entrepreneur',     // 创业选品思路
];

/**
 * 拉取单个Subreddit的热门帖子
 */
export async function fetchRedditSubreddit(subreddit, limit = 25) {
  const url = `https://www.reddit.com/r/${subreddit}/hot.json?limit=${limit}&raw_json=1`;
  console.log(`  📡 Reddit r/${subreddit} ...`);

  try {
    const res = await smartFetch(url, {
      headers: { 'User-Agent': USER_AGENT }
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const data = await res.json();
    const posts = (data?.data?.children || []).map(c => c.data);

    return posts.filter(p => !p.stickied && !p.promoted && p.title);
  } catch (e) {
    console.log(`  ⚠️ r/${subreddit} 失败: ${e.message}`);
    return [];
  }
}

/**
 * 拉取帖子的评论
 */
export async function fetchRedditComments(permalink, limit = 50) {
  const url = `https://www.reddit.com${permalink}.json?limit=${limit}&raw_json=1`;

  try {
    const res = await smartFetch(url, {
      headers: { 'User-Agent': USER_AGENT }
    });
    if (!res.ok) return [];

    const data = await res.json();
    const comments = data?.[1]?.data?.children || [];
    return comments
      .filter(c => c.kind === 't1' && c.data?.body)
      .map(c => ({
        author: c.data.author || '[deleted]',
        body: c.data.body,
        upvotes: c.data.ups || 0,
        posted_at: new Date(c.data.created_utc * 1000).toISOString()
      }));
  } catch (e) {
    return [];
  }
}

/**
 * ============ Hacker News 数据源 ============
 */
export async function fetchHackerNews(limit = 30) {
  console.log('  📡 Hacker News (Show HN / Ask HN) ...');

  try {
    const queries = [
      'https://hn.algolia.com/api/v1/search_by_date?tags=show_hn&hitsPerPage=15',
      'https://hn.algolia.com/api/v1/search_by_date?tags=ask_hn&hitsPerPage=15'
    ];

    const results = [];
    for (const url of queries) {
      const res = await fetch(url);
      if (res.ok) {
        const data = await res.json();
        for (const hit of (data.hits || [])) {
          results.push({
            source: 'hackernews',
            source_url: hit.url || `https://news.ycombinator.com/item?id=${hit.objectID}`,
            subreddit: hit._tags?.includes('show_hn') ? 'Show HN' : 'Ask HN',
            title: hit.title || '',
            body: hit.story_text || hit.comment_text || '',
            author: hit.author || '',
            upvotes: hit.points || 0,
            comments_count: hit.num_comments || 0,
            posted_at: hit.created_at || '',
          });
        }
      }
    }
    return results;
  } catch (e) {
    console.log('  ⚠️ HN失败: ' + e.message);
    return [];
  }
}

/**
 * ============ Product Hunt 数据源 ============
 */
export async function fetchProductHunt(limit = 20) {
  console.log('  📡 Product Hunt ...');

  try {
    const url = 'https://www.producthunt.com/feed';
    const res = await smartFetch(url, {
      headers: {
        'User-Agent': USER_AGENT,
        'Accept': 'application/json'
      }
    });

    if (res.ok) {
      const html = await res.text();
      const jsonMatch = html.match(/window\.__APOLLO_STATE__\s*=\s*(\{.+?\});<\/script>/s);
      if (jsonMatch) {
        const state = JSON.parse(jsonMatch[1]);
        const posts = [];
        for (const [key, val] of Object.entries(state)) {
          if (val?.__typename === 'Post' && val.name) {
            posts.push({
              source: 'producthunt',
              source_url: val.url || `https://www.producthunt.com/posts/${val.slug}`,
              subreddit: 'Product Hunt',
              title: `${val.name} — ${val.tagline || ''}`,
              body: val.description || '',
              author: val.user ? (state[val.user?.__ref]?.name || '') : '',
              upvotes: val.votesCount || 0,
              comments_count: val.commentsCount || 0,
              posted_at: val.createdAt || '',
            });
          }
        }
        return posts.slice(0, limit);
      }
    }
    return [];
  } catch (e) {
    console.log('  ⚠️ PH失败: ' + e.message);
    return [];
  }
}

/**
 * ============ V2EX 数据源 ============
 */
export async function fetchV2ex() {
  console.log('  📡 V2EX (创意/分享创造) ...');

  try {
    const res = await fetch('https://www.v2ex.com/api/topics/show.json?node_name=create', {
      headers: { 'User-Agent': USER_AGENT }
    });
    if (!res.ok) return [];
    const topics = await res.json();
    return topics.slice(0, 20).map(t => ({
      source: 'v2ex',
      source_url: t.url || `https://www.v2ex.com/t/${t.id}`,
      subreddit: 'V2EX/创造',
      title: t.title || '',
      body: t.content || '',
      author: t.member?.username || '',
      upvotes: t.replies || 0,
      comments_count: t.replies || 0,
      posted_at: new Date(t.created * 1000).toISOString(),
    }));
  } catch (e) {
    console.log('  ⚠️ V2EX失败: ' + e.message);
    return [];
  }
}

/**
 * ============ GitHub Trending ============
 */
export async function fetchGitHubTrending() {
  console.log('  📡 GitHub Trending ...');

  try {
    const res = await fetch('https://api.github.com/search/repositories?q=stars:>100+created:>2025-01-01&sort=stars&order=desc&per_page=20', {
      headers: { 'User-Agent': USER_AGENT, 'Accept': 'application/vnd.github.v3+json' }
    });
    if (!res.ok) return [];
    const data = await res.json();
    return (data.items || []).map(r => ({
      source: 'github',
      source_url: r.html_url,
      subreddit: 'GitHub Trending',
      title: `${r.name} — ${r.description || ''}`,
      body: r.description || '',
      author: r.owner?.login || '',
      upvotes: r.stargazers_count || 0,
      comments_count: r.forks_count || 0,
      posted_at: r.created_at || '',
    }));
  } catch (e) {
    console.log('  ⚠️ GitHub失败: ' + e.message);
    return [];
  }
}

/**
 * ============ Reddit OAuth API (正规渠道) ============
 * 适合部署到海外服务器后使用，速率限制更高(600 req/10min)
 */
export async function fetchRedditOAuth(subreddit, accessToken, limit = 25) {
  const url = `https://oauth.reddit.com/r/${subreddit}/hot?limit=${limit}&raw_json=1`;

  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': USER_AGENT,
        'Authorization': `Bearer ${accessToken}`
      }
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    return (data?.data?.children || []).map(c => c.data);
  } catch (e) {
    console.log(`  ⚠️ Reddit OAuth r/${subreddit} 失败: ${e.message}`);
    return [];
  }
}

/**
 * ============ 统一采集入口 ============
 */
export async function collectAllSources(options = {}) {
  const db = getDb();
  let allPosts = [];
  let stats = {};

  // 1. Reddit
  for (const sub of REDDIT_SUBREDDITS) {
    const posts = await fetchRedditSubreddit(sub, 25);
    const formatted = posts.map(p => ({
      source: 'reddit',
      source_url: `https://www.reddit.com${p.permalink}`,
      subreddit: `r/${p.subreddit}`,
      title: p.title,
      body: p.selftext || '',
      author: p.author || '[deleted]',
      upvotes: p.ups || 0,
      comments_count: p.num_comments || 0,
      posted_at: new Date(p.created_utc * 1000).toISOString(),
      raw_json: JSON.stringify(p)
    }));
    allPosts.push(...formatted);
    stats[`reddit_r_${sub}`] = posts.length;
  }

  // 2-5 已移除 Hacker News / Product Hunt / GitHub / V2EX（非电商需求）
  // 电商平台数据由 ecommerce-service.js 独立采集

  // 去重+入库（使用事务加速，避免逐条写入阻塞事件循环）
  const insertPost = db.prepare(`
    INSERT OR IGNORE INTO demand_posts (source, source_url, subreddit, title, body, author, upvotes, comments_count, posted_at, raw_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  let newCount = 0;
  const validPosts = [];
  for (const post of allPosts) {
    if (!post.title) continue;
    if (isRedditGarbage(post.title, post.body || '')) {
      console.log(`  🗑️ 垃圾帖过滤: "${post.title.substring(0, 50)}"`);
      continue;
    }
    validPosts.push(post);
  }

  // 事务批量写入（速度提升10-100x，大幅减少事件循环阻塞）
  const bulkInsert = db.transaction((posts) => {
    for (const post of posts) {
      const result = insertPost.run(
        post.source, post.source_url, post.subreddit,
        post.title.substring(0, 500), (post.body || '').substring(0, 5000),
        post.author, post.upvotes, post.comments_count,
        post.posted_at, post.raw_json || '{}'
      );
      if (result.changes > 0) newCount++;
    }
  });
  bulkInsert(validPosts);

  console.log(`\n📊 采集完成: ${allPosts.length} 条, 新增 ${newCount} 条`);
  console.log(`   来源分布: ${JSON.stringify(stats)}`);

  return { total: allPosts.length, new: newCount, stats };
}

/**
 * 采集评论中的付费信号
 */
export async function collectPaySignals(postId) {
  const db = getDb();
  const post = db.prepare('SELECT * FROM demand_posts WHERE id = ?').get(postId);
  if (!post || post.source !== 'reddit') return [];

  const raw = post.raw_json ? JSON.parse(post.raw_json) : null;
  if (!raw?.permalink) return [];

  const comments = await fetchRedditComments(raw.permalink);

  const PAY_KEYWORDS = [
    'pay', 'price', '$', 'subscribe', 'purchase', 'buy',
    'take my money', 'shut up and take', 'would pay',
    'i need this', 'i want this', 'where can i get',
    'how much', 'Pricing'
  ];

  const insertComment = db.prepare(`
    INSERT OR IGNORE INTO post_comments (post_id, author, body, upvotes, posted_at, has_pay_signal, pay_keywords)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  let paySignals = 0;
  for (const c of comments) {
    const matched = PAY_KEYWORDS.filter(kw => c.body.toLowerCase().includes(kw.toLowerCase()));
    const hasPay = matched.length > 0;
    if (hasPay) paySignals++;

    insertComment.run(
      postId, c.author, c.body.substring(0, 2000),
      c.upvotes, c.posted_at, hasPay ? 1 : 0,
      hasPay ? matched.join(',') : null
    );
  }

  return { total: comments.length, paySignals };
}
