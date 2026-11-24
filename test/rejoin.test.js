import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MessageType } from 'discord.js';

// Import after setting the path so tests never open the bot's real database.
process.env.SQLITE_PATH = ':memory:';
const {
  recordMovement, countJoins, listRepeaters, updateRejoinSettings, setRejoinExempt,
  handleRejoinJoin, handleRejoinLeave, scanMovements, enforceRejoin,
} = await import('../src/lib/rejoin.js');
const { addModlogEvent } = await import('../src/lib/db.js');

let n = 0;
const uid = () => String(900_000_000_000_000_000n + BigInt(++n));
const DAY = 86_400_000;

function makeGuild({ canBan = true, bannable = true } = {}) {
  const id = `g${uid()}`;
  const sent = [];
  const bans = [];
  const logChannel = { id: `log-${id}`, isTextBased: () => true, send: async (p) => { sent.push(p.content); } };
  const guild = {
    id,
    members: {
      me: { permissions: { has: () => canBan } },
      fetch: async (userId) => (userId ? { id: userId, bannable } : new Map()),
      ban: async (userId, opts) => { bans.push({ userId, ...opts }); },
    },
    channels: { cache: new Map([[logChannel.id, logChannel]]), fetch: async () => null },
    systemChannel: null,
  };
  updateRejoinSettings(id, { log_channel_id: logChannel.id });
  return { guild, sent, bans };
}

const member = (guild, userId, joinedTimestamp = Date.now()) => ({
  id: userId, guild, joinedTimestamp, bannable: true,
  user: { id: userId, username: `user${userId.slice(-3)}`, discriminator: '0', bot: false },
});

test('the same join seen from two sources only counts once', () => {
  const { guild } = makeGuild();
  const u = uid();
  const at = Date.now();
  assert.equal(recordMovement({ guildId: guild.id, userId: u, type: 'join', at, source: 'live' }), true);
  assert.equal(recordMovement({ guildId: guild.id, userId: u, type: 'join', at: at + 3000, source: 'system', ref: 'msg:1' }), false);
  assert.equal(recordMovement({ guildId: guild.id, userId: u, type: 'join', at: at + 3000, source: 'system', ref: 'msg:1' }), false);
  assert.equal(recordMovement({ guildId: guild.id, userId: u, type: 'join', at: at + DAY, source: 'live' }), true);
  assert.equal(countJoins(guild.id, u), 2);
});

test('nothing is banned while auto handling is off', async () => {
  const { guild, bans } = makeGuild();
  const u = uid();
  for (let i = 5; i >= 0; i--) await handleRejoinJoin(member(guild, u, Date.now() - i * 3600_000));
  assert.equal(countJoins(guild.id, u), 6);
  assert.equal(bans.length, 0);
});

test('notify mode reports at the threshold without banning', async () => {
  const { guild, sent, bans } = makeGuild();
  updateRejoinSettings(guild.id, { action: 'notify', threshold: 3, window_days: 7 });
  const u = uid();
  const results = [];
  for (let i = 2; i >= 0; i--) results.push(await handleRejoinJoin(member(guild, u, Date.now() - i * 3600_000)));
  assert.deepEqual(results.map((r) => r.action), [null, null, 'notify']);
  assert.equal(bans.length, 0);
  assert.match(sent[0], /第 \*\*3\*\* 次加入/);
});

test('ban mode bans the same UID on its Nth join inside the window', async () => {
  const { guild, sent, bans } = makeGuild();
  updateRejoinSettings(guild.id, { action: 'ban', threshold: 3, window_days: 7, delete_message_seconds: 3600 });
  const u = uid();
  await handleRejoinJoin(member(guild, u, Date.now() - 2 * 3600_000));
  handleRejoinLeave(member(guild, u));
  await handleRejoinJoin(member(guild, u, Date.now() - 3600_000));
  handleRejoinLeave(member(guild, u));
  const r = await handleRejoinJoin(member(guild, u));
  assert.equal(r.action, 'ban');
  assert.equal(bans.length, 1);
  assert.equal(bans[0].userId, u);
  assert.equal(bans[0].deleteMessageSeconds, 3600);
  assert.match(sent.at(-1), /已自動封禁/);
  const [row] = listRepeaters(guild.id, { minJoins: 2 });
  assert.equal(row.joins, 3);
  assert.equal(row.leaves, 2);
  assert.equal(row.last_action, 'ban');
});

test('joins outside the window do not count toward the threshold', async () => {
  const { guild, bans } = makeGuild();
  updateRejoinSettings(guild.id, { action: 'ban', threshold: 3, window_days: 7 });
  const u = uid();
  recordMovement({ guildId: guild.id, userId: u, type: 'join', at: Date.now() - 30 * DAY, source: 'system', ref: `old-${u}-1` });
  recordMovement({ guildId: guild.id, userId: u, type: 'join', at: Date.now() - 20 * DAY, source: 'system', ref: `old-${u}-2` });
  const r = await handleRejoinJoin(member(guild, u));
  assert.equal(r.joins, 1);
  assert.equal(bans.length, 0);
});

test('exempt users and bots are never banned', async () => {
  const { guild, bans } = makeGuild();
  updateRejoinSettings(guild.id, { action: 'ban', threshold: 2, window_days: 7 });
  const u = uid();
  setRejoinExempt(guild.id, u, true);
  await handleRejoinJoin(member(guild, u, Date.now() - 3600_000));
  assert.equal((await handleRejoinJoin(member(guild, u))).action, 'exempt');
  const bot = { ...member(guild, uid()), user: { id: 'b', bot: true } };
  await handleRejoinJoin(bot);
  await handleRejoinJoin(bot);
  assert.equal(bans.length, 0);
});

test('a failed ban is reported instead of crashing', async () => {
  const { guild, sent } = makeGuild({ canBan: false });
  updateRejoinSettings(guild.id, { action: 'ban', threshold: 2, window_days: 7 });
  const u = uid();
  await handleRejoinJoin(member(guild, u, Date.now() - 3600_000));
  assert.equal((await handleRejoinJoin(member(guild, u))).action, 'ban-failed');
  assert.match(sent.at(-1), /封禁失敗.*封鎖成員/);
});

test('scan recovers past joins from system messages and the activity log', async () => {
  const { guild } = makeGuild();
  const u = uid();
  const sys = (id, at, authorId = u, type = MessageType.UserJoin) => ({ id, type, createdTimestamp: at, author: { id: authorId, username: 'x', bot: false } });
  const messages = [
    sys('m1', Date.now() - 3 * DAY), sys('m2', Date.now() - 2 * DAY), sys('m3', Date.now() - DAY),
    sys('m4', Date.now(), uid(), MessageType.Default),
  ];
  class Page extends Map { last() { return [...this.values()].at(-1); } }
  const channel = { id: 'sys', messages: { fetch: async () => new Page(messages.map((m) => [m.id, m])) } };
  addModlogEvent(guild.id, { type: 'leave', userId: u, summary: 'left', createdAt: Date.now() - 2.5 * DAY });

  const stats = await scanMovements(guild, { channel });
  assert.equal(stats.systemJoins, 3);
  assert.equal(stats.modlogEvents, 1);
  const again = await scanMovements(guild, { channel });
  assert.equal(again.systemJoins, 0, 'rescanning does not double count');
  const [row] = listRepeaters(guild.id, { minJoins: 2 });
  assert.equal(row.user_id, u);
  assert.equal(row.joins, 3);
  assert.equal(row.leaves, 1);
});

test('enforce previews first and bans only on confirm, skipping exempt and already banned', async () => {
  const { guild, bans } = makeGuild();
  updateRejoinSettings(guild.id, { threshold: 3, window_days: 7 });
  const [a, b, c] = [uid(), uid(), uid()];
  for (const userId of [a, b, c]) {
    for (let i = 1; i <= 3; i++) recordMovement({ guildId: guild.id, userId, type: 'join', at: Date.now() - i * 3600_000, source: 'live' });
  }
  setRejoinExempt(guild.id, c, true);

  const preview = await enforceRejoin(guild);
  assert.deepEqual(preview.candidates.map((r) => r.user_id).sort(), [a, b].sort());
  assert.equal(bans.length, 0);

  const done = await enforceRejoin(guild, { confirm: true });
  assert.deepEqual(done.banned.sort(), [a, b].sort());
  assert.equal((await enforceRejoin(guild)).candidates.length, 0, 'already banned users are not listed again');
});

test('rapid join/leave spam from live events is not merged', async () => {
  const { guild } = makeGuild();
  const u = uid();
  const at = Date.now();
  for (let i = 0; i < 4; i++) {
    recordMovement({ guildId: guild.id, userId: u, type: 'join', at: at + i * 10_000, source: 'live' });
    recordMovement({ guildId: guild.id, userId: u, type: 'leave', at: at + i * 10_000 + 5000, source: 'live' });
  }
  const [row] = listRepeaters(guild.id, { minJoins: 2 });
  assert.equal(row.joins, 4);
  assert.equal(row.leaves, 4);
});
