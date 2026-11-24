import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EmbedBuilder } from 'discord.js';
import { resolveUsers, resolveMentions, userLabel } from '../src/lib/mentions.js';

let n = 0;
const uid = () => String(500_000_000_000_000_000n + BigInt(++n));

/** 假的 guild：members 裡的人「在伺服器」，users 裡的人只查得到帳號 */
function makeGuild({ members = {}, users = {}, cached = {}, membersFail = false } = {}) {
  const calls = { members: 0, users: 0 };
  const toMember = (id, m) => ({ id, displayName: m.displayName, user: { id, username: m.username } });
  return {
    calls,
    id: `g${uid()}`,
    members: {
      cache: new Map(Object.entries(cached).map(([id, m]) => [id, toMember(id, m)])),
      fetch: async ({ user }) => {
        calls.members++;
        if (membersFail) throw new Error('timeout');
        return new Map(user.filter((id) => members[id]).map((id) => [id, toMember(id, members[id])]));
      },
    },
    client: {
      users: {
        cache: new Map(),
        fetch: async (id) => {
          calls.users++;
          if (!users[id]) throw new Error('Unknown User');
          return { id, ...users[id] };
        },
      },
    },
  };
}

test('members not in the bot cache are still found in the server', async () => {
  const [inside, left, gone] = [uid(), uid(), uid()];
  const guild = makeGuild({
    members: { [inside]: { displayName: '小明', username: 'xiaoming' } },
    users: { [left]: { username: 'leaver', globalName: '離開的人' } },
  });
  const r = await resolveUsers(guild, [inside, left, gone]);
  assert.deepEqual(r.get(inside), { inGuild: true, name: '小明', username: 'xiaoming' });
  assert.deepEqual(r.get(left), { inGuild: false, name: '離開的人', username: 'leaver' });
  assert.equal(r.get(gone).inGuild, false);
  assert.equal(r.get(gone).name, null);
  assert.equal(guild.calls.members, 1, 'one batched member lookup');
});

test('a failed member lookup reports unknown status instead of "left"', async () => {
  const id = uid();
  const guild = makeGuild({ membersFail: true, users: { [id]: { username: 'someone' } } });
  const r = await resolveUsers(guild, [id]);
  assert.equal(r.get(id).inGuild, null);
  assert.equal(r.get(id).name, 'someone');
});

test('cached members skip the API', async () => {
  const id = uid();
  const guild = makeGuild({ cached: { [id]: { displayName: 'A', username: 'a' } } });
  const r = await resolveUsers(guild, [id]);
  assert.equal(r.get(id).inGuild, true);
  assert.equal(guild.calls.members, 0);
});

test('labels show display name and account name', () => {
  assert.equal(userLabel({ name: '小明', username: 'xiaoming' }), '小明（@xiaoming）');
  assert.equal(userLabel({ name: 'same', username: 'same' }), 'same');
  assert.equal(userLabel({ name: null }), '未知使用者');
  assert.equal(userLabel(null, 'stored#0'), 'stored#0');
});

test('mentions in text and embeds become names', async () => {
  const [a, b] = [uid(), uid()];
  const guild = makeGuild({
    members: { [a]: { displayName: '小明', username: 'xiaoming' } },
    users: { [b]: { username: 'bob', globalName: null } },
  });
  const embed = new EmbedBuilder().setDescription(`1. <@${a}> \`${a}\``).addFields({ name: '作者', value: `<@!${b}>` });
  const out = await resolveMentions(guild, { content: `看 <@${a}> 與 <#123456789012345678>`, embeds: [embed] });
  assert.equal(out.content, '看 **小明（@xiaoming）** 與 <#123456789012345678>');
  assert.equal(out.embeds[0].description, `1. **小明（@xiaoming）** \`${a}\``);
  assert.equal(out.embeds[0].fields[0].value, '**bob**');
});

test('payloads without user mentions are returned as is', async () => {
  const guild = makeGuild();
  const p = { content: '<#123456789012345678> 頻道而已' };
  assert.equal(await resolveMentions(guild, p), p);
  assert.equal(guild.calls.members, 0);
});

test('long results are clipped to Discord limits after names get longer', async () => {
  const ids = Array.from({ length: 150 }, () => uid());
  const members = Object.fromEntries(ids.map((id) => [id, { displayName: 'x'.repeat(30), username: 'y'.repeat(30) }]));
  const guild = makeGuild({ members });
  const description = ids.map((id) => `<@${id}>`).join(' ').slice(0, 4000);
  const out = await resolveMentions(guild, { content: description.slice(0, 1990), embeds: [{ description }] });
  assert.ok(out.content.length <= 2000);
  assert.ok(out.embeds[0].description.length <= 4096);
});
