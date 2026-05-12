/**
 * 蓝海选品雷达 — AI选品评分引擎
 * 用DeepSeek对每条需求做多维度打分 + 生成产品挖掘手册
 * 面向跨境电商实物商品选品
 */
import OpenAI from 'openai';
import { getDb } from '../db/init.js';

const openai = new OpenAI({
  baseURL: process.env.OPENAI_BASE_URL || 'https://api.deepseek.com',
  apiKey: process.env.OPENAI_API_KEY,
});

const MODEL = process.env.OPENAI_MODEL || 'deepseek-chat';

/**
 * 对单条需求进行五维度AI打分
 */
export async function scoreDemand(postId) {
  const db = getDb();
  const post = db.prepare('SELECT * FROM demand_posts WHERE id = ?').get(postId);
  if (!post) throw new Error('帖子不存在');

  // 获取已有的评分（不重复打）
  const existing = db.prepare('SELECT id FROM demand_scores WHERE post_id = ?').get(postId);
  if (existing) {
    return db.prepare('SELECT * FROM demand_scores WHERE post_id = ?').get(postId);
  }

  const prompt = `你是跨境电商选品分析师，专门帮中国卖家在海外市场选品。分析下面抓取到的内容，判断它是不是一个真实的实物商品需求信号，并按五个维度打分。

【重要】先判断内容类型：
- 如果是网页UI元素（如"分页/pagination/下一页/sort by/filter/results for/search"）、页面导航、搜索功能描述 → 这不是商品需求，所有维度打0分，is_physical_product 设为 false
- 如果是真实的实物商品（如"便携榨汁杯/智能手表/瑜伽垫/LED灯带"等）→ 正常评分，is_physical_product 设为 true

标题: ${post.title}
描述: ${(post.body || '').substring(0, 1000)}
来源平台: ${post.source} | 品类: ${post.subreddit}
热度信号: Upvotes=${post.upvotes} | 评论=${post.comments_count}

评分维度（仅对实物商品有效）:
1. market_trend(0-100): 市场趋势 — BSR排名走势、Google Trends热度、品类增长率
2. competition_density(0-100): 竞争密度 — 竞品数量少/头部未垄断 → 高分（蓝海信号）
3. profit_margin(0-100): 利润空间 — 1688批发价 vs 海外售价剪刀差，毛利率估算
4. entry_barrier(0-100): 入场难度 — 认证门槛低/物流简单/启动资金少 → 高分（易入场）
5. demand_validation(0-100): 需求验证 — 差评痛点明确/复购信号/社媒讨论热度

请用JSON格式返回（只返回JSON，不要markdown包裹）:
{
  "market_trend": 数字,
  "competition_density": 数字,
  "profit_margin": 数字,
  "entry_barrier": 数字,
  "demand_validation": 数字,
  "user_need_summary": "一句话说清这个选品机会（例如：'美国市场对XXX有强需求，但现有产品差评集中在YYY，存在改进空间'）",
  "pay_signals_estimate": 数字,
  "competitor_list": "可能的竞品品牌或ASIN(用逗号分隔, 无则写'无')",
  "is_physical_product": true或false
}`;

  try {
    const completion = await openai.chat.completions.create({
      model: MODEL,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.3,
      max_tokens: 800,
    });

    const text = completion.choices[0].message.content.trim();
    // 提取JSON（可能被包裹在markdown中）
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('AI未返回有效JSON');

    const scores = JSON.parse(jsonMatch[0]);
    
    // 蓝海选品加权总分（跨境电商实物商品版）
    // 非实物商品直接给0分
    if (scores.is_physical_product === false) {
      scores.market_trend = 0;
      scores.competition_density = 0;
      scores.profit_margin = 0;
      scores.entry_barrier = 0;
      scores.demand_validation = 0;
      scores.pay_signals_estimate = 0;
      scores.user_need_summary = '[非商品] ' + (scores.user_need_summary || '');
    }
    const total = (
      (scores.market_trend || 0) * 0.25 +
      (scores.competition_density || 0) * 0.25 +
      (scores.profit_margin || 0) * 0.20 +
      (scores.entry_barrier || 0) * 0.15 +
      (scores.demand_validation || 0) * 0.15
    );

    db.prepare(`
      INSERT INTO demand_scores (post_id, reddit_signal, market_demand, competition_gap, monetization, feasibility,
        total_score, ai_analysis, user_need_summary, pay_signals_count, competitor_list)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      postId,
      scores.market_trend || 0,       // repurposed: market trend
      scores.demand_validation || 0,  // repurposed: demand validation
      scores.competition_density || 0,// repurposed: competition density
      scores.profit_margin || 0,      // repurposed: profit margin
      scores.entry_barrier || 0,      // repurposed: entry barrier
      Math.round(total * 100) / 100,
      JSON.stringify(scores),
      scores.user_need_summary || '',
      scores.pay_signals_estimate || 0,
      scores.competitor_list || ''
    );

    if (scores.is_physical_product === false) {
      console.log(`  🗑️ 非商品跳过: "${post.title.substring(0, 40)}" → 0分`);
    } else {
      console.log(`  ✅ 选品评分: "${post.title.substring(0, 40)}" → ${Math.round(total)}分`);
    }
    return db.prepare('SELECT * FROM demand_scores WHERE post_id = ?').get(postId);
  } catch (e) {
    console.error(`  ❌ AI评分失败: ${e.message}`);
    throw e;
  }
}

/**
 * 批量评分所有未评分的帖子
 */
export async function scoreAllUnscored(limit = 30) {
  const db = getDb();
  const posts = db.prepare(`
    SELECT p.* FROM demand_posts p
    LEFT JOIN demand_scores s ON s.post_id = p.id
    WHERE s.id IS NULL
    ORDER BY p.upvotes DESC
    LIMIT ?
  `).all(limit);

  console.log(`\n🧠 AI评分: ${posts.length} 条待评分`);

  for (let i = 0; i < posts.length; i++) {
    try {
      await scoreDemand(posts[i].id);
    } catch (e) {
      console.log(`  ⚠️ 跳过: ${e.message}`);
    }
    // 控制API速率
    if (i < posts.length - 1) await sleep(500);
  }

  return { scored: posts.length };
}

/**
 * 生成产品挖掘手册（Pro会员专属）
 */
export async function generateMiningHandbook(postId) {
  const db = getDb();
  const post = db.prepare(`
    SELECT p.*, s.total_score, s.user_need_summary, s.competitor_list, s.reddit_signal, s.market_demand,
      s.competition_gap, s.monetization, s.feasibility
    FROM demand_posts p
    JOIN demand_scores s ON s.post_id = p.id
    WHERE p.id = ?
  `).get(postId);
  
  if (!post) throw new Error('帖子或评分不存在');

  // 已有手册直接返回
  const existing = db.prepare('SELECT * FROM mining_handbooks WHERE post_id = ?').get(postId);
  if (existing) return existing;

  const prompt = `你是跨境电商选品顾问，帮中国跨境卖家找到蓝海产品。基于下面的选品信号，生成一个产品挖掘手册。

商品: ${post.title}
选品信号: ${post.user_need_summary}
蓝海评分: ${post.total_score}/100
来源: ${post.subreddit} | 热度: ${post.upvotes} | 讨论: ${post.comments_count}
竞品参考: ${post.competitor_list || '未识别'}

请用中文生成，包含以下5个部分（用markdown格式）:

## 一、选品机会
（3-4句话：这个商品为什么有市场空间，哪里的需求未被满足）

## 二、目标市场
（目标国家/人群/使用场景，市场规模估算）

## 三、供应链分析
（1688/义乌拿货成本估算，物流方式，认证要求）

## 四、竞品拆解
（亚马逊现有竞品的优缺点，差评集中点，我们的差异化切入点）

## 五、启动路线
（首批备货量、包装建议、Listing关键词、定价策略、首月推广方案）`;

  try {
    const completion = await openai.chat.completions.create({
      model: MODEL,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.5,
      max_tokens: 2000,
    });

    const handbook = completion.choices[0].message.content.trim();

    db.prepare(`
      INSERT INTO mining_handbooks (post_id, need_background, target_user, user_scenarios, competitor_analysis, mvp_plan, monetization_plan, risk_warnings)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(postId, handbook, '', '', '', '', '', '');

    // 简化存储，把全部内容放在need_background
    db.prepare('UPDATE mining_handbooks SET need_background = ? WHERE post_id = ?').run(handbook, postId);

    console.log(`  📘 手册生成: "${post.title.substring(0, 40)}"`);
    return db.prepare('SELECT * FROM mining_handbooks WHERE post_id = ?').get(postId);
  } catch (e) {
    console.error(`  ❌ 手册生成失败: ${e.message}`);
    throw e;
  }
}

/**
 * 生成Top 10日报
 */
export async function generateDailyReport() {
  const db = getDb();
  const top10 = db.prepare(`
    SELECT p.*, s.total_score, s.user_need_summary
    FROM demand_posts p
    JOIN demand_scores s ON s.post_id = p.id
    WHERE s.total_score > 0
    ORDER BY s.total_score DESC
    LIMIT 10
  `).all();

  if (top10.length === 0) return '# 🛒 今日选品日报\n\n暂无有效选品信号，请先执行数据采集。';

  const prompt = `你是跨境电商选品分析师。下面是根据蓝海选品评分排序的Top 10商品机会，请生成一份选品日报。

${top10.map((p, i) => `${i + 1}. [${p.total_score}分] ${p.title} — ${p.user_need_summary} (来源: ${p.source}/${p.subreddit})`).join('\n')}

用中文生成一个简洁的日报，包含:
1. 今日亮点（Top 3深度选品点评：为什么值得做，利润空间预估）
2. 品类趋势（什么品类的需求在冒头）
3. 推荐下手（最值得备货的一个商品，给出现实理由）`;

  try {
    const completion = await openai.chat.completions.create({
      model: MODEL,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.5,
      max_tokens: 1000,
    });
    return completion.choices[0].message.content.trim();
  } catch (e) {
    return '# 今日需求日报\n\n' + top10.map((p, i) => `${i + 1}. [${p.total_score}分] ${p.title}`).join('\n');
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
