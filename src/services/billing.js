/**
 * Reddit需求矿工 — 会员系统 & 支付
 * Free: 看Top 3需求 + 基础卡片
 * Pro: 完整Top 10 + 产品挖掘手册 + 日报推送
 * 
 * 支付方案：
 *  国内用户 → 微信/支付宝收款码 → 人工激活
 *  后续可接入 Stripe / 微信支付API
 */
import { getDb, checkMembership } from '../db/init.js';

export const PLANS = {
  free: {
    name: 'Free',
    price: 0,
    price_label: '免费',
    features: [
      '每日Top 3需求排名',
      '基础需求卡片',
      'Reddit原始链接',
      '7天历史数据',
      'V2EX中文创意',
    ],
    top_limit: 3,
    has_handbook: false,
    has_report: false,
    history_days: 7,
  },
  pro: {
    name: 'Pro',
    price_monthly: 29,
    price_yearly: 199,
    price_label: '¥29/月 或 ¥199/年',
    features: [
      '完整Top 10需求排名',
      '详细五维度评分',
      '产品挖掘手册(AI生成)',
      '竞品分析报告',
      '日报/周报推送',
      '全量历史数据',
      '多数据源(HN/PH/GitHub)',
      '无限需求查看',
    ],
    top_limit: 999,
    has_handbook: true,
    has_report: true,
    history_days: 9999,
  }
};

/**
 * 获取用户会员信息
 */
export function getUserPlan(userId) {
  const { membership } = checkMembership(userId);
  return {
    ...PLANS[membership],
    membership,
  };
}

/**
 * 使用激活码升级会员
 */
export function activateWithCode(userId, code) {
  const db = getDb();
  const activation = db.prepare(
    "SELECT * FROM activation_codes WHERE code = ? AND used_by IS NULL"
  ).get(code);

  if (!activation) return { error: '激活码无效或已被使用' };

  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + activation.duration_days);

  db.prepare(`
    UPDATE users SET membership = ?, membership_expires_at = ?, payment_ref = ?
    WHERE id = ?
  `).run(activation.plan, expiresAt.toISOString(), `CODE:${code}`, userId);

  db.prepare('UPDATE activation_codes SET used_by = ?, used_at = datetime(\'now\') WHERE code = ?')
    .run(userId, code);

  return {
    success: true,
    plan: activation.plan,
    duration: activation.duration_days,
    expires_at: expiresAt.toISOString(),
  };
}

/**
 * 创建支付订单（微信/支付宝）
 */
export function createPaymentOrder(userId, plan, duration) {
  const db = getDb();
  const planInfo = PLANS[plan];
  if (!planInfo || plan === 'free') return { error: '无效套餐' };

  const amount = duration === 'yearly' ? planInfo.price_yearly : planInfo.price_monthly;
  const days = duration === 'yearly' ? 365 : 30;
  const transactionId = 'RDM-' + Date.now() + '-' + Math.random().toString(36).substr(2, 6);

  db.prepare(`
    INSERT INTO payment_records (user_id, amount, currency, method, plan, duration_days, transaction_id, status)
    VALUES (?, ?, 'CNY', 'manual', ?, ?, ?, 'pending')
  `).run(userId, amount, plan, days, transactionId);

  return {
    transaction_id: transactionId,
    amount,
    currency: 'CNY',
    plan: planInfo.name,
    duration: days,
    // 支付说明：引导用户通过微信/支付宝转账
    instructions: {
      wechat: `请转账 ¥${amount} 至微信收款码（开发中）`,
      alipay: `请转账 ¥${amount} 至支付宝收款码（开发中）`,
      note: `转账时请备注: ${transactionId}`,
      activation_after: '支付后联系管理员激活，或使用自助激活码',
    }
  };
}

/**
 * 确认收到付款（管理员操作）
 */
export function confirmPayment(transactionId) {
  const db = getDb();
  const payment = db.prepare('SELECT * FROM payment_records WHERE transaction_id = ?').get(transactionId);
  if (!payment) return { error: '订单不存在' };

  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + payment.duration_days);

  db.prepare('UPDATE payment_records SET status = ? WHERE transaction_id = ?').run('paid', transactionId);
  db.prepare('UPDATE users SET membership = ?, membership_expires_at = ?, payment_ref = ? WHERE id = ?')
    .run(payment.plan, expiresAt.toISOString(), `PAY:${transactionId}`, payment.user_id);

  return { success: true, plan: payment.plan, expires_at: expiresAt.toISOString() };
}

/**
 * 获取Top需求（根据会员等级过滤）
 */
export function getTopDemands(userId, limit = 10) {
  const db = getDb();
  const plan = getUserPlan(userId);
  const actualLimit = Math.min(limit, plan.top_limit);

  // 列表不返回 body（太大了，拖慢加载），详情接口单独取
  // DB列名 → 新维度映射: reddit_signal=市场趋势, market_demand=需求验证, competition_gap=竞争密度, monetization=利润空间, feasibility=入场难度
  const demands = db.prepare(`
    SELECT p.id, p.source, p.source_url as url, p.title, p.subreddit,
      p.author, p.upvotes, p.comments_count, p.posted_at as collected_at,
      s.total_score, s.user_need_summary,
      s.reddit_signal as market_trend_score,
      s.competition_gap as competition_density_score,
      s.monetization as profit_margin_score,
      s.feasibility as entry_barrier_score,
      s.market_demand as demand_validation_score,
      s.pay_signals_count, s.competitor_list
    FROM demand_posts p
    JOIN demand_scores s ON s.post_id = p.id
    WHERE s.total_score > 0
    ORDER BY s.total_score DESC
    LIMIT ?
  `).all(actualLimit);

  return {
    demands,
    membership: plan.membership,
    plan_name: plan.name,
    showing: actualLimit,
    total_available: db.prepare('SELECT COUNT(*) as cnt FROM demand_scores').get().cnt,
    is_pro: plan.membership === 'pro',
    upgrade_prompt: plan.membership !== 'pro'
      ? `你是Free会员，仅显示Top ${plan.top_limit}。升级Pro查看完整Top 10 + 产品挖掘手册`
      : null,
  };
}

/**
 * 获取需求详情（Pro可看手册）
 */
export function getDemandDetail(userId, postId) {
  const db = getDb();
  const plan = getUserPlan(userId);

  const post = db.prepare(`
    SELECT p.id, p.source, p.source_url as url, p.title, p.subreddit,
      p.author, p.upvotes, p.comments_count, p.posted_at as collected_at,
      p.body,
      s.total_score, s.user_need_summary,
      s.reddit_signal as market_trend_score,
      s.competition_gap as competition_density_score,
      s.monetization as profit_margin_score,
      s.feasibility as entry_barrier_score,
      s.market_demand as demand_validation_score,
      s.pay_signals_count, s.competitor_list
    FROM demand_posts p
    JOIN demand_scores s ON s.post_id = p.id
    WHERE p.id = ?
  `).get(postId);

  if (!post) return { error: '需求不存在' };

  // 截断body避免传输过大拖慢详情页
  if (post.body && post.body.length > 500) {
    post.body = post.body.substring(0, 500) + '...';
  }

  let handbook = null;
  if (plan.has_handbook) {
    handbook = db.prepare('SELECT * FROM mining_handbooks WHERE post_id = ?').get(postId);
  }

  return {
    ...post,
    handbook: handbook ? { content: handbook.need_background } : null,
    is_pro: plan.membership === 'pro',
    upgrade_prompt: !plan.has_handbook
      ? '升级Pro可查看完整产品挖掘手册'
      : null,
  };
}

/**
 * 获取日报（Pro专属）
 */
export function getDailyReport(userId) {
  const plan = getUserPlan(userId);
  if (!plan.has_report) {
    return { error: '日报是Pro会员专属功能，请升级', membership: plan.membership };
  }

  const db = getDb();
  const top10 = db.prepare(`
    SELECT p.*, s.total_score, s.user_need_summary
    FROM demand_posts p
    JOIN demand_scores s ON s.post_id = p.id
    WHERE s.total_score > 0
    ORDER BY s.total_score DESC
    LIMIT 10
  `).all();

  return { top10, membership: 'pro' };
}

/**
 * 获取管理统计
 */
export function getAdminStats() {
  const db = getDb();
  return {
    total_users: db.prepare('SELECT COUNT(*) as cnt FROM users').get().cnt,
    pro_users: db.prepare("SELECT COUNT(*) as cnt FROM users WHERE membership = 'pro'").get().cnt,
    total_posts: db.prepare('SELECT COUNT(*) as cnt FROM demand_posts').get().cnt,
    scored_posts: db.prepare('SELECT COUNT(*) as cnt FROM demand_scores').get().cnt,
    total_payments: db.prepare("SELECT COALESCE(SUM(amount), 0) as total FROM payment_records WHERE status = 'paid'").get().total,
  };
}
