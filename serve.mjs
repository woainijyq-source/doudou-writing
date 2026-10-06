// 豆豆写作乐园 · 服务器（零依赖，Node 18+）
// 本机：双击 start.command 运行，网页地址 http://localhost:8765/
// 线上：PM2 运行，Nginx 反代；设置 APP_PASSWORD 后需要家庭口令才能使用。
//
// 作用：
//   1. 提供网页
//   2. 转发 AI 对话（AI_KEY 只在服务器上，网页里不带密钥）
//   3. 转发豆包语音合成，并把合成好的声音缓存在 tts-cache/
//   4. 保存数据：作品本、星星、设置、写到一半的作文（DATA_DIR，默认 data/）
//
// .env 变量：
//   VOLC_TTS_KEY       火山引擎豆包语音 API Key
//   VOLC_TTS_RESOURCE  默认 seed-tts-2.0
//   AI_BASE            默认 https://doudou-newapi.com
//   AI_KEY             AI 接口 Key（设置后网页里的 Key 会被去掉）
//   AI_MODEL           强制使用的模型（可选）
//   APP_PASSWORD       家庭口令（线上必须设置；本机可不设）
//   SESSION_SECRET     登录 Cookie 签名密钥（可选，不设则由口令推导）
//   PORT / HOST        默认 8765 / 127.0.0.1
//   DATA_DIR           默认 ./data
//   CHAT_PER_DAY       每天 AI 调用上限，默认 800
//   TTS_PER_DAY        每天豆包语音合成上限（缓存命中不算），默认 3000
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { exec } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const env = {};
try {
  for (const line of fs.readFileSync(path.join(DIR, '.env'), 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
} catch {}
const get = (k, d = '') => process.env[k] || env[k] || d;

const PORT = Number(get('PORT', '8765'));
const HOST = get('HOST', '127.0.0.1');
const TTS_KEY = get('VOLC_TTS_KEY');
const TTS_RESOURCE = get('VOLC_TTS_RESOURCE', 'seed-tts-2.0');
const TTS_URL = get('VOLC_TTS_URL', 'https://openspeech.bytedance.com/api/v3/tts/unidirectional');
const AI_BASE = get('AI_BASE', 'https://doudou-newapi.com').replace(/\/+$/, '');
const AI_KEY = get('AI_KEY');
const AI_MODEL = get('AI_MODEL');
const APP_PASSWORD = get('APP_PASSWORD');
const SECRET = get('SESSION_SECRET') || crypto.createHash('sha256').update('dd|' + APP_PASSWORD + '|' + TTS_KEY).digest('hex');
const DATA = path.resolve(DIR, get('DATA_DIR', 'data'));
const CACHE = path.join(DIR, 'tts-cache');
const CHAT_PER_DAY = Number(get('CHAT_PER_DAY', '800'));
const TTS_PER_DAY = Number(get('TTS_PER_DAY', '3000'));
for (const d of [CACHE, DATA, path.join(DATA, 'backups')]) fs.mkdirSync(d, { recursive: true });

const VOICES = new Set([
  'zh_female_xiaohe_uranus_bigtts', 'zh_female_vv_uranus_bigtts', 'zh_female_tianmeixiaoyuan_uranus_bigtts',
  'zh_female_shuangkuaisisi_uranus_bigtts', 'zh_male_shaonianzixin_uranus_bigtts',
]);

/* ---------- 小工具 ---------- */
function readBody(req, limit = 300_000) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > limit) { reject(Object.assign(new Error('内容太大'), { status: 413 })); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
async function readJson(req, limit) { const s = await readBody(req, limit); try { return JSON.parse(s || '{}'); } catch { throw Object.assign(new Error('JSON 格式不对'), { status: 400 }); } }
function send(res, code, body, type = 'application/json; charset=utf-8', extra = {}) {
  res.writeHead(code, { 'Content-Type': type, ...extra });
  res.end(body);
}
const json = (res, code, obj, extra) => send(res, code, JSON.stringify(obj), 'application/json; charset=utf-8', extra);
const today = () => new Date().toISOString().slice(0, 10);

/* ---------- 每日额度 ---------- */
const usage = { day: today(), chat: 0, tts: 0 };
function spend(kind, limit) {
  if (usage.day !== today()) Object.assign(usage, { day: today(), chat: 0, tts: 0 });
  if (usage[kind] >= limit) throw Object.assign(new Error('今天用得太多啦，明天再来吧'), { status: 429 });
  usage[kind]++;
}

/* ---------- 登录 ---------- */
const TOKEN = crypto.createHmac('sha256', SECRET).update('doudou-writing:v1').digest('hex');
function authed(req) {
  if (!APP_PASSWORD) return true;
  const m = (req.headers.cookie || '').match(/(?:^|;\s*)dd_auth=([a-f0-9]+)/);
  return !!m && m[1].length === TOKEN.length && crypto.timingSafeEqual(Buffer.from(m[1]), Buffer.from(TOKEN));
}
const fails = new Map(); // ip -> {n, t}
function clientIp(req) { return (req.headers['x-real-ip'] || req.socket.remoteAddress || '').toString(); }

/* ---------- 数据存储（JSON 文件，原子写入） ---------- */
const FILES = { works: 'works.json', profile: 'profile.json', draft: 'draft.json' };
const DEFAULTS = { works: [], profile: { stars: 0, prefs: {} }, draft: null };
const cache = {};
function load(name) {
  if (name in cache) return cache[name];
  try { cache[name] = JSON.parse(fs.readFileSync(path.join(DATA, FILES[name]), 'utf8')); }
  catch { cache[name] = structuredClone(DEFAULTS[name]); }
  return cache[name];
}
let writing = Promise.resolve();
function save(name, value) {
  cache[name] = value;
  writing = writing.then(() => {
    const file = path.join(DATA, FILES[name]), tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(value, null, name === 'works' ? 1 : 0));
    fs.renameSync(tmp, file);
    if (name === 'works') backup();
  }).catch(e => console.error('[保存失败]', name, e.message));
  return writing;
}
function backup() {
  const dir = path.join(DATA, 'backups'), f = path.join(dir, `works-${today()}.json`);
  fs.copyFileSync(path.join(DATA, FILES.works), f);
  const old = fs.readdirSync(dir).filter(x => x.startsWith('works-')).sort();
  for (const x of old.slice(0, Math.max(0, old.length - 60))) fs.rmSync(path.join(dir, x), { force: true });
}
function cleanWork(w) {
  const s = (v, n) => String(v ?? '').slice(0, n);
  return {
    id: s(w.id, 40) || String(Date.now()), date: s(w.date, 20), title: s(w.title, 60), kind: s(w.kind, 20),
    text: s(w.text, 8000), polished: s(w.polished, 8000), said: s(w.said, 8000),
    review: w.review && typeof w.review === 'object' ? w.review : null,
    createdAt: Number(w.createdAt) || Date.now(), updatedAt: Date.now(),
  };
}
function upsertWorks(list) {
  const works = load('works').slice();
  for (const w of list) {
    const c = cleanWork(w), i = works.findIndex(x => x.id === c.id);
    if (i >= 0) works[i] = { ...works[i], ...c, createdAt: works[i].createdAt }; else works.unshift(c);
  }
  works.sort((a, b) => b.createdAt - a.createdAt);
  return save('works', works);
}

/* ---------- 豆包语音 ---------- */
const inflight = new Map();
async function synth(text, voice, rate) {
  const key = crypto.createHash('sha256').update(`${voice}|${rate}|${text}`).digest('hex');
  const file = path.join(CACHE, key + '.mp3');
  if (fs.existsSync(file)) return fs.readFileSync(file);
  if (inflight.has(key)) return inflight.get(key);
  spend('tts', TTS_PER_DAY);
  const p = (async () => {
    for (let attempt = 0; attempt < 2; attempt++) {
      const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 20000);
      try {
        const r = await fetch(TTS_URL, {
          method: 'POST', signal: ctrl.signal,
          headers: { 'Content-Type': 'application/json', 'X-Api-Key': TTS_KEY, 'X-Api-Resource-Id': TTS_RESOURCE, 'X-Api-Request-Id': crypto.randomUUID() },
          body: JSON.stringify({ user: { uid: 'doudou-writing' }, req_params: { text, speaker: voice, audio_params: { format: 'mp3', sample_rate: 24000, speech_rate: rate } } }),
        });
        const raw = await r.text();
        if (!r.ok) { if ((r.status === 429 || r.status >= 500) && attempt === 0) continue; throw new Error(`豆包语音 HTTP ${r.status}: ${raw.slice(0, 160)}`); }
        const parts = [];
        for (const line of raw.split('\n')) {
          const s = line.trim().replace(/^data:\s*/, ''); if (!s || s === '[DONE]') continue;
          let j; try { j = JSON.parse(s); } catch { continue; }
          if (j.code != null && ![0, 20000000].includes(Number(j.code))) throw new Error(`豆包语音错误 ${j.code}: ${j.message || ''}`);
          if (typeof j.data === 'string' && j.data) parts.push(Buffer.from(j.data, 'base64'));
        }
        const buf = Buffer.concat(parts);
        if (!buf.length) throw new Error('豆包语音没有返回声音');
        fs.writeFileSync(file, buf);
        return buf;
      } catch (e) {
        if (attempt === 0 && e.name === 'AbortError') continue;
        throw e;
      } finally { clearTimeout(t); }
    }
    throw new Error('豆包语音超时');
  })();
  inflight.set(key, p);
  try { return await p; } finally { inflight.delete(key); }
}

/* ---------- 网页 ---------- */
function page() {
  let html = fs.readFileSync(path.join(DIR, 'doudou-writing.html'), 'utf8');
  // 服务器上有 AI_KEY 时，不把任何密钥发给浏览器
  if (AI_KEY) html = html.replace(/apiKey:\s*"[^"]*"/, 'apiKey:  ""');
  return html;
}

/* ---------- 路由 ---------- */
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;
  // 本机模式（没设口令）：允许直接双击打开的网页调用
  const origin = req.headers.origin;
  if (!APP_PASSWORD && origin && (origin === 'null' || /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin))) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Vary', 'Origin');
  }
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  try {
    if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
      return send(res, 200, page(), 'text/html; charset=utf-8', { 'Cache-Control': 'no-store' });
    }
    if (req.method === 'GET' && p === '/api/health') {
      return json(res, 200, { ok: true, tts: !!TTS_KEY, store: true, auth: !!APP_PASSWORD, authed: authed(req) });
    }
    if (req.method === 'POST' && p === '/api/login') {
      const ip = clientIp(req), f = fails.get(ip);
      if (f && f.n >= 8 && Date.now() - f.t < 10 * 60e3) return json(res, 429, { error: '试错太多次了，过10分钟再试' });
      const b = await readJson(req, 2000);
      const pw = String(b.password || '');
      const ok = APP_PASSWORD && pw.length === APP_PASSWORD.length && crypto.timingSafeEqual(Buffer.from(pw), Buffer.from(APP_PASSWORD));
      if (!ok) { fails.set(ip, { n: (f && Date.now() - f.t < 10 * 60e3 ? f.n : 0) + 1, t: Date.now() }); return json(res, 401, { error: '口令不对哦' }); }
      fails.delete(ip);
      const secure = (req.headers['x-forwarded-proto'] || '') === 'https' ? '; Secure' : '';
      return json(res, 200, { ok: true }, { 'Set-Cookie': `dd_auth=${TOKEN}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000${secure}` });
    }
    if (p.startsWith('/api/') && !authed(req)) return json(res, 401, { error: '需要家庭口令' });

    /* 数据 */
    if (req.method === 'GET' && p === '/api/data') {
      return json(res, 200, { works: load('works'), profile: load('profile'), draft: load('draft') }, { 'Cache-Control': 'no-store' });
    }
    if (req.method === 'POST' && p === '/api/works') {
      const b = await readJson(req, 400_000);
      if (!b.work || typeof b.work !== 'object') return json(res, 400, { error: '缺少 work' });
      await upsertWorks([b.work]);
      return json(res, 200, { ok: true });
    }
    if (req.method === 'POST' && p === '/api/import') {
      const b = await readJson(req, 3_000_000);
      const list = Array.isArray(b.works) ? b.works.slice(0, 500) : [];
      const have = new Set(load('works').map(w => w.id));
      const fresh = list.filter(w => w && !have.has(String(w.id)));
      if (fresh.length) await upsertWorks(fresh);
      if (Number(b.stars) > 0) { const pr = load('profile'); await save('profile', { ...pr, stars: Math.max(pr.stars || 0, Number(b.stars)) }); }
      return json(res, 200, { ok: true, imported: fresh.length });
    }
    const del = p.match(/^\/api\/works\/([\w.-]{1,40})$/);
    if (req.method === 'DELETE' && del) {
      await save('works', load('works').filter(w => w.id !== del[1]));
      return json(res, 200, { ok: true });
    }
    if (req.method === 'PUT' && p === '/api/profile') {
      const b = await readJson(req, 20_000), pr = load('profile');
      const next = { ...pr };
      if (b.stars != null) next.stars = Math.max(0, Math.floor(Number(b.stars) || 0));
      if (b.prefs && typeof b.prefs === 'object') next.prefs = { ...(pr.prefs || {}), ...b.prefs };
      await save('profile', next);
      return json(res, 200, { ok: true });
    }
    if (req.method === 'PUT' && p === '/api/draft') {
      const b = await readJson(req, 400_000);
      await save('draft', b.draft && typeof b.draft === 'object' ? { ...b.draft, savedAt: Date.now() } : null);
      return json(res, 200, { ok: true });
    }

    /* 朗读 */
    if (req.method === 'POST' && p === '/api/tts') {
      if (!TTS_KEY) return send(res, 503, '没有配置 VOLC_TTS_KEY', 'text/plain; charset=utf-8');
      const b = await readJson(req, 8000);
      const text = String(b.text || '').replace(/\s+/g, ' ').trim();
      const voice = VOICES.has(b.voice) ? b.voice : 'zh_female_xiaohe_uranus_bigtts';
      const rate = Math.max(-50, Math.min(50, Number(b.rate) || 0));
      if (!text || text.length > 300) return send(res, 400, 'text 需要 1 到 300 字', 'text/plain; charset=utf-8');
      const buf = await synth(text, voice, rate);
      return send(res, 200, buf, 'audio/mpeg', { 'Cache-Control': 'private, max-age=31536000, immutable' });
    }
    /* AI */
    if (req.method === 'POST' && p === '/api/chat') {
      const body = await readJson(req);
      spend('chat', CHAT_PER_DAY);
      if (AI_MODEL) body.model = AI_MODEL;
      body.max_tokens = Math.min(Number(body.max_tokens) || 900, 3000);
      const auth = AI_KEY ? 'Bearer ' + AI_KEY : (req.headers.authorization || '');
      const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 120000);
      try {
        const r = await fetch(AI_BASE + '/v1/chat/completions', {
          method: 'POST', signal: ctrl.signal, headers: { 'Content-Type': 'application/json', Authorization: auth }, body: JSON.stringify(body),
        });
        return send(res, r.status, await r.text(), r.headers.get('content-type') || 'application/json');
      } finally { clearTimeout(t); }
    }
    send(res, 404, 'not found', 'text/plain');
  } catch (e) {
    console.error('[出错]', p, e.message);
    send(res, e.status || 502, String(e.message || e), 'text/plain; charset=utf-8');
  }
});

server.listen(PORT, HOST, () => {
  const link = `http://localhost:${PORT}/`;
  console.log(`\n  豆豆写作乐园已启动：${link}`);
  console.log(`  豆包语音：${TTS_KEY ? '已配置' : '未配置（会用系统朗读）'}　家庭口令：${APP_PASSWORD ? '已开启' : '未开启'}　数据目录：${DATA}`);
  if (!process.env.NO_OPEN && !APP_PASSWORD) {
    console.log('  用完关掉这个窗口即可。\n');
    const cmd = process.platform === 'darwin' ? `open "${link}"` : process.platform === 'win32' ? `start "" "${link}"` : `xdg-open "${link}"`;
    exec(cmd);
  }
});
