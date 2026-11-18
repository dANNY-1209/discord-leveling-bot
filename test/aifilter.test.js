import assert from 'node:assert/strict';
import { test } from 'node:test';

// Import after setting the path so tests never open the bot's real database.
process.env.SQLITE_PATH = ':memory:';
const { matchAiBio, matchKeyword, extractHashtags, evaluateTarget, evaluateText, handleAiFilter, scanGuild } = await import('../src/lib/aifilter.js');
const { DEFAULT_AI_KEYWORDS, addAiFilterChannel } = await import('../src/lib/db.js');

const BULY_BIO = '只會畫畫的平凡人 (´・ω・｀)\n成人向創作者，閱讀注意\nR18絵師 · 無断転載 · AI使用禁止\n\n請不要把我的任何作品拿去餵低能AI';
const AISORA_BIO = 'アニメ・オリキャラ\nファンアート\n🔞 Patreon: https://patreon.com/Aisora\n📩 リクエスト・お仕事のご依頼はDMへ';
const rules = () => ({ allowed: new Set(), blocked: new Set(), keywords: DEFAULT_AI_KEYWORDS });
let fixtureId = 1000;

function mockX(t, { bio, name = '', handle, text }) {
  const id = String(fixtureId++);
  handle ??= `artist_${id}`;
  t.mock.method(globalThis, 'fetch', async (url) => {
    assert.ok(url.startsWith('https://api.fxtwitter.com/'));
    const author = { screen_name: handle, name, description: bio };
    return { ok: true, json: async () => ({ code: 200, user: author, tweet: { text, author } }) };
  });
  return { type: 'x-status', id, handle };
}

for (const text of [
  BULY_BIO,
  '請不要把我的任何作品拿去餵低能AI',
  '禁止將這裡的所有作品用於任何形式的 AI 生成、AI繪圖或 Midjourney 訓練',
  '请勿将我的原创作品用于 AI 生成或 Stable Diffusion 训练',
  '私の作品を使った AIイラスト の生成・学習は一切禁止です',
  'AI学習禁止 / AI使用不可 / 生成AIへの利用はお断りします',
  'Do not use any of my illustrations to train generative AI models or Midjourney.',
  'I do not allow my artwork to be used for AI generated images.',
  'No permission is given to use my artwork for AI art or machine learning.',
  'AI art is strictly prohibited.',
  'No AI art / #NoAIart / anti-AI artist / AI-free',
  'Ｎｏ ＡＩ ａｒｔ',
  'AI-free artist',
  'AI hater artist',
  '3D+AI-free animator',
  'No #AIart or #AIgenerated',
  'No Midjourney or Stable Diffusion',
  'AIイラスト、AI生成の学習禁止',
  'AI artists are not welcome here',
]) {
  test(`protection notice is neither AI evidence nor a warning: ${text}`, async (t) => {
    assert.equal(matchKeyword(text, [...DEFAULT_AI_KEYWORDS, 'AI']), null);
    assert.equal(matchAiBio(text), null);
    const verdict = await evaluateTarget(mockX(t, { bio: text }), rules());
    assert.equal(verdict.hit, false);
    assert.ok(!verdict.suspect);
  });
}

for (const text of [
  'AI artist',
  '3D+AI NSFW animator',
  'Illustrations made with AI',
  'AI art and model training',
  'Midjourney / Stable Diffusion / ComfyUI',
  'AI artist. Do not use my works for AI training.',
  'AI artist, do not train AI on my works.',
  'Do not train AI on my works; I am an AI artist.',
  'No AI training on my works, but I create AI art.',
  'AI学習禁止\nAIイラストを制作しています',
  'AI学習禁止 / AIイラストを制作しています',
  'No AI art, handmade and AI artist commissions available',
  'No AI art or Midjourney; AI artist',
  'AI artist, no AI training',
]) {
  test(`independent AI creation evidence still matches: ${text}`, async (t) => {
    const verdict = await evaluateTarget(mockX(t, { bio: text }), rules());
    assert.equal(verdict.hit, true);
  });
}

for (const text of [
  '禁止將我的作品用於 #AI繪圖 或 #AI生成 的訓練',
  'Do not use my illustrations to train #AIart models.',
  '私の作品の #AIイラスト 学習・利用は禁止です',
  'No #AIart or #AIgenerated',
  '#AIイラスト、#AI生成の学習禁止',
]) {
  test(`hashtag retains its protection context: ${text}`, async (t) => {
    assert.equal((await evaluateText('tags', text)).hit, null);
    const verdict = await evaluateTarget(mockX(t, { bio: '', text }), rules());
    assert.equal(verdict.hit, false);
  });
}

test('an independent positive hashtag still matches after a protection notice', async () => {
  const result = await evaluateText('tags', 'No AI training on my work.\nNew image #AIart');
  assert.ok(result.hit);
});

test('an AI tweet tag still matches when the author forbids training', async (t) => {
  const verdict = await evaluateTarget(mockX(t, { bio: BULY_BIO, text: 'New image #AIart' }), rules());
  assert.equal(verdict.hit, true);
});

test('long Japanese text without a denial does not get treated as a training ban', () => {
  assert.equal(matchKeyword(`AI${'への'.repeat(2000)}利用`, ['AI']), 'AI');
});

test('hashtag extraction still excludes URL fragments and Discord headings', () => {
  assert.deepEqual(extractHashtags('# heading https://example.com/#AIart #AI生成'), ['AI生成']);
});

test('buly__ tweet is allowed without even a suspect warning', async (t) => {
  const target = mockX(t, { bio: BULY_BIO, handle: 'buly__', text: '新作品' });
  assert.deepEqual(await evaluateTarget(target, rules()), { hit: false, creator: 'x:buly__' });
});

test('Aisora_AI account name is reported for review even without AI in its bio', async (t) => {
  mockX(t, { bio: AISORA_BIO, handle: 'aisora_ai' });
  const verdict = await evaluateTarget({ type: 'x-user', handle: 'aisora_ai' }, rules());
  assert.equal(verdict.hit, false);
  assert.equal(verdict.suspect, true);
});

test('X display name can supply explicit AI creation evidence', async (t) => {
  const verdict = await evaluateTarget(mockX(t, { bio: '', name: 'Example | AI artist' }), rules());
  assert.equal(verdict.hit, true);
});

test('AI letters within an ordinary handle do not create a warning', async (t) => {
  mockX(t, { bio: 'Illustrator', handle: 'kaia_art' });
  const verdict = await evaluateTarget({ type: 'x-user', handle: 'kaia_art' }, rules());
  assert.equal(verdict.hit, false);
  assert.ok(!verdict.suspect);
});

test('manual allow and block decisions still take priority', async (t) => {
  const target = mockX(t, { bio: BULY_BIO });
  const creator = `x:${target.handle}`;
  const blocked = rules();
  blocked.blocked.add(creator);
  assert.equal((await evaluateTarget(target, blocked)).hit, true);
  blocked.allowed.add(creator);
  assert.equal((await evaluateTarget(target, blocked)).hit, false);
});

test('pixiv official AI marker is not overridden by a protection tag', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => ({ ok: true, json: async () => ({
    body: { aiType: 2, userId: '123', tags: { tags: [{ tag: 'AI学習禁止' }] } },
  }) }));
  assert.equal((await evaluateTarget({ type: 'pixiv-work', id: '123' }, rules())).hit, true);
});

test('pixiv protection tags do not classify a hand-drawn work as AI', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => ({ ok: true, json: async () => ({
    body: { aiType: 1, userId: '456', tags: { tags: [{ tag: 'AI学習禁止' }] } },
  }) }));
  assert.equal((await evaluateTarget({ type: 'pixiv-work', id: '456' }, rules())).hit, false);
});

test('unavailable X data is still allowed as unknown', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('offline'); });
  const verdict = await evaluateTarget({ type: 'x-user', handle: 'offline' }, rules());
  assert.equal(verdict.hit, false);
  assert.equal(verdict.unknown, true);
});

test('protection notice produces neither deletion nor moderator log', async (t) => {
  const guildId = 'protected-message';
  const channelId = 'art';
  addAiFilterChannel(guildId, channelId);
  const target = mockX(t, { bio: BULY_BIO });
  const deleted = t.mock.fn();
  const log = t.mock.method(console, 'log', () => {});
  const message = {
    id: 'protected', guild: { id: guildId }, channel: { id: channelId },
    content: `https://x.com/${target.handle}/status/${target.id}`, delete: deleted,
  };
  assert.equal(await handleAiFilter(message), null);
  assert.equal(deleted.mock.callCount(), 0);
  assert.equal(log.mock.callCount(), 0);
});

test('explicit AI creation evidence still deletes a message in delete mode', async (t) => {
  const guildId = 'ai-message';
  const channelId = 'art';
  addAiFilterChannel(guildId, channelId);
  const target = mockX(t, { bio: 'AI artist. Do not train AI on my work.' });
  const deleted = t.mock.fn();
  t.mock.method(console, 'log', () => {});
  const message = {
    id: 'explicit-ai', guild: { id: guildId, members: { me: {} } },
    channel: { id: channelId, permissionsFor: () => ({ has: () => true }) },
    content: `https://x.com/${target.handle}/status/${target.id}`, delete: deleted,
  };
  assert.equal((await handleAiFilter(message)).deleted, true);
  assert.equal(deleted.mock.callCount(), 1);
});

test('repeated AI deletions warn at 3 and mute for a day at 5', async (t) => {
  const guildId = 'strike-guild';
  const channelId = 'strike-art';
  addAiFilterChannel(guildId, channelId);
  const target = mockX(t, { bio: 'AI artist. Do not train AI on my work.' });
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'warn', () => {});

  const sent = [];
  const timeout = t.mock.fn(async () => {});
  const member = { timeout };
  const make = (id) => ({
    id, author: { id: 'repeat-offender' },
    guild: {
      id: guildId,
      members: { me: { permissions: { has: () => true } }, fetch: async () => member },
      channels: { cache: new Map(), fetch: async () => null },
    },
    channel: {
      id: channelId, send: async (payload) => { sent.push(payload.content); },
      permissionsFor: () => ({ has: () => true }),
    },
    content: `https://x.com/${target.handle}/status/${target.id}`,
    delete: async () => {},
  });

  for (let i = 1; i <= 5; i++) await handleAiFilter(make(`strike-${i}`));

  assert.equal(sent.length, 3, 'warnings at counts 3, 4 and 5');
  assert.match(sent[0], /\*\*3\*\* 次/);
  assert.match(sent[2], /禁言 1 天/);
  assert.equal(timeout.mock.callCount(), 1);
  assert.equal(timeout.mock.calls[0].arguments[0], 24 * 3600_000);
});

test('scan pages past 100 messages and notifies each offender only once', async (t) => {
  const guildId = 'scan-guild';
  const channelId = 'scan-art';
  addAiFilterChannel(guildId, channelId);
  const target = mockX(t, { bio: 'AI artist' });
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'warn', () => {});

  class Page extends Map { last() { return [...this.values()].at(-1); } }
  const sent = [];
  const timeout = t.mock.fn(async () => {});
  const allow = { has: () => true };
  const guild = {
    id: guildId,
    members: { me: { permissions: allow }, fetch: async () => ({ timeout }) },
    channels: { cache: new Map(), fetch: async () => null, fetchActiveThreads: async () => ({}) },
  };
  const channel = {
    id: channelId, name: 'scan-art',
    isTextBased: () => true, isDMBased: () => false, isVoiceBased: () => false, isThread: () => false,
    permissionsFor: () => allow,
    send: async (payload) => { sent.push(payload.content); },
  };
  guild.channels.cache.set(channelId, channel);

  // 150 則訊息，新到舊；其中 6 則是同一人貼的 AI 連結
  const all = [];
  for (let i = 150; i >= 1; i--) {
    const ai = i % 25 === 0;
    all.push({
      id: String(i).padStart(4, '0'), guild, channel, createdTimestamp: i,
      author: { id: ai ? 'scan-offender' : `u${i}` },
      content: ai ? `https://x.com/${target.handle}/status/${target.id}` : 'hello',
      delete: async () => {},
    });
  }
  channel.messages = {
    fetch: async ({ limit, before, after }) => {
      if (after) return new Page();
      if (limit > 100) throw new Error('limit over 100');
      const start = before ? all.findIndex((m) => m.id === before) + 1 : 0;
      return new Page(all.slice(start, start + limit).map((m) => [m.id, m]));
    },
  };
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const pending = scanGuild(guild, { limit: 150 });
  for (let i = 0; i < 20; i++) { await new Promise(setImmediate); t.mock.timers.tick(1000); }
  const stats = await pending;

  assert.equal(stats.messages, 150);
  assert.equal(stats.deleted, 6);
  assert.equal(sent.length, 1, 'one notice per user per scan');
  assert.match(sent[0], /\*\*6\*\* 次，已禁言 1 天/);
  assert.equal(timeout.mock.callCount(), 1);
});
