const https = require('https');

const JSONBIN_ID  = process.env.JSONBIN_ID;
const JSONBIN_KEY = process.env.JSONBIN_KEY;

// ── HTTP 请求封装 ────────────────────────────────────
function request(method, url, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const opts = {
      hostname: u.hostname,
      path: u.pathname,
      method,
      timeout: 15000,
      headers: { 'X-Master-Key': JSONBIN_KEY }
    };
    if (body) {
      opts.headers['Content-Type'] = 'application/json';
      opts.headers['Content-Length'] = Buffer.byteLength(body);
    }

    const req = https.request(opts, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        if (res.statusCode >= 400) reject(new Error(`${res.statusCode}: ${data.slice(0,200)}`));
        else resolve(data);
      });
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

// ── 读取数据 ────────────────────────────────────────
async function readData() {
  const raw = await request('GET', `https://api.jsonbin.io/v3/b/${JSONBIN_ID}/latest`);
  return JSON.parse(raw).record;
}

// ── 写入数据 ────────────────────────────────────────
async function writeData(data) {
  await request('PUT', `https://api.jsonbin.io/v3/b/${JSONBIN_ID}`, JSON.stringify(data));
}

// ── 计算周期天数 ────────────────────────────────────
function getCycleDay(link) {
  const now = new Date();
  const start = new Date(link.cycleStartDate);
  const diff = Math.floor((now.getTime() - start.getTime()) / (1000 * 60 * 60 * 24));
  return ((diff % 3) + 3) % 3;
}

// ── 发送 WxPusher 消息 ──────────────────────────────
async function send(url, name, dayIndex, appToken, uids) {
  await request('POST', 'https://wxpusher.zjiecode.com/api/send/message/', JSON.stringify({
    appToken,
    content: `🛒 购物提醒\n\n${name}\n\n🔄 周期第${dayIndex + 1}天 · 每3天循环\n⏰ 点击下方链接立即购买 ⬇️`,
    contentType: 1,
    uids,
    url
  }));
}

// ── 主流程 ──────────────────────────────────────────
(async () => {
  console.log('🕐 GitHub Actions 推送检查开始...');

  const data = await readData();
  const { wxpusherAppToken, targetUids } = data.config;

  if (!targetUids || targetUids.length === 0) {
    console.log('⚠️ 未配置 UID，跳过');
    return;
  }

  const now = new Date();
  const bj = new Date(now.getTime() + 8 * 60 * 60 * 1000);
  const currentTime = `${String(bj.getUTCHours()).padStart(2, '0')}:${String(bj.getUTCMinutes()).padStart(2, '0')}`;
  const today = bj.toISOString().slice(0, 10);
  console.log(`📅 北京时间: ${today} ${currentTime}`);

  let pushed = 0;
  for (const link of data.links) {
    if (!link.active) continue;
    const dayIndex = getCycleDay(link);
    const cycleTime = (link.remindCycle && link.remindCycle[dayIndex]) || '';
    if (!cycleTime) continue;
    if (cycleTime !== currentTime) continue;
    if (link.lastSent === today) {
      console.log(`⏭  ${link.name} - 今天已推送`);
      continue;
    }

    console.log(`📤 推送: ${link.name} (周期第${dayIndex + 1}天 @ ${cycleTime})`);
    try {
      await send(link.url, link.name, dayIndex, wxpusherAppToken, targetUids);
      link.lastSent = today;
      pushed++;
    } catch (e) {
      console.error(`❌ 推送失败: ${link.name} - ${e.message}`);
    }
  }

  if (pushed > 0) {
    await writeData(data);
    console.log(`✅ 已推送 ${pushed} 条链接`);
  } else {
    console.log('📭 当前无待推送链接');
  }

  console.log('✅ 检查完成');
})().catch(e => {
  console.error('❌ 脚本异常:', e.message);
  process.exit(1);
});
