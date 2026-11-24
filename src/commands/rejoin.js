import {
  SlashCommandBuilder, PermissionFlagsBits, MessageFlags, EmbedBuilder, ChannelType,
} from 'discord.js';
import {
  getRejoinSettings, updateRejoinSettings, listRepeaters, userTimeline, countJoins,
  scanMovements, enforceRejoin, setRejoinExempt, listRejoinExempt, rejoinStats, ENFORCE_CAP,
} from '../lib/rejoin.js';
import { num } from '../lib/format.js';
import { replyResolved, resolveMentions, resolveUsers } from '../lib/mentions.js';

const ACTION_LABEL = { off: '只記錄（不處理）', notify: '達標發通知', ban: '達標自動封禁' };
const SOURCE_LABEL = { live: 'Bot 即時', system: '系統訊息', modlog: '活動日誌', member: '目前成員' };
const TEXT_CHANNELS = [ChannelType.GuildText, ChannelType.GuildAnnouncement];

export const data = new SlashCommandBuilder()
  .setName('rejoin')
  .setDescription('調查反覆進出伺服器的使用者，可設定達到次數自動封禁')
  .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers)
  .addSubcommand((s) => s
    .setName('scan').setDescription('把過去的進出補進紀錄（系統加入訊息、活動日誌、目前成員）。只記錄不封禁')
    .addChannelOption((o) => o.setName('channel').setDescription('有「加入了伺服器」訊息的頻道，預設是伺服器的系統頻道')
      .addChannelTypes(...TEXT_CHANNELS))
    .addIntegerOption((o) => o.setName('limit').setDescription('往回掃幾則，預設 2000').setMinValue(100).setMaxValue(20000)))
  .addSubcommand((s) => s
    .setName('list').setDescription('列出期間內加入多次的人')
    .addIntegerOption((o) => o.setName('days').setDescription('看幾天內，預設 30；0 = 全部').setMinValue(0).setMaxValue(3650))
    .addIntegerOption((o) => o.setName('min-joins').setDescription('至少加入幾次，預設 2').setMinValue(2).setMaxValue(100)))
  .addSubcommand((s) => s
    .setName('user').setDescription('看某個人（或 UID）的進出時間線')
    .addUserOption((o) => o.setName('user').setDescription('使用者；已經離開的人可以貼 UID').setRequired(true)))
  .addSubcommand((s) => s
    .setName('auto').setDescription('同一個 UID 在幾天內加入幾次就自動處理')
    .addStringOption((o) => o.setName('action').setDescription('達標時怎麼做').setRequired(true).addChoices(
      { name: '關閉（只記錄）', value: 'off' },
      { name: '只通知', value: 'notify' },
      { name: '自動封禁', value: 'ban' },
    ))
    .addIntegerOption((o) => o.setName('threshold').setDescription('加入幾次算達標（含這一次），預設 3').setMinValue(2).setMaxValue(50))
    .addIntegerOption((o) => o.setName('days').setDescription('統計幾天內，預設 7').setMinValue(1).setMaxValue(365))
    .addIntegerOption((o) => o.setName('delete-messages').setDescription('封禁時順便刪掉他最近幾小時的訊息，預設 0').setMinValue(0).setMaxValue(168)))
  .addSubcommand((s) => s
    .setName('log-channel').setDescription('通知發到哪裡；留空＝用 /log 的活動日誌頻道')
    .addChannelOption((o) => o.setName('channel').setDescription('通知頻道').addChannelTypes(...TEXT_CHANNELS)))
  .addSubcommand((s) => s
    .setName('enforce').setDescription('封禁已經達標的人（不在伺服器裡的也可以）。不加 confirm 只預覽')
    .addBooleanOption((o) => o.setName('confirm').setDescription('true = 真的封禁'))
    .addIntegerOption((o) => o.setName('threshold').setDescription('門檻，預設用 auto 的設定').setMinValue(2).setMaxValue(50))
    .addIntegerOption((o) => o.setName('days').setDescription('統計幾天內，預設用 auto 的設定').setMinValue(1).setMaxValue(3650)))
  .addSubcommand((s) => s
    .setName('exempt').setDescription('豁免名單：不會因反覆進出被通知或封禁')
    .addStringOption((o) => o.setName('action').setDescription('做什麼').setRequired(true).addChoices(
      { name: '看清單', value: 'list' }, { name: '新增', value: 'add' }, { name: '移除', value: 'remove' },
    ))
    .addUserOption((o) => o.setName('user').setDescription('使用者或 UID')))
  .addSubcommand((s) => s
    .setName('view').setDescription('看目前設定與統計'));

export async function execute(interaction) {
  const guildId = interaction.guildId;
  switch (interaction.options.getSubcommand()) {
    case 'scan': return scan(interaction);
    case 'list': return list(interaction, guildId);
    case 'user': return user(interaction, guildId);
    case 'auto': return auto(interaction, guildId);
    case 'log-channel': return logChannel(interaction, guildId);
    case 'enforce': return enforce(interaction);
    case 'exempt': return exempt(interaction, guildId);
    case 'view': return view(interaction, guildId);
    default: return reply(interaction, '未知的子指令。');
  }
}

const ts = (ms, style = 'f') => `<t:${Math.floor(ms / 1000)}:${style}>`;

async function scan(interaction) {
  const channel = interaction.options.getChannel('channel');
  const limit = interaction.options.getInteger('limit') ?? 2000;
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const s = await scanMovements(interaction.guild, { channel, limit });
  const lines = ['✅ 掃描完成（只記錄，不會封禁任何人）：'];
  if (s.noChannel) lines.push('・沒有系統頻道：伺服器沒設定系統訊息頻道，可用 `channel:` 指定有「加入了伺服器」訊息的頻道');
  else lines.push(`・<#${s.channel}>：看了 ${num(s.systemMessages)} 則，新增 **${num(s.systemJoins)}** 筆加入`);
  lines.push(`・活動日誌：新增 ${num(s.modlogEvents)} 筆加入／離開`);
  lines.push(`・目前成員的加入時間：新增 ${num(s.members)} 筆`);
  lines.push('接著用 `/rejoin list` 看誰加入過很多次。系統訊息只有「加入」，所以掃回來的過去紀錄看不到離開。');
  return interaction.editReply(lines.join('\n'));
}

async function list(interaction, guildId) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const days = interaction.options.getInteger('days') ?? 30;
  const minJoins = interaction.options.getInteger('min-joins') ?? 2;
  const since = days > 0 ? Date.now() - days * 86_400_000 : 0;
  const rows = listRepeaters(guildId, { since, minJoins, limit: 25 });
  const settings = getRejoinSettings(guildId);
  const embed = new EmbedBuilder()
    .setColor(0xe67e22)
    .setTitle(`🔁 反覆進出（${days > 0 ? `${days} 天內` : '全部紀錄'}，加入 ≥ ${minJoins} 次）`)
    .setFooter({ text: `自動處理：${ACTION_LABEL[settings.action]}（${settings.window_days} 天內 ${settings.threshold} 次）・紀錄只涵蓋 Bot 看得到的進出` });
  if (rows.length === 0) {
    embed.setDescription('沒有符合條件的人。還沒掃過的話先跑 `/rejoin scan` 把過去的加入補進來。');
  } else {
    // members.cache 只有 Bot 看過的人，要實際向 Discord 查才知道還在不在
    const users = await resolveUsers(interaction.guild, rows.map((r) => r.user_id));
    embed.setDescription(rows.map((r, i) => {
      const status = users.get(r.user_id)?.inGuild;
      const flags = [
        status === true ? '在伺服器' : status === false ? '已離開' : '狀態未知',
        r.last_action === 'ban' ? '⛔ 已封禁' : r.last_action === 'notify' ? '🔔 已通知' : null,
        r.exempt ? '🛡️ 豁免' : null,
      ].filter(Boolean).join('・');
      return `**${i + 1}.** <@${r.user_id}> \`${r.user_id}\`\n` +
        `　加入 **${r.joins}** 次・離開 ${r.leaves} 次・最近 ${ts(r.last_at, 'R')}・${flags}`;
    }).join('\n').slice(0, 4000));
  }
  return replyResolved(interaction, { embeds: [embed] });
}

async function user(interaction, guildId) {
  const target = interaction.options.getUser('user');
  const events = userTimeline(guildId, target.id, 30);
  const settings = getRejoinSettings(guildId);
  const windowJoins = countJoins(guildId, target.id, Date.now() - settings.window_days * 86_400_000);
  const lines = [
    `<@${target.id}> \`${target.id}\`：${settings.window_days} 天內加入 **${windowJoins}** 次（門檻 ${settings.threshold}）。`,
  ];
  if (events.length === 0) lines.push('沒有任何進出紀錄。');
  for (const e of events) {
    lines.push(`${e.type === 'join' ? '📥 加入' : '📤 離開'} ${ts(e.at)}（${ts(e.at, 'R')}）・${SOURCE_LABEL[e.source] ?? e.source}`);
  }
  return replyResolved(interaction, { content: lines.join('\n').slice(0, 1900) });
}

function auto(interaction, guildId) {
  const action = interaction.options.getString('action');
  const threshold = interaction.options.getInteger('threshold');
  const days = interaction.options.getInteger('days');
  const hours = interaction.options.getInteger('delete-messages');
  const s = updateRejoinSettings(guildId, {
    action, threshold: threshold ?? undefined, window_days: days ?? undefined,
    delete_message_seconds: hours != null ? hours * 3600 : undefined,
  });
  const lines = [`✅ 自動處理：**${ACTION_LABEL[s.action]}**。同一個 UID 在 **${s.window_days}** 天內加入第 **${s.threshold}** 次時觸發。`];
  if (s.action === 'ban') {
    lines.push(`封禁時刪除他最近 ${s.delete_message_seconds / 3600} 小時的訊息。豁免名單上的人不會被封。`);
    lines.push('只對之後的加入生效；已經超標的人用 `/rejoin enforce` 補處理。');
    if (!interaction.guild.members.me.permissions.has(PermissionFlagsBits.BanMembers)) {
      lines.push('⚠️ Bot 沒有「封鎖成員」權限，會封禁失敗。');
    }
  }
  if (s.action !== 'off' && !s.log_channel_id) lines.push('通知會發到 `/log` 的活動日誌頻道；要另外指定用 `/rejoin log-channel`。');
  return reply(interaction, lines.join('\n'));
}

function logChannel(interaction, guildId) {
  const channel = interaction.options.getChannel('channel');
  updateRejoinSettings(guildId, { log_channel_id: channel?.id ?? null });
  return reply(interaction, channel ? `✅ 反覆進出的通知會發到 <#${channel.id}>。` : '✅ 改用 `/log` 的活動日誌頻道。');
}

async function enforce(interaction) {
  const confirm = interaction.options.getBoolean('confirm') ?? false;
  const threshold = interaction.options.getInteger('threshold');
  const days = interaction.options.getInteger('days');
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const r = await enforceRejoin(interaction.guild, { confirm, threshold, windowDays: days });
  const header = `${r.windowDays} 天內加入 ≥ ${r.threshold} 次、未被這個功能封禁過、不在豁免名單`;
  if (r.candidates.length === 0) return interaction.editReply(`沒有符合條件的人（${header}）。`);
  if (!confirm) {
    const preview = r.candidates.slice(0, 20).map((c) => `・<@${c.user_id}> \`${c.user_id}\`${c.user_tag ? `（${c.user_tag}）` : ''} 加入 ${c.joins} 次`);
    return replyResolved(interaction, {
      content: [`🔍 預覽：**${r.candidates.length}** 人會被封禁（${header}）：`, ...preview,
        r.candidates.length > 20 ? `…還有 ${r.candidates.length - 20} 人` : '',
        `確認後加 \`confirm:true\` 執行（一次最多 ${ENFORCE_CAP} 人）。`].filter(Boolean).join('\n'),
      allowedMentions: { parse: [] },
    });
  }
  const lines = [`⛔ 已封禁 **${r.banned.length}** 人（${header}）。`];
  if (r.failed.length) lines.push(`失敗 ${r.failed.length} 人：${r.failed.slice(0, 5).map((f) => `<@${f.userId}>（${f.error}）`).join('、')}`);
  if (r.capped) lines.push(`達到單次上限 ${ENFORCE_CAP} 人，再跑一次處理剩下的。`);
  return replyResolved(interaction, { content: lines.join('\n') });
}

function exempt(interaction, guildId) {
  const action = interaction.options.getString('action');
  const target = interaction.options.getUser('user');
  if (action === 'list') {
    const ids = listRejoinExempt(guildId);
    return reply(interaction, ids.length ? `豁免名單：${ids.map((id) => `<@${id}>`).join('、')}` : '豁免名單是空的。');
  }
  if (!target) return reply(interaction, '⚠️ 要指定 `user`。');
  if (action === 'add') {
    setRejoinExempt(guildId, target.id, true);
    return reply(interaction, `✅ <@${target.id}> 不會因反覆進出被通知或封禁。`);
  }
  return reply(interaction, setRejoinExempt(guildId, target.id, false)
    ? `✅ <@${target.id}> 已移出豁免名單。` : `<@${target.id}> 本來就不在豁免名單。`);
}

function view(interaction, guildId) {
  const s = getRejoinSettings(guildId);
  const embed = new EmbedBuilder()
    .setColor(s.action === 'ban' ? 0xc0392b : s.action === 'notify' ? 0xf39c12 : 0x95a5a6)
    .setTitle('🔁 反覆進出')
    .addFields(
      { name: '自動處理', value: ACTION_LABEL[s.action], inline: true },
      { name: '門檻', value: `${s.window_days} 天內加入 ${s.threshold} 次`, inline: true },
      { name: '封禁時刪訊息', value: `${s.delete_message_seconds / 3600} 小時`, inline: true },
      { name: '通知頻道', value: s.log_channel_id ? `<#${s.log_channel_id}>` : '（用 /log 活動日誌頻道）', inline: true },
      { name: '豁免', value: `${listRejoinExempt(guildId).length} 人`, inline: true },
      { name: '本次啟動以來', value: `加入 ${num(rejoinStats.joins)}・離開 ${num(rejoinStats.leaves)}・通知 ${num(rejoinStats.notified)}・封禁 ${num(rejoinStats.banned)}（失敗 ${num(rejoinStats.banFailed)}）` },
    );
  return replyResolved(interaction, { embeds: [embed] });
}

function reply(interaction, content) {
  return interaction.reply({ content, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
}
