import {
  SlashCommandBuilder, PermissionFlagsBits, MessageFlags, EmbedBuilder, ChannelType,
} from 'discord.js';
import {
  listDupeZones, getDupeZone, ensureDupeZone, updateDupeZone, removeDupeZone,
  setDupeZoneChannel, removeDupeZoneChannel, clearDupeZoneLinks,
  findDupeLinkAnyZone, forgetDupeLink,
  listDupeIgnoredDomains, addDupeIgnoredDomain, removeDupeIgnoredDomain,
} from '../lib/db.js';
import {
  dupeStats, normalizeUrl, scanZone, sweepZone, expandZoneChannels, SWEEP_DELETE_CAP,
  DEFAULT_DELETE_MESSAGE, renderEmojis,
} from '../lib/dupe.js';
import { num } from '../lib/format.js';
import { withResolvableMentions } from '../lib/mentions.js';

const ACTION_LABEL = { delete: '刪除重複訊息', warn: '只提示不刪', off: '停用' };

export const data = new SlashCommandBuilder()
  .setName('dupe')
  .setDescription('分區連結去重：同一區貼過的連結再貼就刪掉')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .addSubcommand((s) => s
    .setName('watch').setDescription('把頻道或分類納入某一區（區不存在就會建立）')
    .addStringOption((o) => o.setName('zone')
      .setDescription('分區名稱，例如：深水區').setAutocomplete(true).setRequired(true))
    .addChannelOption((o) => o.setName('channel')
      .setDescription('要監看的頻道，或整個分類')
      .addChannelTypes(
        ChannelType.GuildText, ChannelType.GuildAnnouncement,
        ChannelType.GuildForum, ChannelType.GuildMedia, ChannelType.GuildCategory,
      ).setRequired(true)))
  .addSubcommand((s) => s
    .setName('unwatch').setDescription('把頻道或分類移出監看（紀錄保留）')
    .addChannelOption((o) => o.setName('channel').setDescription('頻道或分類').setRequired(true)))
  .addSubcommand((s) => s
    .setName('view').setDescription('看目前的分區、監看頻道與紀錄筆數'))
  .addSubcommand((s) => s
    .setName('mode').setDescription('改某一區要刪還是只提示')
    .addStringOption((o) => o.setName('zone').setDescription('分區').setAutocomplete(true).setRequired(true))
    .addStringOption((o) => o.setName('action').setDescription('遇到重複連結怎麼做').setRequired(true)
      .addChoices(
        { name: '刪除重複訊息（預設）', value: 'delete' },
        { name: '只提示不刪', value: 'warn' },
        { name: '停用這一區', value: 'off' },
      ))
    .addIntegerOption((o) => o.setName('notice-seconds')
      .setDescription('提示模式的提示幾秒後自刪，預設 20；0 = 不提示。刪除模式見 delete-notice')
      .setMinValue(0).setMaxValue(300)))
  .addSubcommand((s) => s
    .setName('delete-notice').setDescription('刪掉重複時要不要 @ 當事人，可附伺服器貼圖')
    .addStringOption((o) => o.setName('zone').setDescription('分區').setAutocomplete(true).setRequired(true))
    .addBooleanOption((o) => o.setName('enabled').setDescription('true = 刪除時 @ 當事人；false = 靜默刪除').setRequired(true))
    .addStringOption((o) => o.setName('sticker')
      .setDescription('一起貼出的伺服器貼圖；留空沿用目前設定').setAutocomplete(true))
    .addStringOption((o) => o.setName('message')
      .setDescription('接在 @ 後面的台詞，:表情名稱: 會換成伺服器表情；留空沿用，填 default 恢復預設')
      .setMaxLength(200)))
  .addSubcommand((s) => s
    .setName('scan').setDescription('把這一區的歷史訊息補進紀錄（只記錄，不刪訊息）')
    .addStringOption((o) => o.setName('zone').setDescription('分區').setAutocomplete(true).setRequired(true))
    .addIntegerOption((o) => o.setName('per-channel')
      .setDescription('每個頻道往回掃幾則，預設 500').setMinValue(50).setMaxValue(5000)))
  .addSubcommand((s) => s
    .setName('purge').setDescription('清掉歷史上已經重複的訊息（留最早那則）。不加 confirm 只預覽')
    .addStringOption((o) => o.setName('zone').setDescription('分區').setAutocomplete(true).setRequired(true))
    .addIntegerOption((o) => o.setName('per-channel')
      .setDescription('每個頻道往回掃幾則，預設 500').setMinValue(50).setMaxValue(5000))
    .addBooleanOption((o) => o.setName('confirm')
      .setDescription('true = 真的刪；留空＝只看會刪哪些')))
  .addSubcommand((s) => s
    .setName('check').setDescription('查一條連結是不是已經被記下來了')
    .addStringOption((o) => o.setName('link').setDescription('網址').setRequired(true)))
  .addSubcommand((s) => s
    .setName('forget').setDescription('放掉一條連結的紀錄，之後可以再貼')
    .addStringOption((o) => o.setName('link').setDescription('網址').setRequired(true))
    .addStringOption((o) => o.setName('zone')
      .setDescription('只放掉這一區，留空＝所有區').setAutocomplete(true)))
  .addSubcommand((s) => s
    .setName('clear').setDescription('清掉某一區所有連結紀錄（分區與監看頻道留著）')
    .addStringOption((o) => o.setName('zone').setDescription('分區').setAutocomplete(true).setRequired(true))
    .addBooleanOption((o) => o.setName('confirm').setDescription('確認要清掉').setRequired(true)))
  .addSubcommand((s) => s
    .setName('remove-zone').setDescription('刪掉整個分區（監看頻道與紀錄一起清）')
    .addStringOption((o) => o.setName('zone').setDescription('分區').setAutocomplete(true).setRequired(true))
    .addBooleanOption((o) => o.setName('confirm').setDescription('確認要刪').setRequired(true)))
  .addSubcommand((s) => s
    .setName('ignore-domain').setDescription('不列入去重的網域（反應圖站之類的）')
    .addStringOption((o) => o.setName('action').setDescription('做什麼').setRequired(true).addChoices(
      { name: '看清單', value: 'list' },
      { name: '新增', value: 'add' },
      { name: '移除', value: 'remove' },
    ))
    .addStringOption((o) => o.setName('domain').setDescription('例如 tenor.com')));

const NO_STICKER = 'none';

/** zone 選項列出已經存在的分區；sticker 選項列出這個伺服器的貼圖 */
export async function autocomplete(interaction) {
  const focused = interaction.options.getFocused(true);
  const typed = String(focused.value ?? '').toLowerCase();
  if (focused.name === 'sticker') {
    const stickers = await interaction.guild.stickers.fetch().catch(() => null);
    const choices = [...(stickers?.values() ?? [])]
      .filter((s) => !typed || s.name.toLowerCase().includes(typed))
      .slice(0, 24)
      .map((s) => ({ name: s.description ? `${s.name} — ${s.description}`.slice(0, 100) : s.name, value: s.id }));
    return interaction.respond([{ name: '（不附貼圖，只 @ 人）', value: NO_STICKER }, ...choices]);
  }
  const choices = listDupeZones(interaction.guildId)
    .filter((z) => !typed || z.zone.toLowerCase().includes(typed))
    .slice(0, 25)
    .map((z) => ({ name: `${z.zone}（${z.linkCount} 條）`.slice(0, 100), value: z.zone }));
  return interaction.respond(choices);
}

export async function execute(interaction) {
  const guildId = interaction.guildId;

  switch (interaction.options.getSubcommand()) {
    case 'watch': return watch(interaction, guildId);
    case 'unwatch': return unwatch(interaction, guildId);
    case 'view': return view(interaction, guildId);
    case 'mode': return mode(interaction, guildId);
    case 'delete-notice': return deleteNotice(interaction, guildId);
    case 'scan': return scan(interaction, guildId);
    case 'purge': return purge(interaction, guildId);
    case 'check': return check(interaction, guildId);
    case 'forget': return forget(interaction, guildId);
    case 'clear': return clear(interaction, guildId);
    case 'remove-zone': return removeZone(interaction, guildId);
    case 'ignore-domain': return ignoreDomain(interaction, guildId);
    default: return reply(interaction, '未知的子指令。');
  }
}

function watch(interaction, guildId) {
  const zoneName = interaction.options.getString('zone').trim().slice(0, 50);
  const channel = interaction.options.getChannel('channel');
  if (!zoneName) return reply(interaction, '⚠️ 分區名稱不能是空的。');

  const created = !getDupeZone(guildId, zoneName);
  const zone = ensureDupeZone(guildId, zoneName);
  const before = setDupeZoneChannel(guildId, channel.id, zoneName);

  const isCategory = channel.type === ChannelType.GuildCategory;
  const lines = [
    `✅ ${isCategory ? `分類 **${channel.name}** 底下所有頻道` : `<#${channel.id}>`} 已納入 **${zoneName}**。`,
  ];
  if (created) lines.push(`（新建分區，模式：${ACTION_LABEL[zone.action]}，刪掉就不吭聲、不通知當事人）`);
  if (before && before !== zoneName) lines.push(`⚠️ 這個頻道原本屬於 **${before}**，已改到 **${zoneName}**。`);
  if (before === zoneName) lines.push('（本來就在這一區了）');

  const me = interaction.guild.members.me;
  const perms = me ? channel.permissionsFor(me) : null;
  if (zone.action === 'delete' && perms && !perms.has(PermissionFlagsBits.ManageMessages)) {
    lines.push('⚠️ Bot 在這裡沒有**管理訊息**權限，刪不掉訊息（只會提示）。到伺服器設定把這個權限給 Bot 的角色。');
  }
  lines.push('接下來可以用 `/dupe scan` 把既有的歷史連結補進紀錄。');
  return reply(interaction, lines.join('\n'));
}

function unwatch(interaction, guildId) {
  const channel = interaction.options.getChannel('channel');
  const zone = removeDupeZoneChannel(guildId, channel.id);
  return reply(interaction, zone
    ? `✅ <#${channel.id}> 已移出 **${zone}**（紀錄還留著，要清用 \`/dupe clear\`）。`
    : `<#${channel.id}> 本來就沒在監看。`);
}

function view(interaction, guildId) {
  const zones = listDupeZones(guildId);
  if (zones.length === 0) {
    return reply(interaction, [
      '還沒有任何分區。範例：',
      '```',
      '/dupe watch zone:深水區 channel:#深水區',
      '/dupe watch zone:淺水區 channel:#淺水區',
      '```',
      '每一區各自獨立：同一條連結在深水區貼過，淺水區還是能貼。',
    ].join('\n'));
  }

  const ignored = listDupeIgnoredDomains(guildId);
  const lines = zones.map((z) => {
    const channels = z.channelIds.length
      ? z.channelIds.map((id) => `<#${id}>`).join('、')
      : '⚠️ 沒有監看任何頻道';
    const notice = z.action === 'delete'
      ? (z.delete_ping ? `、刪除時 @ 當事人${z.delete_sticker_id ? '＋貼圖' : ''}` : '、靜默刪除（刪不掉時才提示）')
      : z.action === 'warn' ? `、提示 ${z.notice_seconds ? `${z.notice_seconds}s 後自刪` : '關閉'}` : '';
    return `**${z.zone}** — ${ACTION_LABEL[z.action]}${notice}\n` +
      `　監看：${channels}\n　已記 ${num(z.linkCount)} 條連結`;
  });

  const embed = new EmbedBuilder()
    .setTitle('🔁 分區連結去重')
    .setColor(0x1abc9c)
    .setDescription(lines.join('\n\n'))
    .addFields({ name: '不列入去重的網域', value: ignored.length ? ignored.map((d) => `\`${d}\``).join('、') : '（無）' })
    .setFooter({ text: `本次啟動以來：新記 ${num(dupeStats.recorded)} · 攔到重複 ${num(dupeStats.duplicates)} · 刪除 ${num(dupeStats.deleted)} · 連帶預覽 ${num(dupeStats.previews)} · 失敗 ${num(dupeStats.failed)}` });
  return interaction.reply({ ...withResolvableMentions({ embeds: [embed] }), flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
}

function mode(interaction, guildId) {
  const zoneName = interaction.options.getString('zone');
  if (!getDupeZone(guildId, zoneName)) return reply(interaction, `找不到分區 **${zoneName}**。`);
  const action = interaction.options.getString('action');
  const noticeSeconds = interaction.options.getInteger('notice-seconds');

  const zone = updateDupeZone(guildId, zoneName, {
    action,
    noticeSeconds: noticeSeconds ?? undefined,
  });
  return reply(interaction, [
    `✅ **${zone.zone}**：${ACTION_LABEL[zone.action]}`,
    zone.action === 'delete'
      ? (zone.delete_ping
        ? '刪除時會 @ 當事人（用 `/dupe delete-notice` 調整）。'
        : '刪除時不發任何提示，也不通知當事人（Bot 刪不掉時才會講一句）。')
      : `提示訊息：${zone.notice_seconds ? `${zone.notice_seconds} 秒後自動刪掉` : '不發提示'}`,
  ].join('\n'));
}

async function deleteNotice(interaction, guildId) {
  const zoneName = interaction.options.getString('zone');
  if (!getDupeZone(guildId, zoneName)) return reply(interaction, `找不到分區 **${zoneName}**。`);
  const enabled = interaction.options.getBoolean('enabled');
  const input = interaction.options.getString('sticker')?.trim();
  const messageInput = interaction.options.getString('message')?.trim();
  const deleteMessage = !messageInput ? undefined : messageInput.toLowerCase() === 'default' ? null : messageInput;

  let deleteStickerId;
  let sticker = null;
  if (input === NO_STICKER) {
    deleteStickerId = null;
  } else if (input) {
    const stickers = await interaction.guild.stickers.fetch().catch(() => null);
    sticker = stickers?.get(input)
      ?? [...(stickers?.values() ?? [])].find((s) => s.name.toLowerCase() === input.toLowerCase());
    if (!sticker) return reply(interaction, `⚠️ 這個伺服器找不到貼圖「${input}」。請從自動完成清單選。`);
    deleteStickerId = sticker.id;
  }

  const zone = updateDupeZone(guildId, zoneName, { deletePing: enabled, deleteStickerId, deleteMessage });
  if (!zone.delete_ping) {
    return reply(interaction, `✅ **${zone.zone}**：刪除重複時靜默刪除，不 @ 當事人。`);
  }
  if (!sticker && zone.delete_sticker_id) {
    const stickers = await interaction.guild.stickers.fetch().catch(() => null);
    sticker = stickers?.get(zone.delete_sticker_id) ?? null;
  }
  const lines = [
    `✅ **${zone.zone}**：刪除重複時會 @ 當事人${zone.delete_sticker_id ? `，並貼出 **${sticker?.name ?? zone.delete_sticker_id}**` : '（純文字）'}。`,
  ];
  const line = renderEmojis(zone.delete_message ?? DEFAULT_DELETE_MESSAGE, interaction.guild);
  lines.push(`台詞：@當事人 ${line}`);
  const missing = [...line.matchAll(/(?<!<a?):([\w~]{2,32}):/g)].map((m) => m[0]);
  if (missing.length) lines.push(`⚠️ 這個伺服器找不到表情 ${missing.join(' ')}，會照原樣以文字送出。`);
  if (zone.delete_sticker_id && !sticker) lines.push('⚠️ 這張貼圖已經不在了，會只發台詞。');
  if (zone.action !== 'delete') lines.push(`（這一區目前是「${ACTION_LABEL[zone.action]}」，要改成刪除模式才會用到）`);
  return reply(interaction, lines.join('\n'));
}

async function scan(interaction, guildId) {
  const zoneName = interaction.options.getString('zone');
  const zones = listDupeZones(guildId);
  const zone = zones.find((z) => z.zone === zoneName);
  if (!zone) return reply(interaction, `找不到分區 **${zoneName}**。`);
  if (zone.channelIds.length === 0) return reply(interaction, `**${zoneName}** 還沒有監看任何頻道。`);

  const perChannel = interaction.options.getInteger('per-channel') ?? 500;
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const channels = await expandZoneChannels(interaction.guild, zone.channelIds);
  await interaction.editReply(`⏳ 正在掃 ${channels.length} 個頻道／討論串，每個最多 ${num(perChannel)} 則…`);

  const stats = await scanZone(interaction.guild, zone, { perChannel });
  const lines = [
    `✅ **${zoneName}** 補掃完成`,
    `頻道／討論串：${stats.channels} 個 · 讀了 ${num(stats.messages)} 則訊息`,
    `找到 ${num(stats.links)} 條連結 → 新記 ${num(stats.recorded)} 條（其餘是同一條重複出現）`,
  ];
  if (stats.skipped.length) lines.push(`⚠️ 跳過（Bot 看不到或不能讀歷史）：${stats.skipped.join('、')}`);
  lines.push('補掃只寫紀錄，不會刪任何既有訊息。');
  return interaction.editReply(lines.join('\n'));
}

async function purge(interaction, guildId) {
  const zoneName = interaction.options.getString('zone');
  const zone = listDupeZones(guildId).find((z) => z.zone === zoneName);
  if (!zone) return reply(interaction, `找不到分區 **${zoneName}**。`);
  if (zone.channelIds.length === 0) return reply(interaction, `**${zoneName}** 還沒有監看任何頻道。`);

  const perChannel = interaction.options.getInteger('per-channel') ?? 500;
  const confirmed = interaction.options.getBoolean('confirm') === true;
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const channels = await expandZoneChannels(interaction.guild, zone.channelIds);
  await interaction.editReply(
    `${confirmed ? '🧹 正在清理' : '🔍 正在預覽'} **${zoneName}**：${channels.length} 個頻道／討論串，每個最多 ${num(perChannel)} 則…`
  );

  const { stats, plan } = await sweepZone(interaction.guild, zone, {
    perChannel,
    record: confirmed,
    deleteDupes: confirmed,
    onProgress: confirmed
      ? (st) => interaction.editReply(`🧹 **${zoneName}** 清理中…已刪 ${num(st.deleted)} 則`).catch(() => {})
      : null,
  });

  const examples = plan.slice(0, 8).map((p) =>
    `· <#${p.channelId}> <@${p.userId}> <t:${Math.floor(p.postedAt / 1000)}:d>　\`${p.norm}\`\n` +
    `　重複的：https://discord.com/channels/${guildId}/${p.channelId}/${p.messageId}\n` +
    `　留下的：https://discord.com/channels/${guildId}/${p.original.channelId}/${p.original.messageId}`);

  const lines = [
    `${confirmed ? '✅' : '🔍'} **${zoneName}** ${confirmed ? '清理完成' : '預覽（什麼都還沒動）'}`,
    `讀了 ${stats.channels} 個頻道／討論串、${num(stats.messages)} 則訊息、${num(stats.links)} 條連結`,
    `找到 ${num(stats.duplicates)} 則重複訊息` + (confirmed ? `　→ 已刪 ${num(stats.deleted)} 則` : ''),
  ];
  if (stats.previews > 0) lines.push(`🖼️ 連帶刪掉 ${num(stats.previews)} 則預覽 Bot 的訊息。`);
  if (stats.pinned > 0) lines.push(`📌 ${stats.pinned} 則是釘選訊息，一律不動。`);
  if (stats.failed > 0) lines.push(`⚠️ ${stats.failed} 則刪除失敗（看 log）。`);
  if (stats.capped) lines.push(`⚠️ 單次上限 ${SWEEP_DELETE_CAP} 則，已達上限 → 再跑一次把剩下的清完。`);
  if (stats.noPermission.length) lines.push(`⚠️ 這些頻道 Bot 沒有管理訊息權限，刪不掉：${stats.noPermission.join('、')}`);
  if (stats.skipped.length) lines.push(`⚠️ 跳過（看不到或不能讀歷史）：${stats.skipped.join('、')}`);
  if (examples.length) {
    lines.push(confirmed ? '刪掉的前幾則：' : '會刪掉的前幾則：', ...examples);
    if (plan.length > examples.length) lines.push(`…另外還有 ${num(plan.length - examples.length)} 則。`);
  }
  if (!confirmed && plan.length > 0) {
    lines.push('', `要真的刪就加 \`confirm:true\`：\`/dupe purge zone:${zoneName} per-channel:${perChannel} confirm:true\``);
  }
  if (confirmed) lines.push('（每條連結留的是**最早**那則；釘選訊息不動。刪掉的訊息救不回來。）');

  const content = lines.join('\n');
  return interaction.editReply(content.length > 1900 ? `${content.slice(0, 1900)}\n…（略）` : content);
}

function check(interaction, guildId) {
  const raw = interaction.options.getString('link').trim();
  const norm = normalizeUrl(raw);
  if (!norm) return reply(interaction, '⚠️ 這看起來不是網址。');

  const rows = findDupeLinkAnyZone(guildId, norm);
  const head = `比對用的鑰匙：\`${norm}\``;
  if (rows.length === 0) return reply(interaction, `${head}\n還沒有紀錄，現在貼不會被擋。`);

  const lines = rows.map((r) =>
    `**${r.zone}** — <@${r.user_id}> 於 <t:${Math.floor(r.posted_at / 1000)}:f>\n` +
    `　https://discord.com/channels/${guildId}/${r.channel_id}/${r.message_id}`);
  return reply(interaction, [head, '已經有紀錄：', ...lines].join('\n'));
}

function forget(interaction, guildId) {
  const raw = interaction.options.getString('link').trim();
  const zoneName = interaction.options.getString('zone');
  const norm = normalizeUrl(raw);
  if (!norm) return reply(interaction, '⚠️ 這看起來不是網址。');

  const removed = forgetDupeLink(guildId, norm, zoneName || null);
  return reply(interaction, removed > 0
    ? `✅ 已放掉 ${removed} 筆紀錄（\`${norm}\`${zoneName ? `，限 **${zoneName}**` : ''}），這條連結可以再貼了。`
    : `找不到 \`${norm}\` 的紀錄。`);
}

function clear(interaction, guildId) {
  const zoneName = interaction.options.getString('zone');
  if (!getDupeZone(guildId, zoneName)) return reply(interaction, `找不到分區 **${zoneName}**。`);
  if (!interaction.options.getBoolean('confirm')) {
    return reply(interaction, '沒有確認，什麼都沒做。要清就把 `confirm` 設成 true。');
  }
  const n = clearDupeZoneLinks(guildId, zoneName);
  return reply(interaction, `✅ **${zoneName}** 的 ${num(n)} 筆連結紀錄已清空（分區與監看頻道留著）。`);
}

function removeZone(interaction, guildId) {
  const zoneName = interaction.options.getString('zone');
  if (!getDupeZone(guildId, zoneName)) return reply(interaction, `找不到分區 **${zoneName}**。`);
  if (!interaction.options.getBoolean('confirm')) {
    return reply(interaction, '沒有確認，什麼都沒做。要刪就把 `confirm` 設成 true。');
  }
  const { channels, links } = removeDupeZone(guildId, zoneName);
  return reply(interaction, `✅ 分區 **${zoneName}** 已刪除（${channels} 個監看頻道、${num(links)} 筆紀錄）。`);
}

function ignoreDomain(interaction, guildId) {
  const action = interaction.options.getString('action');
  const domain = interaction.options.getString('domain')?.trim().toLowerCase()
    .replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '');

  if (action === 'list') {
    const list = listDupeIgnoredDomains(guildId);
    return reply(interaction, list.length
      ? `不列入去重的網域：${list.map((d) => `\`${d}\``).join('、')}`
      : '目前沒有忽略任何網域。');
  }
  if (!domain) return reply(interaction, '⚠️ 要填 `domain`，例如 `tenor.com`。');

  if (action === 'add') {
    return reply(interaction, addDupeIgnoredDomain(guildId, domain)
      ? `✅ \`${domain}\`（含子網域）不再列入去重。`
      : `\`${domain}\` 已經在清單裡了。`);
  }
  return reply(interaction, removeDupeIgnoredDomain(guildId, domain)
    ? `✅ \`${domain}\` 已從忽略清單移除，之後會列入去重。`
    : `清單裡沒有 \`${domain}\`。`);
}

function reply(interaction, content) {
  return interaction.reply({ content, flags: MessageFlags.Ephemeral });
}
