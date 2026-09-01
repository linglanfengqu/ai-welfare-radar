#!/usr/bin/env node
/**
 * AI 厂商福利情报站 · 每日巡检脚本（零依赖，Node 18+）
 *
 * 用法：
 *   node scripts/update-data.mjs            # 只巡检，生成 reports/ 下的当日报告
 *   node scripts/update-data.mjs --apply    # 巡检 + 把高置信度新活动自动写回 data.js
 *
 * 它做三件事：
 *   1. 抓取各厂商「公告/更新日志」页，提取疑似福利活动的链接；
 *   2. 逐条检查现有鸡蛋榜条目的链接是否还活着（404/410 判定失效）；
 *   3. 生成巡检报告；--apply 时把「同时带金额/额度和截止日期」的候选自动收录，
 *      并打上 auto:true 标记（页面上会显示「自动收录」角标，提示人工复核）。
 *
 * 控制台类页面（火山/百炼/千帆/腾讯云）需要登录，脚本够不到，
 * 会列在报告的「人工巡检清单」里，点链接人工看一眼即可。
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA_FILE = path.join(ROOT, 'data.js');
const REPORT_DIR = path.join(ROOT, 'reports');
const APPLY = process.argv.includes('--apply');
const TIMEOUT = 15000;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

/* ---------- 数据源配置：想加源就在这里加一条 ----------
 * type: 'list'   公告列表页（静态可抓），脚本自动提取活动链接
 * type: 'manual' 需登录的控制台页，脚本只把它列进人工巡检清单
 */
const SOURCES = [
  { id: 'deepseek',    vendor: 'DeepSeek',      color: '#4d6bfe', type: 'list', url: 'https://api-docs.deepseek.com/zh-cn/news/', pathHint: '/news/' },
  { id: 'moonshot',    vendor: 'Moonshot Kimi', color: '#5a5a5a', type: 'list', url: 'https://platform.moonshot.cn/docs/announce', pathHint: '/announce' },
  { id: 'zhipu',       vendor: '智谱 AI',        color: '#4f6ef7', type: 'list', url: 'https://docs.bigmodel.cn/cn/update', pathHint: '/update' },
  { id: 'siliconflow', vendor: '硅基流动',       color: '#7c5cff', type: 'list', url: 'https://siliconflow.cn/zh-cn/news', pathHint: '/news' },
  { id: 'gemini',      vendor: 'Google Gemini', color: '#1a73e8', type: 'list', url: 'https://ai.google.dev/gemini-api/docs/release-notes' },
  { id: 'anthropic',   vendor: 'Anthropic',     color: '#d4a27f', type: 'list', url: 'https://docs.anthropic.com/en/news', pathHint: '/news' },
  { id: 'openrouter',  vendor: 'OpenRouter',    color: '#a3a3a3', type: 'list', url: 'https://openrouter.ai/changelog', pathHint: '/changelog' },
  { id: 'volcengine',  vendor: '火山方舟',       color: '#3b82f6', type: 'manual', url: 'https://console.volcengine.com/ark' },
  { id: 'bailian',     vendor: '阿里云百炼',     color: '#ff6a00', type: 'manual', url: 'https://bailian.console.aliyun.com' },
  { id: 'qianfan',     vendor: '百度千帆',       color: '#2932e1', type: 'manual', url: 'https://console.bce.baidu.com/qianfan' },
  { id: 'hunyuan',     vendor: '腾讯云混元',     color: '#0052d9', type: 'manual', url: 'https://console.cloud.tencent.com/hunyuan' },
  { id: 'minimax',     vendor: 'MiniMax',       color: '#f23f5d', type: 'manual', url: 'https://platform.minimaxi.com' }
];

const ACTIVITY_RE = /(免费|赠送|白嫖|羊毛|福利|活动|优惠|折扣|降价|半价|折|新用户|新客|注册|体验|代金|积分|公测|限时|额度|tokens?|credit|bonus|promo|free|discount|pricing)/i;
const JUNK_RE = /(备案|许可证|隐私|条款|协议|关于我们|联系我们|加入我们|登录|注册账号|首页|控制台|下载|icp|copyright|license|签名|管理)/i;

/* ================= 工具函数 ================= */
const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

async function fetchText(url) {
  const res = await fetch(url, {
    headers: { 'user-agent': UA, 'accept': 'text/html,application/xhtml+xml,*/*;q=0.8', 'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8' },
    redirect: 'follow',
    signal: AbortSignal.timeout(TIMEOUT)
  });
  const text = await res.text();
  return { status: res.status, text, finalUrl: res.url };
}

function decodeEntities(s) {
  return s
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'").replace(/&nbsp;/g, ' ');
}

function stripHtml(html) {
  return decodeEntities(
    html.replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<[^>]+>/g, ' ')
  ).replace(/\s+/g, ' ').trim();
}

/** 从列表页提取候选公告链接 */
function extractLinks(html, baseUrl) {
  const out = [];
  const re = /<a\b[^>]*href=["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    try {
      const url = new URL(m[1], baseUrl);
      if (!/^https?:$/.test(url.protocol)) continue;
      const title = stripHtml(m[2]);
      if (title.length >= 6 && title.length <= 120) out.push({ title, url: url.toString() });
    } catch { /* 非法链接忽略 */ }
  }
  return out;
}

/** 解析正文里的日期 → YYYY-MM-DD 数组 */
function parseDates(text) {
  const found = new Set();
  const now = new Date();
  const pad = n => String(n).padStart(2, '0');
  const make = (y, mo, d) => `${y}-${pad(mo)}-${pad(d)}`;

  const full = /20\d{2}\s*[-\/年.]\s*(1[0-2]|0?[1-9])\s*[-\/月.]\s*(3[01]|[12]\d|0?[1-9])\s*日?/g;
  let m;
  while ((m = full.exec(text)) !== null) found.add(make(+m[0].slice(0, 4), +m[1], +m[2]));

  const noYear = /(1[0-2]|0?[1-9])\s*月\s*(3[01]|[12]\d|0?[1-9])\s*[日号]/g;
  while ((m = noYear.exec(text)) !== null) {
    const mo = +m[1], d = +m[2];
    let y = now.getFullYear();
    if (new Date(y, mo - 1, d) < now) y += 1;          // 已过去的月日 → 算明年
    found.add(make(y, mo, d));
  }
  return [...found];
}

/** 解析福利量级：token 数 / 代金券金额 / 折扣 */
function parseAmounts(text) {
  const out = [];
  let m;
  const token = /(\d+(?:\.\d+)?)\s*(亿|千万|百万|万)?\s*tokens?/gi;
  while ((m = token.exec(text)) !== null) out.push(`${m[1]} ${m[2] || ''}Tokens`.replace(' ', ' '));
  const yuan = /[¥￥]\s*(\d+(?:\.\d+)?)/g;
  while ((m = yuan.exec(text)) !== null) out.push(`¥${m[1]}`);
  const dollar = /\$\s*(\d+(?:\.\d+)?)/g;
  while ((m = dollar.exec(text)) !== null) out.push(`$${m[1]}`);
  const zhe = /(\d(?:\.\d+)?)\s*折/g;
  while ((m = zhe.exec(text)) !== null) out.push(`${m[1]} 折`);
  return out;
}

function classifyType(text) {
  if (/永久免费| permanently /i.test(text)) return 'forever';
  if (/每日|每天|签到|daily/i.test(text)) return 'daily';
  if (/注册|新用户|新客|signup/i.test(text)) return 'signup';
  return 'limited';
}

/** 粗略估算 token 当量（万），用于「蛋的大小」排序 */
function estimateValue(amounts, title) {
  let v = 0;
  const token = /(\d+(?:\.\d+)?)\s*(亿|千万|百万|万)?\s*tokens?/i.exec(amounts.join(' ') + ' ' + title);
  if (token) {
    const n = parseFloat(token[1]);
    const unit = { '亿': 10000, '千万': 1000, '百万': 100, '万': 1 }[token[2] || '万'];
    v = Math.round(n * unit);
  }
  const yuan = /[¥￥]?(\d+(?:\.\d+)?)/.exec(amounts.find(a => a.startsWith('¥')) || '');
  if (!v && yuan) v = Math.round(parseFloat(yuan[1]) * 25);   // 1 元 ≈ 25 万 token 当量
  return v || 100;
}

const normalize = s => s.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, '');
function bigrams(s) {
  const set = new Set();
  for (let i = 0; i < s.length - 1; i++) set.add(s.slice(i, i + 2));
  return set;
}
function similar(a, b) {
  const A = bigrams(normalize(a)), B = bigrams(normalize(b));
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const g of A) if (B.has(g)) inter++;
  return 2 * inter / (A.size + B.size);
}

function isDuplicate(eggs, cand) {
  const candUrl = cand.url.replace(/\/+$/, '');
  for (const e of eggs) {
    if (e.url && e.url.replace(/\/+$/, '') === candUrl) return true;
    if (e.vendor === cand.vendor && similar(e.title, cand.title) > 0.55) return true;
  }
  return false;
}

/* ================= data.js 读写 ================= */
function loadData() {
  const raw = readFileSync(DATA_FILE, 'utf8');
  const noComments = raw.replace(/\/\*[\s\S]*?\*\//g, '');
  const m = noComments.match(/window\.DATA\s*=\s*(\{[\s\S]*\});?\s*$/);
  if (!m) throw new Error('data.js 里找不到 window.DATA 赋值');
  return JSON.parse(m[1]);
}

function saveData(data) {
  const header = `/* ================================================================
 * AI 厂商福利情报站 · 数据文件（由人工与 scripts/update-data.mjs 共同维护）
 * 自动收录的条目带 "auto": true，人工核对无误后请删掉该标记。
 * ================================================================ */
window.DATA = ${JSON.stringify(data, null, 2)};
`;
  writeFileSync(DATA_FILE, header, 'utf8');
}

/* ================= 价格对表与时效清理 ================= */
const FX_RATE = 7.2;        // USD → CNY 估算汇率
const PRICE_TOL = 0.15;     // 偏差超过 15% 视为价格失真
const INTL_MODEL_IDS = {
  'GPT-5': 'openai/gpt-5',
  'Gemini-2.5-Flash': 'google/gemini-2.5-flash'
};
const round1 = n => Math.round(n * 10) / 10;

async function checkIntlPrices(data, log, apply) {
  log.push('**国际模型价格对表**（OpenRouter 公开 API，按 1 USD ≈ ¥7.2 折算，偏差 >15% 判定失真）：');
  let byId;
  try {
    const res = await fetch('https://openrouter.ai/api/v1/models', { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(TIMEOUT) });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    byId = new Map((await res.json()).data.map(m => [m.id, m]));
  } catch (err) {
    log.push(`  - 对表失败：${err.message}（隔日重试）`);
    return;
  }
  for (const [name, id] of Object.entries(INTL_MODEL_IDS)) {
    const m = byId.get(id);
    const ours = (data.models || []).find(x => x.name === name);
    if (!m || !m.pricing || !ours) { log.push(`  - ${name}：未在 OpenRouter 找到 ${id}，跳过`); continue; }
    const pin = parseFloat(m.pricing.prompt) * 1e6 * FX_RATE;
    const pout = parseFloat(m.pricing.completion) * 1e6 * FX_RATE;
    if (!isFinite(pin) || !isFinite(pout)) continue;
    const drift = Math.max(Math.abs(pin - ours.pin) / ours.pin, Math.abs(pout - ours.pout) / ours.pout);
    if (drift <= PRICE_TOL) { log.push(`  - ${name}：一致（维持 ¥${ours.pin}/¥${ours.pout}）`); continue; }
    if (apply) {
      ours.pin = round1(pin); ours.pout = round1(pout); ours.priceCheckedAt = today();
      log.push(`  - ${name}：偏差 ${(drift * 100).toFixed(0)}%，已自动更新为 ¥${ours.pin}/¥${ours.pout}（结构化数据源，建议顺手复核）`);
    } else {
      log.push(`  - ${name}：偏差 ${(drift * 100).toFixed(0)}%（现值 ¥${ours.pin}/¥${ours.pout} → 新值 ¥${round1(pin)}/¥${round1(pout)}），--apply 可自动更新`);
    }
  }
}

async function verifyDeepSeekPrice(data, log) {
  log.push('**DeepSeek 官方定价页核验**（仅提示，不自动改）：');
  try {
    const { status, text } = await fetchText('https://api-docs.deepseek.com/zh-cn/quick_start/pricing');
    if (status >= 400) throw new Error('HTTP ' + status);
    const plain = stripHtml(text);
    const ours = (data.models || []).find(x => x.name.startsWith('DeepSeek-V3.2'));
    if (!ours) return;
    const ok = [ours.pin, ours.pout].every(v => plain.includes(String(v)) || plain.includes(v.toFixed(1)));
    log.push(ok
      ? `  - DeepSeek-V3.2：定价页能对到 ¥${ours.pin}/¥${ours.pout}，未见明显变化`
      : `  - ⚠ 页面上没对到 ¥${ours.pin}/¥${ours.pout}，官方定价可能已调整，请人工核对 api-docs.deepseek.com/zh-cn/quick_start/pricing`);
  } catch (err) {
    log.push(`  - 核验失败：${err.message}（隔日重试）`);
  }
}

function pruneExpired(data, log, apply) {
  const cutoff = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
  const stale = list => list.filter(x => x.end && !x.forever && x.end < cutoff);
  const removedEggs = stale(data.eggs);
  const removedFree = Array.isArray(data.free) ? stale(data.free) : [];
  if (apply) {
    data.eggs = data.eggs.filter(x => !(x.end && !x.forever && x.end < cutoff));
    if (Array.isArray(data.free)) data.free = data.free.filter(x => !(x.end && !x.forever && x.end < cutoff));
  }
  log.push(`**过期清理**（截止日早于 ${cutoff} 的条目${apply ? '已自动移除' : '待移除，--apply 生效'}）：`);
  removedEggs.forEach(e => log.push(`  - 鸡蛋榜：${e.vendor}「${e.title}」（${e.end} 已过期）`));
  removedFree.forEach(f => log.push(`  - 免费榜：${f.vendor}「${f.name}」（${f.end} 已过期）`));
  if (!removedEggs.length && !removedFree.length) log.push('  - 本轮无超期条目');
}

/* ================= 主流程 ================= */
async function scanSource(src) {
  const { status, text, finalUrl } = await fetchText(src.url);
  if (status >= 400) throw new Error(`HTTP ${status}`);
  const links = extractLinks(text, finalUrl);
  const hintHits = src.pathHint ? links.filter(l => l.url.includes(src.pathHint)) : [];
  const kwHits = links.filter(l => ACTIVITY_RE.test(l.title) && !JUNK_RE.test(l.title));
  const merged = [...new Map([...hintHits, ...kwHits].map(l => [l.url, l])).values()];
  const picked = merged.slice(0, 12);
  return picked.map(l => {
    const blob = l.title;
    return {
      sourceId: src.id,
      vendor: src.vendor,
      color: src.color,
      title: blob.length > 48 ? blob.slice(0, 48) + '…' : blob,
      url: l.url.split('#')[0],
      dates: parseDates(blob),
      amounts: parseAmounts(blob),
      type: classifyType(blob)
    };
  });
}

async function checkLink(url) {
  try {
    const { status } = await fetchText(url);
    if (status === 404 || status === 410) return 'dead';
    if (status >= 400) return 'blocked';   // 403/401/429 等，多半是反爬，不能断定失效
    return 'ok';
  } catch (err) {
    return err.name === 'TimeoutError' ? 'blocked' : 'blocked';
  }
}

async function main() {
  const data = loadData();
  const dateStr = today();
  console.log(`\n🥚 AI 厂商福利巡检 ${dateStr}${APPLY ? '（自动收录模式）' : '（只看不动）'}\n`);

  /* 1. 扫描各数据源 */
  const candidates = [];
  const errors = [];
  const listSources = SOURCES.filter(s => s.type === 'list');
  for (const src of listSources) {
    process.stdout.write(`  扫描 ${src.vendor.padEnd(14)} ${src.url} ... `);
    try {
      const items = await scanSource(src);
      console.log(`OK，${items.length} 条链接`);
      candidates.push(...items);
    } catch (err) {
      console.log(`失败（${err.message}）`);
      errors.push({ source: src, message: err.message });
    }
  }

  /* 2. 与现有条目去重，挑出高置信度新情报 */
  const fresh = candidates.filter(c => !isDuplicate(data.eggs, c));
  const strong = fresh.filter(c => (c.dates.length > 0 && c.amounts.length > 0) ||
                                   (c.amounts.length > 0 && /免费|折扣|折|赠送|送/.test(c.title)));
  const weak = fresh.filter(c => !strong.includes(c));

  /* 3. 现有条目链接健康检查（鸡蛋榜 + 免费榜） */
  const linkTargets = data.eggs.concat(Array.isArray(data.free) ? data.free : []);
  console.log(`\n  检查现有 ${linkTargets.length} 条福利链接 ... `);
  const dead = [], blocked = [];
  for (const e of linkTargets) {
    const state = await checkLink(e.url);
    if (state === 'dead') dead.push(e);
    else if (state === 'blocked') blocked.push(e);
  }
  console.log(`  正常 ${linkTargets.length - dead.length - blocked.length} · 失效 ${dead.length} · 无法验证 ${blocked.length}`);

  /* 3.5 价格对表与时效清理 */
  const priceLog = [], pruneLog = [];
  await checkIntlPrices(data, priceLog, APPLY);
  await verifyDeepSeekPrice(data, priceLog);
  pruneExpired(data, pruneLog, APPLY);
  console.log('  价格对表与过期清理完成，详情见报告');

  /* 4. 生成巡检报告 */
  mkdirSync(REPORT_DIR, { recursive: true });
  const rep = [];
  rep.push(`# 福利巡检报告 · ${dateStr}`);
  rep.push('');
  rep.push(`- 模式：${APPLY ? '自动收录（--apply）' : '只巡检（加 --apply 可自动写回 data.js）'}`);
  rep.push(`- 数据源：${listSources.length - errors.length}/${listSources.length} 个扫描成功`);
  rep.push(`- 新发现候选：${fresh.length} 条（高置信度 ${strong.length} 条）`);
  rep.push(`- 现有条目（鸡蛋榜+免费榜）链接：失效 ${dead.length} 条，无法验证 ${blocked.length} 条`);
  if (data.checkedAt) rep.push(`- 上次巡检：${data.checkedAt}`);
  rep.push('');

  rep.push('## 高置信度新情报（建议尽快人工复核）');
  rep.push('');
  if (strong.length) {
    rep.push('| 厂商 | 标题 | 量级 | 日期 | 链接 |');
    rep.push('|---|---|---|---|---|');
    for (const c of strong) rep.push(`| ${c.vendor} | ${c.title} | ${c.amounts.join(' / ') || '—'} | ${c.dates.join(' , ') || '—'} | ${c.url} |`);
  } else rep.push('_本轮没有发现新的高置信度活动。_');
  rep.push('');

  rep.push('## 疑似相关但信息不全（观察即可）');
  rep.push('');
  if (weak.length) {
    rep.push('| 厂商 | 标题 | 链接 |');
    rep.push('|---|---|---|');
    for (const c of weak.slice(0, 20)) rep.push(`| ${c.vendor} | ${c.title} | ${c.url} |`);
  } else rep.push('_无。_');
  rep.push('');

  if (dead.length || blocked.length) {
    rep.push('## 现有条目健康检查');
    rep.push('');
    if (dead.length) { rep.push('**已失效（建议移除或更新链接）：**'); dead.forEach(e => rep.push(`- [ ] ${e.vendor}「${e.title || e.name}」 ${e.url}`)); rep.push(''); }
    if (blocked.length) { rep.push('**无法验证（反爬/超时，多为正常，隔日复查）：**'); blocked.forEach(e => rep.push(`- ${e.vendor}「${e.title || e.name}」 ${e.url}`)); rep.push(''); }
  }

  rep.push('## 价格与时效自动化');
  rep.push('');
  priceLog.forEach(l => rep.push(l));
  pruneLog.forEach(l => rep.push(l));
  rep.push('');
  rep.push('> 套餐榜与国产模型价格暂无可靠公开数据源，为保证准确性不自动改动，统一列在下方人工清单里核对。');
  rep.push('');

  rep.push('## 人工巡检清单（控制台类，脚本够不到，点开看一眼）');
  rep.push('');
  rep.push('| 厂商 | 入口 |');
  rep.push('|---|---|');
  for (const s of SOURCES.filter(s => s.type === 'manual')) rep.push(`| ${s.vendor} | ${s.url} |`);
  rep.push('');

  if (errors.length) {
    rep.push('## 扫描失败的数据源');
    rep.push('');
    errors.forEach(e => rep.push(`- ${e.source.vendor}：${e.message}（${e.source.url}）`));
    rep.push('');
  }

  const reportFile = path.join(REPORT_DIR, `report-${dateStr}.md`);
  writeFileSync(reportFile, rep.join('\n'), 'utf8');

  /* 5. --apply：高置信度条目写回 data.js */
  let added = 0;
  if (APPLY && strong.length) {
    for (const c of strong) {
      const end = c.dates.sort()[c.dates.length - 1] || null;   // 取最晚日期当截止日
      data.eggs.push({
        vendor: c.vendor, color: c.color, title: c.title,
        desc: `巡检脚本 ${dateStr} 自动收录自官方公告页，待人工复核`,
        amount: c.amounts[0] || '待确认', unit: '待确认',
        type: c.type, value: estimateValue(c.amounts, c.title),
        end, forever: false, url: c.url, auto: true, source: c.sourceId
      });
      added++;
    }
  }
  if (APPLY) {
    data.checkedAt = dateStr;
    saveData(data);
  }

  console.log(`\n  汇总：候选 ${fresh.length}（高置信 ${strong.length} / 待观察 ${weak.length}），自动收录 ${added} 条`);
  console.log(`  报告：${path.relative(ROOT, reportFile)}`);
  if (APPLY && added) console.log('  data.js 已更新 ✅（自动收录条目带 auto 标记，记得人工复核）');
  else if (APPLY) console.log('  data.js 已更新 ✅（仅刷新巡检时间）');

  if (errors.length === listSources.length && listSources.length > 0) {
    console.error('\n⚠ 全部数据源扫描失败，像是网络问题，退出码 1');
    process.exit(1);
  }
}

main().catch(err => { console.error('巡检失败：', err); process.exit(1); });
