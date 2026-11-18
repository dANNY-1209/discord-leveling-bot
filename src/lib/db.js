import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { levelFromTotalXp, totalXpForLevel } from './leveling.js';

const SQLITE_PATH = process.env.SQLITE_PATH || '/data/leveling.db';
mkdirSync(dirname(SQLITE_PATH), { recursive: true });

export const db = new DatabaseSync(SQLITE_PATH);

db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA busy_timeout = 5000;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS guild_settings (
  guild_id            TEXT PRIMARY KEY,
  enabled             INTEGER NOT NULL DEFAULT 1,
  xp_min              INTEGER NOT NULL DEFAULT 15,
  xp_max              INTEGER NOT NULL DEFAULT 25,
  cooldown_ms         INTEGER NOT NULL DEFAULT 60000,
  xp_rate             REAL    NOT NULL DEFAULT 1.0,
  min_length          INTEGER NOT NULL DEFAULT 5,
  announce_mode       TEXT    NOT NULL DEFAULT 'current',
  announce_channel_id TEXT,
  announce_message    TEXT    NOT NULL DEFAULT '🎉 {user} 升到了 **Lv.{level}**！',
  reward_mode         TEXT    NOT NULL DEFAULT 'stack',
  -- 第 17 節 防刷
  defer_seconds          INTEGER NOT NULL DEFAULT 20,
  ignore_duplicates      INTEGER NOT NULL DEFAULT 1,
  min_member_age_minutes INTEGER NOT NULL DEFAULT 15,
  ignore_sticker_emoji   INTEGER NOT NULL DEFAULT 1,
  max_pending_per_user   INTEGER NOT NULL DEFAULT 1,
  clawback_on_delete     INTEGER NOT NULL DEFAULT 0,
  -- 第 18 節 媒體加成
  media_bonus_xp         INTEGER NOT NULL DEFAULT 20,
  -- 連結加成（Owner 決定，v1.2 附件之後追加；有自己的一條 CD）
  link_bonus_xp          INTEGER NOT NULL DEFAULT 20,
  link_bonus_cooldown_ms INTEGER NOT NULL DEFAULT 10800000,
  link_bonus_scope       TEXT    NOT NULL DEFAULT 'everywhere',
  -- 表情反應 XP：按的人與被按的人各得一份，無冷卻
  reaction_xp            INTEGER NOT NULL DEFAULT 3,
  reaction_dedup         TEXT    NOT NULL DEFAULT 'message',
  updated_at          INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS member_levels (
  guild_id              TEXT    NOT NULL,
  user_id               TEXT    NOT NULL,
  total_xp              INTEGER NOT NULL DEFAULT 0,
  level                 INTEGER NOT NULL DEFAULT 0,
  last_xp_at            INTEGER NOT NULL DEFAULT 0,
  message_count_awarded INTEGER NOT NULL DEFAULT 0,
  last_content_hash     TEXT,
  last_link_bonus_at    INTEGER NOT NULL DEFAULT 0,
  updated_at            INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (guild_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_member_levels_board
  ON member_levels (guild_id, total_xp DESC, user_id ASC);

CREATE TABLE IF NOT EXISTS level_rewards (
  guild_id TEXT    NOT NULL,
  level    INTEGER NOT NULL,
  role_id  TEXT    NOT NULL,
  PRIMARY KEY (guild_id, level)
);

CREATE TABLE IF NOT EXISTS ignored_channels (
  guild_id   TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  PRIMARY KEY (guild_id, channel_id)
);

CREATE TABLE IF NOT EXISTS ignored_roles (
  guild_id TEXT NOT NULL,
  role_id  TEXT NOT NULL,
  PRIMARY KEY (guild_id, role_id)
);

-- 18.6 指定頻道的媒體加成。bonus_xp 為 NULL 表示套用全域 media_bonus_xp
CREATE TABLE IF NOT EXISTS media_bonus_channels (
  guild_id   TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  bonus_xp   INTEGER,
  PRIMARY KEY (guild_id, channel_id)
);

-- 關鍵字 → 自動回應（貼圖或訊息連結）。keywords 以換行分隔
CREATE TABLE IF NOT EXISTS trigger_responses (
  guild_id      TEXT    NOT NULL,
  trigger_id    INTEGER NOT NULL,
  keywords      TEXT    NOT NULL,
  response_type TEXT    NOT NULL,
  payload       TEXT    NOT NULL,
  lead_text     TEXT,
  cooldown_ms   INTEGER NOT NULL DEFAULT 60000,
  enabled       INTEGER NOT NULL DEFAULT 1,
  created_at    INTEGER NOT NULL,
  PRIMARY KEY (guild_id, trigger_id)
);

-- 已發過反應 XP 的紀錄，用來去重（無冷卻，靠這張表限制次數）
CREATE TABLE IF NOT EXISTS reaction_awards (
  guild_id   TEXT    NOT NULL,
  message_id TEXT    NOT NULL,
  reactor_id TEXT    NOT NULL,
  awarded_at INTEGER NOT NULL,
  PRIMARY KEY (guild_id, message_id, reactor_id)
);

-- 個別排除的使用者：不累積 XP、不上排行榜、不動他的等級角色
CREATE TABLE IF NOT EXISTS ignored_users (
  guild_id TEXT NOT NULL,
  user_id  TEXT NOT NULL,
  PRIMARY KEY (guild_id, user_id)
);

-- 算加成的網域白名單。比對方式是 host 完全相同或為其子網域
CREATE TABLE IF NOT EXISTS link_bonus_domains (
  guild_id TEXT NOT NULL,
  domain   TEXT NOT NULL,
  PRIMARY KEY (guild_id, domain)
);

-- 連結去重分區（深水區／淺水區各自獨立）。action: delete | warn | off
CREATE TABLE IF NOT EXISTS dupe_zones (
  guild_id       TEXT    NOT NULL,
  zone           TEXT    NOT NULL,
  action         TEXT    NOT NULL DEFAULT 'delete',
  notice_seconds INTEGER NOT NULL DEFAULT 20,
  created_at     INTEGER NOT NULL,
  PRIMARY KEY (guild_id, zone)
);

-- 哪些頻道（或分類）屬於哪一區。一個頻道只能屬於一區
CREATE TABLE IF NOT EXISTS dupe_zone_channels (
  guild_id   TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  zone       TEXT NOT NULL,
  PRIMARY KEY (guild_id, channel_id)
);

-- 每區第一次出現的連結。norm_url 是正規化後的網址，比對就靠它
CREATE TABLE IF NOT EXISTS dupe_links (
  guild_id   TEXT    NOT NULL,
  zone       TEXT    NOT NULL,
  norm_url   TEXT    NOT NULL,
  channel_id TEXT    NOT NULL,
  message_id TEXT    NOT NULL,
  user_id    TEXT    NOT NULL,
  raw_url    TEXT    NOT NULL,
  posted_at  INTEGER NOT NULL,
  PRIMARY KEY (guild_id, zone, norm_url)
);
CREATE INDEX IF NOT EXISTS idx_dupe_links_message ON dupe_links (guild_id, message_id);

-- 不列入去重的網域（預設是 tenor／giphy 這類反應圖）
CREATE TABLE IF NOT EXISTS dupe_ignored_domains (
  guild_id TEXT NOT NULL,
  domain   TEXT NOT NULL,
  PRIMARY KEY (guild_id, domain)
);

-- AI 創作者過濾。action: delete | log | off
CREATE TABLE IF NOT EXISTS ai_filter_settings (
  guild_id       TEXT PRIMARY KEY,
  action         TEXT NOT NULL DEFAULT 'delete',
  log_channel_id TEXT
);

-- 要過濾的頻道（或分類）
CREATE TABLE IF NOT EXISTS ai_filter_channels (
  guild_id   TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  PRIMARY KEY (guild_id, channel_id)
);

-- 手動名單。creator 形如 pixiv:123、x:handle；list: block | allow
CREATE TABLE IF NOT EXISTS ai_filter_creators (
  guild_id TEXT NOT NULL,
  creator  TEXT NOT NULL,
  list     TEXT NOT NULL,
  PRIMARY KEY (guild_id, creator)
);

-- 判定用的 tag／關鍵字
CREATE TABLE IF NOT EXISTS ai_filter_keywords (
  guild_id TEXT NOT NULL,
  keyword  TEXT NOT NULL,
  PRIMARY KEY (guild_id, keyword)
);

-- 每位使用者因 AI 過濾被刪除的次數（累計，管理員可重設）
CREATE TABLE IF NOT EXISTS ai_filter_strikes (
  guild_id TEXT NOT NULL,
  user_id  TEXT NOT NULL,
  count    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (guild_id, user_id)
);
`);

// ---------- 遷移（既有 DB 也要能升到 v1.1）----------

function columnNames(table) {
  return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((r) => r.name));
}

function ensureColumn(table, column, ddl) {
  if (columnNames(table).has(column)) return false;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
  console.log(`[migrate] ${table}.${column} 已新增`);
  return true;
}

db.exec('CREATE TABLE IF NOT EXISTS schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
const getMeta = db.prepare('SELECT value FROM schema_meta WHERE key = ?');
const setMeta = db.prepare('INSERT OR REPLACE INTO schema_meta (key, value) VALUES (?, ?)');

ensureColumn('guild_settings', 'defer_seconds', 'INTEGER NOT NULL DEFAULT 20');
ensureColumn('guild_settings', 'ignore_duplicates', 'INTEGER NOT NULL DEFAULT 1');
ensureColumn('guild_settings', 'min_member_age_minutes', 'INTEGER NOT NULL DEFAULT 15');
ensureColumn('guild_settings', 'ignore_sticker_emoji', 'INTEGER NOT NULL DEFAULT 1');
ensureColumn('guild_settings', 'max_pending_per_user', 'INTEGER NOT NULL DEFAULT 1');
ensureColumn('guild_settings', 'clawback_on_delete', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('guild_settings', 'media_bonus_xp', 'INTEGER NOT NULL DEFAULT 20');
ensureColumn('guild_settings', 'link_bonus_xp', 'INTEGER NOT NULL DEFAULT 20');
ensureColumn('guild_settings', 'link_bonus_cooldown_ms', 'INTEGER NOT NULL DEFAULT 10800000');
ensureColumn("guild_settings", "link_bonus_scope", "TEXT NOT NULL DEFAULT 'everywhere'");
ensureColumn('guild_settings', 'reaction_xp', 'INTEGER NOT NULL DEFAULT 3');
ensureColumn("guild_settings", "reaction_dedup", "TEXT NOT NULL DEFAULT 'message'");
ensureColumn('member_levels', 'last_link_bonus_at', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('member_levels', 'last_content_hash', 'TEXT');
ensureColumn('dupe_zones', 'delete_ping', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('dupe_zones', 'delete_sticker_id', 'TEXT');
ensureColumn('dupe_zones', 'delete_message', 'TEXT');

// 17.11 的建議預設只對「還停在舊預設 0」的既有伺服器套一次，之後 Owner 改回 0 不會被蓋掉
if (!getMeta.get('v1.1-antiabuse-defaults')) {
  const changed = db.prepare('UPDATE guild_settings SET min_length = 5 WHERE min_length = 0').run();
  if (changed.changes > 0) console.log(`[migrate] ${changed.changes} 個伺服器的 min_length 由 0 套用為 5（17.11 建議值）`);
  setMeta.run('v1.1-antiabuse-defaults', new Date().toISOString());
}

// 既有伺服器補上預設網域白名單（只做一次；之後 Owner 刪掉不會被重新塞回來）
if (!getMeta.get('link-domains-seed')) {
  const seed = db.prepare('INSERT OR IGNORE INTO link_bonus_domains (guild_id, domain) VALUES (?, ?)');
  const guilds = db.prepare('SELECT guild_id FROM guild_settings').all();
  let n = 0;
  for (const g of guilds) {
    for (const d of ['pixiv.net', 'x.com', 'twitter.com', 'rule34.xxx', 'iwara.tv']) {
      n += seed.run(g.guild_id, d).changes;
    }
  }
  if (n > 0) console.log(`[migrate] 連結加成預設網域已寫入 ${n} 筆（${guilds.length} 個伺服器）`);
  setMeta.run('link-domains-seed', new Date().toISOString());
}

// 舊的 sticker_triggers 只能放貼圖；搬到通用的 trigger_responses，保留編號與冷卻
if (!getMeta.get('trigger-responses-migrated')) {
  const hasOld = db.prepare("SELECT 1 AS hit FROM sqlite_master WHERE type='table' AND name='sticker_triggers'").get();
  if (hasOld) {
    const ins = db.prepare(`
      INSERT OR IGNORE INTO trigger_responses
        (guild_id, trigger_id, keywords, response_type, payload, lead_text, cooldown_ms, enabled, created_at)
      VALUES (?, ?, ?, 'sticker', ?, NULL, ?, ?, ?)
    `);
    let moved = 0;
    for (const r of db.prepare('SELECT * FROM sticker_triggers').all()) {
      moved += ins.run(r.guild_id, r.trigger_id, r.keywords, r.sticker_id,
        r.cooldown_ms, r.enabled, r.created_at).changes;
    }
    if (moved > 0) console.log(`[migrate] ${moved} 組貼圖觸發器已搬到 trigger_responses`);
  }
  setMeta.run('trigger-responses-migrated', new Date().toISOString());
}

const now = () => Date.now();

// ---------- guild settings ----------

const selSettings = db.prepare('SELECT * FROM guild_settings WHERE guild_id = ?');
// 明確寫入 17.11 的 seed 值：ALTER TABLE 改不動既有欄位的 DEFAULT，
// 舊 DB 若靠 DEFAULT 會拿到 min_length=0，等於新伺服器一開就沒防短訊。
const insSettings = db.prepare(`
  INSERT OR IGNORE INTO guild_settings (
    guild_id, xp_min, xp_max, cooldown_ms, xp_rate, min_length, reward_mode,
    defer_seconds, ignore_duplicates, min_member_age_minutes,
    ignore_sticker_emoji, max_pending_per_user, clawback_on_delete, media_bonus_xp,
    link_bonus_xp, link_bonus_cooldown_ms, link_bonus_scope, reaction_xp, reaction_dedup, updated_at
  ) VALUES (?, 15, 25, 60000, 1.0, 5, 'stack', 20, 1, 15, 1, 1, 0, 20, 20, 10800000, 'everywhere', 3, 'message', ?)
`);

export const DEFAULT_LINK_DOMAINS = ['pixiv.net', 'x.com', 'twitter.com', 'rule34.xxx', 'iwara.tv'];

const insDomain = db.prepare('INSERT OR IGNORE INTO link_bonus_domains (guild_id, domain) VALUES (?, ?)');

function seedLinkDomains(guildId) {
  for (const d of DEFAULT_LINK_DOMAINS) insDomain.run(guildId, d);
}

export function getSettings(guildId) {
  let row = selSettings.get(guildId);
  if (!row) {
    insSettings.run(guildId, now());
    seedLinkDomains(guildId);
    row = selSettings.get(guildId);
  }
  return row;
}

const SETTING_COLUMNS = new Set([
  'enabled', 'xp_min', 'xp_max', 'cooldown_ms', 'xp_rate', 'min_length',
  'announce_mode', 'announce_channel_id', 'announce_message', 'reward_mode',
  'defer_seconds', 'ignore_duplicates', 'min_member_age_minutes',
  'ignore_sticker_emoji', 'max_pending_per_user', 'clawback_on_delete',
  'media_bonus_xp', 'link_bonus_xp', 'link_bonus_cooldown_ms', 'link_bonus_scope',
  'reaction_xp', 'reaction_dedup',
]);

export function updateSettings(guildId, patch) {
  getSettings(guildId);
  const keys = Object.keys(patch).filter((k) => SETTING_COLUMNS.has(k));
  if (keys.length === 0) return getSettings(guildId);
  const assignments = keys.map((k) => `${k} = ?`).join(', ');
  db.prepare(`UPDATE guild_settings SET ${assignments}, updated_at = ? WHERE guild_id = ?`)
    .run(...keys.map((k) => patch[k]), now(), guildId);
  return getSettings(guildId);
}

// ---------- member levels ----------

const selMember = db.prepare('SELECT * FROM member_levels WHERE guild_id = ? AND user_id = ?');
const upsertMember = db.prepare(`
  INSERT INTO member_levels
    (guild_id, user_id, total_xp, level, last_xp_at, message_count_awarded,
     last_content_hash, last_link_bonus_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT (guild_id, user_id) DO UPDATE SET
    total_xp = excluded.total_xp,
    level = excluded.level,
    last_xp_at = excluded.last_xp_at,
    message_count_awarded = excluded.message_count_awarded,
    last_content_hash = excluded.last_content_hash,
    last_link_bonus_at = excluded.last_link_bonus_at,
    updated_at = excluded.updated_at
`);

export function getMember(guildId, userId) {
  return selMember.get(guildId, userId) ?? {
    guild_id: guildId, user_id: userId, total_xp: 0, level: 0,
    last_xp_at: 0, message_count_awarded: 0, last_content_hash: null,
    last_link_bonus_at: 0, updated_at: 0,
  };
}

/**
 * 以 total_xp 為準寫回，level 重算。回傳 { before, after, leveledUp }。
 * delta 可為負；總量不會低於 0。
 */
export function addXp(guildId, userId, delta, {
  touchCooldown = false, countMessage = false, contentHash = undefined, touchLinkBonus = false,
} = {}) {
  const before = getMember(guildId, userId);
  const total = Math.max(0, before.total_xp + Math.round(delta));
  const level = levelFromTotalXp(total);
  const after = {
    ...before,
    total_xp: total,
    level,
    last_xp_at: touchCooldown ? now() : before.last_xp_at,
    message_count_awarded: before.message_count_awarded + (countMessage ? 1 : 0),
    last_content_hash: contentHash === undefined ? before.last_content_hash : contentHash,
    last_link_bonus_at: touchLinkBonus ? now() : before.last_link_bonus_at,
    updated_at: now(),
  };
  upsertMember.run(guildId, userId, after.total_xp, after.level, after.last_xp_at,
    after.message_count_awarded, after.last_content_hash, after.last_link_bonus_at, after.updated_at);
  return { before, after, leveledUp: after.level > before.level };
}

/** 直接設定等級，XP 歸到該級起點 */
export function setLevel(guildId, userId, level) {
  const before = getMember(guildId, userId);
  const lvl = Math.max(0, Math.floor(level));
  const total = totalXpForLevel(lvl);
  const after = { ...before, total_xp: total, level: lvl, last_xp_at: now(), updated_at: now() };
  upsertMember.run(guildId, userId, after.total_xp, after.level, after.last_xp_at,
    after.message_count_awarded, after.last_content_hash, after.last_link_bonus_at, after.updated_at);
  return { before, after, leveledUp: after.level > before.level };
}

const selRank = db.prepare(`
  SELECT COUNT(*) AS ahead FROM member_levels
  WHERE guild_id = ? AND (total_xp > ? OR (total_xp = ? AND user_id < ?))
    AND NOT EXISTS (SELECT 1 FROM ignored_users iu WHERE iu.guild_id = member_levels.guild_id AND iu.user_id = member_levels.user_id)
`);

export function getRank(guildId, userId) {
  const m = getMember(guildId, userId);
  if (m.total_xp <= 0) return null;
  if (isIgnoredUser(guildId, userId)) return null; // 被排除的人不佔名次
  return selRank.get(guildId, m.total_xp, m.total_xp, userId).ahead + 1;
}

const selBoard = db.prepare(`
  SELECT user_id, total_xp, level FROM member_levels
  WHERE guild_id = ? AND total_xp > 0
    AND NOT EXISTS (SELECT 1 FROM ignored_users iu WHERE iu.guild_id = member_levels.guild_id AND iu.user_id = member_levels.user_id)
  ORDER BY total_xp DESC, user_id ASC
  LIMIT ? OFFSET ?
`);
const countBoard = db.prepare(`
  SELECT COUNT(*) AS n FROM member_levels
  WHERE guild_id = ? AND total_xp > 0
    AND NOT EXISTS (SELECT 1 FROM ignored_users iu WHERE iu.guild_id = member_levels.guild_id AND iu.user_id = member_levels.user_id)
`);

export function getLeaderboard(guildId, { limit = 10, offset = 0 } = {}) {
  return { rows: selBoard.all(guildId, limit, offset), total: countBoard.get(guildId).n };
}

/** /sync-roles 用。被排除的人不動他的角色。 */
export function listAllMembers(guildId) {
  return db.prepare(`
    SELECT user_id, total_xp, level FROM member_levels
    WHERE guild_id = ? AND total_xp > 0
      AND NOT EXISTS (SELECT 1 FROM ignored_users iu WHERE iu.guild_id = member_levels.guild_id AND iu.user_id = member_levels.user_id)
  `).all(guildId);
}

export function resetMember(guildId, userId) {
  db.prepare('DELETE FROM member_levels WHERE guild_id = ? AND user_id = ?').run(guildId, userId);
}

export function resetGuild(guildId) {
  const n = countBoard.get(guildId).n;
  db.prepare('DELETE FROM member_levels WHERE guild_id = ?').run(guildId);
  return n;
}

// ---------- level rewards ----------

export function listRewards(guildId) {
  return db.prepare('SELECT level, role_id FROM level_rewards WHERE guild_id = ? ORDER BY level ASC').all(guildId);
}

export function addReward(guildId, level, roleId) {
  db.prepare(`
    INSERT INTO level_rewards (guild_id, level, role_id) VALUES (?, ?, ?)
    ON CONFLICT (guild_id, level) DO UPDATE SET role_id = excluded.role_id
  `).run(guildId, Math.floor(level), roleId);
}

export function removeReward(guildId, level) {
  db.prepare('DELETE FROM level_rewards WHERE guild_id = ? AND level = ?').run(guildId, Math.floor(level));
}

// ---------- ignore lists ----------

export function listIgnoredChannels(guildId) {
  return db.prepare('SELECT channel_id FROM ignored_channels WHERE guild_id = ?').all(guildId).map((r) => r.channel_id);
}
export function addIgnoredChannel(guildId, channelId) {
  db.prepare('INSERT OR IGNORE INTO ignored_channels (guild_id, channel_id) VALUES (?, ?)').run(guildId, channelId);
}
export function removeIgnoredChannel(guildId, channelId) {
  db.prepare('DELETE FROM ignored_channels WHERE guild_id = ? AND channel_id = ?').run(guildId, channelId);
}

export function listIgnoredUsers(guildId) {
  return db.prepare('SELECT user_id FROM ignored_users WHERE guild_id = ?').all(guildId).map((r) => r.user_id);
}
const selIgnoredUser = db.prepare('SELECT 1 AS hit FROM ignored_users WHERE guild_id = ? AND user_id = ?');
export function isIgnoredUser(guildId, userId) {
  return selIgnoredUser.get(guildId, userId) !== undefined;
}
export function addIgnoredUser(guildId, userId) {
  db.prepare('INSERT OR IGNORE INTO ignored_users (guild_id, user_id) VALUES (?, ?)').run(guildId, userId);
}
export function removeIgnoredUser(guildId, userId) {
  db.prepare('DELETE FROM ignored_users WHERE guild_id = ? AND user_id = ?').run(guildId, userId);
}

export function listIgnoredRoles(guildId) {
  return db.prepare('SELECT role_id FROM ignored_roles WHERE guild_id = ?').all(guildId).map((r) => r.role_id);
}
export function addIgnoredRole(guildId, roleId) {
  db.prepare('INSERT OR IGNORE INTO ignored_roles (guild_id, role_id) VALUES (?, ?)').run(guildId, roleId);
}
export function removeIgnoredRole(guildId, roleId) {
  db.prepare('DELETE FROM ignored_roles WHERE guild_id = ? AND role_id = ?').run(guildId, roleId);
}

// ---------- 連結加成網域 ----------

export function listLinkDomains(guildId) {
  return db.prepare('SELECT domain FROM link_bonus_domains WHERE guild_id = ? ORDER BY domain')
    .all(guildId).map((r) => r.domain);
}

export function addLinkDomain(guildId, domain) {
  insDomain.run(guildId, domain);
}

export function removeLinkDomain(guildId, domain) {
  db.prepare('DELETE FROM link_bonus_domains WHERE guild_id = ? AND domain = ?').run(guildId, domain);
}

// ---------- 18.6 媒體加成頻道 ----------

export function listMediaChannels(guildId) {
  return db.prepare('SELECT channel_id, bonus_xp FROM media_bonus_channels WHERE guild_id = ?').all(guildId);
}

/** 回傳該頻道的加成 XP；不是媒體頻道則 0。bonus_xp 為 NULL 時套用全域值。 */
export function resolveMediaBonus(guildId, channelId) {
  const row = db.prepare('SELECT bonus_xp FROM media_bonus_channels WHERE guild_id = ? AND channel_id = ?')
    .get(guildId, channelId);
  if (!row) return 0;
  return row.bonus_xp ?? getSettings(guildId).media_bonus_xp;
}

export function addMediaChannel(guildId, channelId, bonusXp = null) {
  db.prepare(`
    INSERT INTO media_bonus_channels (guild_id, channel_id, bonus_xp) VALUES (?, ?, ?)
    ON CONFLICT (guild_id, channel_id) DO UPDATE SET bonus_xp = excluded.bonus_xp
  `).run(guildId, channelId, bonusXp);
}

export function removeMediaChannel(guildId, channelId) {
  db.prepare('DELETE FROM media_bonus_channels WHERE guild_id = ? AND channel_id = ?').run(guildId, channelId);
}

// ---------- 關鍵字自動回應 ----------

export function listTriggers(guildId, { onlyEnabled = false } = {}) {
  const sql = onlyEnabled
    ? 'SELECT * FROM trigger_responses WHERE guild_id = ? AND enabled = 1 ORDER BY trigger_id'
    : 'SELECT * FROM trigger_responses WHERE guild_id = ? ORDER BY trigger_id';
  return db.prepare(sql).all(guildId).map((r) => ({
    ...r,
    keywordList: r.keywords.split('\n').filter(Boolean),
  }));
}

export function addTrigger(guildId, { keywords, responseType, payload, leadText = null, cooldownMs }) {
  const next = db.prepare('SELECT COALESCE(MAX(trigger_id), 0) + 1 AS id FROM trigger_responses WHERE guild_id = ?')
    .get(guildId).id;
  db.prepare(`
    INSERT INTO trigger_responses
      (guild_id, trigger_id, keywords, response_type, payload, lead_text, cooldown_ms, enabled, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)
  `).run(guildId, next, keywords.join('\n'), responseType, payload, leadText, cooldownMs, now());
  return next;
}

export function removeTrigger(guildId, triggerId) {
  return db.prepare('DELETE FROM trigger_responses WHERE guild_id = ? AND trigger_id = ?')
    .run(guildId, triggerId).changes > 0;
}

export function setTriggerEnabled(guildId, triggerId, enabled) {
  return db.prepare('UPDATE trigger_responses SET enabled = ? WHERE guild_id = ? AND trigger_id = ?')
    .run(enabled ? 1 : 0, guildId, triggerId).changes > 0;
}

export function updateTriggerCooldown(guildId, triggerId, cooldownMs) {
  return db.prepare('UPDATE trigger_responses SET cooldown_ms = ? WHERE guild_id = ? AND trigger_id = ?')
    .run(cooldownMs, guildId, triggerId).changes > 0;
}

export function updateTriggerKeywords(guildId, triggerId, keywords) {
  return db.prepare('UPDATE trigger_responses SET keywords = ? WHERE guild_id = ? AND trigger_id = ?')
    .run(keywords.join('\n'), guildId, triggerId).changes > 0;
}

// ---------- 連結去重分區 ----------

export const DEFAULT_DUPE_IGNORE_DOMAINS = ['tenor.com', 'giphy.com'];

const insDupeIgnore = db.prepare('INSERT OR IGNORE INTO dupe_ignored_domains (guild_id, domain) VALUES (?, ?)');

/** 第一次建分區時把預設忽略網域寫進去（只做一次，之後 Owner 刪掉不會被塞回來） */
function seedDupeIgnoredDomains(guildId) {
  const key = `dupe-ignore-seed:${guildId}`;
  if (getMeta.get(key)) return;
  for (const d of DEFAULT_DUPE_IGNORE_DOMAINS) insDupeIgnore.run(guildId, d);
  setMeta.run(key, new Date().toISOString());
}

export function listDupeZones(guildId) {
  const zones = db.prepare('SELECT * FROM dupe_zones WHERE guild_id = ? ORDER BY zone').all(guildId);
  const channels = db.prepare('SELECT channel_id, zone FROM dupe_zone_channels WHERE guild_id = ?').all(guildId);
  const counts = db.prepare('SELECT zone, COUNT(*) AS n FROM dupe_links WHERE guild_id = ? GROUP BY zone').all(guildId);
  return zones.map((z) => ({
    ...z,
    channelIds: channels.filter((c) => c.zone === z.zone).map((c) => c.channel_id),
    linkCount: counts.find((c) => c.zone === z.zone)?.n ?? 0,
  }));
}

export function getDupeZone(guildId, zone) {
  return db.prepare('SELECT * FROM dupe_zones WHERE guild_id = ? AND zone = ?').get(guildId, zone) ?? null;
}

/** 分區不存在就建起來（預設 delete / 20 秒提示） */
export function ensureDupeZone(guildId, zone) {
  db.prepare('INSERT OR IGNORE INTO dupe_zones (guild_id, zone, created_at) VALUES (?, ?, ?)')
    .run(guildId, zone, now());
  seedDupeIgnoredDomains(guildId);
  return getDupeZone(guildId, zone);
}

export function updateDupeZone(guildId, zone, { action, noticeSeconds, deletePing, deleteStickerId, deleteMessage }) {
  const sets = [];
  const args = [];
  if (action !== undefined) { sets.push('action = ?'); args.push(action); }
  if (noticeSeconds !== undefined) { sets.push('notice_seconds = ?'); args.push(noticeSeconds); }
  if (deletePing !== undefined) { sets.push('delete_ping = ?'); args.push(deletePing ? 1 : 0); }
  if (deleteStickerId !== undefined) { sets.push('delete_sticker_id = ?'); args.push(deleteStickerId); }
  if (deleteMessage !== undefined) { sets.push('delete_message = ?'); args.push(deleteMessage); }
  if (sets.length === 0) return getDupeZone(guildId, zone);
  db.prepare(`UPDATE dupe_zones SET ${sets.join(', ')} WHERE guild_id = ? AND zone = ?`)
    .run(...args, guildId, zone);
  return getDupeZone(guildId, zone);
}

/** 整個分區連同監看頻道與連結紀錄一起刪掉 */
export function removeDupeZone(guildId, zone) {
  const links = db.prepare('DELETE FROM dupe_links WHERE guild_id = ? AND zone = ?').run(guildId, zone).changes;
  const channels = db.prepare('DELETE FROM dupe_zone_channels WHERE guild_id = ? AND zone = ?')
    .run(guildId, zone).changes;
  const gone = db.prepare('DELETE FROM dupe_zones WHERE guild_id = ? AND zone = ?').run(guildId, zone).changes > 0;
  return { gone, channels, links };
}

/** 把頻道（或分類）歸到某一區。回傳它原本屬於的區，沒有就是 null */
export function setDupeZoneChannel(guildId, channelId, zone) {
  const before = db.prepare('SELECT zone FROM dupe_zone_channels WHERE guild_id = ? AND channel_id = ?')
    .get(guildId, channelId)?.zone ?? null;
  db.prepare('INSERT OR REPLACE INTO dupe_zone_channels (guild_id, channel_id, zone) VALUES (?, ?, ?)')
    .run(guildId, channelId, zone);
  return before;
}

export function removeDupeZoneChannel(guildId, channelId) {
  const row = db.prepare('SELECT zone FROM dupe_zone_channels WHERE guild_id = ? AND channel_id = ?')
    .get(guildId, channelId);
  if (!row) return null;
  db.prepare('DELETE FROM dupe_zone_channels WHERE guild_id = ? AND channel_id = ?').run(guildId, channelId);
  return row.zone;
}

/**
 * 依「頻道 → 討論串母頻道 → 分類」的順序找出所屬分區。
 * ids 要照這個優先序傳進來，先命中的贏。
 */
export function resolveDupeZone(guildId, channelIds) {
  for (const id of channelIds) {
    if (!id) continue;
    const row = db.prepare(`
      SELECT z.* FROM dupe_zone_channels c
      JOIN dupe_zones z ON z.guild_id = c.guild_id AND z.zone = c.zone
      WHERE c.guild_id = ? AND c.channel_id = ?
    `).get(guildId, id);
    if (row) return row;
  }
  return null;
}

const selDupeLink = db.prepare('SELECT * FROM dupe_links WHERE guild_id = ? AND zone = ? AND norm_url = ?');

export function findDupeLink(guildId, zone, normUrl) {
  return selDupeLink.get(guildId, zone, normUrl) ?? null;
}

/** 記下某區第一次出現的連結。已經有紀錄就不動它，回傳既有的那筆 */
export function recordDupeLink(guildId, zone, normUrl, { channelId, messageId, userId, rawUrl, postedAt }) {
  const inserted = db.prepare(`
    INSERT OR IGNORE INTO dupe_links
      (guild_id, zone, norm_url, channel_id, message_id, user_id, raw_url, posted_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(guildId, zone, normUrl, channelId, messageId, userId, rawUrl, postedAt ?? now()).changes > 0;
  return { inserted, existing: inserted ? null : selDupeLink.get(guildId, zone, normUrl) };
}

export function listDupeLinksByMessage(guildId, messageId) {
  return db.prepare('SELECT * FROM dupe_links WHERE guild_id = ? AND message_id = ?').all(guildId, messageId);
}

/** 原始訊息被刪掉時放掉它佔的連結，之後同一條可以再貼 */
export function forgetDupeLinksByMessage(messageId) {
  return db.prepare('DELETE FROM dupe_links WHERE message_id = ?').run(messageId).changes;
}

export function forgetDupeLink(guildId, normUrl, zone = null) {
  const sql = zone
    ? 'DELETE FROM dupe_links WHERE guild_id = ? AND norm_url = ? AND zone = ?'
    : 'DELETE FROM dupe_links WHERE guild_id = ? AND norm_url = ?';
  const args = zone ? [guildId, normUrl, zone] : [guildId, normUrl];
  return db.prepare(sql).run(...args).changes;
}

export function clearDupeZoneLinks(guildId, zone) {
  return db.prepare('DELETE FROM dupe_links WHERE guild_id = ? AND zone = ?').run(guildId, zone).changes;
}

export function findDupeLinkAnyZone(guildId, normUrl) {
  return db.prepare('SELECT * FROM dupe_links WHERE guild_id = ? AND norm_url = ? ORDER BY posted_at').all(guildId, normUrl);
}

export function listDupeIgnoredDomains(guildId) {
  return db.prepare('SELECT domain FROM dupe_ignored_domains WHERE guild_id = ? ORDER BY domain')
    .all(guildId).map((r) => r.domain);
}

export function addDupeIgnoredDomain(guildId, domain) {
  seedDupeIgnoredDomains(guildId);
  return insDupeIgnore.run(guildId, domain).changes > 0;
}

export function removeDupeIgnoredDomain(guildId, domain) {
  return db.prepare('DELETE FROM dupe_ignored_domains WHERE guild_id = ? AND domain = ?')
    .run(guildId, domain).changes > 0;
}

// ---------- AI 創作者過濾 ----------

export const DEFAULT_AI_KEYWORDS = [
  'AI生成', 'AIイラスト', 'AI絵', 'AIart', 'AIアート', 'AI絵画', 'AI绘画', 'AI繪圖', 'AI绘图', 'AI繪畫',
  'AI插画', 'AI插畫', 'AIgenerated', 'AIグラビア', 'AI美女', 'AI美少女', 'NovelAI', 'NijiJourney',
  'Midjourney', 'StableDiffusion', 'ComfyUI',
];

const insAiKeyword = db.prepare('INSERT OR IGNORE INTO ai_filter_keywords (guild_id, keyword) VALUES (?, ?)');

/** 第一次用到時把預設 tag 寫進去（只做一次，之後 Owner 刪掉不會被塞回來） */
function seedAiKeywords(guildId) {
  const key = `ai-keywords-seed:${guildId}`;
  if (getMeta.get(key)) return;
  for (const k of DEFAULT_AI_KEYWORDS) insAiKeyword.run(guildId, k);
  setMeta.run(key, new Date().toISOString());
}

export function getAiFilter(guildId) {
  return db.prepare('SELECT * FROM ai_filter_settings WHERE guild_id = ?').get(guildId)
    ?? { guild_id: guildId, action: 'delete', log_channel_id: null };
}

export function updateAiFilter(guildId, patch) {
  const next = { ...getAiFilter(guildId), ...patch };
  db.prepare('INSERT OR REPLACE INTO ai_filter_settings (guild_id, action, log_channel_id) VALUES (?, ?, ?)')
    .run(guildId, next.action, next.log_channel_id);
  return next;
}

export function listAiFilterChannels(guildId) {
  return db.prepare('SELECT channel_id FROM ai_filter_channels WHERE guild_id = ?').all(guildId).map((r) => r.channel_id);
}

export function addAiFilterChannel(guildId, channelId) {
  seedAiKeywords(guildId);
  return db.prepare('INSERT OR IGNORE INTO ai_filter_channels (guild_id, channel_id) VALUES (?, ?)')
    .run(guildId, channelId).changes > 0;
}

export function removeAiFilterChannel(guildId, channelId) {
  return db.prepare('DELETE FROM ai_filter_channels WHERE guild_id = ? AND channel_id = ?')
    .run(guildId, channelId).changes > 0;
}

export function listAiFilterCreators(guildId) {
  return db.prepare('SELECT creator, list FROM ai_filter_creators WHERE guild_id = ? ORDER BY creator').all(guildId);
}

export function setAiFilterCreator(guildId, creator, list) {
  db.prepare('INSERT OR REPLACE INTO ai_filter_creators (guild_id, creator, list) VALUES (?, ?, ?)')
    .run(guildId, creator, list);
}

export function removeAiFilterCreator(guildId, creator) {
  return db.prepare('DELETE FROM ai_filter_creators WHERE guild_id = ? AND creator = ?')
    .run(guildId, creator).changes > 0;
}

export function listAiFilterKeywords(guildId) {
  seedAiKeywords(guildId);
  return db.prepare('SELECT keyword FROM ai_filter_keywords WHERE guild_id = ? ORDER BY keyword')
    .all(guildId).map((r) => r.keyword);
}

export function addAiFilterKeyword(guildId, keyword) {
  seedAiKeywords(guildId);
  return insAiKeyword.run(guildId, keyword).changes > 0;
}

export function removeAiFilterKeyword(guildId, keyword) {
  seedAiKeywords(guildId);
  return db.prepare('DELETE FROM ai_filter_keywords WHERE guild_id = ? AND keyword = ?')
    .run(guildId, keyword).changes > 0;
}

// ---------- 反應 XP 去重 ----------

const selReactionAny = db.prepare('SELECT 1 AS hit FROM reaction_awards WHERE guild_id = ? AND message_id = ? LIMIT 1');
const selReactionByUser = db.prepare('SELECT 1 AS hit FROM reaction_awards WHERE guild_id = ? AND message_id = ? AND reactor_id = ?');
const insReaction = db.prepare('INSERT OR IGNORE INTO reaction_awards (guild_id, message_id, reactor_id, awarded_at) VALUES (?, ?, ?, ?)');

/**
 * 這則訊息／這個人是否已經領過反應 XP。
 * dedup='message'  → 整則訊息只認第一個表符（不論誰按）
 * dedup='per-user' → 每個人在同一則訊息各認一次
 */
export function reactionAlreadyAwarded(guildId, messageId, reactorId, dedup) {
  const row = dedup === 'per-user'
    ? selReactionByUser.get(guildId, messageId, reactorId)
    : selReactionAny.get(guildId, messageId);
  return row !== undefined;
}

/** 回傳 true 表示這次成功佔位（之前沒領過）。用 INSERT 的結果當鎖，避免同時按的競爭。 */
export function claimReactionAward(guildId, messageId, reactorId) {
  return insReaction.run(guildId, messageId, reactorId, now()).changes > 0;
}

export function countReactionAwards(guildId) {
  return db.prepare('SELECT COUNT(*) AS n FROM reaction_awards WHERE guild_id = ?').get(guildId).n;
}

// ---------- AI 過濾的刪除次數（警告／禁言用）----------

const bumpAiStrike = db.prepare(
  'INSERT INTO ai_filter_strikes (guild_id, user_id, count) VALUES (?, ?, 1) '
  + 'ON CONFLICT(guild_id, user_id) DO UPDATE SET count = count + 1'
);
const readAiStrike = db.prepare('SELECT count FROM ai_filter_strikes WHERE guild_id = ? AND user_id = ?');

/** 記一次刪除，回傳累計次數 */
export function addAiFilterStrike(guildId, userId) {
  bumpAiStrike.run(guildId, userId);
  return readAiFilterStrike(guildId, userId);
}

export function readAiFilterStrike(guildId, userId) {
  return readAiStrike.get(guildId, userId)?.count ?? 0;
}

export function resetAiFilterStrike(guildId, userId) {
  return db.prepare('DELETE FROM ai_filter_strikes WHERE guild_id = ? AND user_id = ?')
    .run(guildId, userId).changes > 0;
}

export function closeDb() {
  try { db.close(); } catch { /* 關閉時盡力而為 */ }
}
