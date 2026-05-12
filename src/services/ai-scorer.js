/**
 * Reddit需求矿工 — AI需求评分引擎
 * 用DeepSeek对每条需求做多维度打分 + 生成产品挖掘手册
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

  const prompt = `你是一个产品需求分析师。分析下面的用户帖子，按五个维度打分（0-100分），并给出分析理由。

帖子标题: ${post.title}
帖子内容: ${(post.body || '').substring(0, 1000)}
来源: ${post.subreddit} (${post.source})
Upvotes: ${post.upvotes}
评论数: ${post.comments_count}

评分维度:
1. Reddit信号(0-100): 用户需求真实度和社区反响
2. 市场需求(0-100): 市场天花板和搜索需求
3. 竞争缺口(0-100): 竞品少/做得差 → 分数高
4. 变现能力(0-100): 付费意愿和客单价潜力
5. 可行度(0-100): 2周可MVP+零成本启动 → 分数高

请用JSON格式返回:
{
  "reddit_signal": 数字,
  "market_demand": 数字,
  "competition_gap": 数字,
  "monetization": 数字,
  "feasibility": 数字,
  "user_need_summary": "一句话总结用户到底想要什么",
  "pay_signals_estimate": 数字,
  "competitor_list": "可能的竞品名称(用逗号分隔, 无则写'无')"
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
    
    // 加权总分
    const total = (
      (scores.reddit_signal || 0) * 0.30 +
      (scores.market_demand || 0) * 0.25 +
      (scores.competition_gap || 0) * 0.20 +
      (scores.monetization || 0) * 0.15 +
      (scores.feasibility || 0) * 0.10
    );

    db.prepare(`
      INSERT INTO demand_scores (post_id, reddit_signal, market_demand, competition_gap, monetization, feasibility,
        total_score, ai_analysis, user_need_summary, pay_signals_count, competitor_list)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      postId,
      scores.reddit_signal || 0,
      scores.market_demand || 0,
      scores.competition_gap || 0,
      scores.monetization || 0,
      scores.feasibility || 0,
      Math.round(total * 100) / 100,
      JSON.stringify(scores),
      scores.user_need_summary || '',
      scores.pay_signals_estimate || 0,
      scores.competitor_list || ''
    );

    console.log(`  ✅ 评分完成: "${post.title.substring(0, 40)}" → ${Math.round(total)}分`);
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

  const prompt = `你是一个产品顾问。基于下面的需求分析，生成一个产品挖掘手册。

需求: ${post.title}
需求概要: ${post.user_need_summary}
评分: ${post.total_score}/100
来源: ${post.subreddit} | Upvotes: ${post.upvotes} | 评论: ${post.comments_count}
竞品参考: ${post.competitor_list || '未识别'}

请用中文生成，包含以下5个部分（用markdown格式）:

## 一、需求背景
（2-3句话说明需求从哪来，谁在痛）

## 二、目标用户画像
（具体描述谁会付钱买这个产品）

## 三、竞品分析
（现有解决方案，各自优缺点，我们的差异化切入点）

## 四、MVP方案
（最小可行功能集，技术架构建议，零成本启动路径，预计2周开发）

## 五、变现设计
（定价策略建议，付费入口，首月获客方案）`;

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
    ORDER BY s.total_score DESC
    LIMIT 10
  `).all();

  if (top10.length === 0) return '# 今日需求日报\n\n暂无数据，请先执行数据采集。';

  const prompt = `你是产品分析师。下面是根据多维度评分排序的Top 10产品需求，请生成一份日报。

${top10.map((p, i) => `${i + 1}. [${p.total_score}分] ${p.title} — ${p.user_need_summary} (来源: ${p.subreddit})`).join('\n')}

用中文生成一个简洁的日报，包含:
1. 今日亮点（Top 3深度点评）
2. 趋势观察（什么类型的需求在涌现）
3. 推荐关注（最值得下手的一个）`;

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
