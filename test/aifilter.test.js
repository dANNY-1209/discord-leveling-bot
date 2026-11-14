import assert from 'node:assert/strict';
import { test } from 'node:test';

// Import after setting the path so tests never open the bot's real database.
process.env.SQLITE_PATH = ':memory:';
const { matchAiBio, matchKeyword, extractHashtags, evaluateTarget, evaluateText, handleAiFilter } = await import('../src/lib/aifilter.js');
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
