// Discord 只會把「訊息文字」裡的提及附上使用者資料；embed 裡的 <@id> 只能靠看的人本機已載入的成員去對，
// 大伺服器常常對不到，點下去就跳「您沒有存取此連結的權限」，即使對方還在伺服器裡。
// 所以送出含 embed 的訊息時，把 embed 裡提到的人另外列在訊息文字，讓用戶端拿得到資料。
// 搭配 allowedMentions: { parse: [] } 送出，不會 tag 到任何人。

const MENTION_RE = /<@!?(\d{15,25})>/g;
const CONTENT_LIMIT = 2000;

function embedText(embed) {
  return JSON.stringify(embed?.toJSON?.() ?? embed ?? {});
}

/** embed 裡提到的使用者 ID，依出現順序、不重複 */
export function embedMentionIds(embeds = []) {
  const ids = new Set();
  for (const embed of embeds) {
    for (const m of embedText(embed).matchAll(MENTION_RE)) ids.add(m[1]);
  }
  return [...ids];
}

/** 回傳一份把 embed 裡的提及補進訊息文字的 payload（原本的文字保留在前面；超過 2000 字的部分省略） */
export function withResolvableMentions(payload) {
  if (!payload?.embeds?.length) return payload;
  const content = payload.content ?? '';
  const already = new Set([...content.matchAll(MENTION_RE)].map((m) => m[1]));
  const ids = embedMentionIds(payload.embeds).filter((id) => !already.has(id));
  if (ids.length === 0) return payload;

  let line = '👤';
  const room = CONTENT_LIMIT - content.length - (content ? 1 : 0);
  for (const id of ids) {
    const next = `${line} <@${id}>`;
    if (next.length > room) break;
    line = next;
  }
  if (line === '👤') return payload;
  return { ...payload, content: content ? `${content}\n${line}` : line };
}
