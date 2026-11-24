import { Client, GatewayIntentBits, Events, MessageFlags, Partials, REST, Routes } from 'discord.js';
import { commands, commandMap } from './commands/index.js';
import { awardForMessage, awardForReaction, applyRewards, cancelPending } from './lib/xp.js';
import { handleStickerTriggers } from './lib/triggers.js';
import { handleLinkDupes, handleLatePreview } from './lib/dupe.js';
import { handleAiFilter, startAiFilterScanLoop } from './lib/aifilter.js';
import { getMember, closeDb, forgetDupeLinksByMessage } from './lib/db.js';
import {
  snapshotMessage, handleMessageDelete, handleBulkDelete, handleMessageEdit,
  handleMemberJoin, handleMemberLeave, handleMemberUpdate, handleBan, startModlogMaintenance,
} from './lib/modlog.js';
import { handleRejoinJoin, handleRejoinLeave } from './lib/rejoin.js';

const token = process.env.DISCORD_TOKEN;
if (!token) {
  console.error('缺少 DISCORD_TOKEN，無法啟動。');
  process.exit(1);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent, // Portal 開了還不夠，這裡也要宣告
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessageReactions, // 反應 XP。非特權 intent，Portal 不用另外開
    GatewayIntentBits.GuildModeration, // 活動日誌的封鎖／解封事件。非特權
  ],
  // 17.3 要能收到「未快取訊息」的刪除事件，才不會漏掉取消 pending
  partials: [Partials.GuildMember, Partials.Message, Partials.Channel, Partials.Reaction, Partials.User],
});

const targetGuildId = process.env.GUILD_ID?.trim();

client.once(Events.ClientReady, async (c) => {
  console.log(`✅ 已上線：${c.user.tag}（${c.guilds.cache.size} 個伺服器）`);
  for (const g of c.guilds.cache.values()) console.log(`   ├ ${g.name} (${g.id}) — ${g.memberCount} 人`);

  if (process.env.AUTO_DEPLOY_COMMANDS !== '0') await registerCommands(c.user.id);
  startModlogMaintenance();

  startAiFilterScanLoop(c); // 定時主動掃描 AI 創作者連結（AI_FILTER_SCAN_MINUTES，預設 30，0 關閉）

  if (targetGuildId && !c.guilds.cache.has(targetGuildId)) {
    console.warn(
      `⚠️ Bot 不在目標伺服器 ${targetGuildId} 裡面。\n` +
      '   指令可能註冊得進去（application 有 applications.commands 授權就行），但 Bot 使用者沒加入，\n' +
      '   收不到任何訊息事件 → 永遠不會發 XP。\n' +
      '   請用「同時含 bot 與 applications.commands 兩個 scope」的邀請連結重新授權一次。'
    );
  }
});

// 被邀請進新伺服器時當場註冊指令，不用手動重啟
client.on(Events.GuildCreate, async (guild) => {
  console.log(`➕ 加入伺服器：${guild.name} (${guild.id}) — ${guild.memberCount} 人`);
  if (process.env.AUTO_DEPLOY_COMMANDS === '0') return;
  if (targetGuildId && targetGuildId !== guild.id) return;
  await registerCommands(client.user.id);
});

/** 每次開機重新 PUT 一次指令定義（冪等）。設 AUTO_DEPLOY_COMMANDS=0 可關掉。 */
async function registerCommands(clientId) {
  const guildId = process.env.GUILD_ID?.trim();
  const route = guildId
    ? Routes.applicationGuildCommands(clientId, guildId)
    : Routes.applicationCommands(clientId);
  try {
    const result = await new REST().setToken(token).put(route, { body: commands.map((c) => c.data.toJSON()) });
    console.log(`✅ 已註冊 ${result.length} 個 slash command → ${guildId ? `伺服器 ${guildId}（秒生效）` : '全域（最多約 1 小時生效）'}`);
  } catch (err) {
    console.error('⚠️ slash command 註冊失敗（Bot 仍會繼續發 XP）:', err.message);
  }
}

client.on(Events.MessageCreate, async (message) => {
  try {
    if (!message.inGuild()) return;
    // 活動日誌：先存快照（同步寫 DB），延遲入帳到期時才找得到這一列記 XP
    try { snapshotMessage(message); } catch (err) { console.error('[modlog] 快照失敗', err); }
    // 預覽 Bot 可能比去重的刪除還晚到，要在濾掉 Bot 之前看
    if (message.author.bot) await handleLatePreview(message);
    if (message.author.bot || message.webhookId) return;
    if (message.system) return;

    // 各自獨立：關鍵字貼圖、去重或 AI 過濾失敗都不該影響發 XP
    await Promise.allSettled([
      awardForMessage(message),
      handleStickerTriggers(message),
      handleLinkDupes(message),
      handleAiFilter(message),
    ]).then((results) => {
      for (const r of results) if (r.status === 'rejected') console.error('[messageCreate]', r.reason);
    });
  } catch (err) {
    // 任何錯誤都不能讓整個 Bot 掛掉
    console.error('[messageCreate]', err);
  }
});

// 表情反應：按的人與被按的人各 +XP。無冷卻，靠 reaction_awards 去重。
client.on(Events.MessageReactionAdd, async (reaction, user) => {
  try {
    if (user.bot) return;

    // 舊訊息不在快取裡時是 partial，要先補完才有 author
    if (reaction.partial) await reaction.fetch();
    if (reaction.message.partial) await reaction.message.fetch();

    const message = reaction.message;
    if (!message.guild) return; // DM 不算

    const reactorMember = await message.guild.members.fetch(user.id).catch(() => null);
    if (!reactorMember) return;

    await awardForReaction(message, reactorMember);
  } catch (err) {
    console.error('[messageReactionAdd]', err);
  }
});

// 編輯後才貼上重複連結或 AI 連結也要擋，不然改一下訊息就繞過去了
client.on(Events.MessageUpdate, async (oldMessage, newMessage) => {
  try {
    if (newMessage.partial) newMessage = await newMessage.fetch();
    if (!newMessage.inGuild()) return;
    handleMessageEdit(oldMessage, newMessage).catch((err) => console.error('[modlog] 編輯紀錄失敗', err));
    if (newMessage.author?.bot || newMessage.webhookId || newMessage.system) return;
    const results = await Promise.allSettled([handleLinkDupes(newMessage), handleAiFilter(newMessage)]);
    for (const r of results) if (r.status === 'rejected') console.error('[messageUpdate]', r.reason);
  } catch (err) {
    console.error('[messageUpdate]', err);
  }
});

// 17.3 刪訊即取消尚未入帳的 pending。取消鍵只用 message.id——刪除事件裡內容常是空的。
// 原始貼文被刪掉時也要放掉它佔住的連結，之後同一條可以再貼。
client.on(Events.MessageDelete, (message) => {
  const xpCancelled = cancelPending(message.id);
  if (xpCancelled) {
    console.log(`[antiabuse] pending 因刪訊取消 (message ${message.id})`);
  }
  const freed = forgetDupeLinksByMessage(message.id);
  if (freed > 0) console.log(`[dupe] 原始訊息 ${message.id} 已刪，放掉 ${freed} 條連結紀錄`);
  // 不論誰刪的（本人、管理員、Bot）都記下來
  handleMessageDelete(message, { xpCancelled }).catch((err) => console.error('[modlog] 刪除紀錄失敗', err));
});

client.on(Events.MessageBulkDelete, (messages, channel) => {
  handleBulkDelete(messages, channel).catch((err) => console.error('[modlog] 批次刪除紀錄失敗', err));
  let n = 0;
  let freed = 0;
  for (const id of messages.keys()) {
    if (cancelPending(id)) n++;
    freed += forgetDupeLinksByMessage(id);
  }
  if (n > 0) console.log(`[antiabuse] pending 因批次刪訊取消 ${n} 筆`);
  if (freed > 0) console.log(`[dupe] 批次刪訊放掉 ${freed} 條連結紀錄`);
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (interaction.isAutocomplete()) {
    const command = commandMap.get(interaction.commandName);
    if (!command?.autocomplete) return;
    try {
      await command.autocomplete(interaction);
    } catch (err) {
      console.error(`[autocomplete:${interaction.commandName}]`, err);
      await interaction.respond([]).catch(() => {});
    }
    return;
  }

  if (!interaction.isChatInputCommand()) return;

  const command = commandMap.get(interaction.commandName);
  if (!command) return;

  if (!interaction.inGuild()) {
    return interaction.reply({ content: '這個指令只能在伺服器裡使用。', flags: MessageFlags.Ephemeral });
  }

  try {
    await command.execute(interaction);
  } catch (err) {
    console.error(`[command:${interaction.commandName}]`, err);
    const payload = { content: '⚠️ 指令執行時出錯了，詳情請看 Bot log。', flags: MessageFlags.Ephemeral };
    if (interaction.deferred || interaction.replied) {
      await interaction.followUp(payload).catch(() => {});
    } else {
      await interaction.reply(payload).catch(() => {});
    }
  }
});

// 成員重新加入時，把他原本的等級角色補回去
client.on(Events.GuildMemberAdd, async (member) => {
  handleMemberJoin(member).catch((err) => console.error('[modlog] 加入紀錄失敗', err));
  // 反覆進出：記一筆加入，達門檻照設定通知或封禁
  handleRejoinJoin(member).catch((err) => console.error('[rejoin] 加入處理失敗', err));
  try {
    const row = getMember(member.guild.id, member.id);
    if (row.total_xp > 0) await applyRewards(member, row.level);
  } catch (err) {
    console.error('[guildMemberAdd]', err);
  }
});

client.on(Events.GuildMemberRemove, (member) => {
  handleMemberLeave(member).catch((err) => console.error('[modlog] 離開紀錄失敗', err));
  try { handleRejoinLeave(member); } catch (err) { console.error('[rejoin] 離開紀錄失敗', err); }
});
client.on(Events.GuildMemberUpdate, (oldMember, newMember) => {
  handleMemberUpdate(oldMember, newMember).catch((err) => console.error('[modlog] 成員變更紀錄失敗', err));
});
client.on(Events.GuildBanAdd, (ban) => handleBan(ban, true).catch((err) => console.error('[modlog] 封鎖紀錄失敗', err)));
client.on(Events.GuildBanRemove, (ban) => handleBan(ban, false).catch((err) => console.error('[modlog] 解封紀錄失敗', err)));

client.on(Events.Error, (err) => console.error('[client]', err));
process.on('unhandledRejection', (err) => console.error('[unhandledRejection]', err));

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    console.log(`收到 ${signal}，關閉中…`);
    client.destroy();
    closeDb();
    process.exit(0);
  });
}

client.login(token);
