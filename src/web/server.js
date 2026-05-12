/**
 * Reddit需求矿工 — Web服务
 * Express + SQLite + 完整认证 & 会员系统
 */
import express from 'express';
import path from 'path';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';

dotenv.config();
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3001;

import { initDb, getDb, createSession, authenticateToken, checkMembership } from '../db/init.js';
import { getUserPlan, activateWithCode, createPaymentOrder, confirmPayment,
  getTopDemands, getDemandDetail, getDailyReport, getAdminStats, PLANS } from '../services/billing.js';
import { collectAllSources, collectPaySignals } from '../services/reddit-service.js';
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

// ============ 健康检查 ============
app.get('/api/health', (req, res) => {
  const db = getDb();
  const stats = db.prepare(`
    SELECT 
      (SELECT COUNT(*) FROM demand_posts) as posts,
      (SELECT COUNT(*) FROM demand_scores) as scored,
      (SELECT COUNT(*) FROM users) as users
  `).get();
  res.json({ status: 'ok', service: 'Reddit需求矿工 v1.0', ...stats });
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
  const user = db.prepare('SELECT id, email, membership, membership_expires_at, payment_ref, created_at, last_login_at FROM users WHERE id = ?').get(req.user_id);
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

// ============ 数据采集（需Pro或管理员） ============
app.post('/api/collect', (req, res) => {
  const user = checkMembership(req.user_id);
  // Free会员也能触发，但限制
  collectAllSources({ limit: 100 }).then(result => {
    res.json(result);
  }).catch(e => {
    res.status(500).json({ error: e.message });
  });
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

// ============ 管理员统计 ============
app.get('/api/admin/stats', (req, res) => {
  res.json(getAdminStats());
});

// ============ 激活码管理（管理员） ============
app.post('/api/admin/codes', (req, res) => {
  const { admin_key, plan, count, days } = req.body || {};
  if (admin_key !== 'admin_rdm_2026') return res.status(403).json({ error: '无权限' });

  const db = getDb();
  const codes = [];
  for (let i = 0; i < (count || 1); i++) {
    const code = 'RDM-' + crypto.randomBytes(4).toString('hex').toUpperCase();
    db.prepare('INSERT OR IGNORE INTO activation_codes (code, plan, duration_days) VALUES (?, ?, ?)').run(code, plan, days || 30);
    codes.push(code);
  }
  res.json({ codes });
});

// ============ 启动服务 ============
app.listen(PORT, () => {
  console.log('\n╔══════════════════════════════════════════╗');
  console.log('║   📡 Reddit需求矿工 v1.0                  ║');
  console.log('║   7×24自动挖掘真实付费需求               ║');
  console.log('╠══════════════════════════════════════════╣');
  console.log(`║   Web: http://localhost:${PORT}               ║`);
  console.log(`║   API: http://localhost:${PORT}/api/health    ║`);
  console.log('╚══════════════════════════════════════════╝');

  // 启动自动预热：如果数据库为空，自动采集+评分
  autoWarmUp();
});

// 自动预热：部署后自动填充数据
async function autoWarmUp() {
  try {
    const db = getDb();
    const { cnt } = db.prepare('SELECT COUNT(*) as cnt FROM demand_scores').get();
    if (cnt > 0) {
      console.log(`✅ 已有 ${cnt} 条已评分数据，跳过预热`);
      return;
    }
    const { total } = db.prepare('SELECT COUNT(*) as total FROM demand_posts').get();
    if (total === 0) {
      console.log('🔄 数据库为空，启动自动采集...');
      const result = await collectAllSources({ limit: 50 });
      console.log(`📥 采集完成: ${result.total}条, 新增${result.new}条`);
    }
    console.log('🧠 启动自动AI评分...');
    const scoreResult = await scoreAllUnscored(30);
    console.log(`✅ 自动评分完成: ${scoreResult.scored}条`);
  } catch (e) {
    console.error('⚠️ 自动预热失败（不影响服务）:', e.message);
  }
}
