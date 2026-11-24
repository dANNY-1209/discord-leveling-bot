import {
  SlashCommandBuilder, PermissionFlagsBits, MessageFlags, EmbedBuilder, ChannelType,
} from 'discord.js';
import {
  getModlog, updateModlog, listModlogIgnoredChannels, addModlogIgnoredChannel, removeModlogIgnoredChannel,
  listModlogDeleted, listModlogEvents, listModlogDeleteSuspects, countModlog, purgeModlogGuild,
} from '../lib/db.js';
import {
  modlogStats, deletedMessagePayloads, postToChannel, missingPostPerms, removeAttachmentFiles, clip,
} from '../lib/modlog.js';
import { num } from '../lib/format.js';
import { withResolvableMentions } from '../lib/mentions.js';

const POST_CHANNEL_TYPES = [ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.PublicThread, ChannelType.PrivateThread];

const SOURCE_LABEL = {
  all: '全部', self: '本人自刪', others: '管理員刪除', bot: 'Bot 刪除', xp: '拿到 XP 後才刪',
};
const EVENT_LABEL = {
  delete: '🗑️ 刪除', 'bulk-delete': '🧹 批次刪除', edit: '✏️ 編輯', join: '📥 加入', leave: '📤 離開',
  nickname: '🪪 暱稱', roles: '🎭 角色', timeout: '🔇 禁言', ban: '⛔ 封鎖', unban: '✅ 解封',
};

export const data = new SlashCommandBuilder()
  .setName('log')
  .setDescription('活動日誌與刪除訊息紀錄：誰刪了什麼、拿完 XP 才刪的人')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .addSubcommand((s) => s
    .setName('enable').setDescription('開始／停止記錄訊息與活動（開啟後才會存訊息內容）')
    .addBooleanOption((o) => o.setName('enabled').setDescription('true = 開始記錄').setRequired(true))
    .addBooleanOption((o) => o.setName('purge').setDescription('關閉時一併清空已存的訊息與事件')))
  .addSubcommand((s) => s
    .setName('channel').setDescription('設定自動發日誌的頻道（留空＝不自動發，只存起來用指令調）')
    .addStringOption((o) => o.setName('kind').setDescription('哪一種日誌').setRequired(true).addChoices(
      { name: '刪除訊息', value: 'delete' },
      { name: '活動（編輯、加入離開、角色、禁言、封鎖）', value: 'activity' },
    ))
    .addChannelOption((o) => o.setName('channel').setDescription('日誌頻道；留空＝關掉自動發送')
      .addChannelTypes(...POST_CHANNEL_TYPES)))
  .addSubcommand((s) => s
    .setName('deleted').setDescription('把已刪除的訊息發到指定頻道觀察')
    .addChannelOption((o) => o.setName('to').setDescription('要發到哪個頻道')
      .addChannelTypes(...POST_CHANNEL_TYPES).setRequired(true))
    .addUserOption((o) => o.setName('user').setDescription('只看這個人的'))
    .addStringOption((o) => o.setName('source').setDescription('誰刪的，預設全部').addChoices(
      { name: '全部', value: 'all' },
      { name: '本人自刪', value: 'self' },
      { name: '拿到 XP 後才刪（刷經驗）', value: 'xp' },
      { name: '管理員刪除', value: 'others' },
      { name: 'Bot 刪除（去重／AI 過濾）', value: 'bot' },
    ))
    .addChannelOption((o) => o.setName('in').setDescription('只看這個頻道（選分類＝底下全部）'))
    .addIntegerOption((o) => o.setName('hours').setDescription('往回看幾小時，預設 24').setMinValue(1).setMaxValue(24 * 90))
    .addIntegerOption((o) => o.setName('count').setDescription('最多幾則，預設 10').setMinValue(1).setMaxValue(50)))
  .addSubcommand((s) => s
    .setName('suspects').setDescription('依使用者統計自刪訊息，找出拿完 XP 就刪的人')
    .addIntegerOption((o) => o.setName('days').setDescription('統計幾天內，預設 7').setMinValue(1).setMaxValue(90))
    .addIntegerOption((o) => o.setName('min-deletes').setDescription('至少刪過幾則才列出，預設 3').setMinValue(1).setMaxValue(100))
    .addChannelOption((o) => o.setName('to').setDescription('發到這個頻道；留空＝只有你看得到')
      .addChannelTypes(...POST_CHANNEL_TYPES)))
  .addSubcommand((s) => s
    .setName('activity').setDescription('把活動紀錄發到指定頻道')
    .addChannelOption((o) => o.setName('to').setDescription('要發到哪個頻道')
      .addChannelTypes(...POST_CHANNEL_TYPES).setRequired(true))
    .addUserOption((o) => o.setName('user').setDescription('只看這個人的'))
    .addStringOption((o) => o.setName('type').setDescription('只看某一類').addChoices(
      ...Object.entries(EVENT_LABEL).map(([value, name]) => ({ name, value })),
    ))
    .addIntegerOption((o) => o.setName('hours').setDescription('往回看幾小時，預設 24').setMinValue(1).setMaxValue(24 * 90))
    .addIntegerOption((o) => o.setName('count').setDescription('最多幾筆，預設 30').setMinValue(1).setMaxValue(100)))
  .addSubcommand((s) => s
    .setName('ignore').setDescription('不記錄某些頻道（例如管理頻道）')
    .addStringOption((o) => o.setName('action').setDescription('做什麼').setRequired(true).addChoices(
      { name: '看清單', value: 'list' }, { name: '新增', value: 'add' }, { name: '移除', value: 'remove' },
    ))
    .addChannelOption((o) => o.setName('channel').setDescription('頻道或分類')))
  .addSubcommand((s) => s
    .setName('options').setDescription('保存天數、要不要記 Bot、備份附件')
    .addIntegerOption((o) => o.setName('retention-days').setDescription('訊息與事件保存幾天，預設 14').setMinValue(1).setMaxValue(90))
    .addBooleanOption((o) => o.setName('include-bots').setDescription('也記錄其他 Bot／Webhook 的訊息，預設否'))
    .addBooleanOption((o) => o.setName('bot-deletions').setDescription('本 Bot 去重／AI 過濾刪的也發到日誌，預設是'))
    .addBooleanOption((o) => o.setName('save-attachments').setDescription('先下載附件（8 MB 內），刪掉後還看得到圖，預設否')))
  .addSubcommand((s) => s
    .setName('view').setDescription('看目前的設定與統計'));

export async function execute(interaction) {
  const guildId = interaction.guildId;
  switch (interaction.options.getSubcommand()) {
    case 'enable': return enable(interaction, guildId);
    case 'channel': return setChannel(interaction, guildId);
    case 'deleted': return deleted(interaction, guildId);
    case 'suspects': return suspects(interaction, guildId);
    case 'activity': return activity(interaction, guildId);
    case 'ignore': return ignore(interaction, guildId);
    case 'options': return options(interaction, guildId);
    case 'view': return view(interaction, guildId);
    default: return reply(interaction, '未知的子指令。');
  }
}

async function enable(interaction, guildId) {
  const enabled = interaction.options.getBoolean('enabled');
  const purge = interaction.options.getBoolean('purge') ?? false;
  const settings = updateModlog(guildId, { enabled: enabled ? 1 : 0 });
  if (!enabled) {
    let note = '已存的紀錄保留到保存期限，之後自動清掉。';
    if (purge) {
      const rows = purgeModlogGuild(guildId);
      await removeAttachmentFiles(rows);
      note = `已清空 ${num(rows.length)} 則訊息快照與所有活動事件。`;
    }
    return reply(interaction, `⏸️ 活動日誌已關閉，不再存新訊息。${note}`);
  }
  const lines = [
    '✅ 活動日誌已開啟。從現在起，新訊息會存一份快照，不管誰刪的（本人、管理員、Bot）都查得到。',
    `保存 **${settings.retention_days}** 天，過期自動清掉。開啟前發的訊息沒有快照，被刪時只看得到「誰、在哪」。`,
  ];
  if (!settings.delete_channel_id && !settings.activity_channel_id) {
    lines.push('還沒設定日誌頻道：用 `/log channel` 設定自動發送，或隨時用 `/log deleted to:#頻道` 調出來。');
  }
  if (!interaction.guild.members.me.permissions.has(PermissionFlagsBits.ViewAuditLog)) {
    lines.push('⚠️ Bot 沒有「檢視審核紀錄」權限：分不出是本人刪的還是管理員刪的，會標成「本人刪除或無法確認」。');
  }
  return reply(interaction, lines.join('\n'));
}

function setChannel(interaction, guildId) {
  const kind = interaction.options.getString('kind');
  const channel = interaction.options.getChannel('channel');
  const column = kind === 'delete' ? 'delete_channel_id' : 'activity_channel_id';
  const label = kind === 'delete' ? '刪除訊息' : '活動';
  const settings = updateModlog(guildId, { [column]: channel?.id ?? null });
  if (!channel) {
    const fallback = kind === 'delete' && settings.activity_channel_id ? `（刪除訊息會改發到活動日誌 <#${settings.activity_channel_id}>）` : '';
    return reply(interaction, `✅ 已關掉${label}日誌的自動發送。紀錄照存，可用指令調出來。${fallback}`);
  }
  const lines = [`✅ ${label}日誌會自動發到 <#${channel.id}>。這個頻道本身不會被記錄。`];
  const missing = missingPostPerms(channel, kind === 'delete');
  if (missing.length) lines.push(`⚠️ Bot 在那裡缺少權限：${missing.join('、')}`);
  if (isPublic(channel)) lines.push('⚠️ 這個頻道 @everyone 看得到，被刪的內容會公開。建議改用只有管理員看得到的頻道。');
  if (!settings.enabled) lines.push('（紀錄目前是關的，用 `/log enable enabled:true` 開啟）');
  return reply(interaction, lines.join('\n'));
}

/** 呼叫指令的人看不到的頻道，內容不轉發出去（避免把私密頻道的內容貼到別處） */
function viewerCanSee(interaction, channelId) {
  const channel = interaction.guild.channels.cache.get(channelId);
  if (!channel) return interaction.memberPermissions.has(PermissionFlagsBits.Administrator);
  return channel.permissionsFor(interaction.member)?.has(PermissionFlagsBits.ViewChannel) ?? false;
}

function isPublic(channel) {
  return channel.permissionsFor(channel.guild.roles.everyone)?.has(PermissionFlagsBits.ViewChannel) ?? false;
}

function expandChannel(guild, channel) {
  if (!channel) return null;
  if (channel.type !== ChannelType.GuildCategory) return [channel.id];
  return [channel.id, ...guild.channels.cache.filter((c) => c.parentId === channel.id).map((c) => c.id)];
}

async function checkTarget(interaction, to, needFiles) {
  const missing = missingPostPerms(to, needFiles);
  if (missing.length) {
    await reply(interaction, `⚠️ Bot 在 <#${to.id}> 缺少權限：${missing.join('、')}`);
    return false;
  }
  if (!to.permissionsFor(interaction.member)?.has(PermissionFlagsBits.ViewChannel)) {
    await reply(interaction, `⚠️ 你看不到 <#${to.id}>，換一個頻道。`);
    return false;
  }
  return true;
}

async function deleted(interaction, guildId) {
  const to = interaction.options.getChannel('to');
  const user = interaction.options.getUser('user');
  const source = interaction.options.getString('source') ?? 'all';
  const inChannel = interaction.options.getChannel('in');
  const hours = interaction.options.getInteger('hours') ?? 24;
  const count = interaction.options.getInteger('count') ?? 10;
  if (!await checkTarget(interaction, to, true)) return;

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const rows = listModlogDeleted(guildId, {
    userId: user?.id ?? null,
    channelIds: expandChannel(interaction.guild, inChannel),
    since: Date.now() - hours * 3_600_000,
    limit: 200,
    source,
  });
  const visible = rows.filter((r) => viewerCanSee(interaction, r.channel_id));
  const hidden = rows.length - visible.length;
  const picked = visible.slice(0, count).reverse(); // 舊的先發，頻道裡由上往下照時間讀

  const filters = [
    `來源：${SOURCE_LABEL[source]}`, `${hours} 小時內`,
    ...(user ? [`使用者 <@${user.id}>`] : []), ...(inChannel ? [`頻道 <#${inChannel.id}>`] : []),
  ].join('｜');
  if (picked.length === 0) {
    const settings = getModlog(guildId);
    const hint = settings.enabled ? '' : '\n（紀錄目前是關的：`/log enable enabled:true` 開啟後才會開始存）';
    return interaction.editReply(`找不到符合條件的已刪除訊息（${filters}）。${hidden ? `\n有 ${hidden} 則在你看不到的頻道裡，沒有列出。` : ''}${hint}`);
  }

  const header = new EmbedBuilder()
    .setColor(0x34495e)
    .setTitle(`🗂️ 已刪除訊息 ${picked.length} 則`)
    .setDescription(`${filters}\n由 <@${interaction.user.id}> 調閱${visible.length > count ? `（還有 ${visible.length - count} 則沒列出，可加大 count 或縮小範圍）` : ''}`)
    .setTimestamp();
  await postToChannel(to, [{ embeds: [header] }]);
  const sent = await postToChannel(to, deletedMessagePayloads(interaction.guild, picked));
  const lines = [`✅ 已把 ${picked.length} 則已刪除訊息發到 <#${to.id}>${sent ? '' : '（發送失敗，請看 Bot log）'}。`];
  if (hidden) lines.push(`有 ${hidden} 則在你看不到的頻道裡，沒有轉發。`);
  if (isPublic(to)) lines.push('⚠️ 這個頻道 @everyone 看得到。');
  return interaction.editReply(lines.join('\n'));
}

async function suspects(interaction, guildId) {
  const days = interaction.options.getInteger('days') ?? 7;
  const minDeletes = interaction.options.getInteger('min-deletes') ?? 3;
  const to = interaction.options.getChannel('to');
  if (to && !await checkTarget(interaction, to, false)) return;

  const rows = listModlogDeleteSuspects(guildId, { since: Date.now() - days * 86_400_000, minDeletes, limit: 15 });
  const embed = new EmbedBuilder()
    .setColor(0xe67e22)
    .setTitle(`🔎 自刪訊息排行（${days} 天內，至少 ${minDeletes} 則）`)
    .setFooter({ text: '入帳後刪 = 拿到 XP 才刪（XP 不會追回）｜排隊中刪 = 延遲入帳前就刪，沒拿到 XP｜⚡ = 發出 60 秒內就刪' })
    .setTimestamp();
  if (rows.length === 0) {
    embed.setDescription('沒有符合條件的使用者。');
  } else {
    embed.setDescription(rows.map((r, i) => {
      const flag = r.awarded >= 3 ? ' ⚠️' : '';
      return `**${i + 1}.** <@${r.author_id}>${r.author_tag ? `（${r.author_tag}）` : ''} \`${r.author_id}\`${flag}　自刪 **${r.deletes}** 則\n` +
        `　入帳後刪 ${r.awarded} 則（+${num(r.xp ?? 0)} XP）・排隊中刪 ${r.cancelled} 則・⚡ ${r.quick} 則・` +
        `最近 <t:${Math.floor(r.last_deleted_at / 1000)}:R>`;
    }).join('\n'));
    embed.addFields({ name: '下一步', value: '`/log deleted to:#頻道 user:@某人 source:拿到 XP 後才刪` 看實際內容；確認刷分可用 `/remove-xp` 扣回。' });
  }
  if (!getModlog(guildId).enabled) embed.addFields({ name: '⚠️', value: '紀錄目前是關的，只會統計開啟期間的資料。' });

  if (!to) return interaction.reply({ ...withResolvableMentions({ embeds: [embed] }), flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
  await postToChannel(to, [{ embeds: [embed] }]);
  return reply(interaction, `✅ 已發到 <#${to.id}>。`);
}

async function activity(interaction, guildId) {
  const to = interaction.options.getChannel('to');
  const user = interaction.options.getUser('user');
  const type = interaction.options.getString('type');
  const hours = interaction.options.getInteger('hours') ?? 24;
  const count = interaction.options.getInteger('count') ?? 30;
  if (!await checkTarget(interaction, to, false)) return;

  const events = listModlogEvents(guildId, {
    userId: user?.id ?? null, types: type ? [type] : null, since: Date.now() - hours * 3_600_000, limit: 300,
  }).filter((e) => !e.channel_id || viewerCanSee(interaction, e.channel_id)).slice(0, count).reverse();
  if (events.length === 0) return reply(interaction, '這段時間沒有符合條件的活動紀錄。');

  const lines = events.map((e) => {
    const where = e.channel_id ? ` <#${e.channel_id}>` : '';
    const who = e.user_id ? ` <@${e.user_id}>` : '';
    return `<t:${Math.floor(e.created_at / 1000)}:t> ${EVENT_LABEL[e.type] ?? e.type}${who}${where}　${clip(e.summary, 300)}`;
  });
  // 每則 embed 描述最多 4096 字，切成幾段送
  const payloads = [];
  let chunk = [];
  let len = 0;
  for (const line of lines) {
    if (len + line.length + 1 > 3900 && chunk.length) { payloads.push(chunk); chunk = []; len = 0; }
    chunk.push(line);
    len += line.length + 1;
  }
  if (chunk.length) payloads.push(chunk);
  const title = `📋 活動紀錄 ${events.length} 筆（${hours} 小時內${type ? `・${EVENT_LABEL[type]}` : ''}${user ? `・${user.username}` : ''}）`;
  const sent = await postToChannel(to, payloads.map((c, i) => ({
    embeds: [new EmbedBuilder().setColor(0x3498db).setTitle(i === 0 ? title : `${title}（續）`).setDescription(c.join('\n'))],
  })));
  return reply(interaction, `✅ 已把 ${events.length} 筆活動紀錄發到 <#${to.id}>${sent ? '' : '（發送失敗，請看 Bot log）'}。`);
}

function ignore(interaction, guildId) {
  const action = interaction.options.getString('action');
  const channel = interaction.options.getChannel('channel');
  if (action === 'list') {
    const list = listModlogIgnoredChannels(guildId);
    return reply(interaction, list.length ? `不記錄的頻道：${list.map((id) => `<#${id}>`).join('、')}` : '沒有排除任何頻道。');
  }
  if (!channel) return reply(interaction, '⚠️ 要指定 channel。');
  if (action === 'add') {
    addModlogIgnoredChannel(guildId, channel.id);
    return reply(interaction, `✅ 之後不記錄 <#${channel.id}>${channel.type === ChannelType.GuildCategory ? '（整個分類）' : ''}。已存的紀錄不受影響。`);
  }
  return reply(interaction, removeModlogIgnoredChannel(guildId, channel.id)
    ? `✅ <#${channel.id}> 恢復記錄。` : `<#${channel.id}> 本來就沒有被排除。`);
}

function options(interaction, guildId) {
  const patch = {};
  const retention = interaction.options.getInteger('retention-days');
  const includeBots = interaction.options.getBoolean('include-bots');
  const botDeletions = interaction.options.getBoolean('bot-deletions');
  const saveAttachments = interaction.options.getBoolean('save-attachments');
  if (retention != null) patch.retention_days = retention;
  if (includeBots != null) patch.include_bots = includeBots ? 1 : 0;
  if (botDeletions != null) patch.bot_deletions = botDeletions ? 1 : 0;
  if (saveAttachments != null) patch.save_attachments = saveAttachments ? 1 : 0;
  if (Object.keys(patch).length === 0) return reply(interaction, '沒有要改的項目。用 `/log view` 看目前設定。');
  const s = updateModlog(guildId, patch);
  const lines = ['✅ 已更新。', ...optionLines(s)];
  if (saveAttachments) lines.push('附件會存在 Bot 主機的資料夾（跟資料庫同一處），過期一起清掉；圖多的伺服器會吃不少硬碟。');
  return reply(interaction, lines.join('\n'));
}

function optionLines(s) {
  return [
    `保存天數：**${s.retention_days}** 天`,
    `記錄其他 Bot／Webhook：${s.include_bots ? '是' : '否'}`,
    `本 Bot 刪的也發日誌：${s.bot_deletions ? '是' : '否'}`,
    `備份附件：${s.save_attachments ? '是（8 MB 以內，每則最多 4 個）' : '否（刪掉後只剩檔名）'}`,
  ];
}

function view(interaction, guildId) {
  const s = getModlog(guildId);
  const c = countModlog(guildId);
  const ignored = listModlogIgnoredChannels(guildId);
  const me = interaction.guild.members.me;
  const embed = new EmbedBuilder()
    .setColor(s.enabled ? 0x2ecc71 : 0x95a5a6)
    .setTitle(`活動日誌：${s.enabled ? '✅ 記錄中' : '⏸️ 關閉'}`)
    .addFields(
      { name: '刪除訊息日誌', value: s.delete_channel_id ? `<#${s.delete_channel_id}>` : (s.activity_channel_id ? `（併入活動日誌 <#${s.activity_channel_id}>）` : '不自動發送'), inline: true },
      { name: '活動日誌', value: s.activity_channel_id ? `<#${s.activity_channel_id}>` : '不自動發送', inline: true },
      { name: '不記錄的頻道', value: ignored.length ? ignored.map((id) => `<#${id}>`).join('、').slice(0, 1024) : '無', inline: false },
      { name: '選項', value: optionLines(s).join('\n'), inline: false },
      { name: '資料庫', value: `訊息快照 ${num(c.stored)} 則（已刪除 ${num(c.deleted)}）・活動事件 ${num(c.events)} 筆`, inline: false },
      { name: '本次啟動以來', value: `快照 ${num(modlogStats.snapshots)}・刪除 ${num(modlogStats.deletes)}（無快照 ${num(modlogStats.unknownDeletes)}）・編輯 ${num(modlogStats.edits)}・發出 ${num(modlogStats.posted)}（失敗 ${num(modlogStats.postFailed)}）`, inline: false },
    );
  if (!me.permissions.has(PermissionFlagsBits.ViewAuditLog)) {
    embed.addFields({ name: '⚠️ 權限', value: 'Bot 沒有「檢視審核紀錄」：分不出本人刪除還是管理員刪除。' });
  }
  return interaction.reply({ ...withResolvableMentions({ embeds: [embed] }), flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
}

function reply(interaction, content) {
  return interaction.reply({ content, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
}
