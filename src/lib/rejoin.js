import { MessageType, PermissionFlagsBits } from 'discord.js';
import { db, getModlog } from './db.js';
import { fetchHistory } from './dupe.js';

// 反覆進出伺服器的調查與自動處理。
// Discord 不提供過去的進出紀錄，所以資料從三處來：
//   live    Bot 上線期間收到的加入／離開事件（從現在起都會記）
//   system  系統頻道裡「某某加入了伺服器」的系統訊息（只有加入，沒有離開）
//   modlog  /log 活動日誌已存的加入／離開事件
//   member  目前成員的加入時間（補上最近一次加入）
// 不同來源在 DEDUPE_MS 內看到同一人同一種事件，算同一次（例如 Bot 即時收到的加入 + 系統加入訊息）；
// 同一來源的事件各算各的，秒進秒退的洗版不會被合併掉。

const DEDUPE_MS = 2 * 60_000;
export const ENFORCE_CAP = 50;

db.exec(`
CREATE TABLE IF NOT EXISTS member_movements (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT    NOT NULL,
  user_id  TEXT    NOT NULL,
  type     TEXT    NOT NULL,
  at       INTEGER NOT NULL,
  source   TEXT    NOT NULL,
  ref      TEXT,
  user_tag TEXT
);
CREATE INDEX IF NOT EXISTS idx_member_movements_user ON member_movements (guild_id, user_id, type, at);
CREATE INDEX IF NOT EXISTS idx_member_movements_guild ON member_movements (guild_id, type, at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_member_movements_ref ON member_movements (guild_id, ref) WHERE ref IS NOT NULL;

-- action: off（只記錄）| notify（達標發通知）| ban（達標封禁）
CREATE TABLE IF NOT EXISTS rejoin_settings (
  guild_id               TEXT PRIMARY KEY,
  action                 TEXT    NOT NULL DEFAULT 'off',
  threshold              INTEGER NOT NULL DEFAULT 3,
  window_days            INTEGER NOT NULL DEFAULT 7,
  log_channel_id         TEXT,
  delete_message_seconds INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS rejoin_exempt (
  guild_id TEXT NOT NULL,
  user_id  TEXT NOT NULL,
  PRIMARY KEY (guild_id, user_id)
);

-- Bot 因反覆進出做過的處理（封禁／通知），/rejoin list 用來標示
CREATE TABLE IF NOT EXISTS rejoin_actions (
  guild_id TEXT    NOT NULL,
  user_id  TEXT    NOT NULL,
  action   TEXT    NOT NULL,
  joins    INTEGER NOT NULL,
  at       INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rejoin_actions_user ON rejoin_actions (guild_id, user_id, at);
`);

export const rejoinStats = { joins: 0, leaves: 0, notified: 0, banned: 0, banFailed: 0 };

// ---------- 設定 ----------

const DEFAULTS = { action: 'off', threshold: 3, window_days: 7, log_channel_id: null, delete_message_seconds: 0 };
const COLUMNS = Object.keys(DEFAULTS);

export function getRejoinSettings(guildId) {
  return db.prepare('SELECT * FROM rejoin_settings WHERE guild_id = ?').get(guildId) ?? { guild_id: guildId, ...DEFAULTS };
}

export function updateRejoinSettings(guildId, patch) {
  const next = { ...getRejoinSettings(guildId) };
  for (const k of COLUMNS) if (patch[k] !== undefined) next[k] = patch[k];
  db.prepare(`INSERT OR REPLACE INTO rejoin_settings (guild_id, ${COLUMNS.join(', ')}) VALUES (?, ${COLUMNS.map(() => '?').join(', ')})`)
    .run(guildId, ...COLUMNS.map((k) => next[k]));
  return next;
}

export function isRejoinExempt(guildId, userId) {
  return Boolean(db.prepare('SELECT 1 AS hit FROM rejoin_exempt WHERE guild_id = ? AND user_id = ?').get(guildId, userId));
}

export function setRejoinExempt(guildId, userId, exempt) {
  const sql = exempt
    ? 'INSERT OR IGNORE INTO rejoin_exempt (guild_id, user_id) VALUES (?, ?)'
    : 'DELETE FROM rejoin_exempt WHERE guild_id = ? AND user_id = ?';
  return db.prepare(sql).run(guildId, userId).changes > 0;
}

export function listRejoinExempt(guildId) {
  return db.prepare('SELECT user_id FROM rejoin_exempt WHERE guild_id = ?').all(guildId).map((r) => r.user_id);
}

// ---------- 紀錄 ----------

/** 記一筆加入／離開。回傳 false 表示重複（同一個 ref，或同一人同一種事件在 2 分鐘內已記過） */
export function recordMovement({ guildId, userId, type, at = Date.now(), source, ref = null, userTag = null }) {
  if (ref && db.prepare('SELECT 1 AS hit FROM member_movements WHERE guild_id = ? AND ref = ?').get(guildId, ref)) return false;
  // 只跟「別的來源」比：同一來源的兩筆一定是兩次真的進出（秒進秒退也要各算一次）
  const near = db.prepare(`SELECT id, ref FROM member_movements
    WHERE guild_id = ? AND user_id = ? AND type = ? AND source != ? AND at BETWEEN ? AND ? LIMIT 1`)
    .get(guildId, userId, type, source, at - DEDUPE_MS, at + DEDUPE_MS);
  if (near) {
    // 同一次事件從另一個來源再看到：補上 ref，之後重掃同一則系統訊息就直接略過
    if (ref && !near.ref) db.prepare('UPDATE member_movements SET ref = ? WHERE id = ?').run(ref, near.id);
    return false;
  }
  db.prepare(`INSERT INTO member_movements (guild_id, user_id, type, at, source, ref, user_tag)
    VALUES (?, ?, ?, ?, ?, ?, ?)`).run(guildId, userId, type, at, source, ref, userTag);
  return true;
}

export function countJoins(guildId, userId, since = 0) {
  return db.prepare(`SELECT COUNT(*) AS n FROM member_movements
    WHERE guild_id = ? AND user_id = ? AND type = 'join' AND at >= ?`).get(guildId, userId, since).n;
}

/** 期間內加入至少 minJoins 次的人，次數多的在前 */
export function listRepeaters(guildId, { since = 0, minJoins = 2, limit = 25 } = {}) {
  return db.prepare(`
    SELECT m.user_id,
      SUM(CASE WHEN m.type = 'join' THEN 1 ELSE 0 END) AS joins,
      SUM(CASE WHEN m.type = 'leave' THEN 1 ELSE 0 END) AS leaves,
      MIN(m.at) AS first_at, MAX(m.at) AS last_at,
      (SELECT user_tag FROM member_movements t WHERE t.guild_id = m.guild_id AND t.user_id = m.user_id
        AND t.user_tag IS NOT NULL ORDER BY t.at DESC LIMIT 1) AS user_tag,
      (SELECT action FROM rejoin_actions a WHERE a.guild_id = m.guild_id AND a.user_id = m.user_id
        ORDER BY a.at DESC LIMIT 1) AS last_action,
      EXISTS (SELECT 1 FROM rejoin_exempt e WHERE e.guild_id = m.guild_id AND e.user_id = m.user_id) AS exempt
    FROM member_movements m
    WHERE m.guild_id = ? AND m.at >= ?
    GROUP BY m.user_id
    HAVING joins >= ?
    ORDER BY joins DESC, last_at DESC
    LIMIT ?
  `).all(guildId, since, minJoins, limit);
}

export function userTimeline(guildId, userId, limit = 30) {
  return db.prepare(`SELECT type, at, source FROM member_movements WHERE guild_id = ? AND user_id = ?
    ORDER BY at DESC LIMIT ?`).all(guildId, userId, limit);
}

function recordAction(guildId, userId, action, joins) {
  db.prepare('INSERT INTO rejoin_actions (guild_id, user_id, action, joins, at) VALUES (?, ?, ?, ?, ?)')
    .run(guildId, userId, action, joins, Date.now());
}

function tagOf(user) {
  if (!user) return null;
  return user.discriminator && user.discriminator !== '0' ? `${user.username}#${user.discriminator}` : user.username;
}

// ---------- 即時事件 ----------

/** guildMemberRemove：記一筆離開 */
export function handleRejoinLeave(member) {
  if (member.user?.bot) return false;
  const ok = recordMovement({
    guildId: member.guild.id, userId: member.id, type: 'leave', source: 'live', userTag: tagOf(member.user),
  });
  if (ok) rejoinStats.leaves++;
  return ok;
}

/**
 * guildMemberAdd：記一筆加入，期間內加入次數達門檻就照設定通知或封禁。
 * 回傳 { joins, action }；action 為 null 表示沒有處理。
 */
export async function handleRejoinJoin(member) {
  if (member.user?.bot) return { joins: 0, action: null };
  const guild = member.guild;
  const at = member.joinedTimestamp ?? Date.now();
  if (recordMovement({ guildId: guild.id, userId: member.id, type: 'join', at, source: 'live', userTag: tagOf(member.user) })) {
    rejoinStats.joins++;
  }

  const settings = getRejoinSettings(guild.id);
  const since = Date.now() - settings.window_days * 86_400_000;
  const joins = countJoins(guild.id, member.id, since);
  if (settings.action === 'off' || joins < settings.threshold) return { joins, action: null };
  if (isRejoinExempt(guild.id, member.id)) return { joins, action: 'exempt' };

  const head = `<@${member.id}>（${tagOf(member.user)}・\`${member.id}\`）${settings.window_days} 天內第 **${joins}** 次加入`;
  if (settings.action === 'notify') {
    recordAction(guild.id, member.id, 'notify', joins);
    rejoinStats.notified++;
    await notify(guild, settings, `🔁 ${head}（門檻 ${settings.threshold} 次，只通知、未處理）`);
    return { joins, action: 'notify' };
  }

  const result = await banUser(guild, member.id, settings, joins, member);
  await notify(guild, settings, result.ok
    ? `⛔ ${head}，已自動封禁（門檻 ${settings.threshold} 次）。`
    : `⚠️ ${head}，達到封禁門檻但封禁失敗：${result.error}`);
  return { joins, action: result.ok ? 'ban' : 'ban-failed' };
}

/** 封禁一個 UID（不在伺服器裡也可以）。檢查 Bot 權限與角色高低 */
async function banUser(guild, userId, settings, joins, member = null) {
  const me = guild.members.me;
  if (!me?.permissions?.has(PermissionFlagsBits.BanMembers)) {
    rejoinStats.banFailed++;
    return { ok: false, error: 'Bot 沒有「封鎖成員」權限' };
  }
  const current = member ?? await guild.members.fetch(userId).catch(() => null);
  if (current && current.bannable === false) {
    rejoinStats.banFailed++;
    return { ok: false, error: '對方的角色高於或等於 Bot，或是伺服器擁有者' };
  }
  try {
    await guild.members.ban(userId, {
      reason: `反覆進出伺服器：${settings.window_days} 天內加入 ${joins} 次`,
      deleteMessageSeconds: settings.delete_message_seconds,
    });
    recordAction(guild.id, userId, 'ban', joins);
    rejoinStats.banned++;
    return { ok: true };
  } catch (err) {
    rejoinStats.banFailed++;
    return { ok: false, error: err.message };
  }
}

async function notify(guild, settings, content) {
  const channelId = settings.log_channel_id ?? getModlog(guild.id).activity_channel_id;
  if (!channelId) {
    console.log(`[rejoin] ${content.replace(/<@\d+>/g, '').trim()}`);
    return;
  }
  const channel = guild.channels.cache.get(channelId) ?? await guild.channels.fetch(channelId).catch(() => null);
  if (!channel?.isTextBased?.()) return;
  await channel.send({ content, allowedMentions: { parse: [] } })
    .catch((err) => console.warn(`[rejoin] 通知發送失敗: ${err.message}`));
}

// ---------- 掃描補資料 ----------

/**
 * 把過去的進出補進紀錄：系統頻道的加入訊息、/log 的加入離開事件、目前成員的加入時間。
 * 只記錄，不封禁。重複掃描不會重複計數。
 */
export async function scanMovements(guild, { channel = null, limit = 2000 } = {}) {
  const stats = { systemMessages: 0, systemJoins: 0, modlogEvents: 0, members: 0, channel: null, noChannel: false };

  const source = channel ?? guild.systemChannel;
  if (source?.messages) {
    stats.channel = source.id;
    const history = await fetchHistory(source, limit);
    stats.systemMessages = history.length;
    for (const m of history) {
      if (m.type !== MessageType.UserJoin || !m.author || m.author.bot) continue;
      if (recordMovement({
        guildId: guild.id, userId: m.author.id, type: 'join', at: m.createdTimestamp,
        source: 'system', ref: `msg:${m.id}`, userTag: tagOf(m.author),
      })) stats.systemJoins++;
    }
  } else {
    stats.noChannel = true;
  }

  const events = db.prepare(`SELECT id, type, user_id, created_at FROM modlog_events
    WHERE guild_id = ? AND type IN ('join', 'leave') AND user_id IS NOT NULL`).all(guild.id);
  for (const e of events) {
    if (recordMovement({ guildId: guild.id, userId: e.user_id, type: e.type, at: e.created_at, source: 'modlog', ref: `modlog:${e.id}` })) {
      stats.modlogEvents++;
    }
  }

  const members = await guild.members.fetch().catch(() => null);
  for (const member of members?.values() ?? []) {
    if (member.user?.bot || !member.joinedTimestamp) continue;
    if (recordMovement({
      guildId: guild.id, userId: member.id, type: 'join', at: member.joinedTimestamp,
      source: 'member', ref: `member:${member.id}:${member.joinedTimestamp}`, userTag: tagOf(member.user),
    })) stats.members++;
  }
  return stats;
}

// ---------- 補處理已經超標的人 ----------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 找出期間內已達門檻、還沒被這個功能封禁過、也不在豁免名單的人。
 * confirm=false 只預覽；true 才封禁，一次最多 ENFORCE_CAP 人。
 */
export async function enforceRejoin(guild, { confirm = false, threshold = null, windowDays = null } = {}) {
  const settings = getRejoinSettings(guild.id);
  const t = threshold ?? settings.threshold;
  const days = windowDays ?? settings.window_days;
  const candidates = listRepeaters(guild.id, { since: Date.now() - days * 86_400_000, minJoins: t, limit: 500 })
    .filter((r) => !r.exempt && r.last_action !== 'ban');
  const result = { threshold: t, windowDays: days, candidates, banned: [], failed: [], capped: false };
  if (!confirm) return result;

  for (const r of candidates) {
    if (result.banned.length + result.failed.length >= ENFORCE_CAP) { result.capped = true; break; }
    const outcome = await banUser(guild, r.user_id, { ...settings, window_days: days }, r.joins);
    if (outcome.ok) result.banned.push(r.user_id);
    else result.failed.push({ userId: r.user_id, error: outcome.error });
    await sleep(500);
  }
  if (result.banned.length) {
    await notify(guild, settings, `⛔ 補處理反覆進出：封禁 ${result.banned.length} 人（${days} 天內加入 ≥ ${t} 次）：` +
      result.banned.map((id) => `<@${id}>`).join(' '));
  }
  return result;
}
