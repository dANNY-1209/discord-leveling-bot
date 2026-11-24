// <@id> 能不能顯示成名字，要看「看的人的 Discord 用戶端」有沒有載入這個人；大伺服器裡常常沒有，
// 就會變成「@未知使用者」，點下去跳「您沒有存取此連結的權限」，即使對方還在伺服器裡。
// 所以查詢結果、日誌改由 Bot 自己查名字，直接寫成文字。
//
// 另外 guild.members.cache 只有 Bot 啟動後看過的成員，不能拿來判斷「還在不在伺服器」：
// 要用 members.fetch({ user: [...] }) 實際問 Discord。

const MENTION_RE = /<@!?(\d{15,25})>/g;
const CACHE_TTL = 10 * 60_000;
const MAX_USER_LOOKUPS = 40; // 不在伺服器的人要逐一查，一次最多查這麼多，避免撞到 rate limit
const cache = new Map(); // `${guildId}:${userId}` -> { at, info }

/**
 * 查一批使用者：回傳 Map<id, { inGuild: true|false|null, name, username }>
 * inGuild = null 表示查詢失敗、無法判斷；name = null 表示查不到名字
 */
export async function resolveUsers(guild, ids) {
  const out = new Map();
  const need = [];
  const now = Date.now();
  for (const id of new Set(ids)) {
    const hit = cache.get(`${guild.id}:${id}`);
    const cached = guild.members.cache.get(id);
    if (cached) out.set(id, { inGuild: true, name: cached.displayName ?? cached.user?.username ?? null, username: cached.user?.username ?? null });
    else if (hit && now - hit.at < CACHE_TTL) out.set(id, hit.info);
    else need.push(id);
  }
  if (need.length === 0) return out;

  const found = new Map();
  let membersOk = true;
  for (let i = 0; i < need.length; i += 100) {
    const chunk = need.slice(i, i + 100);
    const got = await guild.members.fetch({ user: chunk }).catch(() => null);
    if (!got) { membersOk = false; continue; }
    for (const [id, m] of got) found.set(id, m);
  }

  let lookups = 0;
  for (const id of need) {
    let info;
    const member = found.get(id) ?? guild.members.cache.get(id);
    if (member) {
      info = { inGuild: true, name: member.displayName ?? member.user?.username ?? null, username: member.user?.username ?? null };
    } else {
      let user = guild.client?.users?.cache?.get(id) ?? null;
      if (!user && lookups < MAX_USER_LOOKUPS && guild.client?.users?.fetch) {
        lookups++;
        user = await guild.client.users.fetch(id).catch(() => null);
      }
      info = {
        inGuild: membersOk ? false : null,
        name: user ? (user.globalName ?? user.username) : null,
        username: user?.username ?? null,
      };
    }
    out.set(id, info);
    if (info.inGuild !== null && info.name) cache.set(`${guild.id}:${id}`, { at: now, info });
  }
  return out;
}

/** 「顯示名稱（@帳號）」；查不到就用備用名稱 */
export function userLabel(info, fallback = null) {
  const name = info?.name ?? fallback;
  if (!name) return '未知使用者';
  const username = info?.username;
  return username && username !== name ? `${name}（@${username}）` : name;
}

function collectIds(value, ids) {
  if (typeof value === 'string') {
    for (const m of value.matchAll(MENTION_RE)) ids.add(m[1]);
  } else if (Array.isArray(value)) {
    value.forEach((v) => collectIds(v, ids));
  } else if (value && typeof value === 'object') {
    Object.values(value).forEach((v) => collectIds(v, ids));
  }
}

function replaceIn(value, labels) {
  if (typeof value === 'string') return value.replace(MENTION_RE, (all, id) => (labels.has(id) ? `**${labels.get(id)}**` : all));
  if (Array.isArray(value)) return value.map((v) => replaceIn(v, labels));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, replaceIn(v, labels)]));
  return value;
}

const clip = (s, max) => (typeof s === 'string' && s.length > max ? `${s.slice(0, max - 1)}…` : s);

/** 把 embed 換完名字後可能超過的長度剪回 Discord 上限 */
function fitEmbed(e) {
  const out = { ...e };
  if (out.title) out.title = clip(out.title, 256);
  if (out.description) out.description = clip(out.description, 4096);
  if (out.fields) out.fields = out.fields.map((f) => ({ ...f, name: clip(f.name, 256), value: clip(f.value, 1024) }));
  return out;
}

/**
 * 把 payload（文字與 embed）裡的 <@id> 換成 Bot 查到的名字。
 * 只用在查詢結果和日誌：要真的 tag 人的訊息（升級通知等）不要經過這裡。
 */
export async function resolveMentions(guild, payload) {
  if (!guild || !payload) return payload;
  const embeds = (payload.embeds ?? []).map((e) => e?.toJSON?.() ?? e);
  const ids = new Set();
  collectIds(payload.content, ids);
  collectIds(embeds, ids);
  if (ids.size === 0) return payload;

  const users = await resolveUsers(guild, [...ids]);
  const labels = new Map([...ids].map((id) => [id, userLabel(users.get(id))]));
  const out = { ...payload };
  if (payload.content) out.content = clip(replaceIn(payload.content, labels), 2000);
  if (payload.embeds) out.embeds = embeds.map((e) => fitEmbed(replaceIn(e, labels)));
  return out;
}

/** 先 defer 再回覆，查名字花的時間不會超過互動的 3 秒期限 */
export async function replyResolved(interaction, payload, { ephemeral = true } = {}) {
  if (!interaction.deferred && !interaction.replied) {
    await interaction.deferReply(ephemeral ? { flags: 64 } : {});
  }
  const resolved = await resolveMentions(interaction.guild, payload);
  return interaction.editReply({ ...resolved, allowedMentions: { parse: [] } });
}
