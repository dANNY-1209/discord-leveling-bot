import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EmbedBuilder } from 'discord.js';
import { embedMentionIds, withResolvableMentions } from '../src/lib/mentions.js';

const A = '111111111111111111';
const B = '222222222222222222';

test('mentions inside embeds are copied into the message text once', () => {
  const embed = new EmbedBuilder().setDescription(`<@${A}> 和 <@!${B}>，又是 <@${A}>`)
    .addFields({ name: '作者', value: `<@${B}>` });
  assert.deepEqual(embedMentionIds([embed]), [A, B]);
  const out = withResolvableMentions({ embeds: [embed] });
  assert.equal(out.content, `👤 <@${A}> <@${B}>`);
  assert.equal(out.embeds[0], embed);
});

test('existing text is kept and users already in it are not repeated', () => {
  const out = withResolvableMentions({ content: `看 <@${A}>`, embeds: [{ description: `<@${A}> <@${B}>` }] });
  assert.equal(out.content, `看 <@${A}>\n👤 <@${B}>`);
});

test('payloads without embed mentions are untouched', () => {
  const p = { embeds: [{ description: '<#123456789012345678> 頻道而已' }] };
  assert.equal(withResolvableMentions(p), p);
  const q = { content: 'hi' };
  assert.equal(withResolvableMentions(q), q);
});

test('the mention line stays inside the 2000 character limit', () => {
  const ids = Array.from({ length: 150 }, (_, i) => String(300000000000000000n + BigInt(i)));
  const out = withResolvableMentions({ embeds: [{ description: ids.map((id) => `<@${id}>`).join(' ') }] });
  assert.ok(out.content.length <= 2000);
  assert.ok(out.content.startsWith(`👤 <@${ids[0]}>`));
});
