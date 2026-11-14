import { PermissionFlagsBits } from 'discord.js';
import {
  getAiFilter, listAiFilterChannels, listAiFilterCreators, listAiFilterKeywords,
} from './db.js';
import { baseHost, channelChain, extractUrls, hostIn, TWITTER_HOSTS } from './dupe.js';

export const aiFilterStats = { checked: 0, matched: 0, deleted: 0, failed: 0, unknown: 0, suspect: 0 };

const PIXIV_HOSTS = ['pixiv.net', 'phixiv.net'];
// x.com/<這些> 不是使用者頁
const X_RESERVED = new Set(['i', 'home', 'search', 'explore', 'hashtag', 'intent', 'settings',
  'messages', 'notifications', 'share', 'compose', 'login', 'signup', 'tos', 'privacy']);
// patreon.com/<這些> 不是創作者頁
const PATREON_RESERVED = new Set(['home', 'login', 'signup', 'posts', 'user', 'join', 'explore', 'search',
  'messages', 'notifications', 'settings', 'about', 'pricing', 'c', 'cw']);

/** 一位作者最近的作品裡，至少這個比例標 AI 才算 AI 創作者（件數太少不判定） */
const AI_CREATOR_RATIO = 0.6;
const AI_CREATOR_MIN_WORKS = 3;

/** 一則訊息最多查幾條連結，避免被一則貼滿連結的訊息拖住 */
const MAX_LINKS_PER_MESSAGE = 10;

const FETCH_TIMEOUT_MS = 5000;
const USER_AGENT = 'discord-leveling-bot (moderation link check)';

// ---------- tag／關鍵字比對 ----------

// 否定只作用於同一句／子句，不能讓「禁止訓練」蓋掉另一句「我使用 AI 創作」。
const CLAUSE_BREAK_RE = /[.!?。！？;；\n|]+|\s+\/\s+|\b(?:but|however|yet)\b|但是|不過|不过|可是|しかし|ただし|でも|[,，](?=\s*(?:i\b|we\b|我|本人))/;
// 長聲明從禁止語開始生效，例如「請不要把我的任何作品拿去餵低能AI」。
const NEGATION_PREFIX_RE = /(?:禁止|严禁|嚴禁|請勿|请勿|不要|不得|不可|不准|不允許|不允许|拒絕|拒绝|拒否|反對|反对|反対|\b(?:do\s+not|don['’]?t|must\s+not|may\s+not|cannot|can['’]t|prohibit\w*|forbid\w*|disallow\w*|ban(?:ned)?|no\s+(?:use|training|permission|consent))\b)[\s\S]*$/;
const NEGATION_BEFORE_RE = /(?:不使用|未使用|不用|不是|沒有|没有|非|無|无|\b(?:no|non|not|anti|without|never|hate|against|stop))[\s_#-]*(?:(?:any|generative)[\s_-]+)?$/;
// 後置否定只接受用途／訓練等連接語，不把前面的獨立 AI 創作者宣告一併放行。
const NEGATION_AFTER_RE = /^(?:[\s_#・/、へのをにはで的之-]|使用|利用|学習|學習|学习|訓練|训练|生成|イラスト|アート|絵|画像|一切|用於|用于|\b(?:art|artwork|images?|content|use|usage|for|machine|learning|training|is|are|strictly|absolutely)\b)*(?:禁止|不可|拒否|お断り|不使用|未使用|使用しません|使いません|してません|しません|ではない|ではありません|じゃない|\b(?:ng|prohibit\w*|forbid\w*|banned|not\s+allowed|free|hater|sucks?|theft|thie(?:f|ves))\b)/;

function isNegated(text, index, length) {
  const before = fold(text.slice(0, index)).split(CLAUSE_BREAK_RE).at(-1);
  const after = fold(text.slice(index + length)).split(CLAUSE_BREAK_RE)[0];
  return NEGATION_PREFIX_RE.test(before) || NEGATION_BEFORE_RE.test(before) || NEGATION_AFTER_RE.test(after);
}

// AI 創作者的自介寫法：「3D+AI NSFW animator」「AI artist」「animator using AI」「made with AI」
// 以及常見的高產量動畫／圖片集寫法（很多 AI 創作者不會直接寫 AI）
const AI_ROLE = '(?:animat\\w*|artists?|art|artworks?|creators?|creations?|generated|generator|hentai|nsfw|waifus?|girls?|images?|illustrat\\w*|videos?|porn|lewds?|render\\w*|anime)';
const AI_BIO_PATTERNS = [
  /\b\d\s?d\s*[+&]\s*ai\b/g,
  new RegExp(`(?<![.\\w])ai\\b[\\s-]*(?:[\\w-]+[\\s-]+)?${AI_ROLE}\\b`, 'g'),
  new RegExp(`\\b${AI_ROLE}\\s*(?:using|with|by|powered by|\\+|&)\\s*ai\\b`, 'g'),
  /\b(?:made|created|generated|assisted|powered)\s+(?:with|by|using)\s+ai\b/g,
  /(?<![.\w])ai[\s-]*(?:assisted|powered|made|created)\b/g,
  // 高產量動畫／圖片集（kiityysfw 類型）
  /\bsfw\s*animations?\b/gi,
  /\bnsfw\s*(?:images?\s*&?\s*)?animations?\b/gi,
  /\bimages?\s*&\s*animations?\b/gi,
  /\banimation\s*preview\b/gi,
  /\bfull\s*(?:uncensored\s*)?set\b/gi,
  /\bsets?\s*available\b/gi,
  // 常見 AI 工具（即使沒寫 AI 也高度可疑）
  /\b(?:novelai|midjourney|niji(?:journey)?|pixai|stable\s*diffusion|comfyui|automatic1111|a1111)\b/gi,
];
// 單獨出現的 AI：太短不足以刪除，只當疑似（.ai 網域不算）
const BARE_AI_RE = /(?<![.\w])ai\b/g;
// 「角色 - 作品」加一行 sfw／nsfw 的固定文案。手繪作者也可能這樣寫，所以同樣只當疑似
const CAPTION_TEMPLATE_RE = /^[^\n]{2,60}\s[-–—]\s[^\n]{2,60}\n+\s*n?sfw\s*$/i;

function firstUnnegated(text, patterns) {
  const hay = fold(text);
  for (const re of patterns) {
    for (const m of hay.matchAll(re)) {
      if (!isNegated(hay, m.index, m[0].length)) return m[0];
    }
  }
  return null;
}

/** 簡介符合 AI 創作者寫法時回傳命中的片段 */
export function matchAiBio(bio) {
  return firstUnnegated(bio, AI_BIO_PATTERNS);
}

/** 文案是不是「角色 - 作品 + sfw／nsfw」的固定格式（網址不計） */
export function isCaptionTemplate(text) {
  return CAPTION_TEMPLATE_RE.test(String(text ?? '').replace(/https?:\/\/\S+/g, '').trim());
}

/** 簡介與網站欄位提到的同一人身分：Patreon，以及標明是小號／配對的 X 帳號 */
export function linkedIdentities(bio, website = '') {
  const text = `${bio ?? ''}\n${website ?? ''}`;
  const out = new Set();
  for (const m of text.matchAll(/patreon\.com\/(?:cw\/|c\/)?([\w-]+)/gi)) {
    const slug = m[1].toLowerCase();
    if (!PATREON_RESERVED.has(slug)) out.add(`patreon:${slug}`);
  }
  // 擴大連座：SFW/NSFW 配對、animations、@mention 附近
  const alt = /(?:\bn?sfw\b|\bnsfw\b|\bacc\b|\baccount\b|\balt\b|\bsub\b|animations?|サブ|裏垢|本垢|副|promo)[^\n]{0,40}?(?:(?:x|twitter)\.com\/|@)(\w{1,15})/gi;
  for (const m of text.matchAll(alt)) out.add(`x:${m[1].toLowerCase()}`);
  // 任何 @handle 如果在同一行有 SFW/NSFW/animations 也連
  const mentionNear = /@[a-zA-Z0-9_]{1,15}/g;
  for (const m of text.matchAll(mentionNear)) {
    const lineStart = text.lastIndexOf('\n', m.index) + 1;
    const lineEnd = text.indexOf('\n', m.index);
    const line = text.slice(lineStart, lineEnd === -1 ? undefined : lineEnd);
    if (/\b(?:n?sfw|animations?|images?\s*&\s*animations?)\b/i.test(line)) {
      out.add(`x:${m[0].slice(1).toLowerCase()}`);
    }
  }
  return [...out];
}

const fold = (text) => String(text ?? '').normalize('NFKC').toLowerCase();

function keywordRegex(keyword) {
  const chars = [...fold(keyword).replace(/[\s_-]+/g, '')]
    .map((c) => c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return chars.length ? new RegExp(chars.join('[\\s_-]*'), 'g') : null;
}

/** 命中哪個關鍵字；空格／底線／連字號差異不計，禁止使用／訓練的聲明不算 */
export function matchKeyword(text, keywords) {
  const hay = fold(text);
  for (const keyword of keywords) {
    const re = keywordRegex(keyword);
    if (!re) continue;
    for (const m of hay.matchAll(re)) {
      if (!isNegated(hay, m.index, m[0].length)) return keyword;
    }
  }
  return null;
}

const HASHTAG_RE = /(?:^|[^\p{L}\p{N}_&/])[#＃]([\p{L}\p{M}\p{N}_]+)/gu;

/** 文字裡的 #tag。網址的 #fragment 與 Discord 標題語法（# 後有空白）都不算 */
export function extractHashtags(text) {
  return [...String(text ?? '').matchAll(HASHTAG_RE)].map((m) => m[1]);
}

// 抽出 tag 後仍保留原句，避免「禁止用於 #AIart 訓練」失去否定上下文。
function matchHashtagKeyword(text, keywords) {
  const content = String(text ?? '');
  for (const m of content.matchAll(HASHTAG_RE)) {
    const tag = m[1];
    const index = m.index + m[0].length - tag.length;
    if (matchKeyword(tag, keywords) && !isNegated(content, index, tag.length)) return tag;
  }
  return null;
}

// ---------- 連結解析 ----------

function safeDecode(text) {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

/** 網址 → 要查什麼。不是 pixiv／X／Patreon 的回傳 null */
export function parseTarget(raw) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  const host = baseHost(u.hostname);
  const path = u.pathname;

  if (hostIn(host, TWITTER_HOSTS)) {
    const tag = /^\/hashtag\/([^/]+)/.exec(path);
    if (tag) return { type: 'tag', tag: safeDecode(tag[1]) };
    const status = /^\/([^/]+)(?:\/web)?\/status(?:es)?\/(\d+)/.exec(path);
    if (status) {
      const handle = status[1].toLowerCase();
      return { type: 'x-status', id: status[2], handle: X_RESERVED.has(handle) ? null : handle };
    }
    const handle = /^\/(\w{1,15})(?:\/|$)/.exec(path)?.[1].toLowerCase();
    return handle && !X_RESERVED.has(handle) ? { type: 'x-user', handle } : null;
  }

  if (host === 'pixiv.me') {
    const slug = path.split('/')[1];
    return slug ? { type: 'pixiv-short', slug } : null;
  }

  if (hostIn(host, PIXIV_HOSTS)) {
    const tag = /\/tags\/([^/]+)/.exec(path);
    if (tag) return { type: 'tag', tag: safeDecode(tag[1]) };
    const q = u.searchParams;
    const work = /\/artworks\/(\d+)/.exec(path)?.[1] ?? q.get('illust_id');
    if (work) return { type: 'pixiv-work', id: work };
    const user = /\/users\/(\d+)/.exec(path)?.[1]
      ?? (/\/member(?:_illust)?\.php$/.test(path) ? q.get('id') : null);
    return user ? { type: 'pixiv-user', id: user } : null;
  }

  if (hostIn(host, ['patreon.com'])) {
    const slug = /^\/(?:cw\/|c\/)?([\w-]+)\/?$/.exec(path)?.[1].toLowerCase();
    return slug && !PATREON_RESERVED.has(slug) ? { type: 'patreon', slug } : null;
  }
  return null;
}

// ---------- 外部查詢（只快取事實，不快取判定：名單一改就生效）----------

const CACHE_TTL_MS = 6 * 3600_000;
const CACHE_TTL_MISS_MS = 10 * 60_000;
const CACHE_MAX = 2000;
const cache = new Map();

async function cached(key, load) {
  const hit = cache.get(key);
  if (hit && Date.now() < hit.expires) return hit.value;
  const value = await load();
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
  cache.set(key, { value, expires: Date.now() + (value ? CACHE_TTL_MS : CACHE_TTL_MISS_MS) });
  return value;
}

async function fetchJson(url, headers = {}) {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json', ...headers },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null; // 逾時或對方掛掉：當作查不到，不能讓訊息處理跟著失敗
  }
}

const PIXIV_HEADERS = { Referer: 'https://www.pixiv.net/' };

function pixivWork(id) {
  return cached(`pixiv-work:${id}`, async () => {
    const j = await fetchJson(`https://www.pixiv.net/ajax/illust/${id}?lang=ja`, PIXIV_HEADERS);
    if (!j || j.error || !j.body) return null;
    return {
      aiType: j.body.aiType,
      userId: String(j.body.userId),
      tags: (j.body.tags?.tags ?? []).map((t) => t.tag),
    };
  });
}

function pixivUser(id) {
  return cached(`pixiv-user:${id}`, async () => {
    const j = await fetchJson(`https://www.pixiv.net/ajax/user/${id}/profile/top`, PIXIV_HEADERS);
    if (!j || j.error || !j.body) return null;
    const works = [...Object.values(j.body.illusts ?? {}), ...Object.values(j.body.manga ?? {})];
    return { total: works.length, ai: works.filter((w) => w?.aiType === 2).length };
  });
}

function pixivShortLink(slug) {
  return cached(`pixiv-short:${slug}`, async () => {
    try {
      const res = await fetch(`https://pixiv.me/${encodeURIComponent(slug)}`, {
        headers: { 'User-Agent': USER_AGENT },
        redirect: 'manual',
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      return /\/users\/(\d+)/.exec(res.headers.get('location') ?? '')?.[1] ?? null;
    } catch {
      return null;
    }
  });
}

function xTweet(id) {
  return cached(`x-status:${id}`, async () => {
    const j = await fetchJson(`https://api.fxtwitter.com/i/status/${id}`);
    if (j?.code !== 200 || !j.tweet) return null;
    return {
      text: j.tweet.text ?? '',
      handle: String(j.tweet.author?.screen_name ?? '').toLowerCase() || null,
      name: j.tweet.author?.name ?? '',
      bio: j.tweet.author?.description ?? '',
      website: j.tweet.author?.website?.url ?? '',
    };
  });
}

function xUser(handle) {
  return cached(`x-user:${handle}`, async () => {
    const j = await fetchJson(`https://api.fxtwitter.com/${encodeURIComponent(handle)}`);
    if (j?.code !== 200 || !j.user) return null;
    return { name: j.user.name ?? '', bio: j.user.description ?? '', website: j.user.website?.url ?? '' };
  });
}

// ---------- 判定 ----------

export function loadRules(guildId) {
  const blocked = new Set();
  const allowed = new Set();
  for (const row of listAiFilterCreators(guildId)) (row.list === 'allow' ? allowed : blocked).add(row.creator);
  return { blocked, allowed, keywords: listAiFilterKeywords(guildId) };
}

const NOT_AI = (creator) => ({ hit: false, creator });
const HIT = (creator, reason) => ({ hit: true, creator, reason });
const UNKNOWN = (creator, reason) => ({ hit: false, unknown: true, creator, reason });
const SUSPECT = (creator, reason) => ({ hit: false, suspect: true, creator, reason });

/** 手動名單優先於任何自動判定 */
function listVerdict(creator, rules) {
  if (rules.allowed.has(creator)) return { hit: false, creator, reason: `${creator} 在放行名單` };
  if (rules.blocked.has(creator)) return HIT(creator, `${creator} 在封鎖名單`);
  return null;
}

async function evaluatePixivUser(userId, rules) {
  const creator = `pixiv:${userId}`;
  const listed = listVerdict(creator, rules);
  if (listed) return listed;
  const profile = await pixivUser(userId);
  if (!profile) return UNKNOWN(creator, 'pixiv 查不到這位作者');
  if (profile.total >= AI_CREATOR_MIN_WORKS && profile.ai / profile.total >= AI_CREATOR_RATIO) {
    return HIT(creator, `pixiv 作者最近 ${profile.total} 件作品有 ${profile.ai} 件標記 AI 生成`);
  }
  return NOT_AI(creator);
}

async function evaluatePixivWork(id, rules) {
  const work = await pixivWork(id);
  if (!work) return UNKNOWN(null, 'pixiv 查不到這件作品（可能是 R-18、已刪除或暫時連不上）');
  const creator = `pixiv:${work.userId}`;
  const listed = listVerdict(creator, rules);
  if (listed) return listed;
  if (work.aiType === 2) return HIT(creator, 'pixiv 作品標記為 AI 生成');
  for (const tag of work.tags) {
    const keyword = matchKeyword(tag, rules.keywords);
    if (keyword) return HIT(creator, `pixiv 作品的 tag「${tag}」`);
  }
  return evaluatePixivUser(work.userId, rules);
}

function evaluateXBio(creator, { bio, website, name = '' }, rules) {
  for (const [label, text] of [['個人簡介', bio], ['顯示名稱', name]]) {
    const keyword = matchKeyword(text, rules.keywords);
    if (keyword) return HIT(creator, `X ${label}提到「${keyword}」`);
    const phrase = matchAiBio(text);
    if (phrase) return HIT(creator, `X ${label}寫著「${phrase}」`);
  }
  const linked = linkedIdentities(bio, website).find((id) => rules.blocked.has(id));
  if (linked) return HIT(creator, `X 個人簡介連到封鎖名單上的 ${linked}`);
  if (firstUnnegated(`${name}\n${bio}`, [BARE_AI_RE])) return SUSPECT(creator, 'X 顯示名稱或個人簡介提到 AI');
  // _AI 是待確認的帳號標記；不比對普通名字裡的 ai，也不足以自動刪除。
  if (/(?:^|_)ai(?:_|$)/i.test(creator?.slice(2) ?? '')) return SUSPECT(creator, 'X 帳號名稱有獨立 AI 標記');
  return NOT_AI(creator);
}

async function evaluateXStatus(target, rules) {
  // 網址本身就帶帳號的話，名單判定不必連外
  if (target.handle) {
    const listed = listVerdict(`x:${target.handle}`, rules);
    if (listed) return listed;
  }
  const tweet = await xTweet(target.id);
  if (!tweet) return UNKNOWN(target.handle ? `x:${target.handle}` : null, '查不到這則推文（可能已刪除、私人帳號或服務暫時連不上）');

  const creator = tweet.handle ? `x:${tweet.handle}` : null;
  if (creator) {
    const listed = listVerdict(creator, rules);
    if (listed) return listed;
  }
  const tag = matchHashtagKeyword(tweet.text, rules.keywords);
  if (tag) return HIT(creator, `推文的 tag「#${tag}」`);
  // 推文本身的高產量／AI工具寫法也算（不只看 bio）
  const tweetPhrase = firstUnnegated(tweet.text, AI_BIO_PATTERNS);
  if (tweetPhrase) return HIT(creator, `推文寫著「${tweetPhrase}」`);
  const verdict = evaluateXBio(creator, tweet, rules);
  if (!verdict.hit && !verdict.suspect && isCaptionTemplate(tweet.text)) {
    return SUSPECT(creator, '推文是「角色 - 作品 + sfw／nsfw」的固定文案');
  }
  return verdict;
}

async function evaluateXUser(handle, rules) {
  const creator = `x:${handle}`;
  const listed = listVerdict(creator, rules);
  if (listed) return listed;
  const user = await xUser(handle);
  if (!user) return UNKNOWN(creator, '查不到這個 X 帳號');
  return evaluateXBio(creator, user, rules);
}

/** X 帳號簡介裡連到的同一人身分；封鎖時一併加入名單 */
export async function linkedCreators(creator) {
  if (!creator?.startsWith('x:')) return [];
  const user = await xUser(creator.slice(2));
  return user ? linkedIdentities(user.bio, user.website).filter((id) => id !== creator) : [];
}

export async function evaluateTarget(target, rules) {
  switch (target.type) {
    case 'tag': {
      return matchKeyword(target.tag, rules.keywords)
        ? HIT(null, `連到 tag「${target.tag}」`)
        : NOT_AI(null);
    }
    case 'pixiv-work': return evaluatePixivWork(target.id, rules);
    case 'pixiv-user': return evaluatePixivUser(target.id, rules);
    case 'pixiv-short': {
      const id = await pixivShortLink(target.slug);
      return id ? evaluatePixivUser(id, rules) : UNKNOWN(null, '解不開這條 pixiv.me 短網址');
    }
    case 'x-status': return evaluateXStatus(target, rules);
    case 'x-user': return evaluateXUser(target.handle, rules);
    case 'patreon': return listVerdict(`patreon:${target.slug}`, rules) ?? NOT_AI(`patreon:${target.slug}`);
    default: return NOT_AI(null);
  }
}

/** 檢查一段文字。第一個命中就停；results 列出已查過的每一項 */
export async function evaluateText(guildId, text) {
  const rules = loadRules(guildId);
  const results = [];

  const tag = matchHashtagKeyword(text, rules.keywords);
  if (tag) {
    const verdict = { source: `#${tag}`, ...HIT(null, `訊息裡的 tag「#${tag}」`) };
    results.push(verdict);
    return { hit: verdict, results };
  }

  const targets = [];
  const seen = new Set();
  for (const raw of extractUrls(text)) {
    const target = parseTarget(raw);
    const key = JSON.stringify(target);
    if (target && !seen.has(key)) {
      seen.add(key);
      targets.push({ raw, target });
    }
  }

  for (const { raw, target } of targets.slice(0, MAX_LINKS_PER_MESSAGE)) {
    const verdict = { source: raw, ...(await evaluateTarget(target, rules)) };
    results.push(verdict);
    if (verdict.hit) return { hit: verdict, results };
  }
  return { hit: null, results };
}

// ---------- 訊息處理 ----------

const warnedChannels = new Set();
// 收到 embed 也會觸發 messageUpdate：同一則只回報一次
const reported = new Set();

function firstReport(message, verdict) {
  const key = `${message.id}:${verdict.source}`;
  if (reported.has(key)) return false;
  if (reported.size >= 5000) reported.clear();
  reported.add(key);
  return true;
}

/** 訊息本文加上轉傳內容（轉傳的訊息 content 是空的，文字在 snapshot 裡） */
function messageText(message) {
  const snapshots = message.messageSnapshots ? [...message.messageSnapshots.values()] : [];
  return [message.content, ...snapshots.map((s) => s.content)].filter(Boolean).join('\n');
}

async function sendLog(message, settings, verdict, deleted) {
  if (!settings.log_channel_id) return;
  const channel = message.guild.channels.cache.get(settings.log_channel_id)
    ?? await message.guild.channels.fetch(settings.log_channel_id).catch(() => null);
  if (!channel?.isTextBased?.()) return;

  let status = '👀 命中（只記錄）';
  if (verdict.suspect) status = '🔍 疑似 AI（未刪除，請人工判斷）';
  else if (deleted) status = '🗑️ 已刪除';
  else if (settings.action === 'delete') status = '⚠️ 應刪除但失敗';
  const jump = deleted ? '' : `\n訊息：${message.url}`;
  const who = verdict.creator ? `\n創作者：\`${verdict.creator}\`` : '';
  await channel.send({
    // <> 包住網址，紀錄頻道不展開預覽
    content: `${status} <@${message.author.id}> 在 <#${message.channel.id}>\n` +
      `原因：${verdict.reason}${who}\n來源：${verdict.source.startsWith('#') ? verdict.source : `<${verdict.source}>`}${jump}`,
    allowedMentions: { parse: [] },
  }).catch((err) => console.warn(`[aifilter] 紀錄訊息發送失敗: ${err.message}`));
}

/**
 * 過濾頻道裡貼 AI 創作者的連結或 tag 就處理掉。
 * 跟 XP／去重完全獨立；訊息被刪時，既有的 messageDelete 會一併取消 pending 與去重紀錄。
 */
export async function handleAiFilter(message) {
  const guildId = message.guild.id;
  const settings = getAiFilter(guildId);
  if (settings.action === 'off') return null;

  const watched = listAiFilterChannels(guildId);
  if (watched.length === 0 || !channelChain(message.channel).some((id) => watched.includes(id))) return null;
  if (message.pinned) return null; // 釘選的通常是刻意留著的

  const text = messageText(message);
  if (!text) return null;

  aiFilterStats.checked++;
  const { hit, results } = await evaluateText(guildId, text);
  for (const r of results) {
    if (r.unknown) {
      aiFilterStats.unknown++;
      console.log(`[aifilter] 無法判定，放行：${r.source}（${r.reason}）`);
    }
  }
  if (!hit) {
    // 疑似只回報，永遠不刪：是否封鎖交給管理員
    for (const r of results.filter((v) => v.suspect)) {
      if (!firstReport(message, r)) continue;
      aiFilterStats.suspect++;
      console.log(`[aifilter] 疑似 ${message.id}：${r.reason}（${r.source}）`);
      await sendLog(message, settings, r, false);
    }
    return null;
  }

  if (!firstReport(message, hit)) return null;
  aiFilterStats.matched++;

  let deleted = false;
  if (settings.action === 'delete') {
    const perms = message.channel.permissionsFor(message.guild.members.me);
    if (perms?.has(PermissionFlagsBits.ManageMessages)) {
      try {
        await message.delete();
        deleted = true;
        aiFilterStats.deleted++;
      } catch (err) {
        if (err?.code === 10008) return null; // 已經被別的機制刪掉了
        aiFilterStats.failed++;
        console.warn(`[aifilter] 刪除訊息 ${message.id} 失敗: ${err.message}`);
      }
    } else {
      aiFilterStats.failed++;
      if (!warnedChannels.has(message.channel.id)) {
        warnedChannels.add(message.channel.id);
        console.warn(`[aifilter] Bot 在 #${message.channel.name ?? message.channel.id} 沒有「管理訊息」權限，刪不掉。`);
      }
    }
  }

  console.log(`[aifilter] ${deleted ? '已刪除' : '未刪除'} ${message.id}：${hit.reason}（${hit.source}）`);
  await sendLog(message, settings, hit, deleted);
  return { deleted, verdict: hit };
}
