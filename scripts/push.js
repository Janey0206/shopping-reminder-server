const fs = require('fs');
const path = require('path');
const https = require('https');

// WxPusher 配置从环境变量读取
const WXPUSHER_TOKEN = process.env.WXPUSHER_TOKEN;
const WXPUSHER_UID   = process.env.WXPUSHER_UID;

// ── HTTP 请求 ────────────────────────────────────────
function request(method, url, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const opts = {
      hostname: u.hostname, path: u.pathname, method,
      timeout: 15000,
      headers: {}
    };
    if (body) {
      opts.headers['Content-Type'] = 'application/json';
      opts.headers['Content-Length'] = Buffer.byteLength(body);
    }
    const req = https.request(opts, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        if (res.statusCode >= 400) reject(new Error(`${res.statusCode}: ${data.slice(0, 200)}`));
        else resolve(data);
      });
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

// ── 计算周期天数 ────────────────────────────────────
function getCycleDay(link) {
  const now = new Date();
  const start = new Date(link.cycleStartDate);
  const diff = Math.floor((now.getTime() - start.getTime()) / (1000 * 60 * 60 * 24));
  return ((diff % 3) + 3) % 3;
}

// ── WxPusher 推送 ────────────────────────────────────
async function push(name, url, dayIndex) {
  const content = `🛒 购物提醒\n\n${name}\n\n🔄 周期第${dayIndex + 1}天 · 每3天循环\n⏰ 点击下方链接立即购买 ⬇️`;
  await request('POST', 'https://wxpusher.zjiecode.com/api/send/message/', JSON.stringify({
    appToken: WXPUSHER_TOKEN,
    contentType: 1,
    uids: [WXPUSHER_UID],
    url,
    content
  }));
}

// ── 主流程 ──────────────────────────────────────────
(async () => {
  console.log('🕐 推送检查开始...');

  if (!WXPUSHER_TOKEN || !WXPUSHER_UID) {
    console.error('❌ 缺少环境变量: WXPUSHER_TOKEN 或 WXPUSHER_UID');
    process.exit(1);
  }

  // 读取数据
  const dataPath = path.join(__dirname, '..', 'data.json');
  const data = JSON.parse(fs.readFileSync(dataPath, 'utf-8'));
  const { links } = data;

  if (!links || links.length === 0) {
    console.log('📭 暂无链接');
    return;
  }

  // 北京时间
  const now = new Date();
  const bj = new Date(now.getTime() + 8 * 60 * 60 * 1000);
  const ct = `${String(bj.getUTCHours()).padStart(2, '0')}:${String(bj.getUTCMinutes()).padStart(2, '0')}`;
  const today = bj.toISOString().slice(0, 10);
  console.log(`📅 ${today} ${ct} (北京时间)`);

  let pushed = 0;
  for (const link of links) {
    if (!link.active) continue;
    const di = getCycleDay(link);
    const targetTime = (link.remindCycle && link.remindCycle[di]) || '';
    if (!targetTime) continue;
    if (targetTime !== ct) continue;
    if (link.lastSent === today) {
      console.log(`⏭ ${link.name} - 今天已推送`);
      continue;
    }

    console.log(`📤 推送: ${link.name} (第${di+1}天 @ ${targetTime})`);
    try {
      await push(link.url, link.name, di);
      link.lastSent = today;
      pushed++;
    } catch (e) {
      console.error(`❌ ${link.name}: ${e.message}`);
    }
  }

  if (pushed > 0) {
    fs.writeFileSync(dataPath, JSON.stringify(data, null, 2) + '\n');
    console.log(`✅ 已推送 ${pushed} 条链接, data.json 已更新`);
  } else {
    console.log('📭 无待推送链接');
  }
})().catch(e => {
  console.error('❌', e.message);
  process.exit(1);
});
