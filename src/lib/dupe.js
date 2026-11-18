import { ChannelType, PermissionFlagsBits } from 'discord.js';
import {
  resolveDupeZone, findDupeLink, recordDupeLink, listDupeIgnoredDomains,
  listDupeLinksByMessage, forgetDupeLink,
} from './db.js';

export const dupeStats = { recorded: 0, duplicates: 0, deleted: 0, failed: 0, previews: 0 };

// 訊息裡的網址。排除 <> 包起來的、以及 markdown 連結的括號
const URL_RE = /https?:\/\/[^\s<>()[\]"'`|\\]+/gi;
// 中英文句尾標點常被黏在網址後面
const TRAILING_JUNK = /[.,;:!?'"*_~)\]}。，、；：！？）」』】…]+$/;

/** 訊息文字裡的網址（原樣，只去掉黏在尾巴的標點） */
export function extractUrls(content) {
  const found = String(content ?? '').match(URL_RE) ?? [];
  return found.map((raw) => raw.replace(TRAILING_JUNK, '')).filter((raw) => /^https?:\/\/[^/]+\./i.test(raw));
}

export function baseHost(hostname) {
  return hostname.toLowerCase().replace(/^www\./, '');
}

/** host 完全相同或為其子網域（m.youtube.com 命中 youtube.com） */
export function hostIn(host, domains) {
  return domains.some((d) => host === d || host.endsWith(`.${d}`));
}

// 通用追蹤參數，所有網站都砍
const JUNK_PARAM_RE = /^(utm_|at_|mc_|_branch|_ga$|fbclid$|gclid$|dclid$|igshid$|igsh$|yclid$|ncid$|srsltid$|spm$|share_|share$|__twitter|twclid$|ref_src$|ref_url$|trk$|mkt_tok$)/i;

export const TWITTER_HOSTS = ['x.com', 'twitter.com', 'vxtwitter.com', 'fixvx.com', 'fxtwitter.com',
  'fixupx.com', 'twittpr.com', 'nitter.net', 'twstalker.com', 'xcancel.com'];
const BOORU_HOSTS = ['rule34.xxx', 'gelbooru.com', 'safebooru.org', 'rule34.paheal.net',
  'yande.re', 'konachan.com', 'danbooru.donmai.us'];

/**
 * 同一個目標的不同寫法收斂成同一把鑰匙：
 * 鏡像網域（vxtwitter ↔ x.com）、語言前綴（/en/artworks）、短網址、無關的 query 都算同一條。
 * 回傳 null 表示這條網址不拿來比對。
 */
function canonicalize(host, u) {
  const path = u.pathname;
  const q = u.searchParams;

  if (hostIn(host, TWITTER_HOSTS)) {
    const m = /\/status(?:es)?\/(\d+)/.exec(path);
    return m ? `x.com/status/${m[1]}` : null;
  }

  if (hostIn(host, ['pixiv.net', 'phixiv.net', 'pixiv.cat'])) {
    // /en/artworks/123 與舊版 member_illust.php?illust_id=123 是同一張
    const illust = /\/artworks\/(\d+)/.exec(path)?.[1] ?? q.get('illust_id');
    if (illust) return `pixiv.net/artworks/${illust}`;
    const user = /\/users\/(\d+)/.exec(path);
    return user ? `pixiv.net/users/${user[1]}` : null;
  }

  if (hostIn(host, ['youtube.com', 'youtube-nocookie.com'])) {
    const id = q.get('v') ?? /\/(?:shorts|embed|live|v)\/([\w-]{6,})/.exec(path)?.[1];
    return id ? `youtube.com/watch?v=${id}` : null;
  }
  if (host === 'youtu.be') {
    const id = path.replace(/^\//, '').split('/')[0];
    return id ? `youtube.com/watch?v=${id}` : null;
  }

  if (hostIn(host, ['iwara.tv'])) {
    const m = /\/videos?\/([\w-]+)/.exec(path);
    return m ? `iwara.tv/video/${m[1]}` : null;
  }

  // 同一本畫廊在 e-hentai 與 exhentai 是同一個 id/token
  if (hostIn(host, ['e-hentai.org', 'exhentai.org'])) {
    const m = /\/g\/(\d+)\/([0-9a-f]+)/.exec(path);
    return m ? `e-hentai.org/g/${m[1]}/${m[2]}` : null;
  }
  if (hostIn(host, ['nhentai.net', 'nhentai.to', 'nhentai.xxx'])) {
    const m = /\/g\/(\d+)/.exec(path);
    return m ? `nhentai.net/g/${m[1]}` : null;
  }

  if (hostIn(host, BOORU_HOSTS)) {
    const id = q.get('id') ?? /\/posts?\/(\d+)/.exec(path)?.[1];
    return id ? `${host}/post/${id}` : null;
  }

  if (hostIn(host, ['reddit.com', 'redd.it'])) {
    const m = /\/comments\/(\w+)/.exec(path);
    return m ? `reddit.com/comments/${m[1]}` : null;
  }

  if (hostIn(host, ['instagram.com', 'ddinstagram.com'])) {
    const m = /\/(?:p|reel|reels|tv)\/([\w-]+)/.exec(path);
    return m ? `instagram.com/p/${m[1]}` : null;
  }

  if (hostIn(host, ['tiktok.com'])) {
    const m = /\/video\/(\d+)/.exec(path);
    return m ? `tiktok.com/video/${m[1]}` : null;
  }

  if (hostIn(host, ['bilibili.com'])) {
    const m = /\/video\/((?:BV|bv)[\w]+|av\d+)/.exec(path);
    return m ? `bilibili.com/video/${m[1]}` : null;
  }

  if (hostIn(host, ['fanbox.cc'])) {
    const m = /\/posts\/(\d+)/.exec(path);
    return m ? `fanbox.cc/posts/${m[1]}` : null;
  }

  // kemono 換域名很勤（party → su → cr），一律當同一個站
  if (hostIn(host, ['kemono.party', 'kemono.su', 'kemono.cr', 'coomer.party', 'coomer.su'])) {
    const m = /\/([\w-]+)\/user\/([\w-]+)\/post\/([\w-]+)/.exec(path);
    return m ? `kemono/${m[1]}/${m[2]}/${m[3]}` : null;
  }

  if (hostIn(host, ['pornhub.com'])) {
    const key = q.get('viewkey');
    return key ? `pornhub.com/view_video?viewkey=${key}` : null;
  }

  // Discord 訊息跳轉連結：canary / ptb 都收斂成 discord.com
  if (hostIn(host, ['discord.com', 'discordapp.com']) && path.startsWith('/channels/')) {
    return `discord.com${path.replace(/\/+$/, '')}`;
  }

  return null;
}

/**
 * 正規化成比對用的鑰匙。認不出的站就走通用規則：
 * host 去 www、砍追蹤參數、剩下的參數排序、去尾斜線與 #fragment。
 */
export function normalizeUrl(raw) {
  let u;
  try {
    u = new URL(String(raw ?? '').trim());
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;

  const host = baseHost(u.hostname);
  const special = canonicalize(host, u);
  if (special) return special;

  const params = [...u.searchParams.entries()]
    .filter(([k]) => !JUNK_PARAM_RE.test(k))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const qs = params.map(([k, v]) => `${k}=${v}`).join('&');
  const path = u.pathname.replace(/\/+$/, '');
  return `${host}${path}${qs ? `?${qs}` : ''}`;
}

/** Discord 跳轉連結與忽略清單上的網域不列入去重 */
function isIgnored(raw, norm, ignoredDomains) {
  if (norm.startsWith('discord.com/channels/')) return true;
  let host;
  try {
    host = baseHost(new URL(raw).hostname);
  } catch {
    return true;
  }
  return hostIn(host, ignoredDomains);
}

/** 訊息裡要列入去重的連結（同一則重複的只算一次） */
export function collectLinks(guildId, content, ignoredDomains = null) {
  const ignored = ignoredDomains ?? listDupeIgnoredDomains(guildId);
  const seen = new Map();
  for (const raw of extractUrls(content)) {
    const norm = normalizeUrl(raw);
    if (!norm) continue;
    if (isIgnored(raw, norm, ignored)) continue;
    if (!seen.has(norm)) seen.set(norm, raw);
  }
  return [...seen].map(([norm, raw]) => ({ norm, raw }));
}

/** 頻道歸屬的查找順序：討論串本身 → 母頻道 → 分類 */
export function channelChain(channel) {
  const ids = [];
  if (!channel) return ids;
  if (typeof channel.isThread === 'function' && channel.isThread()) {
    ids.push(channel.id);
    const parent = channel.parent;
    if (parent) {
      ids.push(parent.id);
      if (parent.parentId) ids.push(parent.parentId);
    } else if (channel.parentId) {
      ids.push(channel.parentId);
    }
    return ids;
  }
  ids.push(channel.id);
  if (channel.parentId) ids.push(channel.parentId);
  return ids;
}

/**
 * 紀錄指向的原貼文是不是還在。看不到頻道或遇到其他錯誤都當「還在」——
 * 寧可擋下重複，也不要因為一次 API 失敗就把紀錄放掉。
 */
async function originalStillExists(guild, row) {
  const channel = guild.channels?.cache?.get(row.channel_id)
    ?? await guild.channels?.fetch?.(row.channel_id).catch(() => null);
  if (!channel?.messages) return true;
  const result = await channel.messages.fetch(row.message_id)
    .catch((err) => (err?.code === 10008 ? null : undefined));
  return result !== null;
}

const warnedChannels = new Set();

function warnMissingManageMessages(channel, zone) {
  if (warnedChannels.has(channel.id)) return;
  warnedChannels.add(channel.id);
  console.warn(
    `[dupe] ${zone} 要刪重複連結，但 Bot 在 #${channel.name ?? channel.id} 沒有「管理訊息」權限 → 只提示不刪。`
  );
}

// ---------- 連帶刪除預覽 Bot 的訊息 ----------

// 預設是 ermiana：預覽是回覆原訊息，影片等附加連結接著發成獨立的「[連結](url)」訊息。
// PREVIEW_BOT_IDS 可換成別的 Bot（逗號分隔），設成空字串就關閉。
const PREVIEW_BOT_IDS = new Set(
  (process.env.PREVIEW_BOT_IDS ?? '1078919650764652594').split(',').map((id) => id.trim()).filter(Boolean)
);
const PREVIEW_MEDIA_RE = /^(\|\|)?\[連結\]\(\S+\)(\|\|)?$/;
const LATE_PREVIEW_MS = 2 * 60 * 1000;
const LATE_MEDIA_MS = 30 * 1000;

// 預覽 Bot 要先抓資料才發文，可能比我們的刪除還晚到，所以要記住剛刪了什麼
const deletedSources = new Map(); // 被刪訊息 id -> 到期時間
const openMediaTails = new Map(); // 頻道 id -> 到期時間：預覽剛被刪，它的附加連結可能還在路上

const isPreviewBotMessage = (m) => PREVIEW_BOT_IDS.has(m.author?.id) && !m.webhookId;
const isPreviewMedia = (m) => !m.reference && PREVIEW_MEDIA_RE.test(m.content ?? '');

function rememberUntil(map, key, ms) {
  const now = Date.now();
  for (const [k, expires] of map) if (expires <= now) map.delete(k);
  map.set(key, now + ms);
}

const stillActive = (map, key) => (map.get(key) ?? 0) > Date.now();

/**
 * 某則訊息底下的預覽：回覆它的那些，加上緊接著發的附加連結。
 * 碰到預覽 Bot 回覆別則訊息就停，那之後的附加連結是別人的。
 */
function findPreviews(sourceId, botMessages) {
  const previews = [];
  let inTail = false;
  const ordered = [...botMessages].sort((a, b) => a.createdTimestamp - b.createdTimestamp);
  for (const m of ordered) {
    if (m.reference?.messageId === sourceId) {
      previews.push(m);
      inTail = true;
    } else if (m.reference) {
      inTail = false;
    } else if (inTail && isPreviewMedia(m)) {
      previews.push(m);
    }
  }
  return { previews, inTail };
}

/** 預覽刪失敗不影響去重本身；已經不在了（10008）不算錯 */
async function deletePreview(message) {
  try {
    await message.delete();
    dupeStats.previews++;
    return true;
  } catch (err) {
    if (err?.code !== 10008) console.warn(`[dupe] 刪除預覽 ${message.id} 失敗: ${err.message}`);
    return false;
  }
}

/**
 * 刪掉訊息，連同預覽 Bot（ermiana）已經發出來的預覽。沒刪成功會丟錯，預覽也不會動。
 * 去重與 AI 過濾共用：預覽清理失敗只記 log，不影響「訊息已刪」這件事。
 */
export async function deleteWithPreviews(message) {
  // 先記再刪：預覽可能剛好在刪除途中送達
  rememberUntil(deletedSources, message.id, LATE_PREVIEW_MS);
  try {
    await message.delete();
  } catch (err) {
    deletedSources.delete(message.id);
    throw err;
  }

  try {
    const after = await message.channel.messages.fetch({ after: message.id, limit: 50 }).catch(() => null);
    if (!after) return;
    const { previews, inTail } = findPreviews(message.id, [...after.values()].filter(isPreviewBotMessage));
    await Promise.all(previews.map(deletePreview));
    if (inTail) rememberUntil(openMediaTails, message.channel.id, LATE_MEDIA_MS);
  } catch (err) {
    console.warn(`[preview] 找預覽時失敗（訊息已刪）: ${err.message}`);
  }
}

/** 預覽 Bot 的新訊息：對象已經被當重複刪掉的話，這則也不留 */
export async function handleLatePreview(message) {
  if (!isPreviewBotMessage(message)) return false;
  const channelId = message.channel.id;
  const sourceId = message.reference?.messageId;

  if (sourceId) {
    if (!stillActive(deletedSources, sourceId)) {
      openMediaTails.delete(channelId); // 別則訊息的預覽，之後的附加連結不是我們要刪的
      return false;
    }
    rememberUntil(openMediaTails, channelId, LATE_MEDIA_MS);
  } else if (!isPreviewMedia(message) || !stillActive(openMediaTails, channelId)) {
    return false;
  }
  return deletePreview(message);
}

export const DEFAULT_DELETE_MESSAGE = '你的鏈接重複了 :DoraCare:';

/** :名稱: 換成這個伺服器的自訂表情；找不到的照原樣留著 */
export function renderEmojis(text, guild) {
  return String(text ?? '').replace(/(?<!<a?):([\w~]{2,32}):/g, (raw, name) => {
    const emoji = guild.emojis?.cache?.find((e) => e.name === name);
    return emoji ? emoji.toString() : raw;
  });
}

/**
 * 刪掉重複之後 mention 當事人並說一句台詞，有設貼圖就附上。
 * 貼圖被刪或不能用時只發文字，不讓這一步把去重弄壞。
 */
async function sendDeleteNotice(message, zone, perms) {
  if (!perms?.has(PermissionFlagsBits.SendMessages)) return;
  const allowedMentions = { users: [message.author.id] };
  const line = renderEmojis(zone.delete_message ?? DEFAULT_DELETE_MESSAGE, message.guild);
  const text = { content: `${message.author} ${line}`.trim(), allowedMentions };
  try {
    await message.channel.send(zone.delete_sticker_id ? { ...text, stickers: [zone.delete_sticker_id] } : text);
  } catch (err) {
    if (!zone.delete_sticker_id) {
      console.warn(`[dupe] 刪除通知發送失敗: ${err.message}`);
      return;
    }
    console.warn(`[dupe] ${zone.zone} 的貼圖 ${zone.delete_sticker_id} 發不出去（${err.message}），改發文字`);
    await message.channel.send(text).catch((e) => console.warn(`[dupe] 刪除通知發送失敗: ${e.message}`));
  }
}

/**
 * 監看區裡的重複連結處理。每區各自獨立：同一條連結在深水區貼過，淺水區還是能貼。
 * 跟 XP／關鍵字觸發完全無關，不給也不扣 XP。
 */
export async function handleLinkDupes(message) {
  const guildId = message.guild.id;
  const zone = resolveDupeZone(guildId, channelChain(message.channel));
  if (!zone || zone.action === 'off') return null;

  const links = collectLinks(guildId, message.content);
  if (links.length === 0) return null;

  // 先查完再寫入：訊息要被刪掉的話，不能留下它自己佔位的紀錄
  let hit = null;
  for (const l of links) {
    const existing = findDupeLink(guildId, zone.zone, l.norm);
    if (!existing || existing.message_id === message.id) continue;
    // 原貼文可能在 Bot 離線時被刪掉（收不到事件）→ 確認還在才擋
    if (!(await originalStillExists(message.guild, existing))) {
      forgetDupeLink(guildId, l.norm, zone.zone);
      console.log(`[dupe] ${zone.zone} 的原始訊息 ${existing.message_id} 已不存在，放掉 ${l.norm}`);
      continue;
    }
    hit = { ...l, existing };
    break;
  }

  if (!hit) {
    const keep = new Set(links.map((l) => l.norm));
    // 編輯過的訊息：把已經不在內容裡的舊紀錄放掉
    for (const row of listDupeLinksByMessage(guildId, message.id)) {
      if (!keep.has(row.norm_url)) forgetDupeLink(guildId, row.norm_url, row.zone);
    }
    for (const l of links) {
      const { inserted } = recordDupeLink(guildId, zone.zone, l.norm, {
        channelId: message.channel.id,
        messageId: message.id,
        userId: message.author.id,
        rawUrl: l.raw,
        postedAt: message.createdTimestamp,
      });
      if (inserted) dupeStats.recorded++;
    }
    return { zone: zone.zone, recorded: links.map((l) => l.norm) };
  }

  dupeStats.duplicates++;
  const original = hit.existing;
  const jump = `https://discord.com/channels/${guildId}/${original.channel_id}/${original.message_id}`;
  const perms = message.channel.permissionsFor(message.guild.members.me);

  let deleted = false;
  if (zone.action === 'delete') {
    if (perms?.has(PermissionFlagsBits.ManageMessages)) {
      try {
        await deleteWithPreviews(message);
        deleted = true;
        dupeStats.deleted++;
      } catch (err) {
        dupeStats.failed++;
        console.warn(`[dupe] 刪除訊息 ${message.id} 失敗: ${err.message}`);
      }
    } else {
      warnMissingManageMessages(message.channel, zone.zone);
    }
  }

  if (deleted && zone.delete_ping) await sendDeleteNotice(message, zone, perms);

  // 刪除通知預設關閉（靜默刪除）。「沒刪」的情況才需要講一句
  if (!deleted && zone.notice_seconds > 0 && perms?.has(PermissionFlagsBits.SendMessages)) {
    const lines = [
      `🔁 ${message.author} 這條連結在 **${zone.zone}** 已經有人貼過了。`,
      `原始貼文：${jump}`,
    ];
    if (zone.action === 'delete') lines.push('（Bot 缺「管理訊息」權限，刪不掉，只能提示）');
    try {
      const notice = await message.channel.send({
        content: lines.join('\n'),
        allowedMentions: { users: [message.author.id] },
      });
      const timer = setTimeout(() => notice.delete().catch(() => {}), zone.notice_seconds * 1000);
      timer.unref?.();
    } catch (err) {
      console.warn(`[dupe] 提示訊息發送失敗: ${err.message}`);
    }
  }

  console.log(`[dupe] ${zone.zone} 重複：${hit.norm} — ${deleted ? '已刪除' : '未刪除'}（原始 ${original.message_id}）`);
  return { zone: zone.zone, duplicate: hit.norm, deleted, original };
}

// ---------- 歷史補掃 ----------

const TEXTY = new Set([
  ChannelType.GuildText, ChannelType.GuildAnnouncement,
  ChannelType.PublicThread, ChannelType.PrivateThread, ChannelType.AnnouncementThread,
]);

/** 分區監看的 id 展開成實際可讀訊息的頻道（分類 → 底下頻道；論壇 → 底下討論串） */
export async function expandZoneChannels(guild, channelIds) {
  const out = new Map();
  const add = (ch) => { if (ch && !out.has(ch.id)) out.set(ch.id, ch); };

  for (const id of channelIds) {
    const channel = guild.channels.cache.get(id) ?? await guild.channels.fetch(id).catch(() => null);
    if (!channel) continue;

    const roots = channel.type === ChannelType.GuildCategory
      ? [...channel.children.cache.values()]
      : [channel];

    for (const root of roots) {
      if (TEXTY.has(root.type)) add(root);
      if (root.type === ChannelType.GuildForum || root.type === ChannelType.GuildMedia || TEXTY.has(root.type)) {
        const active = await root.threads?.fetchActive?.().catch(() => null);
        for (const t of active?.threads?.values() ?? []) add(t);
        const archived = await root.threads?.fetchArchived?.({ limit: 100 }).catch(() => null);
        for (const t of archived?.threads?.values() ?? []) add(t);
      }
    }
  }
  return [...out.values()];
}

/** 最近 limit 則訊息（由新到舊）。Discord 一次最多給 100 則，超過要分頁 */
export async function fetchHistory(channel, limit) {
  const out = [];
  let before;
  while (out.length < limit) {
    const batch = await channel.messages.fetch({ limit: Math.min(100, limit - out.length), before })
      .catch(() => null);
    if (!batch || batch.size === 0) break;
    out.push(...batch.values());
    before = batch.last().id;
    if (batch.size < 100) break;
  }
  return out;
}

/** 一次掃掉的上限，避免一條指令跑太久撞到 interaction 逾時 */
export const SWEEP_DELETE_CAP = 400;

// 這個 timer 不能 unref：await 的對象被 unref 掉，行程會在等待中直接結束
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 掃一個分區的歷史訊息，照時間由舊到新處理，所以同一條連結留的是**最早**那則。
 *
 *   record      true  = 把第一次出現的連結寫進紀錄
 *   deleteDupes true  = 把後來重複的那些訊息刪掉（釘選的不動）
 *
 * 三種用法：補掃＝record、預覽＝兩個都 false（完全不動資料）、清理＝兩個都 true。
 */
export async function sweepZone(guild, zone, {
  perChannel = 500, record = false, deleteDupes = false, onProgress = null,
} = {}) {
  const ignored = listDupeIgnoredDomains(guild.id);
  const channels = await expandZoneChannels(guild, zone.channelIds);
  const seen = new Map(); // norm -> { messageId, channelId }
  const stats = {
    channels: 0, skipped: [], noPermission: [], messages: 0, links: 0,
    recorded: 0, duplicates: 0, pinned: 0, deleted: 0, previews: 0, failed: 0, capped: false,
  };
  const plan = [];

  const priorOf = (norm) => {
    if (seen.has(norm)) return seen.get(norm);
    const row = findDupeLink(guild.id, zone.zone, norm);
    return row ? { messageId: row.message_id, channelId: row.channel_id } : null;
  };

  // 先把整區的訊息全抓下來，再**跨頻道**照時間排序：
  // 「留最早那則」是以整個分區為準，不是各頻道各留一則
  const canDeleteIn = new Map();
  const previewBotMessages = new Map(); // 頻道 id -> 預覽 Bot 的訊息
  const timeline = [];

  for (const channel of channels) {
    const perms = channel.permissionsFor(guild.members.me);
    if (!perms?.has(PermissionFlagsBits.ViewChannel) || !perms?.has(PermissionFlagsBits.ReadMessageHistory)) {
      stats.skipped.push(channel.name ?? channel.id);
      continue;
    }
    const canDelete = perms.has(PermissionFlagsBits.ManageMessages);
    canDeleteIn.set(channel.id, canDelete);
    if (deleteDupes && !canDelete) stats.noPermission.push(channel.name ?? channel.id);
    stats.channels++;

    const history = await fetchHistory(channel, perChannel);
    previewBotMessages.set(channel.id, history.filter(isPreviewBotMessage));
    const messages = history.filter((m) => !m.author?.bot && !m.webhookId);
    stats.messages += messages.length;
    for (const message of messages) timeline.push({ channel, message });
  }

  timeline.sort((a, b) => a.message.createdTimestamp - b.message.createdTimestamp);

  for (const { channel, message: m } of timeline) {
    const links = collectLinks(guild.id, m.content, ignored);
    if (links.length === 0) continue;
    stats.links += links.length;

    let dup = null;
    for (const l of links) {
      const prior = priorOf(l.norm);
      if (prior && prior.messageId !== m.id) { dup = { ...l, prior }; break; }
    }

    if (dup) {
      // 釘選的訊息不動：那通常是刻意留著的
      if (m.pinned) { stats.pinned++; continue; }
      stats.duplicates++;
      plan.push({
        channelId: channel.id,
        channelName: channel.name ?? channel.id,
        messageId: m.id,
        userId: m.author?.id ?? null,
        postedAt: m.createdTimestamp,
        norm: dup.norm,
        raw: dup.raw,
        original: dup.prior,
      });
      if (deleteDupes && canDeleteIn.get(channel.id)) {
        if (stats.deleted >= SWEEP_DELETE_CAP) { stats.capped = true; continue; }
        try {
          await m.delete();
          stats.deleted++;
          if (onProgress && stats.deleted % 25 === 0) await onProgress(stats);
          await sleep(350); // 給 Discord 的刪訊速率留餘裕
          for (const preview of findPreviews(m.id, previewBotMessages.get(channel.id)).previews) {
            if (await deletePreview(preview)) stats.previews++;
            await sleep(350);
          }
        } catch (err) {
          stats.failed++;
          console.warn(`[dupe] 清理時刪 ${m.id} 失敗: ${err.message}`);
        }
      }
      continue; // 這則要消失（或已消失），它帶的其他連結不佔紀錄
    }

    for (const l of links) {
      seen.set(l.norm, { messageId: m.id, channelId: channel.id });
      if (record) {
        const { inserted } = recordDupeLink(guild.id, zone.zone, l.norm, {
          channelId: channel.id,
          messageId: m.id,
          userId: m.author.id,
          rawUrl: l.raw,
          postedAt: m.createdTimestamp,
        });
        if (inserted) stats.recorded++;
      }
    }
  }
  return { stats, plan };
}

/** 補掃：只寫紀錄，不刪任何東西 */
export async function scanZone(guild, zone, { perChannel = 500 } = {}) {
  const { stats } = await sweepZone(guild, zone, { perChannel, record: true });
  return stats;
}
