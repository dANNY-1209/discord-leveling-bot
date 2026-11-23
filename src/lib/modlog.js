import { AuditLogEvent, AttachmentBuilder, EmbedBuilder, PermissionFlagsBits } from 'discord.js';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  getModlog, listModlogIgnoredChannels,
  saveModlogMessage, getModlogMessage, updateModlogMessageContent, markModlogDeleted,
  addModlogEvent, pruneModlog, countReactionAwardsForMessage, getMember,
} from './db.js';

// 活動日誌／刪除訊息紀錄。預設關閉；/log enable 之後才開始存訊息快照。
// 刪除事件只帶 message.id（訊息不在快取、Bot 重啟過時內容是空的），所以收訊時先把內容存進 DB。

export const modlogStats = { snapshots: 0, deletes: 0, unknownDeletes: 0, edits: 0, posted: 0, postFailed: 0 };

const ATTACH_DIR = join(dirname(process.env.SQLITE_PATH || '/data/leveling.db'), 'modlog-attachments');
const ATTACH_MAX_BYTES = 8 * 1024 * 1024;
const ATTACH_MAX_PER_MESSAGE = 4;
const BOT_DELETION_TTL_MS = 120_000;
const QUICK_DELETE_MS = 60_000;
export const UNKNOWN_DELETER = '?';

const COLORS = { delete: 0xe74c3c, bulk: 0xc0392b, edit: 0xf1c40f, join: 0x2ecc71, leave: 0x95a5a6, member: 0x3498db, ban: 0x8e44ad };

// ---------- Bot 自己刪的訊息 ----------

const botDeletions = new Map(); // message_id -> { reason, expires }

/** 去重／AI 過濾刪訊前先登記原因，刪除日誌才分得出是 Bot 刪的、不是本人刪的 */
export function markBotDeletion(messageId, reason) {
  const now = Date.now();
  for (const [id, v] of botDeletions) if (v.expires <= now) botDeletions.delete(id);
  botDeletions.set(messageId, { reason, expires: now + BOT_DELETION_TTL_MS });
}

function takeBotDeletion(messageId) {
  const v = botDeletions.get(messageId);
  if (!v) return null;
  botDeletions.delete(messageId);
  return v.expires > Date.now() ? v.reason : null;
}

// ---------- 範圍判斷 ----------

function channelChain(channel) {
  if (!channel) return [];
  return [channel.id, channel.parentId, channel.parent?.parentId].filter(Boolean);
}

/** 紀錄有沒有開、這個頻道要不要記。日誌頻道本身一律不記，避免自己記自己 */
export function modlogScope(guildId, channel) {
  const settings = getModlog(guildId);
  if (!settings.enabled) return null;
  const chain = channelChain(channel);
  if (chain.length > 0) {
    if (chain.includes(settings.delete_channel_id) || chain.includes(settings.activity_channel_id)) return null;
    const ignored = listModlogIgnoredChannels(guildId);
    if (chain.some((id) => ignored.includes(id))) return null;
  }
  return settings;
}

// ---------- 收訊快照 ----------

function describeAttachments(message) {
  return [...(message.attachments?.values() ?? [])].map((a) => ({
    name: a.name, url: a.url, size: a.size, contentType: a.contentType ?? null,
  }));
}

function authorTag(user) {
  if (!user) return null;
  return user.discriminator && user.discriminator !== '0' ? `${user.username}#${user.discriminator}` : user.username;
}

/** messageCreate：開了紀錄就存一份快照。要在發 XP 之前呼叫，入帳時才找得到這一列 */
export function snapshotMessage(message) {
  if (!message.inGuild?.() || message.system) return false;
  const settings = modlogScope(message.guild.id, message.channel);
  if (!settings) return false;
  if ((message.author?.bot || message.webhookId) && !settings.include_bots) return false;

  const attachments = describeAttachments(message);
  saveModlogMessage({
    messageId: message.id,
    guildId: message.guild.id,
    channelId: message.channel.id,
    authorId: message.author?.id,
    authorTag: authorTag(message.author),
    authorBot: Boolean(message.author?.bot || message.webhookId),
    content: message.content ?? '',
    attachments,
    stickers: [...(message.stickers?.values() ?? [])].map((s) => s.name),
    replyTo: message.reference?.messageId ?? null,
    createdAt: message.createdTimestamp ?? Date.now(),
  });
  modlogStats.snapshots++;

  // 刪掉之後 Discord CDN 上的附件也會失效，要留圖只能先下載。預設關，見 /log options
  if (settings.save_attachments && attachments.length > 0) {
    saveAttachments(message, attachments).catch((err) => console.warn(`[modlog] 附件備份失敗 ${message.id}: ${err.message}`));
  }
  return true;
}

async function saveAttachments(message, attachments) {
  const dir = join(ATTACH_DIR, message.guild.id);
  await mkdir(dir, { recursive: true });
  const saved = [];
  for (const [i, a] of attachments.entries()) {
    if (i >= ATTACH_MAX_PER_MESSAGE || !a.size || a.size > ATTACH_MAX_BYTES) { saved.push(a); continue; }
    try {
      const res = await fetch(a.url, { signal: AbortSignal.timeout(20_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      const safeName = String(a.name).replace(/[^\w.\-]+/g, '_').slice(-80) || 'file';
      const file = join(dir, `${message.id}-${i}-${safeName}`);
      await writeFile(file, buf);
      saved.push({ ...a, file });
    } catch (err) {
      console.warn(`[modlog] 下載附件 ${a.name} 失敗: ${err.message}`);
      saved.push(a);
    }
  }
  const row = getModlogMessage(message.id);
  if (!row) return; // 這段時間內被清掉了
  saveModlogMessage({
    messageId: row.message_id, guildId: row.guild_id, channelId: row.channel_id,
    authorId: row.author_id, authorTag: row.author_tag, authorBot: row.author_bot,
    content: row.content, attachments: saved, stickers: row.stickers, replyTo: row.reply_to, createdAt: row.created_at,
  });
}

async function removeAttachmentFiles(rows) {
  for (const r of rows) {
    for (const a of r.attachments ?? []) if (a.file) await rm(a.file, { force: true }).catch(() => {});
  }
}

// ---------- 誰刪的（稽核紀錄，盡力而為） ----------

const auditSeen = new Map(); // guild_id -> Map(entry_id -> count)

/**
 * 本人刪自己的訊息不會進稽核紀錄；管理員刪別人的才會。所以查得到 = 管理員，查不到 = 本人或無法確認。
 * 同一位管理員連刪同一人同一頻道的訊息，Discord 會把它們併成同一筆、只把 count 加一，要記住上次看到的 count。
 */
async function findDeleter(guild, authorId, channelId) {
  const me = guild.members.me;
  if (!authorId || !me?.permissions.has(PermissionFlagsBits.ViewAuditLog)) return { known: false };
  await new Promise((r) => setTimeout(r, 1500)); // 稽核紀錄比刪除事件晚一點才寫入
  const logs = await guild.fetchAuditLogs({ type: AuditLogEvent.MessageDelete, limit: 10 }).catch(() => null);
  if (!logs) return { known: false };

  let seen = auditSeen.get(guild.id);
  const firstLook = !seen;
  if (!seen) { seen = new Map(); auditSeen.set(guild.id, seen); }

  let match = null;
  for (const entry of logs.entries.values()) {
    const count = entry.extra?.count ?? 1;
    const before = seen.get(entry.id);
    seen.set(entry.id, count);
    if (match || entry.targetId !== authorId || entry.extra?.channel?.id !== channelId) continue;
    const fresh = before === undefined && !firstLook && Date.now() - entry.createdTimestamp < 30_000;
    const freshFirst = before === undefined && firstLook && Date.now() - entry.createdTimestamp < 10_000;
    if (fresh || freshFirst || (before !== undefined && count > before)) match = entry.executorId;
  }
  if (seen.size > 200) for (const id of [...seen.keys()].slice(0, seen.size - 100)) seen.delete(id);
  return { known: true, executorId: match };
}

// ---------- 刪除 ----------

/**
 * messageDelete。xpCancelled = 刪的時候這則還在延遲入帳的排隊中（沒拿到 XP）。
 * 已入帳才刪的不會追回 XP（見 README 防刷一節），所以日誌會特別標出來。
 */
export async function handleMessageDelete(message, { xpCancelled = false } = {}) {
  const guild = message.guild;
  if (!guild) return null;
  const settings = modlogScope(guild.id, message.channel);
  if (!settings) return null;

  let row = getModlogMessage(message.id);
  if (!row && !message.partial && message.author) {
    // 開紀錄之前就在快取裡的訊息：用快取內容補一列
    if ((message.author.bot || message.webhookId) && !settings.include_bots) return null;
    snapshotMessage(message);
    row = getModlogMessage(message.id);
  }
  if (row?.author_bot && !settings.include_bots) return null;

  const botReason = takeBotDeletion(message.id);
  // Bot 刪的卻沒有快照 = 刪的是別的 Bot 的訊息（例如去重順手刪掉的 ermiana 預覽），不值得記
  if (botReason && !row) return null;
  if (botReason && !settings.bot_deletions) {
    if (row) markModlogDeleted(message.id, { reason: botReason, xpCancelled });
    return null;
  }

  // deleted_by：作者本人 ID = 本人刪；別人 ID = 管理員刪；UNKNOWN_DELETER = 沒權限查稽核紀錄、分不出來
  const authorId = row?.author_id ?? message.author?.id ?? null;
  let deletedBy;
  if (botReason) {
    deletedBy = guild.members.me?.id ?? null;
  } else {
    const r = await findDeleter(guild, authorId, message.channelId);
    deletedBy = r.known ? (r.executorId ?? authorId ?? UNKNOWN_DELETER) : UNKNOWN_DELETER;
  }

  const deletedAt = Date.now();
  modlogStats.deletes++;
  if (row) {
    if (!markModlogDeleted(message.id, { deletedAt, deletedBy, reason: botReason, xpCancelled })) return null;
    row = getModlogMessage(message.id);
  } else {
    modlogStats.unknownDeletes++;
  }

  const entry = row ?? {
    message_id: message.id, guild_id: guild.id, channel_id: message.channelId, author_id: message.author?.id ?? null,
    author_tag: authorTag(message.author), content: null, attachments: [], stickers: [], reply_to: null,
    created_at: message.createdTimestamp ?? null, deleted_at: deletedAt, deleted_by: deletedBy,
    delete_reason: botReason, xp_awarded: 0, xp_cancelled: xpCancelled ? 1 : 0,
  };

  addModlogEvent(guild.id, {
    type: 'delete', userId: entry.author_id, channelId: entry.channel_id, messageId: message.id, createdAt: deletedAt,
    summary: `${deleteSourceText(entry, guild)}｜${xpText(entry)}｜${clip(entry.content ?? '（內容未記錄）', 200)}`,
  });

  const target = settings.delete_channel_id ?? settings.activity_channel_id;
  if (target) await postToChannelId(guild, target, deletedMessagePayloads(guild, [entry]));
  return entry;
}

/** messageDeleteBulk：管理員清訊或封鎖時刪訊息。一則摘要 + 完整內容附成 txt */
export async function handleBulkDelete(messages, channel) {
  const guild = channel?.guild;
  if (!guild) return null;
  const settings = modlogScope(guild.id, channel);
  if (!settings) return null;

  const deletedAt = Date.now();
  const rows = [];
  for (const id of messages.keys()) {
    const reason = takeBotDeletion(id) ?? 'bulk';
    let row = getModlogMessage(id);
    const cached = messages.get(id);
    if (!row && cached && !cached.partial && cached.author) { snapshotMessage(cached); row = getModlogMessage(id); }
    if (!row) continue;
    if (row.author_bot && !settings.include_bots) continue;
    markModlogDeleted(id, { deletedAt, reason });
    rows.push(getModlogMessage(id));
  }
  const unknown = messages.size - rows.length;
  addModlogEvent(guild.id, {
    type: 'bulk-delete', channelId: channel.id, createdAt: deletedAt,
    summary: `批次刪除 ${messages.size} 則（有內容 ${rows.length} 則）`,
  });

  const target = settings.delete_channel_id ?? settings.activity_channel_id;
  if (!target) return rows;
  rows.sort((a, b) => a.created_at - b.created_at);
  const embed = new EmbedBuilder()
    .setColor(COLORS.bulk)
    .setTitle(`🧹 批次刪除 ${messages.size} 則`)
    .setDescription(`頻道：<#${channel.id}>\n有記錄內容：${rows.length} 則${unknown ? `，未記錄：${unknown} 則` : ''}`)
    .setTimestamp(deletedAt);
  const files = rows.length ? [new AttachmentBuilder(Buffer.from(transcript(rows), 'utf8'), { name: `bulk-delete-${channel.id}-${deletedAt}.txt` })] : [];
  await postToChannelId(guild, target, [{ embeds: [embed], files }]);
  return rows;
}

// ---------- 編輯 ----------

export async function handleMessageEdit(oldMessage, newMessage) {
  if (!newMessage.inGuild?.()) return null;
  const settings = modlogScope(newMessage.guild.id, newMessage.channel);
  if (!settings) return null;
  if ((newMessage.author?.bot || newMessage.webhookId) && !settings.include_bots) return null;

  const row = getModlogMessage(newMessage.id);
  const before = oldMessage && !oldMessage.partial ? oldMessage.content : row?.content;
  const after = newMessage.content ?? '';
  if (before === after) return null; // 補 embed 預覽也會觸發 update，內容沒變不算編輯
  if (row) updateModlogMessageContent(newMessage.id, after, newMessage.editedTimestamp ?? Date.now());
  else snapshotMessage(newMessage);
  modlogStats.edits++;

  addModlogEvent(newMessage.guild.id, {
    type: 'edit', userId: newMessage.author?.id, channelId: newMessage.channel.id, messageId: newMessage.id,
    summary: `${clip(before ?? '（舊內容未記錄）', 150)} → ${clip(after, 150)}`,
  });
  if (!settings.activity_channel_id) return true;
  const embed = new EmbedBuilder()
    .setColor(COLORS.edit)
    .setAuthor({ name: `${authorTag(newMessage.author) ?? '未知'} 編輯了訊息` })
    .setDescription(`<@${newMessage.author?.id}> 在 <#${newMessage.channel.id}>　[跳到訊息](${newMessage.url})`)
    .addFields(
      { name: '修改前', value: clip(before ?? '（舊內容未記錄）', 1024) || '（空）' },
      { name: '修改後', value: clip(after, 1024) || '（空）' },
    )
    .setFooter({ text: `訊息 ${newMessage.id}・使用者 ${newMessage.author?.id}` })
    .setTimestamp();
  await postToChannelId(newMessage.guild, settings.activity_channel_id, [{ embeds: [embed] }]);
  return true;
}

// ---------- 成員活動 ----------

async function memberEvent(guild, { type, userId, color, title, lines }) {
  const settings = getModlog(guild.id);
  if (!settings.enabled) return;
  addModlogEvent(guild.id, { type, userId, summary: lines.join('｜') });
  if (!settings.activity_channel_id) return;
  const embed = new EmbedBuilder().setColor(color).setTitle(title)
    .setDescription(lines.join('\n')).setFooter({ text: `使用者 ${userId}` }).setTimestamp();
  await postToChannelId(guild, settings.activity_channel_id, [{ embeds: [embed] }]);
}

export function handleMemberJoin(member) {
  return memberEvent(member.guild, {
    type: 'join', userId: member.id, color: COLORS.join, title: '📥 成員加入',
    lines: [`<@${member.id}>（${authorTag(member.user)}）`, `帳號建立：<t:${Math.floor(member.user.createdTimestamp / 1000)}:R>`],
  });
}

export function handleMemberLeave(member) {
  const lv = getMember(member.guild.id, member.id);
  const lines = [`<@${member.id}>（${authorTag(member.user) ?? member.id}）`];
  if (member.joinedTimestamp) lines.push(`加入於：<t:${Math.floor(member.joinedTimestamp / 1000)}:R>`);
  if (lv.total_xp > 0) lines.push(`等級：Lv.${lv.level}（${lv.total_xp} XP）`);
  return memberEvent(member.guild, { type: 'leave', userId: member.id, color: COLORS.leave, title: '📤 成員離開', lines });
}

export async function handleMemberUpdate(oldMember, newMember) {
  if (oldMember.partial) return; // 沒有舊資料就比不出差異
  const who = `<@${newMember.id}>（${authorTag(newMember.user)}）`;
  if (oldMember.nickname !== newMember.nickname) {
    await memberEvent(newMember.guild, {
      type: 'nickname', userId: newMember.id, color: COLORS.member, title: '✏️ 暱稱變更',
      lines: [who, `${oldMember.nickname ?? '（無）'} → ${newMember.nickname ?? '（無）'}`],
    });
  }
  const added = newMember.roles.cache.filter((r) => !oldMember.roles.cache.has(r.id));
  const removed = oldMember.roles.cache.filter((r) => !newMember.roles.cache.has(r.id));
  if (added.size || removed.size) {
    const lines = [who];
    if (added.size) lines.push(`➕ ${added.map((r) => `<@&${r.id}>`).join(' ')}`);
    if (removed.size) lines.push(`➖ ${removed.map((r) => `<@&${r.id}>`).join(' ')}`);
    await memberEvent(newMember.guild, { type: 'roles', userId: newMember.id, color: COLORS.member, title: '🎭 角色變更', lines });
  }
  const oldUntil = oldMember.communicationDisabledUntilTimestamp ?? 0;
  const newUntil = newMember.communicationDisabledUntilTimestamp ?? 0;
  if (oldUntil !== newUntil && (newUntil > Date.now() || oldUntil > Date.now())) {
    await memberEvent(newMember.guild, {
      type: 'timeout', userId: newMember.id, color: COLORS.ban, title: newUntil > Date.now() ? '🔇 禁言' : '🔊 解除禁言',
      lines: newUntil > Date.now() ? [who, `到 <t:${Math.floor(newUntil / 1000)}:f>`] : [who],
    });
  }
}

export function handleBan(ban, banned) {
  return memberEvent(ban.guild, {
    type: banned ? 'ban' : 'unban', userId: ban.user.id, color: COLORS.ban,
    title: banned ? '⛔ 封鎖' : '✅ 解除封鎖',
    lines: [`<@${ban.user.id}>（${authorTag(ban.user)}）`, ...(ban.reason ? [`原因：${clip(ban.reason, 300)}`] : [])],
  });
}

// ---------- 輸出 ----------

export function clip(text, max) {
  const s = String(text ?? '');
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

export function formatDuration(ms) {
  if (ms == null || ms < 0) return '未知';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} 秒`;
  if (s < 3600) return `${Math.floor(s / 60)} 分 ${s % 60} 秒`;
  if (s < 86400) return `${Math.floor(s / 3600)} 小時 ${Math.floor((s % 3600) / 60)} 分`;
  return `${Math.floor(s / 86400)} 天 ${Math.floor((s % 86400) / 3600)} 小時`;
}

const BOT_REASON_LABEL = { dupe: '重複連結（/dupe）', 'ai-filter': 'AI 創作者過濾（/ai-filter）', bulk: '批次刪除' };

export function deleteSourceText(row, guild) {
  if (row.delete_reason) {
    const label = BOT_REASON_LABEL[row.delete_reason] ?? row.delete_reason;
    return row.delete_reason === 'bulk' ? `🧹 ${label}` : `🤖 Bot 刪除：${label}`;
  }
  if (!row.deleted_by || row.deleted_by === UNKNOWN_DELETER) return '❔ 本人刪除或無法確認（Bot 缺「檢視審核紀錄」權限）';
  if (row.deleted_by === row.author_id) return '🙋 本人刪除';
  return row.deleted_by === guild?.members?.me?.id ? '🤖 Bot 刪除' : `🛡️ 管理員 <@${row.deleted_by}> 刪除`;
}

export function xpText(row) {
  if (row.xp_awarded > 0) return `⚠️ 已入帳 +${row.xp_awarded} XP 後才刪（XP 未追回）`;
  if (row.xp_cancelled) return '⏳ 排隊中就刪，未入帳';
  return '未拿到訊息 XP';
}

function deletedEmbed(guild, row) {
  const createdAt = row.created_at ? Math.floor(row.created_at / 1000) : null;
  const lifetime = row.created_at && row.deleted_at ? row.deleted_at - row.created_at : null;
  const content = row.content == null
    ? '*（內容未記錄：可能是紀錄開啟前、或 Bot 離線時發的訊息）*'
    : (clip(row.content, 3900) || '*（沒有文字）*');
  const embed = new EmbedBuilder()
    .setColor(row.xp_awarded > 0 ? 0xe67e22 : COLORS.delete)
    .setAuthor({ name: `${row.author_tag ?? '未知使用者'} 的訊息被刪除` })
    .setDescription(content)
    .addFields(
      { name: '作者', value: row.author_id ? `<@${row.author_id}>` : '未知', inline: true },
      { name: '頻道', value: `<#${row.channel_id}>`, inline: true },
      { name: '刪除者', value: deleteSourceText(row, guild), inline: true },
      { name: '發送時間', value: createdAt ? `<t:${createdAt}:f>` : '未知', inline: true },
      { name: '存活時間', value: `${formatDuration(lifetime)}${lifetime != null && lifetime < QUICK_DELETE_MS ? ' ⚡' : ''}`, inline: true },
      { name: '經驗值', value: xpText(row), inline: true },
    )
    .setFooter({ text: `訊息 ${row.message_id}${row.author_id ? `・使用者 ${row.author_id}` : ''}` })
    .setTimestamp(row.deleted_at ?? Date.now());
  const reactions = row.guild_id ? countReactionAwardsForMessage(row.guild_id, row.message_id) : 0;
  if (reactions > 0) embed.addFields({ name: '反應 XP', value: `這則訊息發過 ${reactions} 筆反應 XP（未追回）`, inline: true });
  if (row.reply_to) embed.addFields({ name: '回覆', value: `https://discord.com/channels/${row.guild_id}/${row.channel_id}/${row.reply_to}`, inline: true });
  const extras = [];
  if (row.attachments?.length) {
    extras.push(...row.attachments.map((a) => `📎 ${a.name}${a.size ? `（${Math.round(a.size / 1024)} KB）` : ''}${a.file ? '' : '（原檔已隨訊息刪除）'}`));
  }
  if (row.stickers?.length) extras.push(`🏷️ 貼圖：${row.stickers.join('、')}`);
  if (extras.length) embed.addFields({ name: '附件／貼圖', value: clip(extras.join('\n'), 1024) });
  return embed;
}

/** 把一批已刪除訊息排成可送出的訊息：一則最多 10 個 embed、總字數 6000 以內；有備份附件的單獨送 */
export function deletedMessagePayloads(guild, rows) {
  const payloads = [];
  let batch = [];
  let size = 0;
  const flush = () => { if (batch.length) payloads.push({ embeds: batch }); batch = []; size = 0; };
  for (const row of rows) {
    const embed = deletedEmbed(guild, row);
    const files = (row.attachments ?? []).filter((a) => a.file).map((a) => new AttachmentBuilder(a.file, { name: a.name }));
    if (files.length) { flush(); payloads.push({ embeds: [embed], files }); continue; }
    const len = embed.length;
    if (batch.length >= 10 || size + len > 5800) flush();
    batch.push(embed);
    size += len;
  }
  flush();
  return payloads;
}

function transcript(rows) {
  return rows.map((r) => {
    const t = new Date(r.created_at).toISOString();
    const att = r.attachments?.length ? `\n  [附件] ${r.attachments.map((a) => a.name).join(', ')}` : '';
    return `[${t}] ${r.author_tag ?? r.author_id} (${r.author_id}) #${r.channel_id}\n  ${String(r.content ?? '').replace(/\n/g, '\n  ')}${att}`;
  }).join('\n\n');
}

/** 檢查 Bot 能不能在這個頻道發日誌；回傳缺的權限名稱 */
export function missingPostPerms(channel, needFiles = false) {
  const perms = channel?.permissionsFor?.(channel.guild.members.me);
  if (!perms) return ['檢視頻道'];
  const need = [
    [PermissionFlagsBits.ViewChannel, '檢視頻道'],
    [PermissionFlagsBits.SendMessages, '傳送訊息'],
    [PermissionFlagsBits.EmbedLinks, '嵌入連結'],
  ];
  if (needFiles) need.push([PermissionFlagsBits.AttachFiles, '附加檔案']);
  return need.filter(([flag]) => !perms.has(flag)).map(([, name]) => name);
}

const warnedTargets = new Set();

export async function postToChannel(channel, payloads) {
  let sent = 0;
  for (const p of payloads) {
    try {
      await channel.send({ ...p, allowedMentions: { parse: [] } });
      sent++;
      modlogStats.posted++;
    } catch (err) {
      modlogStats.postFailed++;
      if (!warnedTargets.has(channel.id)) {
        warnedTargets.add(channel.id);
        console.warn(`[modlog] 在 #${channel.name ?? channel.id} 發日誌失敗: ${err.message}`);
      }
    }
  }
  return sent;
}

async function postToChannelId(guild, channelId, payloads) {
  const channel = guild.channels.cache.get(channelId) ?? await guild.channels.fetch(channelId).catch(() => null);
  if (!channel?.isTextBased?.()) return 0;
  return postToChannel(channel, payloads);
}

// ---------- 定期清理 ----------

export async function runModlogPrune() {
  const removed = pruneModlog();
  await removeAttachmentFiles(removed);
  if (removed.length) console.log(`[modlog] 清掉過期訊息快照 ${removed.length} 則`);
  return removed.length;
}

export { removeAttachmentFiles };

export function startModlogMaintenance() {
  runModlogPrune().catch((err) => console.error('[modlog] 清理失敗', err));
  const timer = setInterval(() => runModlogPrune().catch((err) => console.error('[modlog] 清理失敗', err)), 3_600_000);
  timer.unref?.();
  return timer;
}
