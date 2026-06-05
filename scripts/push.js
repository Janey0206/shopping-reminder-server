const axios = require('axios');

const JSONBIN_ID  = process.env.JSONBIN_ID;
const JSONBIN_KEY = process.env.JSONBIN_KEY;
const JSONBIN_URL = `https://api.jsonbin.io/v3/b/${JSONBIN_ID}`;

// ── 读取数据 ────────────────────────────────────────
async function readData() {
  const res = await axios.get(`${JSONBIN_URL}/latest`, {
    headers: { 'X-Master-Key': JSONBIN_KEY },
    timeout: 10000
  });
  return res.data.record;
}

// ── 写入数据 ────────────────────────────────────────
async function writeData(data) {
  await axios.put(JSONBIN_URL, data, {
    headers: { 'Content-Type': 'application/json', 'X-Master-Key': JSONBIN_KEY },
    timeout: 10000
  });
}

// ── 计算周期天数 ────────────────────────────────────
function getCycleDay(link) {
  const now = new Date();
  const start = new Date(link.cycleStartDate);
  const diff = Math.floor((now.getTime() - start.getTime()) / (1000 * 60 * 60 * 24));
  return ((diff % 3) + 3) % 3; // 0=day1, 1=day2, 2=day3
}

// ── 发送 WxPusher 消息 ──────────────────────────────
async function send(url, name, dayIndex, appToken, uids) {
  await axios.post('https://wxpusher.zjiecode.com/api/send/message/', {
    appToken,
    content: `🛒 购物提醒\n\n${name}\n\n🔄 周期第${dayIndex + 1}天 · 每3天循环\n⏰ 点击下方链接立即购买 ⬇️`,
    contentType: 1,
    uids,
    url
  }, { timeout: 10000 });
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

  // 北京时间
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
})();
