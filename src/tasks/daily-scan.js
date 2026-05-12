/**
 * Reddit需求矿工 — 定时扫描任务
 * 每6小时采集一次数据 + AI评分
 * 使用: node src/tasks/daily-scan.js
 */
import dotenv from 'dotenv';
dotenv.config();

import { initDb } from '../db/init.js';
import { collectAllSources } from '../services/reddit-service.js';
import { scoreAllUnscored, generateDailyReport } from '../services/ai-scorer.js';
import { getDb } from '../db/init.js';

async function main() {
  console.log('╔══════════════════════════════════════╗');
  console.log('║  📡 Reddit需求矿工 — 定时扫描       ║');
  console.log('╚══════════════════════════════════════╝\n');

  initDb();
  const db = getDb();
  const logId = db.prepare("INSERT INTO scan_logs (source, status, started_at) VALUES ('all', 'running', datetime('now'))").run().lastInsertRowid;

  try {
    // 1. 采集所有数据源
    console.log('📡 Phase 1: 多源数据采集');
    const collectResult = await collectAllSources({ limit: 100 });
    console.log(`   ✅ ${collectResult.new} 条新数据`);

    // 2. AI评分
    console.log('\n🧠 Phase 2: AI评分');
    const scoreResult = await scoreAllUnscored(30);
    console.log(`   ✅ 评分完成`);

    // 3. 生成日报（可选）
    console.log('\n📰 Phase 3: 生成日报');
    const report = await generateDailyReport();
    console.log(`   ✅ 日报已生成 (${report.length} 字符)`);

    db.prepare("UPDATE scan_logs SET status = 'done', posts_found = ?, new_posts = ?, completed_at = datetime('now') WHERE id = ?")
      .run(collectResult.total, collectResult.new, logId);

    console.log('\n✅ 全流程完成');
  } catch (e) {
    console.error('\n❌ 扫描失败:', e.message);
    db.prepare("UPDATE scan_logs SET status = 'error', error = ?, completed_at = datetime('now') WHERE id = ?")
      .run(e.message, logId);
    process.exit(1);
  }

  process.exit(0);
}

main();
