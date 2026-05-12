# 📡 Reddit需求矿工 (Reddit Demand Miner)

> 7×24自动扫描全球社区与电商平台，挖掘真实付费需求，AI打分排序

## 数据源

### 社区平台
| 平台 | 说明 | 采集内容 |
|------|------|----------|
| 🔴 **Reddit** | 按子版块扫描 | 讨论帖 + 评论区差评信号 |
| 🟠 **Hacker News** | Y Combinator 技术社区 | Show HN / Ask HN 帖子 |
| 🟣 **Product Hunt** | 产品发布平台 | 热门产品 + 评论 |
| ⚫ **GitHub** | 开源社区热榜 | Trending repos (issue中挖掘需求) |
| 🇨🇳 **V2EX** | 中文技术社区 | 创意/分享节点帖子 |

### 电商平台
| 平台 | 说明 | 采集内容 |
|------|------|----------|
| 🟡 **Amazon** | Best Sellers + Movers & Shakers | 热卖产品标题、评分、评论数、价格 |
| 🟠 **AliExpress** | 按品类搜索热卖 | 产品标题、订单数、评分、价格 |
| 🟢 **Shopee** | 多站点（马来/印尼/菲律宾/新加坡/泰国/越南/巴西） | 热门商品、销量、商店信息 |
| 🔵 **eBay** | Trending / Best Selling | 热卖产品、已售数量、卖家 |

## 快速开始

```bash
# 安装依赖
npm install

# 初始化数据库
npm run db:init

# 启动服务
npm start
```

服务运行在 `http://localhost:3001`

### 手动触发采集

```bash
# 采集所有社区源
curl -X POST http://localhost:3001/api/collect

# 仅采集电商平台
curl -X POST http://localhost:3001/api/collect \
  -H "Content-Type: application/json" \
  -d '{"source":"ecommerce"}'

# 采集单个平台 (amazon / aliexpress / shopee / ebay)
curl -X POST http://localhost:3001/api/collect \
  -H "Content-Type: application/json" \
  -d '{"source":"amazon"}'
```

## 评分维度

AI 综合5个维度对每条需求打分（满分100）：

| 维度 | 权重 | 说明 |
|------|------|------|
| 🚀 付费意愿 | 30% | 是否有人愿意付钱 |
| 🎯 需求明确度 | 25% | 需求描述清晰程度 |
| 📈 市场机会 | 20% | 是否已有玩家、市场规模 |
| ⚡ 执行难度 | 15% | 开发门槛（越低分越高） |
| 🔁 持续性 | 10% | 是否为一次性需求 |

## 会员计划

| | Free | Pro |
|------|------|------|
| 需求排名 | Top 3 | Top 10 |
| AI评分详情 | 基础分数 | 五维评分 + 分析 |
| 产品挖掘手册 | ❌ | ✅ AI自动生成 |
| 日报解读 | ❌ | ✅ 每日需求综述 |
| 价格 | 免费 | ¥29/月 或 ¥199/年 |

## 技术栈

- **运行时**: Node.js (ES modules)
- **数据库**: SQLite (better-sqlite3)
- **Web框架**: Express
- **AI**: OpenAI / DeepSeek API
- **数据采集**: 原生 fetch + 正则解析（零额外依赖）
- **部署**: Railway 免费层

## 项目结构

```
src/
├── db/init.js           # 数据库初始化 & 连接
├── services/
│   ├── reddit-service.js    # 社区平台采集
│   ├── ecommerce-service.js # 电商平台采集 (Amazon/AliExpress/Shopee/eBay)
│   ├── ai-scorer.js         # AI 评分引擎
│   └── billing.js           # 会员计费
├── tasks/
│   └── daily-scan.js        # 定时扫描任务
└── web/
    ├── server.js             # Express 服务器
    └── public/
        ├── dashboard.html    # 控制台
        ├── login.html        # 登录页
        └── register.html     # 注册页
```
