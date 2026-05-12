/**
 * Reddit需求矿工 — 数据库初始化
 * SQLite + WAL模式，零成本启动
 */
import Database from 'better-sqlite3';
import path from 'path';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import crypto from 'crypto';

dotenv.config();
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', '..', 'data', 'reddit_miner.db');

let db;

export function getDb() {
  if (!db) {
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
  }
  return db;
}

export function initDb() {
  const db = getDb();

  db.exec(`
    -- 用户表（一账号一会员）
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      membership TEXT DEFAULT 'free',
      membership_expires_at TEXT,
      payment_ref TEXT,
      payment_amount REAL DEFAULT 0,
      is_admin INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      last_login_at TEXT DEFAULT (datetime('now'))
    );

    -- 会话表
    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id),
      created_at TEXT DEFAULT (datetime('now')),
      expires_at TEXT NOT NULL
    );

    -- 需求帖子原始数据
    CREATE TABLE IF NOT EXISTS demand_posts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source TEXT NOT NULL,
      source_url TEXT,
      subreddit TEXT,
      title TEXT NOT NULL,
      body TEXT,
      author TEXT,
      upvotes INTEGER DEFAULT 0,
      comments_count INTEGER DEFAULT 0,
      posted_at TEXT,
      fetched_at TEXT DEFAULT (datetime('now')),
      raw_json TEXT,
      UNIQUE(source, source_url)
    );

    -- 评论数据
    CREATE TABLE IF NOT EXISTS post_comments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      post_id INTEGER REFERENCES demand_posts(id),
      author TEXT,
      body TEXT,
      upvotes INTEGER DEFAULT 0,
      posted_at TEXT,
      has_pay_signal INTEGER DEFAULT 0,
      pay_keywords TEXT
    );

    -- AI评分结果
    CREATE TABLE IF NOT EXISTS demand_scores (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      post_id INTEGER REFERENCES demand_posts(id) UNIQUE,
      reddit_signal REAL DEFAULT 0,
      market_demand REAL DEFAULT 0,
      competition_gap REAL DEFAULT 0,
      monetization REAL DEFAULT 0,
      feasibility REAL DEFAULT 0,
      total_score REAL DEFAULT 0,
      ai_analysis TEXT,
      user_need_summary TEXT,
      pay_signals_count INTEGER DEFAULT 0,
      competitor_list TEXT,
      scored_at TEXT DEFAULT (datetime('now'))
    );

    -- 产品挖掘手册（Pro会员可见）
    CREATE TABLE IF NOT EXISTS mining_handbooks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      post_id INTEGER REFERENCES demand_posts(id) UNIQUE,
      need_background TEXT,
      target_user TEXT,
      user_scenarios TEXT,
      competitor_analysis TEXT,
      mvp_plan TEXT,
      monetization_plan TEXT,
      risk_warnings TEXT,
      generated_at TEXT DEFAULT (datetime('now'))
    );

    -- 会员激活码
    CREATE TABLE IF NOT EXISTS activation_codes (
      code TEXT PRIMARY KEY,
      plan TEXT NOT NULL,
      duration_days INTEGER NOT NULL,
      used_by INTEGER REFERENCES users(id),
      used_at TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    -- 支付记录
    CREATE TABLE IF NOT EXISTS payment_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER REFERENCES users(id),
      amount REAL NOT NULL,
      currency TEXT DEFAULT 'CNY',
      method TEXT,
      plan TEXT,
      duration_days INTEGER,
      transaction_id TEXT,
      status TEXT DEFAULT 'pending',
      created_at TEXT DEFAULT (datetime('now'))
    );

    -- 扫描任务日志
    CREATE TABLE IF NOT EXISTS scan_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source TEXT,
      posts_found INTEGER DEFAULT 0,
      new_posts INTEGER DEFAULT 0,
      status TEXT,
      error TEXT,
      started_at TEXT DEFAULT (datetime('now')),
      completed_at TEXT
    );

    -- 索引
    CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
    CREATE INDEX IF NOT EXISTS idx_posts_source ON demand_posts(source);
    CREATE INDEX IF NOT EXISTS idx_posts_subreddit ON demand_posts(subreddit);
    CREATE INDEX IF NOT EXISTS idx_posts_posted ON demand_posts(posted_at);
    CREATE INDEX IF NOT EXISTS idx_scores_total ON demand_scores(total_score DESC);
    CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions(token);
    CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
  `);

  // 升级旧库：添加 is_admin 列（Safe-add 不抛异常）
  try {
    db.prepare('ALTER TABLE users ADD COLUMN is_admin INTEGER DEFAULT 0').run();
    console.log('✅ is_admin 列已添加');
  } catch (e) {
    // 列已存在，忽略（SQLite 3.35+ 用 IF NOT EXISTS，兼容旧版用 try-catch）
    if (!e.message.includes('duplicate')) console.log('ℹ️ is_admin 列已存在，跳过');
  }

  // 初始化管理员激活码
  const existingCodes = db.prepare('SELECT COUNT(*) as cnt FROM activation_codes').get();
  if (existingCodes.cnt === 0) {
    const codes = [
      { code: 'RDM-FREE-001', plan: 'free', days: 9999, note: '永久免费' },
      { code: 'RDM-PRO-30', plan: 'pro', days: 30, note: 'Pro月度体验' },
      { code: 'RDM-PRO-365', plan: 'pro', days: 365, note: 'Pro年度' },
      { code: 'RDM-DEMO-7', plan: 'pro', days: 7, note: 'Demo 7天' },
    ];
    const insert = db.prepare('INSERT OR IGNORE INTO activation_codes (code, plan, duration_days) VALUES (?, ?, ?)');
    for (const c of codes) {
      insert.run(c.code, c.plan, c.days);
    }
  }

  // 初始化超级管理员账号（首次创建或从备份恢复后修正）
  const adminHash = crypto.createHash('sha256').update('123456').digest('hex');
  const adminRow = db.prepare("SELECT id, is_admin, membership FROM users WHERE email = '1604613739@qq.com'").get();
  if (!adminRow) {
    db.prepare(`INSERT INTO users (email, password_hash, membership, is_admin) VALUES ('1604613739@qq.com', ?, 'pro', 1)`).run(adminHash);
    console.log('👑 超级管理员账号已创建: 1604613739@qq.com / 123456');
  } else {
    // 恢复后修正：确保 admin 权限和 Pro 会员
    if (!adminRow.is_admin || adminRow.membership !== 'pro') {
      db.prepare("UPDATE users SET is_admin = 1, membership = 'pro', membership_expires_at = NULL WHERE email = '1604613739@qq.com'").run();
      console.log('👑 超级管理员权限已修正: 1604613739@qq.com (Pro + Admin)');
    }
  }

  console.log('✅ Reddit需求矿工 数据库初始化完成');
  console.log(`   路径: ${DB_PATH}`);
  return db;
}

/**
 * 用户认证：创建会话token
 */
export function createSession(userId) {
  const db = getDb();
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
  db.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)').run(token, userId, expiresAt);
  return token;
}

/**
 * 验证token，返回user_id
 */
export function authenticateToken(token) {
  if (!token) return null;
  const db = getDb();
  const session = db.prepare(
    "SELECT user_id FROM sessions WHERE token = ? AND expires_at > datetime('now')"
  ).get(token);
  return session ? session.user_id : null;
}

/**
 * 检查用户会员是否有效
 */
export function checkMembership(userId) {
  const db = getDb();
  const user = db.prepare('SELECT membership, membership_expires_at FROM users WHERE id = ?').get(userId);
  if (!user) return { membership: 'free', active: true };

  if (user.membership === 'pro' && user.membership_expires_at) {
    const expired = new Date(user.membership_expires_at) < new Date();
    if (expired) {
      db.prepare("UPDATE users SET membership = 'free', membership_expires_at = NULL WHERE id = ?").run(userId);
      return { membership: 'free', active: true, downgraded: true };
    }
  }
  return { membership: user.membership, active: true };
}

// 直接运行时初始化
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  initDb();
  console.log('📊 数据库已就绪');
  process.exit(0);
}
