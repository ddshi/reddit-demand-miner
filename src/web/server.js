/**
 * Reddit需求矿工 — Web服务
 * Express + SQLite + 完整认证 & 会员系统
 */
import express from 'express';
import path from 'path';
import fs from 'fs';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';

dotenv.config();
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3001;

import { initDb, getDb, createSession, authenticateToken, checkMembership } from '../db/init.js';
import { getUserPlan, activateWithCode, createPaymentOrder, confirmPayment,
  getTopDemands, getDemandDetail, getDailyReport, getAdminStats, PLANS } from '../services/billing.js';
import { collectAllSources, collectPaySignals } from '../services/reddit-service.js';
import { collectAmazon, collectAliExpress, collectShopee, collectEbay, collectAllEcommerce } from '../services/ecommerce-service.js';
import { scoreDemand, scoreAllUnscored, generateDailyReport } from '../services/ai-scorer.js';
import crypto from 'crypto';

// ============ 初始化 ============
initDb();
const app = express();
app.use(express.json({ limit: '10mb' }));
// 防缓存：HTML页面不使用缓存
app.use(express.static(path.join(__dirname, 'public'), { setHeaders: (res, p) => { if (p.endsWith('.html')) { res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate'); res.setHeader('Pragma', 'no-cache'); } } }));

// 页面路由映射（友好URL）
app.get('/', (req, res) => res.redirect('/dashboard'));
app.get('/login', (req, res) => { res.setHeader('Cache-Control', 'no-store'); res.sendFile(path.join(__dirname, 'public', 'login.html')); });
app.get('/register', (req, res) => { res.setHeader('Cache-Control', 'no-store'); res.sendFile(path.join(__dirname, 'public', 'register.html')); });
app.get('/dashboard', (req, res) => { res.setHeader('Cache-Control', 'no-store'); res.sendFile(path.join(__dirname, 'public', 'dashboard.html')); });
app.get('/admin', (req, res) => { res.setHeader('Cache-Control', 'no-store'); res.sendFile(path.join(__dirname, 'public', 'admin.html')); });

// ============ 认证中间件 ============
const PUBLIC_ROUTES = ['/health', '/plans', '/login', '/register', '/activate'];
function requireAuth(req, res, next) {
  if (req.method === 'OPTIONS') return next();
  const token = req.headers.authorization?.replace('Bearer ', '') || req.query.token;
  const userId = authenticateToken(token);
  if (!userId) return res.status(401).json({ error: '请先登录', code: 'AUTH_REQUIRED' });
  req.user_id = userId;
  next();
}

app.use('/api', (req, res, next) => {
  if (PUBLIC_ROUTES.includes(req.path)) return next();
  return requireAuth(req, res, next);
});

// Admin middleware
function requireAdmin(req, res, next) {
  const db = getDb();
  const user = db.prepare('SELECT is_admin FROM users WHERE id = ?').get(req.user_id);
  if (!user || !user.is_admin) return res.status(403).json({ error: '需要管理员权限', code: 'ADMIN_REQUIRED' });
  next();
}

// ============ 健康检查 ============
app.get('/api/health', (req, res) => {
  const db = getDb();
  const stats = db.prepare(`
    SELECT 
      (SELECT COUNT(*) FROM demand_posts) as posts,
      (SELECT COUNT(*) FROM demand_scores) as scored,
      (SELECT COUNT(*) FROM users) as users
  `).get();
  res.json({ status: 'ok', service: '蓝海选品雷达 v2.0', ...stats });
});

// ============ 套餐信息（公开） ============
app.get('/api/plans', (req, res) => {
  res.json(PLANS);
});

// ============ 注册 ============
app.post('/api/register', (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password || password.length < 6) {
    return res.status(400).json({ error: '请输入有效邮箱和至少6位密码' });
  }

  const db = getDb();
  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
  if (existing) return res.status(409).json({ error: '该邮箱已被注册' });

  const hash = crypto.createHash('sha256').update(password).digest('hex');
  const result = db.prepare(
    'INSERT INTO users (email, password_hash, membership) VALUES (?, ?, ?)'
  ).run(email, hash, 'free');

  const token = createSession(result.lastInsertRowid);
  res.status(201).json({
    token,
    user: { id: result.lastInsertRowid, email, membership: 'free' },
    message: '注册成功！你是Free会员，可查看Top 3需求'
  });
});

// ============ 登录 ============
app.post('/api/login', (req, res) => {
  const { email, password } = req.body || {};
  const db = getDb();
  const hash = crypto.createHash('sha256').update(password || '').digest('hex');

  const user = db.prepare('SELECT * FROM users WHERE email = ? AND password_hash = ?').get(email, hash);
  if (!user) return res.status(401).json({ error: '邮箱或密码错误' });

  db.prepare("UPDATE users SET last_login_at = datetime('now') WHERE id = ?").run(user.id);
  const token = createSession(user.id);

  res.json({
    token,
    user: {
      id: user.id,
      email: user.email,
      membership: user.membership,
      expires_at: user.membership_expires_at,
    }
  });
});

// ============ 获取当前用户 ============
app.get('/api/me', (req, res) => {
  const db = getDb();
  const user = db.prepare('SELECT id, email, membership, membership_expires_at, is_admin, payment_ref, created_at, last_login_at FROM users WHERE id = ?').get(req.user_id);
  if (!user) return res.status(404).json({ error: '用户不存在' });

  const plan = getUserPlan(req.user_id);
  res.json({ ...user, plan: plan.name, features: plan.features });
});

// ============ 会员激活 ============
app.post('/api/activate', (req, res) => {
  const { code } = req.body || {};
  const userId = authenticateToken(req.headers.authorization?.replace('Bearer ', ''));
  if (!userId) return res.status(401).json({ error: '请先登录' });

  const result = activateWithCode(userId, code);
  if (result.error) return res.status(400).json(result);
  res.json(result);
});

// ============ 创建支付 ============
app.post('/api/payment/create', (req, res) => {
  const { plan, duration } = req.body || {};
  const result = createPaymentOrder(req.user_id, plan, duration);
  if (result.error) return res.status(400).json(result);
  res.json(result);
});

// ============ 确认支付（管理员） ============
app.post('/api/payment/confirm', (req, res) => {
  const { transaction_id, admin_key } = req.body || {};
  if (admin_key !== 'admin_rdm_2026') return res.status(403).json({ error: '无权限' });
  const result = confirmPayment(transaction_id);
  res.json(result);
});

// ============ 获取Top需求 ============
app.get('/api/demands', (req, res) => {
  const result = getTopDemands(req.user_id);
  res.json(result);
});

// ============ 需求详情 ============
app.get('/api/demands/:id', (req, res) => {
  const result = getDemandDetail(req.user_id, parseInt(req.params.id));
  res.json(result);
});

// ============ 日报 ============
app.get('/api/report', (req, res) => {
  const result = getDailyReport(req.user_id);
  res.json(result);
});

// ============ 数据采集（异步后台执行） ============
app.post('/api/collect', (req, res) => {
  const user = checkMembership(req.user_id);
  const source = (req.body?.source || req.query?.source || '').toLowerCase();

  // 立即返回，采集+评分在后台异步执行
  res.json({ queued: true, message: '采集任务已加入后台队列，预计2-3分钟完成' });

  // 后台执行
  (async () => {
    try {
      let result;
      switch (source) {
        case 'amazon': result = await collectAmazon(50); break;
        case 'aliexpress': result = await collectAliExpress(30); break;
        case 'shopee': result = await collectShopee(35); break;
        case 'ebay': result = await collectEbay(25); break;
        case 'ecommerce': result = await collectAllEcommerce(20); break;
        default:
          result = await Promise.all([collectAllSources({ limit: 50 }), collectAllEcommerce(15)]);
      }
      console.log('📥 后台采集完成，启动自动评分...');
      await scoreAllUnscored(30);
      console.log('✅ 后台采集+评分全部完成');
    } catch (e) {
      console.error('⚠️ 后台采集失败:', e.message);
    }
  })();
});

// ============ AI评分（管理员） ============
app.post('/api/score', (req, res) => {
  scoreAllUnscored(30).then(result => {
    res.json(result);
  }).catch(e => {
    res.status(500).json({ error: e.message });
  });
});

// ============ 生成日报 ============
app.post('/api/report/generate', (req, res) => {
  generateDailyReport().then(report => {
    res.json({ report });
  }).catch(e => {
    res.status(500).json({ error: e.message });
  });
});

// ============ 管理员 API（需 is_admin=1） ============

// 获取用户列表
app.get('/api/admin/users', requireAdmin, (req, res) => {
  const db = getDb();
  const users = db.prepare(`
    SELECT id, email, membership, membership_expires_at, is_admin, payment_ref, created_at, last_login_at
    FROM users ORDER BY created_at DESC
  `).all();
  res.json({ users });
});

// 手动添加用户
app.post('/api/admin/users', requireAdmin, (req, res) => {
  const { email, password, membership, expires_at } = req.body || {};
  if (!email || !password || password.length < 6) {
    return res.status(400).json({ error: '请输入有效邮箱和至少6位密码' });
  }
  const db = getDb();
  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
  if (existing) return res.status(409).json({ error: '该邮箱已存在' });

  const hash = crypto.createHash('sha256').update(password).digest('hex');
  const tier = membership === 'pro' ? 'pro' : 'free';
  db.prepare(`
    INSERT INTO users (email, password_hash, membership, membership_expires_at)
    VALUES (?, ?, ?, ?)
  `).run(email, hash, tier, expires_at || null);
  res.status(201).json({ message: `用户 ${email} 创建成功` });
});

// 修改用户信息
app.put('/api/admin/users/:id', requireAdmin, (req, res) => {
  const { id } = req.params;
  const { email, password, membership, expires_at, is_admin } = req.body || {};
  const db = getDb();
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!user) return res.status(404).json({ error: '用户不存在' });

  const updates = [];
  const params = [];

  if (email) { updates.push('email = ?'); params.push(email); }
  if (password) {
    updates.push('password_hash = ?');
    params.push(crypto.createHash('sha256').update(password).digest('hex'));
  }
  if (membership) { updates.push('membership = ?'); params.push(membership); }
  if (expires_at !== undefined) { updates.push('membership_expires_at = ?'); params.push(expires_at || null); }
  if (is_admin !== undefined) { updates.push('is_admin = ?'); params.push(is_admin ? 1 : 0); }

  if (updates.length === 0) return res.status(400).json({ error: '没有需要修改的字段' });

  params.push(id);
  db.prepare(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`).run(...params);

  const updated = db.prepare('SELECT id, email, membership, membership_expires_at, is_admin FROM users WHERE id = ?').get(id);
  res.json({ message: '用户信息已更新', user: updated });
});

// 删除用户
app.delete('/api/admin/users/:id', requireAdmin, (req, res) => {
  const { id } = req.params;
  const db = getDb();
  const user = db.prepare('SELECT id, email FROM users WHERE id = ?').get(id);
  if (!user) return res.status(404).json({ error: '用户不存在' });
  if (user.email === '1604613739@qq.com') return res.status(403).json({ error: '不能删除超级管理员' });

  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
  db.prepare('DELETE FROM payment_records WHERE user_id = ?').run(id);
  db.prepare('DELETE FROM users WHERE id = ?').run(id);
  res.json({ message: `用户 ${user.email} 已删除` });
});

// 统计（管理员）
app.get('/api/admin/stats', requireAdmin, (req, res) => {
  res.json(getAdminStats());
});

// 激活码管理
app.post('/api/admin/codes', requireAdmin, (req, res) => {
  const { plan, count, days } = req.body || {};
  const db = getDb();
  const codes = [];
  for (let i = 0; i < (count || 1); i++) {
    const code = 'RDM-' + crypto.randomBytes(4).toString('hex').toUpperCase();
    db.prepare('INSERT OR IGNORE INTO activation_codes (code, plan, duration_days) VALUES (?, ?, ?)').run(code, plan, days || 30);
    codes.push(code);
  }
  res.json({ codes });
});

// 获取所有激活码
app.get('/api/admin/codes', requireAdmin, (req, res) => {
  const db = getDb();
  const codes = db.prepare('SELECT * FROM activation_codes ORDER BY created_at DESC').all();
  res.json({ codes });
});

// 支付确认
app.post('/api/payment/confirm', requireAdmin, (req, res) => {
  const { transaction_id } = req.body || {};
  const result = confirmPayment(transaction_id);
  res.json(result);
});

// ============ 用户数据备份/恢复 ============
const BACKUP_PATH = path.join(__dirname, '..', '..', 'data', 'users_backup.json');

// 导出所有用户数据（管理员调用，部署前备份）
app.get('/api/admin/backup', (req, res) => {
  try {
    const db = getDb();
    const users = db.prepare('SELECT * FROM users').all();
    const sessions = db.prepare('SELECT * FROM sessions').all();
    res.json({ users, sessions, exported_at: new Date().toISOString() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 从备份文件恢复用户数据
function restoreUsersFromBackup() {
  try {
    if (!fs.existsSync(BACKUP_PATH)) {
      console.log('📭 无用户备份文件，跳过恢复');
      return;
    }
    const backup = JSON.parse(fs.readFileSync(BACKUP_PATH, 'utf-8'));
    if (!backup.users || backup.users.length === 0) {
      console.log('📭 备份文件无用户数据');
      return;
    }
    const db = getDb();
    const { cnt } = db.prepare('SELECT COUNT(*) as cnt FROM users').get();
    if (cnt > 0) {
      console.log(`✅ 已有 ${cnt} 个用户，跳过恢复`);
      return;
    }
    const insU = db.prepare(`INSERT OR IGNORE INTO users (id, email, password_hash, membership, membership_expires_at, is_admin, created_at, last_login_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const u of backup.users) {
      insU.run(u.id, u.email, u.password_hash, u.membership || 'free', u.membership_expires_at, u.is_admin || 0, u.created_at, u.last_login_at);
    }
    if (backup.sessions) {
      const insS = db.prepare(`INSERT OR IGNORE INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)`);
      for (const s of backup.sessions) {
        if (new Date(s.expires_at) > new Date()) insS.run(s.token, s.user_id, s.created_at, s.expires_at);
      }
    }
    console.log(`💾 已从备份恢复 ${backup.users.length} 个用户`);
  } catch (e) {
    console.error('⚠️ 备份恢复失败:', e.message);
  }
}

// ============ 启动服务 ============
app.listen(PORT, () => {
  console.log('\n╔══════════════════════════════════════════╗');
  console.log('║   📡 Reddit需求矿工 v1.0                  ║');
  console.log('║   7×24自动挖掘真实付费需求               ║');
  console.log('╠══════════════════════════════════════════╣');
  console.log(`║   Web: http://localhost:${PORT}               ║`);
  console.log(`║   API: http://localhost:${PORT}/api/health    ║`);
  console.log('╚══════════════════════════════════════════╝');

  // 先恢复用户数据，再采集需求数据
  restoreUsersFromBackup();
  // 启动自动预热：如果数据库为空，自动采集+评分
  autoWarmUp();
});

// 自动预热：分步进行，绝不阻塞请求
// 策略：60秒后才启动采集 → 分小批 → 批间yield → 绝不阻塞HTTP
async function autoWarmUp() {
  // 60秒延迟，给服务足够时间处理注册/登录等请求
  await new Promise(r => setTimeout(r, 60000));

  async function yieldEventLoop() {
    // 每处理一批后释放事件循环，让HTTP请求有机会执行
    await new Promise(r => setImmediate(r));
  }

  async function collectWithYield(sourceName, collector, args) {
    await yieldEventLoop();
    console.log(`📥 [预热] 开始采集 ${sourceName}...`);
    try {
      const result = await collector(...args);
      console.log(`✅ [预热] ${sourceName} 完成: ${result.total}条, 新增${result.new}条`);
      return result;
    } catch (e) {
      console.log(`⚠️ [预热] ${sourceName} 失败:`, e.message);
      return { total: 0, new: 0 };
    }
  }

  try {
    const db = getDb();
    const { cnt } = db.prepare('SELECT COUNT(*) as cnt FROM demand_scores').get();
    if (cnt > 0) {
      console.log(`✅ 已有 ${cnt} 条已评分数据，跳过预热`);
      return;
    }
    const { total } = db.prepare('SELECT COUNT(*) as total FROM demand_posts').get();
    if (total === 0) {
      console.log('🔔 [预热] 数据库为空，60秒后逐步采集（不阻塞请求）...');
      // 社区数据源（小批量，batch间yield）
      await collectWithYield('Reddit社区', collectAllSources, [{ limit: 20 }]);
      // 电商数据源
      await collectWithYield('电商平台', collectAllEcommerce, [5]);
    }
    // 评分也分小批
    await yieldEventLoop();
    console.log('🧠 [预热] 启动AI评分（5条）...');
    try {
      const scoreResult = await scoreAllUnscored(5);
      console.log(`✅ [预热] 首批评分: ${scoreResult.scored}条`);
    } catch (e) {
      console.log('⚠️ [预热] 评分失败:', e.message);
    }
    // 剩余评分在后台，不阻塞
    scoreAllUnscored(20).then(r => console.log(`✅ 补充评分: ${r.scored}条`)).catch(() => {});
  } catch (e) {
    console.error('⚠️ 自动预热失败（不影响服务）:', e.message);
  }
}
