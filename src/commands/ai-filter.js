import {
  SlashCommandBuilder, PermissionFlagsBits, MessageFlags, EmbedBuilder, ChannelType,
} from 'discord.js';
import {
  getAiFilter, updateAiFilter,
  listAiFilterChannels, addAiFilterChannel, removeAiFilterChannel,
  listAiFilterCreators, setAiFilterCreator, removeAiFilterCreator,
  listAiFilterKeywords, addAiFilterKeyword, removeAiFilterKeyword,
  readAiFilterStrike, resetAiFilterStrike,
} from '../lib/db.js';
import {
  aiFilterStats, evaluateTarget, evaluateText, linkedCreators, parseTarget,
  scanGuild, STRIKE_MUTE_AT, STRIKE_WARN_AT,
} from '../lib/aifilter.js';
import { num } from '../lib/format.js';

const ACTION_LABEL = { delete: '刪除訊息', log: '只記錄不刪', off: '停用' };

export const data = new SlashCommandBuilder()
  .setName('ai-filter')
  .setDescription('在指定頻道過濾 pixiv／X 的 AI 創作者連結與 tag')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .addSubcommand((s) => s
    .setName('watch').setDescription('把頻道或分類納入過濾')
    .addChannelOption((o) => o.setName('channel')
      .setDescription('要過濾的頻道，或整個分類')
      .addChannelTypes(
        ChannelType.GuildText, ChannelType.GuildAnnouncement,
        ChannelType.GuildForum, ChannelType.GuildMedia, ChannelType.GuildCategory,
      ).setRequired(true)))
  .addSubcommand((s) => s
    .setName('unwatch').setDescription('把頻道或分類移出過濾')
    .addChannelOption((o) => o.setName('channel').setDescription('頻道或分類').setRequired(true)))
  .addSubcommand((s) => s
    .setName('view').setDescription('看目前的設定、名單與統計'))
  .addSubcommand((s) => s
    .setName('mode').setDescription('命中時要刪除還是只記錄')
    .addStringOption((o) => o.setName('action').setDescription('命中時怎麼做').setRequired(true)
      .addChoices(
        { name: '刪除訊息（預設）', value: 'delete' },
        { name: '只記錄不刪（試運行）', value: 'log' },
        { name: '停用', value: 'off' },
      )))
  .addSubcommand((s) => s
    .setName('log-channel').setDescription('設定紀錄頻道；留空＝關閉紀錄')
    .addChannelOption((o) => o.setName('channel').setDescription('只讓管理員看得到的頻道')
      .addChannelTypes(ChannelType.GuildText)))
  .addSubcommand((s) => s
    .setName('creator').setDescription('手動封鎖或放行創作者（優先於自動判定）')
    .addStringOption((o) => o.setName('action').setDescription('做什麼').setRequired(true).addChoices(
      { name: '封鎖', value: 'block' },
      { name: '放行（誤判時用）', value: 'allow' },
      { name: '從名單移除', value: 'remove' },
    ))
    .addStringOption((o) => o.setName('target')
      .setDescription('作者頁或作品連結、@X帳號、或 pixiv 使用者 ID').setRequired(true)))
  .addSubcommand((s) => s
    .setName('keyword').setDescription('判定用的 tag／關鍵字')
    .addStringOption((o) => o.setName('action').setDescription('做什麼').setRequired(true).addChoices(
      { name: '看清單', value: 'list' },
      { name: '新增', value: 'add' },
      { name: '移除', value: 'remove' },
    ))
    .addStringOption((o) => o.setName('value').setDescription('例如 AIイラスト')))
  .addSubcommand((s) => s
    .setName('check').setDescription('試判定一段文字或連結（不會刪任何東西）')
    .addStringOption((o) => o.setName('text').setDescription('連結或含 #tag 的文字').setRequired(true)))
  .addSubcommand((s) => s
    .setName('scan').setDescription('立刻掃描過濾頻道的歷史訊息，命中的照規則處理')
    .addIntegerOption((o) => o.setName('limit').setDescription('每個頻道往回掃幾則（預設 100）')
      .setMinValue(10).setMaxValue(500)))
  .addSubcommand((s) => s
    .setName('strikes').setDescription('查看或重設某位使用者的 AI 過濾刪除次數')
    .addUserOption((o) => o.setName('user').setDescription('要查的使用者').setRequired(true))
    .addStringOption((o) => o.setName('action').setDescription('預設只查看').addChoices(
      { name: '查看', value: 'view' },
      { name: '重設為 0（誤判或已處理時用）', value: 'reset' },
    )));

export async function execute(interaction) {
  const guildId = interaction.guildId;

  switch (interaction.options.getSubcommand()) {
    case 'watch': return watch(interaction, guildId);
    case 'unwatch': return unwatch(interaction, guildId);
    case 'view': return view(interaction, guildId);
    case 'mode': return mode(interaction, guildId);
    case 'log-channel': return logChannel(interaction, guildId);
    case 'creator': return creator(interaction, guildId);
    case 'keyword': return keyword(interaction, guildId);
    case 'check': return check(interaction, guildId);
    case 'scan': return scan(interaction, guildId);
    case 'strikes': return strikes(interaction, guildId);
    default: return reply(interaction, '未知的子指令。');
  }
}

async function scan(interaction, guildId) {
  const limit = interaction.options.getInteger('limit') ?? 100;
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const stats = await scanGuild(interaction.guild, { limit });
  if (stats === null) {
    return interaction.editReply('⚠️ 沒有掃描：模式是「停用」，或還沒有指定過濾頻道。');
  }
  if (stats.busy) return interaction.editReply('這個伺服器正在掃描中，請稍後再試。');

  const lines = [
    `✅ 掃描完成：${stats.channels} 個頻道、${stats.messages} 則訊息，刪除 **${stats.deleted}** 則。`,
  ];
  if (stats.skipped.length) lines.push(`⚠️ 沒有權限讀取而略過：${stats.skipped.map((n) => `\`${n}\``).join('、')}`);
  if (getAiFilter(guildId).action !== 'delete') lines.push('（目前不是「刪除訊息」模式，命中只記錄、未刪除。）');
  return interaction.editReply(lines.join('\n'));
}

async function strikes(interaction, guildId) {
  const user = interaction.options.getUser('user');
  const action = interaction.options.getString('action') ?? 'view';
  if (action === 'reset') {
    const had = resetAiFilterStrike(guildId, user.id);
    return reply(interaction, had ? `✅ <@${user.id}> 的刪除次數已重設為 0。` : `<@${user.id}> 本來就是 0 次。`);
  }
  const count = readAiFilterStrike(guildId, user.id);
  const next = count >= STRIKE_MUTE_AT ? '已達禁言門檻（再被刪仍會禁言 1 天）'
    : count >= STRIKE_WARN_AT ? `已達警告門檻，再累積到 ${STRIKE_MUTE_AT} 次會禁言 1 天`
      : `還沒到警告門檻（${STRIKE_WARN_AT} 次）`;
  return reply(interaction, `<@${user.id}> 因 AI 過濾被刪除 **${count}** 次：${next}。`);
}

function watch(interaction, guildId) {
  const channel = interaction.options.getChannel('channel');
  const added = addAiFilterChannel(guildId, channel.id);
  const isCategory = channel.type === ChannelType.GuildCategory;
  const settings = getAiFilter(guildId);

  const lines = [added
    ? `✅ ${isCategory ? `分類 **${channel.name}** 底下所有頻道` : `<#${channel.id}>`} 已納入過濾（模式：${ACTION_LABEL[settings.action]}）。`
    : `<#${channel.id}> 本來就在過濾清單裡。`];

  const me = interaction.guild.members.me;
  const perms = me ? channel.permissionsFor(me) : null;
  if (settings.action === 'delete' && perms && !perms.has(PermissionFlagsBits.ManageMessages)) {
    lines.push('⚠️ Bot 在這裡沒有**管理訊息**權限，刪不掉訊息。到伺服器設定把這個權限給 Bot 的角色。');
  }
  return reply(interaction, lines.join('\n'));
}

function unwatch(interaction, guildId) {
  const channel = interaction.options.getChannel('channel');
  return reply(interaction, removeAiFilterChannel(guildId, channel.id)
    ? `✅ <#${channel.id}> 已移出過濾。`
    : `<#${channel.id}> 本來就沒在過濾。`);
}

function view(interaction, guildId) {
  const settings = getAiFilter(guildId);
  const channels = listAiFilterChannels(guildId);
  const creators = listAiFilterCreators(guildId);
  const show = (list) => {
    const names = creators.filter((c) => c.list === list).map((c) => `\`${c.creator}\``).join('、') || '（無）';
    return names.length > 1000 ? `${names.slice(0, 1000)}…` : names;
  };

  const embed = new EmbedBuilder()
    .setTitle('🤖 AI 創作者過濾')
    .setColor(0x9b59b6)
    .addFields(
      { name: '模式', value: ACTION_LABEL[settings.action], inline: true },
      { name: '紀錄頻道', value: settings.log_channel_id ? `<#${settings.log_channel_id}>` : '（未設定）', inline: true },
      { name: '過濾頻道', value: channels.map((id) => `<#${id}>`).join('、') || '⚠️ 還沒有指定，目前不會過濾任何訊息' },
      { name: '封鎖名單', value: show('block') },
      { name: '放行名單', value: show('allow') },
      { name: 'Tag／關鍵字', value: listAiFilterKeywords(guildId).map((k) => `\`${k}\``).join('、').slice(0, 1000) || '（無）' },
    )
    .setFooter({ text: `本次啟動以來：檢查 ${num(aiFilterStats.checked)} · 命中 ${num(aiFilterStats.matched)} · 刪除 ${num(aiFilterStats.deleted)} · 失敗 ${num(aiFilterStats.failed)} · 無法判定 ${num(aiFilterStats.unknown)} · 疑似 ${num(aiFilterStats.suspect)}` });
  return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
}

function mode(interaction, guildId) {
  const settings = updateAiFilter(guildId, { action: interaction.options.getString('action') });
  return reply(interaction, `✅ 模式改為：${ACTION_LABEL[settings.action]}`);
}

function logChannel(interaction, guildId) {
  const channel = interaction.options.getChannel('channel');
  updateAiFilter(guildId, { log_channel_id: channel?.id ?? null });
  return reply(interaction, channel ? `✅ 紀錄會發到 <#${channel.id}>。` : '✅ 已關閉紀錄。');
}

/** @帳號 → x:handle；純數字 → pixiv:id；連結就照連結解析，作品連結要查出作者 */
async function resolveCreator(input) {
  const handle = /^@(\w{1,15})$/.exec(input)?.[1];
  if (handle) return `x:${handle.toLowerCase()}`;
  if (/^\d+$/.test(input)) return `pixiv:${input}`;

  const target = parseTarget(input);
  if (!target) return null;
  if (target.type === 'x-user') return `x:${target.handle}`;
  if (target.type === 'x-status' && target.handle) return `x:${target.handle}`;
  if (target.type === 'pixiv-user') return `pixiv:${target.id}`;
  if (target.type === 'patreon') return `patreon:${target.slug}`;
  if (target.type === 'tag') return null;
  const verdict = await evaluateTarget(target, { blocked: new Set(), allowed: new Set(), keywords: [] });
  return verdict.creator ?? null;
}

async function creator(interaction, guildId) {
  const action = interaction.options.getString('action');
  const input = interaction.options.getString('target').trim();
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const id = await resolveCreator(input);
  if (!id) {
    return interaction.editReply('⚠️ 認不出創作者。請貼作者頁或作品連結、`@X帳號`，或 pixiv 使用者 ID（查不到的作品連結也會失敗，改貼作者頁）。');
  }
  if (action === 'remove') {
    return interaction.editReply(removeAiFilterCreator(guildId, id)
      ? `✅ \`${id}\` 已從名單移除，回到自動判定。`
      : `名單裡沒有 \`${id}\`。`);
  }
  setAiFilterCreator(guildId, id, action);
  if (action === 'allow') {
    return interaction.editReply(`✅ 已放行 \`${id}\`：不再因這位作者或其作品被判定。`);
  }

  // 同一人的 Patreon 與標明的小號一起封，已被放行的不動
  const allowed = new Set(listAiFilterCreators(guildId).filter((c) => c.list === 'allow').map((c) => c.creator));
  const linked = (await linkedCreators(id)).filter((other) => !allowed.has(other));
  for (const other of linked) setAiFilterCreator(guildId, other, 'block');
  return interaction.editReply(
    `✅ 已封鎖 \`${id}\`：作者頁與能查到作者的作品連結都會被處理。` +
    (linked.length ? `\n一併封鎖簡介連到的：${linked.map((c) => `\`${c}\``).join('、')}（各自可用 \`remove\` 移除）` : '')
  );
}

function keyword(interaction, guildId) {
  const action = interaction.options.getString('action');
  const value = interaction.options.getString('value')?.trim().replace(/^[#＃]/, '');

  if (action === 'list') {
    return reply(interaction, listAiFilterKeywords(guildId).map((k) => `\`${k}\``).join('、') || '清單是空的。');
  }
  if (!value) return reply(interaction, '⚠️ 要填 `value`，例如 `AIイラスト`。');
  if (action === 'add') {
    return reply(interaction, addAiFilterKeyword(guildId, value) ? `✅ 已新增 \`${value}\`。` : `\`${value}\` 已經在清單裡了。`);
  }
  return reply(interaction, removeAiFilterKeyword(guildId, value) ? `✅ 已移除 \`${value}\`。` : `清單裡沒有 \`${value}\`。`);
}

async function check(interaction, guildId) {
  const text = interaction.options.getString('text');
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const { hit, results } = await evaluateText(guildId, text);
  if (results.length === 0) return interaction.editReply('這段文字沒有 AI tag，也沒有可判定的 pixiv／X 連結。');

  const lines = results.map((r) => {
    let icon = '✅ 未命中';
    if (r.hit) icon = '🚫 命中';
    else if (r.suspect) icon = '🔍 疑似（不刪，只發到紀錄頻道）';
    else if (r.unknown) icon = '❓ 無法判定（放行）';
    const who = r.creator ? `　創作者：\`${r.creator}\`` : '';
    return `${icon}　\`${r.source}\`${who}${r.reason ? `\n　${r.reason}` : ''}`;
  });
  lines.push(hit ? '→ 貼在過濾頻道會被處理。' : '→ 貼在過濾頻道不會被處理。');
  const content = lines.join('\n');
  return interaction.editReply(content.length > 1900 ? `${content.slice(0, 1900)}\n…（略）` : content);
}

function reply(interaction, content) {
  return interaction.reply({ content, flags: MessageFlags.Ephemeral });
}
