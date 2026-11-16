import assert from 'node:assert/strict';
import { test } from 'node:test';

// Import after setting the path so tests never open the bot's real database.
process.env.SQLITE_PATH = ':memory:';
const { collectLinks, isReactionMediaUrl } = await import('../src/lib/dupe.js');

const norms = (content, ignored = []) => collectLinks('g1', content, ignored).map((l) => l.norm);

test('Tenor / Giphy / Klipy GIF links are never deduped, even with an empty ignore list', () => {
  for (const url of [
    'https://tenor.com/view/cat-dance-gif-123456',
    'https://tenor.com/zh-TW/view/cat-dance-gif-123456',
    'https://media.tenor.com/abcDEF/cat.gif',
    'https://c.tenor.com/abcDEF/tenor.gif',
    'https://tenor.co/bXyZ.gif',
    'https://giphy.com/gifs/cat-abc123',
    'https://media.giphy.com/media/abc123/giphy.gif',
    'https://media1.giphy.com/media/abc123/giphy.gif',
    'https://gph.is/g/abc',
    'https://klipy.com/gifs/cat-dance',
  ]) {
    assert.ok(isReactionMediaUrl(url), url);
    assert.deepEqual(norms(url), [], url);
  }
});

test('Discord emoji, sticker and CDN GIF links are never deduped', () => {
  for (const url of [
    'https://cdn.discordapp.com/emojis/123456789012345678.webp?size=48&quality=lossless',
    'https://cdn.discordapp.com/emojis/123456789012345678.gif',
    'https://media.discordapp.net/stickers/123456789012345678.png?size=160',
    'https://cdn.discordapp.com/stickers/123456789012345678.json',
    'https://media.discordapp.net/attachments/1/2/reaction.gif',
    'https://cdn.discordapp.com/attachments/1/2/REACTION.GIF?ex=abc&is=def&hm=123',
  ]) {
    assert.ok(isReactionMediaUrl(url), url);
    assert.deepEqual(norms(url), [], url);
  }
});

test('regular links, including non-GIF Discord attachments, are still deduped', () => {
  for (const url of [
    'https://x.com/artist/status/1234567890',
    'https://www.pixiv.net/artworks/12345',
    'https://cdn.discordapp.com/attachments/1/2/artwork.png',
    'https://media.discordapp.net/attachments/1/2/clip.mp4',
    'https://example.com/tenor.gif',
    'https://nottenor.com/view/x',
  ]) {
    assert.equal(isReactionMediaUrl(url), false, url);
    assert.equal(norms(url).length, 1, url);
  }
});

test('a message mixing a GIF with a real link only records the real link', () => {
  assert.deepEqual(
    norms('lol https://tenor.com/view/lol-gif-1 看這張 https://x.com/a/status/42'),
    ['x.com/status/42'],
  );
});
