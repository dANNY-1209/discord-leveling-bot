import { PermissionFlagsBits } from 'discord.js';
import {
  getSettings, getMember, addXp, getRank,
  listRewards, listIgnoredChannels, listIgnoredRoles, resolveMediaBonus, listLinkDomains,
  isIgnoredUser, reactionAlreadyAwarded, claimReactionAward, setModlogXp,
} from './db.js';
import { renderTemplate } from './format.js';
import {
  normalize, charLength, hasNoTextSubstance,
  qualifiedMediaHashes, messageIdentityHash, matchedLinkDomains,
} from './content.js';

// 17.8 可觀測性：只記計數，不記訊息內容
export const stats = {
  granted: 0, deferred: 0, cancelledByDelete: 0,
  skippedNoText: 0, skippedTooShort: 0, skippedNewMember: 0,
  skippedDuplicate: 0, skippedCooldown: 0, skippedPendingBusy: 0,
  skippedIgnoredUser: 0,
  reactionGranted: 0, reactionXp: 0, reactionSkippedDuplicate: 0, reactionSkippedIneligible: 0,
  mediaBonusGranted: 0, mediaBonusXp: 0,
  linkBonusGranted: 0, linkBonusXp: 0, linkBonusOnCooldown: 0,
};

// 冷卻先放記憶體，last_xp_at 同時落盤；重啟後從 DB 回填，所以冷卻不會被重啟洗掉。
const cooldowns = new Map();
const userKey = (guildId, userId) => `${guildId}:${userId}`;

// 連結加成走自己的一條冷卻（預設 3 小時），跟 60 秒訊息冷卻互不影響
const linkCooldowns = new Map();

function onLinkCooldown(guildId, userId, cooldownMs) {
  if (cooldownMs <= 0) return false;
  const k = userKey(guildId, userId);
  let last = linkCooldowns.get(k);
  if (last === undefined) {
    last = getMember(guildId, userId).last_link_bonus_at;
    linkCooldowns.set(k, last);
  }
  return Date.now() - last < cooldownMs;
}

function onCooldown(guildId, userId, cooldownMs) {
  const k = userKey(guildId, userId);
  let last = cooldowns.get(k);
  if (last === undefined) {
    last = getMember(guildId, userId).last_xp_at;
    cooldowns.set(k, last);
  }
  return Date.now() - last < cooldownMs;
}

// ---------- 17.3 延遲入帳 ----------
// pending 只放記憶體：17.9 明確允許「重啟當下的 pending 消失」。
const pendingByMessage = new Map();   // message_id -> { timer, message, hash, key }
const pendingCountByUser = new Map(); // "guild:user" -> number

function pendingCount(guildId, userId) {
  return pendingCountByUser.get(userKey(guildId, userId)) ?? 0;
}

function addPending(message, hash, hasMedia, hasLink, delayMs) {
  const key = userKey(message.guild.id, message.author.id);
  const timer = setTimeout(() => {
    pendingByMessage.delete(message.id);
    pendingCountByUser.set(key, Math.max(0, (pendingCountByUser.get(key) ?? 1) - 1));
    grant(message, hash, hasMedia, hasLink).catch((err) => console.error('[grant]', err));
  }, delayMs);
  if (typeof timer.unref === 'function') timer.unref();

  pendingByMessage.set(message.id, { timer, message, hash, hasMedia, hasLink, key });
  pendingCountByUser.set(key, pendingCount(message.guild.id, message.author.id) + 1);
  stats.deferred++;
}

/** 取消鍵只用 message.id —— 刪除事件裡內容常是空的（17.3）。 */
export function cancelPending(messageId) {
  const entry = pendingByMessage.get(messageId);
  if (!entry) return false;
  clearTimeout(entry.timer);
  pendingByMessage.delete(messageId);
  pendingCountByUser.set(entry.key, Math.max(0, (pendingCountByUser.get(entry.key) ?? 1) - 1));
  stats.cancelledByDelete++;
  return true;
}

export function pendingSize() {
  return pendingByMessage.size;
}

/**
 * Handoff 第 8 節的事件流程 + 第 17 節的防刷。
 * 回傳 null = 這則訊息不給 XP；{ deferred: true } = 已排隊；其餘 = 當場入帳的結果。
 */
export async function awardForMessage(message) {
  const guildId = message.guild.id;
  const userId = message.author.id;
  const settings = getSettings(guildId);

  if (!settings.enabled) return null;

  // 個別排除的使用者：最優先，連 pending 都不建
  if (isIgnoredUser(guildId, userId)) {
    stats.skippedIgnoredUser++;
    return null;
  }

  // 頻道排除（含討論串的母頻道、分類）
  const ignoredChannels = new Set(listIgnoredChannels(guildId));
  if (ignoredChannels.has(message.channel.id)) return null;
  if (message.channel.parentId && ignoredChannels.has(message.channel.parentId)) return null;
  if (message.channel.parent?.parentId && ignoredChannels.has(message.channel.parent.parentId)) return null;

  // 角色排除
  const ignoredRoles = listIgnoredRoles(guildId);
  if (ignoredRoles.length > 0 && message.member?.roles.cache.hasAny(...ignoredRoles)) return null;

  // 18.3 本則自己的合格媒體（圖／影片附件）。外連、sticker、引用別人的圖都不算。
  const mediaHashes = qualifiedMediaHashes(message);
  const hasMedia = mediaHashes.length > 0;

  // 17.2 純貼圖／純 emoji。真的上傳了圖或影片就算有實質內容，不受這條擋。
  if (settings.ignore_sticker_emoji && !hasMedia && hasNoTextSubstance(message)) {
    stats.skippedNoText++;
    return null;
  }

  const normalized = normalize(message.content);

  // 最短字數（正規化後以「字」計）。18.4：帶合格媒體的投稿豁免，純圖也該拿得到。
  if (!hasMedia && settings.min_length > 0 && charLength(normalized) < settings.min_length) {
    stats.skippedTooShort++;
    return null;
  }

  // 17.7 新成員緩衝：用 joinedAt，不是帳號創立日
  if (settings.min_member_age_minutes > 0) {
    const joinedAt = message.member?.joinedTimestamp
      ?? (await message.guild.members.fetch(userId).catch(() => null))?.joinedTimestamp;
    if (joinedAt && Date.now() - joinedAt < settings.min_member_age_minutes * 60_000) {
      stats.skippedNewMember++;
      return null;
    }
  }

  // 連結加成：命中白名單網域就標記。範圍受 link_bonus_scope 限制。
  const linkDomains = matchedLinkDomains(message, listLinkDomains(guildId));
  const inMediaChannel = resolveMediaBonus(guildId, message.channel.id) > 0;
  const hasLink = linkDomains.length > 0
    && (settings.link_bonus_scope !== 'media-channels' || inMediaChannel);

  // 17.5 + 18.5 重複：只跟該使用者「上一次成功入帳」比。純圖的身分由檔案指紋決定。
  const hash = messageIdentityHash(guildId, userId, normalized, mediaHashes);
  if (settings.ignore_duplicates && getMember(guildId, userId).last_content_hash === hash) {
    stats.skippedDuplicate++;
    return null;
  }

  // 17.6 冷卻未到 → 連 pending 都不建
  if (onCooldown(guildId, userId, settings.cooldown_ms)) {
    stats.skippedCooldown++;
    return null;
  }

  // 17.6 已有 pending → 直接忽略，不重置 grant_at
  if (pendingCount(guildId, userId) >= Math.max(1, settings.max_pending_per_user)) {
    stats.skippedPendingBusy++;
    return null;
  }

  const deferMs = Math.max(0, settings.defer_seconds) * 1000;
  if (deferMs === 0) return grant(message, hash, hasMedia, hasLink); // defer_seconds=0 → 相容舊行為
  addPending(message, hash, hasMedia, hasLink, deferMs);
  return { deferred: true, grantAt: Date.now() + deferMs, hasMedia, hasLink };
}

/** grant_at 到期且未被取消才會走到這裡：抽 XP、寫入、公告、發角色。 */
async function grant(message, hash, hasMedia = false, hasLink = false) {
  const guildId = message.guild.id;
  const userId = message.author.id;
  const settings = getSettings(guildId);

  const span = Math.max(0, settings.xp_max - settings.xp_min);
  const roll = settings.xp_min + Math.floor(Math.random() * (span + 1));

  // 18.4 awarded = round(random(min,max) * xp_rate) + 頻道加成，最低 1。
  // 加成是固定值、不乘倍率，且一則訊息最多加一次（不是每張附件各加一次）。
  const mediaBonus = hasMedia ? resolveMediaBonus(guildId, message.channel.id) : 0;

  // 連結加成：獨立冷卻。被 CD 擋住只是不加這一筆，基礎 XP 照給。
  let linkBonus = 0;
  let linkOnCooldown = false;
  if (hasLink) {
    if (onLinkCooldown(guildId, userId, settings.link_bonus_cooldown_ms)) {
      linkOnCooldown = true;
      stats.linkBonusOnCooldown++;
    } else {
      linkBonus = settings.link_bonus_xp;
    }
  }

  const bonus = mediaBonus + linkBonus;
  const base = Math.round(roll * settings.xp_rate);
  const amount = Math.max(1, base + bonus);
  if (mediaBonus > 0) { stats.mediaBonusGranted++; stats.mediaBonusXp += mediaBonus; }
  if (linkBonus > 0) {
    stats.linkBonusGranted++;
    stats.linkBonusXp += linkBonus;
    linkCooldowns.set(userKey(guildId, userId), Date.now());
  }

  cooldowns.set(userKey(guildId, userId), Date.now());
  const result = addXp(guildId, userId, amount, {
    touchCooldown: true, countMessage: true, contentHash: hash, touchLinkBonus: linkBonus > 0,
  });
  stats.granted++;
  // 活動日誌：記下這則拿了多少，之後被刪就看得出「拿完 XP 才刪」（沒開紀錄時沒有這一列，不會動到）
  setModlogXp(message.id, amount);

  if (result.leveledUp) {
    await announceLevelUp(
      { guild: message.guild, channel: message.channel, member: message.member, user: message.author },
      result, settings,
    ).catch((err) => console.error('[levelup] 公告失敗:', err));
    await applyRewards(message.member, result.after.level, settings).catch((err) =>
      console.error('[levelup] 角色獎勵失敗:', err));
  }

  return { amount, base, bonus, mediaBonus, linkBonus, linkOnCooldown, ...result };
}

async function announceLevelUp(ctx, result, settings) {
  if (settings.announce_mode === 'off') return;
  const { guild, member, user } = ctx;

  const rank = getRank(guild.id, user.id);
  const text = renderTemplate(settings.announce_message, {
    user: `<@${user.id}>`,
    username: member?.displayName ?? user.username,
    level: result.after.level,
    old_level: result.before.level,
    xp: result.after.total_xp,
    rank: rank ?? '—',
  });

  if (settings.announce_mode === 'dm') {
    await user.send({ content: `**${guild.name}**\n${text}` });
    return;
  }

  let channel = ctx.channel;
  if (settings.announce_mode === 'channel' && settings.announce_channel_id) {
    const target = await guild.channels.fetch(settings.announce_channel_id).catch(() => null);
    if (target?.isTextBased()) channel = target;
  }
  if (!channel?.isTextBased?.()) return;

  const me = guild.members.me;
  if (!channel.permissionsFor(me)?.has(PermissionFlagsBits.SendMessages)) {
    console.warn(`[levelup] 沒有權限在 #${channel.name} 發言，跳過公告`);
    return;
  }
  await channel.send({ content: text, allowedMentions: { users: [user.id] } });
}

// ---------- 表情反應 XP ----------

/** 個別收款人是否有資格拿 XP（排除名單、No-XP 角色、新成員緩衝各自套用） */
function eligibleForXp(guildId, member, settings, ignoredRoles) {
  if (!member || member.user?.bot) return false;
  if (isIgnoredUser(guildId, member.id)) return false;
  if (ignoredRoles.length > 0 && member.roles?.cache?.hasAny(...ignoredRoles)) return false;
  if (settings.min_member_age_minutes > 0 && member.joinedTimestamp
      && Date.now() - member.joinedTimestamp < settings.min_member_age_minutes * 60_000) return false;
  return true;
}

/**
 * 有人按表情 → 按的人與被按的人各 +reaction_xp。沒有冷卻，
 * 靠 reaction_awards 去重：dedup='message' 整則只認第一個表符，'per-user' 每人各一次。
 * 回傳 null 表示這次不給。
 */
export async function awardForReaction(message, reactorMember) {
  const guild = message.guild;
  const guildId = guild.id;
  const settings = getSettings(guildId);

  if (!settings.enabled || settings.reaction_xp <= 0) return null;

  // 頻道排除（含討論串母頻道與分類）
  const ignoredChannels = new Set(listIgnoredChannels(guildId));
  if (ignoredChannels.has(message.channel.id)) return null;
  if (message.channel.parentId && ignoredChannels.has(message.channel.parentId)) return null;
  if (message.channel.parent?.parentId && ignoredChannels.has(message.channel.parent.parentId)) return null;

  // 被按的訊息必須是人類發的；自己按自己不算
  if (message.author?.bot || message.webhookId) return null;
  if (!message.author || message.author.id === reactorMember.id) {
    stats.reactionSkippedIneligible++;
    return null;
  }

  if (reactionAlreadyAwarded(guildId, message.id, reactorMember.id, settings.reaction_dedup)) {
    stats.reactionSkippedDuplicate++;
    return null;
  }

  const ignoredRoles = listIgnoredRoles(guildId);
  const authorMember = message.member
    ?? await guild.members.fetch(message.author.id).catch(() => null);

  const recipients = [];
  if (eligibleForXp(guildId, reactorMember, settings, ignoredRoles)) {
    recipients.push({ member: reactorMember, role: 'reactor' });
  }
  if (eligibleForXp(guildId, authorMember, settings, ignoredRoles)) {
    recipients.push({ member: authorMember, role: 'author' });
  }
  if (recipients.length === 0) {
    stats.reactionSkippedIneligible++;
    return null;
  }

  // 先佔位再發 XP：INSERT 成功才算這次有效，避免同時按下的重複入帳
  if (!claimReactionAward(guildId, message.id, reactorMember.id)) {
    stats.reactionSkippedDuplicate++;
    return null;
  }

  const amount = settings.reaction_xp;
  const awarded = [];
  for (const { member, role } of recipients) {
    // 反應 XP 不動 last_xp_at 與 last_content_hash：它跟訊息冷卻／重複偵測是分開的
    const result = addXp(guildId, member.id, amount);
    stats.reactionGranted++;
    stats.reactionXp += amount;
    awarded.push({ userId: member.id, role, ...result });

    if (result.leveledUp) {
      await announceLevelUp(
        { guild, channel: message.channel, member, user: member.user },
        result, settings,
      ).catch((err) => console.error('[reaction] 公告失敗:', err));
      await applyRewards(member, result.after.level, settings)
        .catch((err) => console.error('[reaction] 角色獎勵失敗:', err));
    }
  }

  return { amount, awarded };
}

/**
 * 套用等級角色。給角色失敗只寫 log，不回滾 XP（人已經升級了，可事後 /sync-roles 補）。
 * 回傳 { added, removed, failed }。
 */
export async function applyRewards(member, level, settings = null) {
  if (!member) return { added: [], removed: [], failed: [] };
  const guild = member.guild;
  const cfg = settings ?? getSettings(guild.id);
  const rewards = listRewards(guild.id);
  if (rewards.length === 0) return { added: [], removed: [], failed: [] };

  const earned = rewards.filter((r) => r.level <= level);
  const me = guild.members.me;
  const canManage = me?.permissions.has(PermissionFlagsBits.ManageRoles);

  let wanted;
  if (cfg.reward_mode === 'replace') {
    const top = earned.at(-1);
    wanted = top ? [top.role_id] : [];
  } else {
    wanted = earned.map((r) => r.role_id);
  }
  const wantedSet = new Set(wanted);
  const allRewardRoleIds = new Set(rewards.map((r) => r.role_id));

  const added = [];
  const removed = [];
  const failed = [];

  for (const roleId of wanted) {
    if (member.roles.cache.has(roleId)) continue;
    const role = guild.roles.cache.get(roleId) ?? await guild.roles.fetch(roleId).catch(() => null);
    if (!role) { failed.push({ roleId, reason: '角色不存在（可能已被刪除）' }); continue; }
    if (!canManage) { failed.push({ roleId, reason: 'Bot 缺少 Manage Roles 權限' }); continue; }
    if (me.roles.highest.comparePositionTo(role) <= 0) {
      failed.push({ roleId, reason: `Bot 角色不高於 @${role.name}，Discord 不允許指派` });
      continue;
    }
    try {
      await member.roles.add(role, `等級獎勵 Lv.${level}`);
      added.push(roleId);
    } catch (err) {
      failed.push({ roleId, reason: err.message });
    }
  }

  // replace 模式：脫掉其他獎勵角色（只動獎勵角色，不碰使用者其他角色）
  if (cfg.reward_mode === 'replace') {
    for (const roleId of allRewardRoleIds) {
      if (wantedSet.has(roleId) || !member.roles.cache.has(roleId)) continue;
      const role = guild.roles.cache.get(roleId);
      if (!role || !canManage || me.roles.highest.comparePositionTo(role) <= 0) continue;
      try {
        await member.roles.remove(role, '等級獎勵 replace 模式：只保留最高階');
        removed.push(roleId);
      } catch (err) {
        failed.push({ roleId, reason: err.message });
      }
    }
  }

  for (const f of failed) console.warn(`[rewards] ${member.user.tag} role ${f.roleId}: ${f.reason}`);
  return { added, removed, failed };
}

/** 管理指令降級時可選擇撤掉已不該持有的獎勵角色 */
export async function stripRewardsAbove(member, level) {
  const guild = member.guild;
  const rewards = listRewards(guild.id);
  const me = guild.members.me;
  const removed = [];
  for (const r of rewards) {
    if (r.level <= level || !member.roles.cache.has(r.role_id)) continue;
    const role = guild.roles.cache.get(r.role_id);
    if (!role || me.roles.highest.comparePositionTo(role) <= 0) continue;
    try {
      await member.roles.remove(role, `等級下修至 Lv.${level}`);
      removed.push(r.role_id);
    } catch (err) {
      console.warn(`[rewards] 撤除 ${r.role_id} 失敗: ${err.message}`);
    }
  }
  return removed;
}
