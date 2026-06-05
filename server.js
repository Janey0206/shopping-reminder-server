const express = require('express');
const cron = require('node-cron');
const axios = require('axios');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3456;

// ── 环境变量配置 ─────────────────────────────────────
const JSONBIN_ID  = process.env.JSONBIN_ID  || '6a227e91da38895dfe8af9ae';
const JSONBIN_KEY = process.env.JSONBIN_KEY || '$2a$10$2OLCMU12EzuwpDjDntK8nu9QoAlZGeH6Gbs3NqitRZIJYif3YcMH2';
const JSONBIN_URL = `https://api.jsonbin.io/v3/b/${JSONBIN_ID}`;

// ── 内存缓存（减少 JSONBin 请求次数） ────────────────
let cache = null;
let cacheTime = 0;
const CACHE_TTL = 30 * 1000; // 30秒缓存

// ── 中间件 ───────────────────────────────────────────
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── CORS（允许 GitHub Pages 跨域调用） ───────────────
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// ── JSONBin 数据读取 ─────────────────────────────────
async function readData() {
  const now = Date.now();
  if (cache && (now - cacheTime) < CACHE_TTL) {
    return JSON.parse(JSON.stringify(cache)); // 深拷贝
  }
  try {
    const res = await axios.get(`${JSONBIN_URL}/latest`, {
      headers: { 'X-Master-Key': JSONBIN_KEY },
      timeout: 10000
    });
    cache = res.data.record;
    cacheTime = now;
    // 迁移旧格式
    cache.links = cache.links.map(migrateLink);
    return JSON.parse(JSON.stringify(cache));
  } catch (err) {
    console.error('[JSONBin] 读取失败:', err.message);
    // 返回缓存（即使过期）
    if (cache) return JSON.parse(JSON.stringify(cache));
    // 兜底空数据
    return {
      links: [],
      config: {
        wxpusherAppToken: process.env.WXPUSHER_TOKEN || '',
        targetUids: process.env.WXPUSHER_UID ? [process.env.WXPUSHER_UID] : []
      }
    };
  }
}

// ── JSONBin 数据写入 ─────────────────────────────────
async function writeData(data) {
  try {
    await axios.put(JSONBIN_URL, data, {
      headers: {
        'Content-Type': 'application/json',
        'X-Master-Key': JSONBIN_KEY
      },
      timeout: 10000
    });
    cache = JSON.parse(JSON.stringify(data));
    cacheTime = Date.now();
    return true;
  } catch (err) {
    console.error('[JSONBin] 写入失败:', err.message);
    return false;
  }
}

// ── 旧格式迁移 ───────────────────────────────────────
function migrateLink(link) {
  if (link.remindCycle) return link;
  const cycle = ['', '', ''];
  if (link.remindTime) cycle[0] = link.remindTime;
  return {
    id: link.id,
    name: link.name,
    url: link.url,
    active: link.active !== false,
    remindCycle: cycle,
    cycleStartDate: link.cycleStartDate || link.createdAt?.slice(0, 10) || new Date().toISOString().slice(0, 10),
    lastSent: link.lastSent || null,
    createdAt: link.createdAt || new Date().toISOString()
  };
}

// ── 计算当前周期天数 ─────────────────────────────────
function getCurrentCycleDay(link) {
  const now = new Date();
  const start = new Date(link.cycleStartDate);
  const diffDays = Math.floor((now.getTime() - start.getTime()) / (1000 * 60 * 60 * 24));
  return ((diffDays % 3) + 3) % 3; // 0=第1天, 1=第2天, 2=第3天
}

// ── 生成唯一 ID ──────────────────────────────────────
function generateId() {
  return 'link_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6);
}

// ── WxPusher 推送 ────────────────────────────────────
async function sendWxPusherMessage(content, url, uids, appToken) {
  try {
    const res = await axios.post('https://wxpusher.zjiecode.com/api/send/message/', {
      appToken,
      content,
      contentType: 1,
      uids,
      url
    }, { timeout: 10000 });
    console.log('[WxPusher] 推送结果:', JSON.stringify(res.data));
    return res.data;
  } catch (err) {
    console.error('[WxPusher] 推送失败:', err.message);
    return { success: false, msg: err.message };
  }
}

// ── API: 健康检查 ────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({ success: true, msg: '服务运行中', time: new Date().toISOString() });
});

// ── API: 获取所有链接 ────────────────────────────────
app.get('/api/links', async (req, res) => {
  const data = await readData();
  res.json({ success: true, data: data.links });
});

// ── API: 添加链接 ────────────────────────────────────
app.post('/api/links', async (req, res) => {
  const { name, url, remindCycle, cycleStartDate, active } = req.body;

  if (!name || !url) return res.json({ success: false, msg: '名称和链接不能为空' });
  if (!remindCycle || !Array.isArray(remindCycle) || remindCycle.length !== 3)
    return res.json({ success: false, msg: '请设置三日提醒周期' });
  if (remindCycle.every(t => !t))
    return res.json({ success: false, msg: '请至少开启一天的提醒' });

  const link = {
    id: generateId(),
    name: name.trim(),
    url: url.trim(),
    remindCycle: remindCycle.map(t => t ? t.trim() : ''),
    cycleStartDate: cycleStartDate || new Date().toISOString().slice(0, 10),
    active: active !== false,
    lastSent: null,
    createdAt: new Date().toISOString()
  };

  const data = await readData();
  data.links.push(link);
  await writeData(data);

  console.log('[添加链接]', link.name);
  res.json({ success: true, data: link });
});

// ── API: 更新链接 ────────────────────────────────────
app.put('/api/links/:id', async (req, res) => {
  const { id } = req.params;
  const { name, url, remindCycle, cycleStartDate, active } = req.body;

  const data = await readData();
  const idx = data.links.findIndex(l => l.id === id);
  if (idx === -1) return res.json({ success: false, msg: '链接不存在' });

  if (name !== undefined) data.links[idx].name = name.trim();
  if (url !== undefined) data.links[idx].url = url.trim();
  if (remindCycle !== undefined) data.links[idx].remindCycle = remindCycle.map(t => t ? t.trim() : '');
  if (cycleStartDate !== undefined) data.links[idx].cycleStartDate = cycleStartDate;
  if (active !== undefined) data.links[idx].active = active;

  await writeData(data);
  res.json({ success: true, data: data.links[idx] });
});

// ── API: 删除链接 ────────────────────────────────────
app.delete('/api/links/:id', async (req, res) => {
  const { id } = req.params;

  const data = await readData();
  const idx = data.links.findIndex(l => l.id === id);
  if (idx === -1) return res.json({ success: false, msg: '链接不存在' });

  const removed = data.links.splice(idx, 1)[0];
  await writeData(data);

  console.log('[删除链接]', removed.name);
  res.json({ success: true, data: removed });
});

// ── API: 立即测试推送 ────────────────────────────────
app.post('/api/test-push', async (req, res) => {
  const data = await readData();
  const { wxpusherAppToken, targetUids } = data.config;

  if (!targetUids || targetUids.length === 0)
    return res.json({ success: false, msg: '请先配置 UID' });

  const result = await sendWxPusherMessage(
    '🧪 这是一条测试消息\n\n三日循环推送配置成功！',
    'https://www.taobao.com',
    targetUids,
    wxpusherAppToken
  );
  res.json(result);
});

// ── API: 获取配置 ────────────────────────────────────
app.get('/api/config', async (req, res) => {
  const data = await readData();
  res.json({
    success: true,
    data: {
      targetUids: data.config.targetUids,
      appToken: data.config.wxpusherAppToken.replace(/(.{6}).*(.{4})/, '$1****$2')
    }
  });
});

// ── API: 更新配置 ────────────────────────────────────
app.put('/api/config', async (req, res) => {
  const { targetUids } = req.body;
  const data = await readData();

  if (targetUids !== undefined) data.config.targetUids = targetUids;

  await writeData(data);
  res.json({ success: true, data: { targetUids: data.config.targetUids } });
});

// ── 定时任务：每分钟检查 ──────────────────────────────
cron.schedule('* * * * *', async () => {
  let data;
  try {
    data = await readData();
  } catch (err) {
    console.error('[Cron] 读取数据失败:', err.message);
    return;
  }

  const { wxpusherAppToken, targetUids } = data.config;
  if (!targetUids || targetUids.length === 0) return;

  const now = new Date();
  // 使用北京时间 (UTC+8)
  const bjNow = new Date(now.getTime() + 8 * 60 * 60 * 1000);
  const currentTime = `${String(bjNow.getUTCHours()).padStart(2, '0')}:${String(bjNow.getUTCMinutes()).padStart(2, '0')}`;
  const today = bjNow.toISOString().slice(0, 10);

  let dataChanged = false;

  for (const link of data.links) {
    if (!link.active) continue;

    const dayIndex = getCurrentCycleDay(link);
    const cycleTime = (link.remindCycle && link.remindCycle[dayIndex]) || '';
    if (!cycleTime) continue;
    if (cycleTime !== currentTime) continue;
    if (link.lastSent === today) {
      console.log(`[跳过] ${link.name} - 今天已推送`);
      continue;
    }

    const content = `🛒 购物提醒\n\n${link.name}\n\n🔄 周期第${dayIndex + 1}天 · 每3天循环\n⏰ 点击下方链接立即购买 ⬇️`;
    console.log(`[推送] ${link.name} → 周期第${dayIndex + 1}天 ${cycleTime}`);

    await sendWxPusherMessage(content, link.url, targetUids, wxpusherAppToken);
    link.lastSent = today;
    dataChanged = true;
  }

  if (dataChanged) await writeData(data);
});

console.log('[定时任务] 三日循环调度器已启动（北京时间）');

// ── 启动服务 ─────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🛒 购物提醒工具已启动`);
  console.log(`   端口: ${PORT}`);
  console.log(`   数据存储: JSONBin ${JSONBIN_ID.slice(0, 8)}...`);
  console.log(`   推送模式: 每3天循环，北京时间\n`);
});
