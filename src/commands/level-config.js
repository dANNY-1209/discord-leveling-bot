import {
  SlashCommandBuilder, PermissionFlagsBits, MessageFlags, EmbedBuilder, ChannelType,
} from 'discord.js';
import {
  getSettings, updateSettings,
  listRewards, addReward, removeReward,
  listIgnoredChannels, addIgnoredChannel, removeIgnoredChannel,
  listIgnoredRoles, addIgnoredRole, removeIgnoredRole,
  listIgnoredUsers, addIgnoredUser, removeIgnoredUser, isIgnoredUser, resetMember, getMember,
  listMediaChannels, addMediaChannel, removeMediaChannel,
  listLinkDomains, addLinkDomain, removeLinkDomain, DEFAULT_LINK_DOMAINS, countReactionAwards,
} from '../lib/db.js';
import { num } from '../lib/format.js';
import { stats, pendingSize } from '../lib/xp.js';
import { withResolvableMentions } from '../lib/mentions.js';

const IGNORABLE_CHANNELS = [
  ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.GuildForum,
  ChannelType.GuildVoice, ChannelType.GuildCategory,
];

const ADD_REMOVE = [{ name: '新增 (add)', value: 'add' }, { name: '移除 (remove)', value: 'remove' }];

export const data = new SlashCommandBuilder()
  .setName('level-config')
  .setDescription('等級系統設定')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .addSubcommand((s) => s.setName('view').setDescription('顯示目前所有設定'))
  .addSubcommand((s) => s
    .setName('toggle').setDescription('開啟／關閉整個等級系統')
    .addBooleanOption((o) => o.setName('enabled').setDescription('true = 開啟').setRequired(true)))
  .addSubcommand((s) => s
    .setName('announce').setDescription('升級公告設定')
    .addStringOption((o) => o.setName('mode').setDescription('公告方式').addChoices(
      { name: '關閉', value: 'off' },
      { name: '發在當前頻道', value: 'current' },
      { name: '發到指定頻道', value: 'channel' },
      { name: '私訊本人', value: 'dm' },
    ))
    .addChannelOption((o) => o.setName('channel').setDescription('指定頻道（mode=channel 時使用）')
      .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement))
    .addStringOption((o) => o.setName('message')
      .setDescription('文案，可用 {user} {username} {level} {old_level} {xp} {rank}')))
  .addSubcommand((s) => s
    .setName('xp-rate').setDescription('全域 XP 倍率（預設 1.0）')
    .addNumberOption((o) => o.setName('value').setDescription('0.25 ~ 3.0')
      .setMinValue(0.25).setMaxValue(3).setRequired(true)))
  .addSubcommand((s) => s
    .setName('cooldown').setDescription('同一人的發 XP 冷卻秒數（預設 60）')
    .addIntegerOption((o) => o.setName('seconds').setDescription('0 ~ 3600')
      .setMinValue(0).setMaxValue(3600).setRequired(true)))
  .addSubcommand((s) => s
    .setName('xp-range').setDescription('每則有效訊息的 XP 區間（預設 15 25）')
    .addIntegerOption((o) => o.setName('min').setDescription('最小值').setMinValue(1).setMaxValue(1000).setRequired(true))
    .addIntegerOption((o) => o.setName('max').setDescription('最大值').setMinValue(1).setMaxValue(1000).setRequired(true)))
  .addSubcommand((s) => s
    .setName('min-length').setDescription('最短字數（正規化後計字），預設 5；0 = 不限制')
    .addIntegerOption((o) => o.setName('value').setDescription('0 ~ 100').setMinValue(0).setMaxValue(100).setRequired(true)))
  .addSubcommand((s) => s
    .setName('ignore-channel').setDescription('No-XP 頻道（選分類則整個分類都不給）')
    .addStringOption((o) => o.setName('action').setDescription('新增或移除').addChoices(...ADD_REMOVE).setRequired(true))
    .addChannelOption((o) => o.setName('channel').setDescription('頻道或分類')
      .addChannelTypes(...IGNORABLE_CHANNELS).setRequired(true)))
  .addSubcommand((s) => s
    .setName('ignore-role').setDescription('No-XP 角色')
    .addStringOption((o) => o.setName('action').setDescription('新增或移除').addChoices(...ADD_REMOVE).setRequired(true))
    .addRoleOption((o) => o.setName('role').setDescription('角色').setRequired(true)))
  .addSubcommand((s) => s
    .setName('ignore-user').setDescription('把個別成員排除在等級系統外（不累積 XP、不上排行榜）')
    .addStringOption((o) => o.setName('action').setDescription('新增或移除').addChoices(...ADD_REMOVE).setRequired(true))
    .addUserOption((o) => o.setName('user').setDescription('成員').setRequired(true))
    .addBooleanOption((o) => o.setName('purge').setDescription('加入時是否一併清掉他現有的 XP（預設不清）')))
  .addSubcommand((s) => s
    .setName('reward-add').setDescription('新增等級角色獎勵')
    .addIntegerOption((o) => o.setName('level').setDescription('達到幾級').setMinValue(1).setMaxValue(500).setRequired(true))
    .addRoleOption((o) => o.setName('role').setDescription('要給的角色').setRequired(true)))
  .addSubcommand((s) => s
    .setName('reward-remove').setDescription('刪除某一級的角色獎勵')
    .addIntegerOption((o) => o.setName('level').setDescription('等級').setMinValue(1).setMaxValue(500).setRequired(true)))
  .addSubcommand((s) => s
    .setName('defer').setDescription('延遲入帳秒數（防「發完就刪」刷分），預設 20')
    .addIntegerOption((o) => o.setName('seconds').setDescription('0 = 關閉延遲；建議 15~30')
      .setMinValue(0).setMaxValue(60).setRequired(true)))
  .addSubcommand((s) => s
    .setName('duplicates').setDescription('重複內容要不要給 XP，預設不給')
    .addBooleanOption((o) => o.setName('ignore').setDescription('true = 跟上次相同的內容不給 XP').setRequired(true)))
  .addSubcommand((s) => s
    .setName('member-age').setDescription('新成員進服多久後才開始給 XP，預設 15 分鐘')
    .addIntegerOption((o) => o.setName('minutes').setDescription('0 = 不限制')
      .setMinValue(0).setMaxValue(1440).setRequired(true)))
  .addSubcommand((s) => s
    .setName('sticker-emoji').setDescription('純貼圖／純 emoji 要不要給 XP，預設不給')
    .addBooleanOption((o) => o.setName('ignore').setDescription('true = 純貼圖／純 emoji 不給 XP').setRequired(true)))
  .addSubcommand((s) => s
    .setName('media-channel').setDescription('指定頻道發圖／影片給額外 XP')
    .addStringOption((o) => o.setName('action').setDescription('新增或移除').addChoices(...ADD_REMOVE).setRequired(true))
    .addChannelOption((o) => o.setName('channel').setDescription('頻道')
      .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.GuildForum).setRequired(true))
    .addIntegerOption((o) => o.setName('bonus').setDescription('此頻道的加成 XP；留空則用全域預設')
      .setMinValue(1).setMaxValue(500)))
  .addSubcommand((s) => s
    .setName('media-bonus').setDescription('媒體加成的全域預設 XP，預設 20')
    .addIntegerOption((o) => o.setName('value').setDescription('1 ~ 500')
      .setMinValue(1).setMaxValue(500).setRequired(true)))
  .addSubcommand((s) => s
    .setName('link-bonus').setDescription('貼指定站台連結的加成（有自己的一條 CD），三個參數都可選填')
    .addIntegerOption((o) => o.setName('value').setDescription('加成 XP，預設 20').setMinValue(1).setMaxValue(500))
    .addNumberOption((o) => o.setName('cooldown-hours').setDescription('獨立 CD 小時數，預設 3；0 = 不另外限制')
      .setMinValue(0).setMaxValue(168))
    .addStringOption((o) => o.setName('scope').setDescription('哪些頻道算').addChoices(
      { name: '所有頻道（預設）', value: 'everywhere' },
      { name: '只有媒體加成頻道', value: 'media-channels' },
    )))
  .addSubcommand((s) => s
    .setName('link-domain').setDescription('管理算加成的網域白名單')
    .addStringOption((o) => o.setName('action').setDescription('新增或移除').addChoices(...ADD_REMOVE).setRequired(true))
    .addStringOption((o) => o.setName('domain').setDescription('例如 pixiv.net；貼整條網址也可以').setRequired(true)))
  .addSubcommand((s) => s
    .setName('reaction-xp').setDescription('按表情時，按的人與被按的人各得多少 XP（無冷卻）')
    .addIntegerOption((o) => o.setName('value').setDescription('每人幾 XP，預設 3；0 = 關閉')
      .setMinValue(0).setMaxValue(100))
    .addStringOption((o) => o.setName('dedup').setDescription('同一則訊息算幾次').addChoices(
      { name: '整則訊息只認第一個表符（預設）', value: 'message' },
      { name: '每個人在同一則各認一次', value: 'per-user' },
    )))
  .addSubcommand((s) => s
    .setName('reward-mode').setDescription('角色獎勵模式')
    .addStringOption((o) => o.setName('mode').setDescription('stack = 全部保留／replace = 只留最高階')
      .addChoices({ name: 'stack（勳章牆，全部保留）', value: 'stack' }, { name: 'replace（只留最高一階）', value: 'replace' })
      .setRequired(true)));

export async function execute(interaction) {
  const sub = interaction.options.getSubcommand();
  const guildId = interaction.guildId;

  switch (sub) {
    case 'view':
      return viewConfig(interaction);

    case 'toggle': {
      const enabled = interaction.options.getBoolean('enabled');
      updateSettings(guildId, { enabled: enabled ? 1 : 0 });
      return reply(interaction, enabled ? '✅ 等級系統已開啟。' : '⏸️ 等級系統已關閉，暫停發 XP。');
    }

    case 'announce': {
      const mode = interaction.options.getString('mode');
      const channel = interaction.options.getChannel('channel');
      const message = interaction.options.getString('message');
      if (!mode && !channel && !message) {
        return reply(interaction, '至少要指定 mode、channel 或 message 其中一項。');
      }
      const patch = {};
      if (mode) patch.announce_mode = mode;
      if (channel) patch.announce_channel_id = channel.id;
      if (message) patch.announce_message = message;
      if (mode === 'channel' && !channel && !getSettings(guildId).announce_channel_id) {
        return reply(interaction, '⚠️ mode=channel 需要同時指定 channel。');
      }
      const s = updateSettings(guildId, patch);
      return reply(interaction, `✅ 公告設定已更新：**${describeAnnounce(s)}**\n文案：${s.announce_message}`);
    }

    case 'xp-rate': {
      const value = interaction.options.getNumber('value');
      updateSettings(guildId, { xp_rate: value });
      return reply(interaction, `✅ XP 倍率設為 **${value}x**。`);
    }

    case 'cooldown': {
      const seconds = interaction.options.getInteger('seconds');
      updateSettings(guildId, { cooldown_ms: seconds * 1000 });
      return reply(interaction, `✅ 冷卻設為 **${seconds} 秒**（重啟前已在冷卻中的人不受影響）。`);
    }

    case 'xp-range': {
      const min = interaction.options.getInteger('min');
      const max = interaction.options.getInteger('max');
      if (min > max) return reply(interaction, '⚠️ min 不能大於 max。');
      updateSettings(guildId, { xp_min: min, xp_max: max });
      return reply(interaction, `✅ 每則有效訊息的 XP 設為 **${min} ~ ${max}**（MEE6 原始值是 15 ~ 25）。`);
    }

    case 'min-length': {
      const value = interaction.options.getInteger('value');
      updateSettings(guildId, { min_length: value });
      return reply(interaction, value === 0
        ? '✅ 已取消最短字數限制。'
        : `✅ 最短字數設為 **${value}** 字（去空白後計算）。`);
    }

    case 'ignore-channel': {
      const action = interaction.options.getString('action');
      const channel = interaction.options.getChannel('channel');
      if (action === 'add') addIgnoredChannel(guildId, channel.id);
      else removeIgnoredChannel(guildId, channel.id);
      const isCategory = channel.type === ChannelType.GuildCategory;
      return reply(interaction, `✅ ${action === 'add' ? '已排除' : '已恢復'} <#${channel.id}>` +
        (isCategory ? '（整個分類底下的頻道）' : '') + ' 的 XP。');
    }

    case 'ignore-role': {
      const action = interaction.options.getString('action');
      const role = interaction.options.getRole('role');
      if (action === 'add') addIgnoredRole(guildId, role.id);
      else removeIgnoredRole(guildId, role.id);
      return reply(interaction, `✅ ${action === 'add' ? '已排除' : '已恢復'} <@&${role.id}> 的 XP。`);
    }

    case 'ignore-user': {
      const action = interaction.options.getString('action');
      const user = interaction.options.getUser('user');
      const purge = interaction.options.getBoolean('purge') ?? false;
      if (user.bot) return reply(interaction, 'Bot 本來就不會累積 XP，不需要排除。');

      if (action === 'add') {
        const had = getMember(guildId, user.id).total_xp;
        addIgnoredUser(guildId, user.id);
        if (purge) resetMember(guildId, user.id);
        return reply(interaction, [
          `✅ <@${user.id}> 已排除在等級系統外。`,
          '此後：不累積 XP、不出現在 `/leaderboard`、不佔名次、`/sync-roles` 也不會動他的角色。',
          purge
            ? `現有 ${num(had)} XP 已一併清除。`
            : `現有 ${num(had)} XP 保留著（沒清除）；之後移除排除就會原樣回來。要清掉請加 \`purge:true\`。`,
          '已經發出去的等級角色不會自動收回，需要的話手動處理。',
        ].join('\n'));
      }

      if (!isIgnoredUser(guildId, user.id)) {
        return reply(interaction, `<@${user.id}> 本來就不在排除名單裡。`);
      }
      removeIgnoredUser(guildId, user.id);
      return reply(interaction,
        `✅ <@${user.id}> 已恢復，重新開始累積 XP 並回到排行榜（原有 ${num(getMember(guildId, user.id).total_xp)} XP）。`);
    }

    case 'reward-add': {
      const level = interaction.options.getInteger('level');
      const role = interaction.options.getRole('role');
      addReward(guildId, level, role.id);
      const warn = roleHierarchyWarning(interaction.guild, role);
      return reply(interaction, `✅ Lv.**${level}** → <@&${role.id}>${warn}`);
    }

    case 'reward-remove': {
      const level = interaction.options.getInteger('level');
      removeReward(guildId, level);
      return reply(interaction, `✅ 已刪除 Lv.${level} 的角色獎勵（已經發出去的角色不會自動收回）。`);
    }

    case 'defer': {
      const seconds = interaction.options.getInteger('seconds');
      updateSettings(guildId, { defer_seconds: seconds });
      return reply(interaction, seconds === 0
        ? '⚠️ 延遲入帳已關閉。訊息會當場入帳，「發完立刻刪」就能刷分了。'
        : `✅ 延遲入帳設為 **${seconds} 秒**。期間內把訊息刪掉就不會入帳；升級公告也會晚這麼久。`);
    }

    case 'duplicates': {
      const ignore = interaction.options.getBoolean('ignore');
      updateSettings(guildId, { ignore_duplicates: ignore ? 1 : 0 });
      return reply(interaction, ignore
        ? '✅ 跟自己上一次入帳內容相同的訊息不給 XP（只跟本人比，不跟全服比）。'
        : '⚠️ 已允許重複內容給 XP，複製貼上同一句就能穩拿。');
    }

    case 'member-age': {
      const minutes = interaction.options.getInteger('minutes');
      updateSettings(guildId, { min_member_age_minutes: minutes });
      return reply(interaction, minutes === 0
        ? '⚠️ 新成員緩衝已關閉，小號進服就能拿 XP。'
        : `✅ 進服未滿 **${minutes} 分鐘**不給 XP（看加入時間，不是帳號創立日）。`);
    }

    case 'sticker-emoji': {
      const ignore = interaction.options.getBoolean('ignore');
      updateSettings(guildId, { ignore_sticker_emoji: ignore ? 1 : 0 });
      return reply(interaction, ignore
        ? '✅ 純貼圖／純 emoji 不給 XP。'
        : '⚠️ 純貼圖／純 emoji 也會給 XP，零成本洗頻的門就開了。');
    }

    case 'media-channel': {
      const action = interaction.options.getString('action');
      const channel = interaction.options.getChannel('channel');
      const bonus = interaction.options.getInteger('bonus');
      if (action === 'add') {
        addMediaChannel(guildId, channel.id, bonus ?? null);
        const amount = bonus ?? getSettings(guildId).media_bonus_xp;
        const ignored = listIgnoredChannels(guildId).includes(channel.id);
        return reply(interaction,
          `✅ <#${channel.id}> 發圖／影片額外 **+${amount} XP**` +
          (bonus ? '（此頻道專屬）' : '（跟隨全域預設）') +
          '\n一則訊息最多加一次，只認本則自己的圖片／影片附件——外連、貼圖、引用別人的圖都不算。' +
          (ignored ? '\n⚠️ 這個頻道同時在 No-XP 名單裡，所以完全不會給 XP。要先移除排除才會生效。' : ''));
      }
      removeMediaChannel(guildId, channel.id);
      return reply(interaction, `✅ <#${channel.id}> 已取消媒體加成（基礎 XP 不受影響）。`);
    }

    case 'media-bonus': {
      const value = interaction.options.getInteger('value');
      updateSettings(guildId, { media_bonus_xp: value });
      const followers = listMediaChannels(guildId).filter((c) => c.bonus_xp === null).length;
      return reply(interaction,
        `✅ 媒體加成全域預設設為 **+${value} XP**` +
        (followers ? `，套用到 ${followers} 個沒設專屬值的頻道。` : '。'));
    }

    case 'link-bonus': {
      const value = interaction.options.getInteger('value');
      const hours = interaction.options.getNumber('cooldown-hours');
      const scope = interaction.options.getString('scope');
      if (value === null && hours === null && !scope) {
        return reply(interaction, '至少要指定 value、cooldown-hours 或 scope 其中一項。');
      }
      const patch = {};
      if (value !== null) patch.link_bonus_xp = value;
      if (hours !== null) patch.link_bonus_cooldown_ms = Math.round(hours * 3600 * 1000);
      if (scope) patch.link_bonus_scope = scope;
      const next = updateSettings(guildId, patch);
      return reply(interaction, [
        '✅ 連結加成已更新：',
        `加成 **+${next.link_bonus_xp} XP**`,
        `獨立 CD **${describeLinkCooldown(next)}**`,
        `範圍 **${next.link_bonus_scope === 'media-channels' ? '只有媒體加成頻道' : '所有頻道'}**`,
        `白名單：${listLinkDomains(guildId).map((d) => `\`${d}\``).join('、') || '（空，等於停用）'}`,
      ].join('\n'));
    }

    case 'link-domain': {
      const action = interaction.options.getString('action');
      const domain = normalizeDomain(interaction.options.getString('domain'));
      if (!domain) return reply(interaction, '⚠️ 看不出網域，請給類似 `pixiv.net` 的格式。');
      if (action === 'add') {
        addLinkDomain(guildId, domain);
        return reply(interaction, `✅ 已加入 \`${domain}\`。子網域會一起算（例如 \`www.${domain}\`）。\n` +
          `目前白名單：${listLinkDomains(guildId).map((d) => `\`${d}\``).join('、')}`);
      }
      removeLinkDomain(guildId, domain);
      const left = listLinkDomains(guildId);
      return reply(interaction, `✅ 已移除 \`${domain}\`。\n` +
        `目前白名單：${left.map((d) => `\`${d}\``).join('、') || '（空，連結加成等於停用）'}`);
    }

    case 'reaction-xp': {
      const value = interaction.options.getInteger('value');
      const dedup = interaction.options.getString('dedup');
      if (value === null && !dedup) {
        return reply(interaction, '至少要指定 value 或 dedup 其中一項。');
      }
      const patch = {};
      if (value !== null) patch.reaction_xp = value;
      if (dedup) patch.reaction_dedup = dedup;
      const next = updateSettings(guildId, patch);
      if (next.reaction_xp === 0) {
        return reply(interaction, '⏸️ 反應 XP 已關閉。');
      }
      return reply(interaction, [
        `✅ 反應 XP：按的人與被按的人**各 +${next.reaction_xp} XP**，無冷卻。`,
        next.reaction_dedup === 'per-user'
          ? '去重：**每個人在同一則訊息各認一次**（十個人按 → 作者拿十份）。'
          : '去重：**整則訊息只認第一個表符**（不論誰按，之後的都不給）。',
        '自己按自己不算；Bot 發的訊息不算；No-XP 頻道／角色／成員照樣排除。',
      ].join('\n'));
    }

    case 'reward-mode': {
      const mode = interaction.options.getString('mode');
      updateSettings(guildId, { reward_mode: mode });
      return reply(interaction, mode === 'stack'
        ? '✅ 改為 **stack**：到達過的獎勵角色都保留。'
        : '✅ 改為 **replace**：只保留目前最高一階（下次升級或 `/sync-roles` 時生效）。');
    }

    default:
      return reply(interaction, '未知的子指令。');
  }
}

function reply(interaction, content) {
  return interaction.reply({ content, flags: MessageFlags.Ephemeral });
}

/** 使用者可能直接貼整條網址，統一收成 host */
function normalizeDomain(raw) {
  let v = String(raw ?? '').trim().toLowerCase();
  v = v.replace(/^[a-z]+:\/\//, '').split(/[/?#]/)[0].replace(/^www\./, '');
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(v) ? v : null;
}

function describeLinkCooldown(s) {
  const ms = s.link_bonus_cooldown_ms;
  if (ms <= 0) return '不另外限制';
  const h = ms / 3600000;
  return h >= 1 ? `${Number.isInteger(h) ? h : h.toFixed(2)} 小時` : `${Math.round(ms / 60000)} 分鐘`;
}

function describeAnnounce(s) {
  switch (s.announce_mode) {
    case 'off': return '關閉';
    case 'current': return '發在當前頻道';
    case 'dm': return '私訊本人';
    case 'channel': return s.announce_channel_id ? `發到 <#${s.announce_channel_id}>` : '指定頻道（⚠️ 尚未設定）';
    default: return s.announce_mode;
  }
}

function roleHierarchyWarning(guild, role) {
  const me = guild.members.me;
  if (!me?.permissions.has(PermissionFlagsBits.ManageRoles)) {
    return '\n⚠️ Bot 沒有 **Manage Roles** 權限，這個獎勵發不出去。';
  }
  if (me.roles.highest.comparePositionTo(role) <= 0) {
    return `\n⚠️ Bot 的角色位置不高於 <@&${role.id}>，Discord 不允許指派。請到伺服器設定把 Bot 的角色往上拖。`;
  }
  return '';
}

async function viewConfig(interaction) {
  const guildId = interaction.guildId;
  const s = getSettings(guildId);
  const rewards = listRewards(guildId);
  const ignoredChannels = listIgnoredChannels(guildId);
  const ignoredRoles = listIgnoredRoles(guildId);
  const ignoredUsers = listIgnoredUsers(guildId);

  const mediaChannels = listMediaChannels(guildId);
  const mediaLines = mediaChannels.length
    ? [
        `全域預設 **+${s.media_bonus_xp} XP**`,
        ...mediaChannels.map((c) => {
          const amount = c.bonus_xp ?? s.media_bonus_xp;
          const own = c.bonus_xp !== null ? '（專屬）' : '';
          const warn = ignoredChannels.includes(c.channel_id) ? ' ⚠️ 同時在 No-XP 名單' : '';
          return `<#${c.channel_id}> → +${amount} XP${own}${warn}`;
        }),
      ].join('\n')
    : `（尚未設定；全域預設 +${s.media_bonus_xp} XP）`;

  const domains = listLinkDomains(guildId);
  const missingDefaults = DEFAULT_LINK_DOMAINS.filter((d) => !domains.includes(d));
  const linkLines = [
    domains.length
      ? `+**${s.link_bonus_xp} XP** · CD **${describeLinkCooldown(s)}** · 範圍 **${s.link_bonus_scope === 'media-channels' ? '僅媒體頻道' : '所有頻道'}**`
      : '⚠️ 白名單為空，連結加成等於停用',
    domains.length ? `白名單：${domains.map((d) => `\`${d}\``).join('、')}` : null,
    missingDefaults.length ? `（預設站台未啟用：${missingDefaults.join('、')}）` : null,
  ].filter(Boolean).join('\n');

  const reactionLines = s.reaction_xp > 0
    ? [
        `按的人與被按的人**各 +${s.reaction_xp} XP** · 無冷卻`,
        s.reaction_dedup === 'per-user'
          ? '去重：每人在同一則各一次'
          : '去重：整則只認第一個表符',
        `累計已發放紀錄 ${num(countReactionAwards(guildId))} 筆`,
      ].join('\n')
    : '⏸️ 已關閉';

  const rewardLines = rewards.length
    ? rewards.map((r) => {
        const role = interaction.guild.roles.cache.get(r.role_id);
        const bad = role ? roleHierarchyWarning(interaction.guild, role) : '\n⚠️ 角色已被刪除';
        return `Lv.${r.level} → <@&${r.role_id}>${bad ? ' ⚠️' : ''}`;
      }).join('\n')
    : '（尚未設定）';

  const problems = rewards
    .map((r) => {
      const role = interaction.guild.roles.cache.get(r.role_id);
      if (!role) return `Lv.${r.level} 的角色已被刪除`;
      const w = roleHierarchyWarning(interaction.guild, role);
      return w ? `Lv.${r.level}：${w.replace(/\n⚠️ /, '')}` : null;
    })
    .filter(Boolean);

  const embed = new EmbedBuilder()
    .setTitle(`⚙️ ${interaction.guild.name} 等級設定`)
    .setColor(s.enabled ? 0x2ecc71 : 0x95a5a6)
    .addFields(
      { name: '狀態', value: s.enabled ? '🟢 運作中' : '⏸️ 已關閉', inline: true },
      { name: 'XP 區間', value: `${s.xp_min} ~ ${s.xp_max}`, inline: true },
      { name: '倍率', value: `${s.xp_rate}x`, inline: true },
      { name: '冷卻', value: `${Math.round(s.cooldown_ms / 1000)} 秒`, inline: true },
      { name: '獎勵模式', value: s.reward_mode, inline: true },
      {
        name: '🛡️ 防刷（第 17 節）',
        value: [
          `延遲入帳：**${s.defer_seconds ? `${s.defer_seconds} 秒` : '關閉 ⚠️'}**`,
          `最短字數：**${s.min_length ? `${s.min_length} 字` : '不限 ⚠️'}**`,
          `重複內容：**${s.ignore_duplicates ? '不給 XP' : '給 ⚠️'}**`,
          `純貼圖／emoji：**${s.ignore_sticker_emoji ? '不給 XP' : '給 ⚠️'}**`,
          `新成員緩衝：**${s.min_member_age_minutes ? `${s.min_member_age_minutes} 分鐘` : '關閉 ⚠️'}**`,
          `同時排隊上限：**${s.max_pending_per_user}** 則／人`,
        ].join('\n'),
      },
      {
        name: '📊 本次啟動以來',
        value: [
          `入帳 **${num(stats.granted)}** 次 · 排隊中 **${pendingSize()}** 則`,
          `因刪訊取消 **${num(stats.cancelledByDelete)}** · 重複忽略 **${num(stats.skippedDuplicate)}**`,
          `太短 **${num(stats.skippedTooShort)}** · 純貼圖 **${num(stats.skippedNoText)}** · 新成員 **${num(stats.skippedNewMember)}**`,
          `冷卻中 **${num(stats.skippedCooldown)}** · 已有排隊 **${num(stats.skippedPendingBusy)}** · 已排除成員 **${num(stats.skippedIgnoredUser)}**`,
          `媒體加成發出 **${num(stats.mediaBonusGranted)}** 次（共 ${num(stats.mediaBonusXp)} XP）`,
          `連結加成發出 **${num(stats.linkBonusGranted)}** 次（共 ${num(stats.linkBonusXp)} XP）· 因 CD 未給 **${num(stats.linkBonusOnCooldown)}**`,
          `反應 XP 發出 **${num(stats.reactionGranted)}** 份（共 ${num(stats.reactionXp)} XP）· 重複略過 **${num(stats.reactionSkippedDuplicate)}** · 不符資格 **${num(stats.reactionSkippedIneligible)}**`,
        ].join('\n'),
      },
      { name: '🖼️ 媒體加成（第 18 節）', value: mediaLines },
      { name: '🔗 連結加成', value: linkLines },
      { name: '😀 反應 XP', value: reactionLines },
      { name: '升級公告', value: `${describeAnnounce(s)}\n\`${s.announce_message}\`` },
      { name: '等級角色', value: rewardLines },
      {
        name: 'No-XP 頻道',
        value: ignoredChannels.length ? ignoredChannels.map((id) => `<#${id}>`).join('、') : '（無）',
        inline: true,
      },
      {
        name: 'No-XP 成員',
        value: ignoredUsers.length ? ignoredUsers.map((id) => `<@${id}>`).join('、') : '（無）',
      },
      {
        name: 'No-XP 角色',
        value: ignoredRoles.length ? ignoredRoles.map((id) => `<@&${id}>`).join('、') : '（無）',
        inline: true,
      },
    );

  if (problems.length) {
    embed.addFields({ name: '⚠️ 需要處理', value: problems.join('\n') });
  }

  return interaction.reply({ ...withResolvableMentions({ embeds: [embed] }), flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
}
