import assert from 'node:assert/strict';
import { test } from 'node:test';

// Import after setting the path so tests never open the bot's real database.
process.env.SQLITE_PATH = ':memory:';
const {
  snapshotMessage, handleMessageDelete, handleMessageEdit, markBotDeletion, deletedMessagePayloads, UNKNOWN_DELETER,
} = await import('../src/lib/modlog.js');
const {
  updateModlog, setModlogXp, getModlogMessage, listModlogDeleted, listModlogDeleteSuspects,
  listModlogEvents, addModlogIgnoredChannel, pruneModlog, db,
} = await import('../src/lib/db.js');

let nextId = 1;
const id = () => String(1_000_000 + nextId++);

function makeGuild({ auditLog = false, auditEntries = [] } = {}) {
  const posted = [];
  const logChannel = { id: id(), name: 'mod-log', isTextBased: () => true, send: async (p) => { posted.push(p); } };
  const guild = {
    id: id(),
    members: { me: { id: 'bot-user', permissions: { has: () => auditLog } } },
    channels: { cache: new Map([[logChannel.id, logChannel]]), fetch: async (cid) => guild.channels.cache.get(cid) ?? null },
    fetchAuditLogs: async () => ({ entries: new Map(auditEntries.map((e) => [e.id, e])) }),
  };
  return { guild, logChannel, posted };
}

function makeMessage(guild, { channelId = 'chan-1', authorId = 'user-1', content = 'hello world', bot = false, createdAt = Date.now() } = {}) {
  return {
    id: id(), guild, partial: false, system: false, webhookId: null,
    inGuild: () => true,
    channel: { id: channelId, parentId: null }, channelId,
    author: { id: authorId, username: `name-${authorId}`, discriminator: '0', bot },
    content, attachments: new Map(), stickers: new Map(), reference: null,
    createdTimestamp: createdAt,
    url: `https://discord.com/channels/${guild.id}/${channelId}/x`,
  };
}

test('nothing is stored while logging is disabled', () => {
  const { guild } = makeGuild();
  const msg = makeMessage(guild);
  assert.equal(snapshotMessage(msg), false);
  assert.equal(getModlogMessage(msg.id), undefined);
});

test('self-deleted message keeps its content and flags XP that was already awarded', async () => {
  const { guild, logChannel, posted } = makeGuild();
  updateModlog(guild.id, { enabled: 1, delete_channel_id: logChannel.id });
  const msg = makeMessage(guild, { content: 'filler text to farm xp', createdAt: Date.now() - 30_000 });
  assert.equal(snapshotMessage(msg), true);
  setModlogXp(msg.id, 22);

  // Deletion events usually arrive as partials without content.
  const entry = await handleMessageDelete({ id: msg.id, guild, channel: msg.channel, channelId: msg.channelId, partial: true });
  assert.equal(entry.content, 'filler text to farm xp');
  assert.equal(entry.xp_awarded, 22);
  assert.equal(entry.deleted_by, UNKNOWN_DELETER, 'without audit log access the deleter is unknown');

  assert.equal(posted.length, 1);
  const embed = posted[0].embeds[0].data;
  assert.match(embed.description, /filler text/);
  assert.ok(embed.fields.some((f) => f.name === '經驗值' && f.value.includes('+22')));

  const self = listModlogDeleted(guild.id, { source: 'self' });
  assert.deepEqual(self.map((r) => r.message_id), [msg.id]);
  assert.equal(listModlogDeleted(guild.id, { source: 'xp' }).length, 1);
  const [suspect] = listModlogDeleteSuspects(guild.id);
  assert.equal(suspect.author_id, 'user-1');
  assert.equal(suspect.awarded, 1);
  assert.equal(suspect.xp, 22);
});

test('deleting while XP is still pending is recorded as a cancelled attempt', async () => {
  const { guild } = makeGuild();
  updateModlog(guild.id, { enabled: 1 });
  const msg = makeMessage(guild, { authorId: 'quick-deleter' });
  snapshotMessage(msg);
  const entry = await handleMessageDelete({ id: msg.id, guild, channel: msg.channel, channelId: msg.channelId, partial: true }, { xpCancelled: true });
  assert.equal(entry.xp_cancelled, 1);
  const [s] = listModlogDeleteSuspects(guild.id);
  assert.equal(s.cancelled, 1);
  assert.equal(s.quick, 1);
});

test('bot deletions are labelled and kept out of the self-delete statistics', async () => {
  const { guild, logChannel, posted } = makeGuild();
  updateModlog(guild.id, { enabled: 1, delete_channel_id: logChannel.id });
  const msg = makeMessage(guild, { authorId: 'dupe-poster' });
  snapshotMessage(msg);
  markBotDeletion(msg.id, 'dupe');
  const entry = await handleMessageDelete({ id: msg.id, guild, channel: msg.channel, channelId: msg.channelId, partial: true });
  assert.equal(entry.delete_reason, 'dupe');
  assert.ok(posted[0].embeds[0].data.fields.some((f) => f.value.includes('重複連結')));
  assert.equal(listModlogDeleted(guild.id, { source: 'bot' }).length, 1);
  assert.equal(listModlogDeleted(guild.id, { source: 'self' }).length, 0);
  assert.equal(listModlogDeleteSuspects(guild.id).length, 0);
});

test('bot deletions can be stored without being posted', async () => {
  const { guild, logChannel, posted } = makeGuild();
  updateModlog(guild.id, { enabled: 1, delete_channel_id: logChannel.id, bot_deletions: 0 });
  const msg = makeMessage(guild);
  snapshotMessage(msg);
  markBotDeletion(msg.id, 'ai-filter');
  await handleMessageDelete({ id: msg.id, guild, channel: msg.channel, channelId: msg.channelId, partial: true });
  assert.equal(posted.length, 0);
  assert.equal(listModlogDeleted(guild.id, { source: 'bot' }).length, 1);
});

test('audit log identifies a moderator deletion', async () => {
  const msg0 = { authorId: 'victim', channelId: 'chan-mod' };
  const entry = { id: 'audit-1', targetId: 'victim', executorId: 'moderator', extra: { channel: { id: 'chan-mod' }, count: 1 }, createdTimestamp: Date.now() };
  const { guild } = makeGuild({ auditLog: true, auditEntries: [entry] });
  updateModlog(guild.id, { enabled: 1 });
  const msg = makeMessage(guild, msg0);
  snapshotMessage(msg);
  const result = await handleMessageDelete({ id: msg.id, guild, channel: msg.channel, channelId: msg.channelId, partial: true });
  assert.equal(result.deleted_by, 'moderator');
  assert.equal(listModlogDeleted(guild.id, { source: 'others' }).length, 1);
  assert.equal(listModlogDeleteSuspects(guild.id).length, 0);
});

test('with audit log access and no entry, the author deleted it themselves', async () => {
  const { guild } = makeGuild({ auditLog: true, auditEntries: [] });
  updateModlog(guild.id, { enabled: 1 });
  const msg = makeMessage(guild, { authorId: 'self-user' });
  snapshotMessage(msg);
  const result = await handleMessageDelete({ id: msg.id, guild, channel: msg.channel, channelId: msg.channelId, partial: true });
  assert.equal(result.deleted_by, 'self-user');
  assert.equal(listModlogDeleted(guild.id, { source: 'self' }).length, 1);
});

test('a deletion without a snapshot is still logged as unknown content', async () => {
  const { guild, logChannel, posted } = makeGuild();
  updateModlog(guild.id, { enabled: 1, delete_channel_id: logChannel.id });
  const entry = await handleMessageDelete({ id: id(), guild, channel: { id: 'c', parentId: null }, channelId: 'c', partial: true });
  assert.equal(entry.content, null);
  assert.match(posted[0].embeds[0].data.description, /內容未記錄/);
});

test('edits update the snapshot and add an activity event', async () => {
  const { guild } = makeGuild();
  updateModlog(guild.id, { enabled: 1 });
  const msg = makeMessage(guild, { content: 'before' });
  snapshotMessage(msg);
  const edited = { ...msg, content: 'after', editedTimestamp: Date.now() };
  assert.equal(await handleMessageEdit({ partial: true }, edited), true);
  assert.equal(getModlogMessage(msg.id).content, 'after');
  const [ev] = listModlogEvents(guild.id, { types: ['edit'] });
  assert.match(ev.summary, /before → after/);
  // Embed-only updates do not count as edits.
  assert.equal(await handleMessageEdit({ ...edited, partial: false }, edited), null);
});

test('ignored channels, log channels and other bots are not recorded', () => {
  const { guild, logChannel } = makeGuild();
  updateModlog(guild.id, { enabled: 1, delete_channel_id: logChannel.id });
  addModlogIgnoredChannel(guild.id, 'secret');
  assert.equal(snapshotMessage(makeMessage(guild, { channelId: 'secret' })), false);
  assert.equal(snapshotMessage(makeMessage(guild, { channelId: logChannel.id })), false);
  assert.equal(snapshotMessage(makeMessage(guild, { bot: true })), false);
  updateModlog(guild.id, { include_bots: 1 });
  assert.equal(snapshotMessage(makeMessage(guild, { bot: true })), true);
});

test('payloads respect Discord embed limits', () => {
  const { guild } = makeGuild();
  const rows = Array.from({ length: 23 }, (_, i) => ({
    message_id: String(i), guild_id: guild.id, channel_id: 'c', author_id: 'u', author_tag: 'u',
    content: 'x'.repeat(i % 3 === 0 ? 3000 : 50), attachments: [], stickers: [], created_at: Date.now() - 1000,
    deleted_at: Date.now(), deleted_by: UNKNOWN_DELETER, delete_reason: null, xp_awarded: 0, xp_cancelled: 0,
  }));
  const payloads = deletedMessagePayloads(guild, rows);
  assert.equal(payloads.reduce((n, p) => n + p.embeds.length, 0), 23);
  for (const p of payloads) {
    assert.ok(p.embeds.length <= 10);
    assert.ok(p.embeds.reduce((n, e) => n + e.length, 0) <= 6000);
  }
});

test('retention prunes old snapshots and events', () => {
  const { guild } = makeGuild();
  updateModlog(guild.id, { enabled: 1, retention_days: 1 });
  const old = makeMessage(guild, { createdAt: Date.now() - 3 * 86_400_000 });
  const fresh = makeMessage(guild);
  snapshotMessage(old);
  snapshotMessage(fresh);
  db.prepare('INSERT INTO modlog_events (guild_id, type, summary, created_at) VALUES (?, ?, ?, ?)')
    .run(guild.id, 'join', 'old', Date.now() - 3 * 86_400_000);
  const removed = pruneModlog();
  assert.ok(removed.some((r) => r.message_id === old.id));
  assert.equal(getModlogMessage(old.id), undefined);
  assert.ok(getModlogMessage(fresh.id));
  assert.equal(listModlogEvents(guild.id, { types: ['join'] }).length, 0);
});
