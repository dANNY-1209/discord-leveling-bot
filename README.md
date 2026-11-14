# Discord Leveling Bot

自架 Discord 等級系統，對標 MEE6 Levels plugin。範圍只有 **XP / 等級 / 排行榜 / 等級角色**。
規格來源：`~/Discord-Leveling-Bot-Handoff.docx`（v1.0, 2026-09-25）。

## 這是 gateway bot

**不對外開任何 port。** Bot 主動連出去跟 Discord 開 WebSocket，訊息從那條連線推進來。
所以不需要 DSM 反代、domain、憑證或防火牆規則——Developer Portal 的
**Interactions Endpoint URL 要留空**（填了會切成 HTTP 模式，就收不到 `messageCreate`，XP 永遠是 0）。

## 檔案位置

| 用途 | 路徑 |
|---|---|
| 源碼 | `deployments/discord-leveling-bot/` |
| SQLite 資料（**XP 全在這，要備份**） | `deployment_datas/discord-leveling-bot/leveling.db` |
| Token 等機密 | `deployment_secret_files/discord-leveling-bot/bot.env`（`chmod 600`） |

## 部署

```sh
cd /volume1/homes/dannyho/deployments/discord-leveling-bot
sudo docker compose up -d --build
sudo docker logs -f discord-leveling-bot
```

開機時會自動把 slash command 重新註冊一次（冪等）。`GUILD_ID` 有填 → 註冊到該伺服器，秒生效；
留空 → 全域註冊，最多等約 1 小時。要關掉自動註冊就設 `AUTO_DEPLOY_COMMANDS=0`。

改完程式碼：`sudo docker compose up -d --build`。

## 環境變數（`bot.env`）

| 變數 | 說明 |
|---|---|
| `DISCORD_TOKEN` | Bot token，必填 |
| `CLIENT_ID` | Application ID（`1552974970512998410`） |
| `GUILD_ID` | 目標伺服器 ID。開發期建議填，slash command 秒生效 |
| `SQLITE_PATH` | 預設 `/data/leveling.db` |
| `AUTO_DEPLOY_COMMANDS` | 設 `0` 關掉開機自動註冊指令 |

## Discord 端的前置設定

1. Developer Portal → Bot → 開啟 **Message Content Intent** 與 **Server Members Intent**。
   Portal 開了還不夠，程式碼也宣告了同一組 intent，兩邊缺一不可（本專案已宣告）。
2. 邀請連結（權限已算好）：
   ```
   https://discord.com/oauth2/authorize?client_id=1552974970512998410&scope=bot%20applications.commands&permissions=2416036864
   ```
   含 View Channels / Send Messages / Embed Links / Attach Files / Read Message History /
   Manage Roles / Use Application Commands。**沒有 Administrator**。
   要用 `/dupe` 刪重複連結還需要 **Manage Messages**，可以直接在伺服器設定把這個權限給 Bot 的角色，
   或用含該權限的邀請連結重新授權一次（`permissions=2416045056`）。
3. **把 Bot 的角色拖到所有等級獎勵角色之上。** Discord 只允許 Bot 管理比自己低的角色，
   這是等級角色最常見的失敗原因。`/level-config view` 會直接標出哪幾級會失敗。

## 指令

| 指令 | 權限 | 說明 |
|---|---|---|
| `/rank [user]` | 全員 | 等級、排名、本級進度條、總 XP |
| `/leaderboard [page]` | 全員 | 每頁 10 名 |
| `/give-xp user amount` | Manage Server | 加 XP，會觸發升級與角色 |
| `/remove-xp user amount [strip-roles]` | Manage Server | 扣 XP，等級下修 |
| `/set-level user level` | Manage Server | 直接設等級，XP 歸該級起點，角色自動對齊 |
| `/reset-xp user\|all` | Manage Server | 重置；`all` 需按鈕二次確認（60 秒逾時） |
| `/sync-roles` | Manage Server | 依資料庫重發一次角色，補歷史錯誤 |
| `/level-config …` | Manage Server | 見下 |
| `/trigger …` | Manage Server | 關鍵字自動回應（貼圖／轉發連結），見下 |
| `/dupe …` | Manage Server | 分區連結去重：同一區貼過的連結再貼就刪，見下 |
| `/ai-filter …` | Manage Server | 指定頻道過濾 pixiv／X 的 AI 創作者連結與 tag，見下 |

### `/level-config` 子指令

`view`、`toggle`、`announce`、`xp-rate`、`cooldown`、`xp-range`、`min-length`、
`ignore-channel`、`ignore-role`、`ignore-user`、`reward-add`、`reward-remove`、`reward-mode`、
`defer`、`duplicates`、`member-age`、`sticker-emoji`、`media-channel`、`media-bonus`、`link-bonus`、`link-domain`、`reaction-xp`

- `ignore-channel` 選**分類**的話，整個分類底下的頻道都不給 XP。
- `ignore-user` 把個別成員排除在系統外：不累積 XP、不出現在 `/leaderboard`、不佔名次、
  `/sync-roles` 也不動他的角色。現有 XP 預設**保留**（移除排除就原樣回來），加 `purge:true` 才清掉。
  已發出去的等級角色不會自動收回。`/rank` 查他會顯示「已排除」。
- `reward-mode`：`stack`（到達過的角色都保留，勳章牆）或 `replace`（只留最高一階）。
- `announce` 文案變數：`{user}` `{username}` `{level}` `{old_level}` `{xp}` `{rank}`。

## 防刷（Handoff 第 17 節，v1.1）

核心是**延遲入帳**：訊息通過前置檢查後不立刻加 XP，先排 `defer_seconds`（預設 20 秒）的 pending，
到期且沒被刪掉才真的入帳。所以「發一句立刻刪」拿不到 XP。

| 攻擊手法 | 對策 | 設定 |
|---|---|---|
| 發一句立刻刪 | 延遲 20 秒入帳，`messageDelete` 取消 pending | `/level-config defer` |
| 冷卻內連發再全刪 | 鎖打在「成功入帳」而非「發訊」；同時只准 1 則 pending | `max_pending_per_user` |
| 複製貼上同一句 | 跟本人上次入帳的內容 hash 比對，相同不給 | `/level-config duplicates` |
| 「1」「ok」洗頻 | 最短字數，預設 5（正規化後計字） | `/level-config min-length` |
| 純貼圖／純 emoji | 扣掉表情後沒有實質文字就不給 | `/level-config sticker-emoji` |
| Bot／Webhook 自回 | `author.bot` 或 `webhookId` 直接忽略 | 寫死 |
| 丟棄小號重進 | 進服未滿 15 分鐘不給（看 `joinedAt`） | `/level-config member-age` |

實作重點：

- **pending 只放記憶體**，重啟後消失（17.9 明確允許）。已入帳的 XP 在 DB 裡不受影響。
- **取消鍵只用 `message.id`**——刪除事件裡內容常是空的。`messageDelete` 與 `messageDeleteBulk` 都監聽。
- **只有 pending 成功轉成 XP 才寫 `last_xp_at`**，所以「發→刪→再發」不能加快速率，理論上限仍是每 60 秒一則。
- **不存訊息全文**。只存 `sha256(guildId + userId + 正規化內容)` 的前 16 hex。
- **重複比對只跟本人比**，不跟全服比——兩個人都說「早安」不會互相擋掉。
- **沒有做事後追回（clawback）**。17.4 說明了原因：跨級回滾要重算等級、可能拔角色、排行榜會跳。
  `clawback_on_delete` 欄位保留但預設 0，未實作。
- 升級公告因此會晚約 `defer_seconds`，這是 17.3 認定可接受的產品代價。

`/level-config view` 會列出全部防刷設定，關掉的項目標 ⚠️，並附本次啟動以來的計數
（入帳、因刪訊取消、重複忽略、太短、純貼圖、新成員、冷卻中、已有排隊）。

## 媒體加成（Handoff Addendum v1.2 第 18 節）

指定頻道（`#fanart`、`#clips` 之類）發**真正的圖片或影片附件**，該次入帳多給一筆固定 XP。

```
awarded = round(random(xp_min, xp_max) * xp_rate) + 頻道加成     // 最低 1
```

加成是**固定值、不乘倍率**（18.4 明說不要用倍率當預設），且**一則訊息最多加一次**——
8 張圖仍只 +20，這是本功能最容易被刷穿的寫法。

設定：

```
/level-config media-channel add channel:#fanart          # 用全域預設 +20
/level-config media-channel add channel:#clips bonus:50  # 此頻道專屬 +50
/level-config media-channel remove channel:#fanart
/level-config media-bonus value:20                       # 全域預設
```

### 什麼算合格媒體（18.3）

| 來源 | 算不算 |
|---|---|
| 附件 `contentType` 為 `image/*` 或 `video/*` | ✅ |
| `contentType` 空時看副檔名 `.png .jpg .jpeg .gif .webp .mp4 .webm .mov` | ✅ |
| 同一則多張圖／多段影片 | ✅ 但只加一次 |
| 純文字 + 外連 YouTube／Twitter | ❌ embed 太好刷 |
| Sticker／自訂表情 | ❌ 成本太低 |
| 回覆裡引用別人的圖 | ❌ 只看本則自己的 `attachments` |

### 與防刷的關係

媒體加成是「**通過第 17 節防刷之後、入帳當下多加一筆**」，不是第二條獨立冷卻：

- **共用 60 秒冷卻**，發圖不會另開一條。
- **延遲入帳同樣適用**：20 秒內把圖刪掉，基礎與加成都不給。
- **重複規則仍生效**：附件指紋 `sha256(size + filename + contentType)` 併入 `last_content_hash`，
  同一人重傳同一檔不算。
- **`has_media` 在收訊時就判定好並帶進 pending**，入帳時不回頭抓可能已被刪的附件（18.6）。
- **No-XP 名單優先**：頻道同時被排除的話完全不給，加成也不會救它。
- **帶合格媒體的訊息豁免 `min_length` 與「純貼圖／emoji」規則**，否則純圖投稿會在還沒算加成前
  就被擋掉。純文字訊息不受此豁免，所以 `#fanart` 裡打「ok」照樣不給。

`/level-config view` 會列出全域預設、每個媒體頻道的加成值、以及與 No-XP 名單衝突的 ⚠️。

## 連結加成（Owner 追加，v1.2 附件之後）

貼白名單站台的連結也給一筆加成，**走自己獨立的一條冷卻，預設 3 小時**。

> ⚠️ 這與 Addendum v1.2 的 18.3／18.5 相反——那裡把外連列為「預設不算」，理由是
> 「任何人都能貼同一個影片連結」。獨立的長 CD（預設 3 小時 → 一天最多 8 次）
> 就是對這個顧慮的緩解。這是 Owner 明確要求的決定，不是漏做規格。

**預設白名單**：`pixiv.net`、`x.com`、`twitter.com`、`rule34.xxx`、`iwara.tv`

`twitter.com` 一起放進去是因為舊連結還很多，實質同一站。比對方式是 host 完全相同或為其子網域，
所以 `www.pixiv.net`、`user.fanbox.cc` 這類都會命中。

```
/level-config link-bonus value:20 cooldown-hours:3 scope:所有頻道   # 三個參數都可單獨改
/level-config link-bonus cooldown-hours:0                          # 0 = 不另外限制（仍受 60 秒訊息冷卻）
/level-config link-domain action:add domain:fanbox.cc              # 貼整條網址也會自動收成 host
/level-config link-domain action:remove domain:twitter.com
```

`scope` 兩種：`everywhere`（預設，任何非 No-XP 頻道）或 `media-channels`（只有媒體加成頻道才算）。

行為細節：

- **一則訊息最多加一次**，同時貼 pixiv + iwara + rule34 也只 +20。
- **可與媒體加成疊加**：媒體頻道裡「一張圖 + 一條 pixiv 連結」＝基礎 + 20 + 20，兩者各自只加一次。
- **CD 擋住時只是不加這筆，基礎 XP 照給**。
- **只看訊息文字，不解析 embed**——embed 是 Discord 事後補的，收訊當下不一定有。
- 延遲入帳、重複內容、No-XP 名單、進服緩衝全部照舊適用：貼完 20 秒內刪掉就完全不給。
- 白名單清空 = 連結加成停用。`/level-config view` 會標 ⚠️，也會列出哪些預設站台被移除了。

## 表情反應 XP

有人按表情 → **按的人與被按的人各 +3 XP**（預設值），**沒有冷卻**。
次數由去重規則限制，不是由時間限制。

```
/level-config reaction-xp value:3                 # 每人幾 XP；0 = 關閉
/level-config reaction-xp dedup:整則訊息只認第一個表符
/level-config reaction-xp dedup:每個人在同一則各認一次
```

| `dedup` | 行為 |
|---|---|
| `message`（預設） | 整則訊息只認**第一個**表符，不論誰按。十個人按 → 只有第一個人和作者各拿一次 |
| `per-user` | 每個人在同一則訊息各認一次。十個人按 → 作者拿十份，每人各拿一份 |

不給的情況：

- **自己按自己**的訊息
- 被按的訊息是 **Bot／Webhook** 發的
- 頻道在 **No-XP 名單**（含分類）→ 雙方都不給
- 收款人自己在 **No-XP 成員／角色**名單，或**進服未滿緩衝時間** → 只擋他自己，對方照拿

實作細節：

- 去重靠 `reaction_awards` 表（`guild_id + message_id + reactor_id`），**落盤**，所以移除表符再按回去不會重複領。
- 用 `INSERT` 成功與否當鎖（`claimReactionAward`），同時按下也不會雙重入帳。
- **不動 `last_xp_at` 與 `last_content_hash`**：反應 XP 跟訊息的 60 秒冷卻、重複內容偵測完全分開。
- 反應 XP 也會觸發升級公告與等級角色。
- 需要 `GuildMessageReactions` intent（非特權，Portal 不用另外開）與 `Partials.Reaction`／`Partials.User`
  才收得到舊訊息的反應事件。

## 關鍵字自動回應

訊息含有指定關鍵字時，bot 自動回應——**貼圖**或**轉發一條訊息連結**。
跟 XP 系統完全獨立：不受 No-XP 名單、訊息冷卻、延遲入帳影響，也不給或扣 XP。

```
/trigger add-sticker keywords:美味, 好吃 sticker:<從清單選>
/trigger add-link    keywords:圖在哪, where link:<貼訊息連結> text:在這裡 👉
/trigger list
/trigger keywords id:1 value:delicious mode:加進現有清單
/trigger cooldown id:1 seconds:300
/trigger toggle   id:1 enabled:false
/trigger remove   id:1
```

### 貼圖模式

`sticker` 欄位有**自動完成**，開始打字就列出這個伺服器的貼圖，不用自己找 ID
（也接受直接貼 ID 或打完整貼圖名稱）。透過 Discord 的 `sticker_ids` 欄位送出，
顯示效果跟人類發的貼圖一樣，bot 用自己伺服器的貼圖不需要 Nitro。

### 連結模式

`link` 貼的是訊息跳轉連結——在 Discord 右鍵那則訊息 → **複製訊息連結**，不需要開發者模式。
Bot 把連結當純文字發出，Discord 自己展開成那則訊息的預覽（含圖片）。

新增時會先驗證：連結指向別的伺服器、頻道抓不到、訊息已被刪除都會警告，
抓得到則回報「指向 #某頻道 的一則訊息，含 N 張圖片」。
**預覽能不能展開看的是「觀看者」在那個頻道的權限**，不是 bot 的——
所以放在私密頻道的圖，沒權限的人只會看到一條點不開的連結。

非 Discord 連結也能用，會當普通網址直接貼出。`text` 可附一句話在連結前面，留空就只發連結。
發出的訊息一律不解析 mention（`allowedMentions: { parse: [] }`），所以文字裡放 `@everyone` 不會真的 ping。

### 共同行為

- 比對是**子字串**、大小寫不敏感：關鍵字 `美味` 會中「這個超級美味耶」。
- 關鍵字用逗號分隔（半角或全角都可）。一組可放任意多個關鍵字，全部指向同一個回應、共用同一條冷卻。
- **一則訊息最多回應一次**：多個關鍵字或多組觸發器同時命中，只認**編號最小**的那組。
- **冷卻以「頻道 × 觸發器」為單位**，預設 60 秒。設 0 則不限制（有洗頻風險）。
- Bot／Webhook 的訊息不觸發，避免兩隻 bot 互相觸發成迴圈。
- 貼圖被刪、連結失效、缺發言權限都只寫 log，不會讓 bot 掛掉；`list` 會標 ⚠️。
- `keywords` 子指令可就地改關鍵字（`replace`／`add`／`remove`），不動回應內容與冷卻，改完立即生效。

## 分區連結去重（`/dupe`，Owner 追加）

指定幾個區（例如**深水區**與**淺水區**），同一條連結在**同一區**貼過第二次就把訊息刪掉。
**比對範圍是「整個區」**：深水區底下有幾個頻道，同一條連結在整區只留一則（最早貼的那個頻道那則），
在別的頻道再貼一樣會被刪。**兩區各自獨立**：深水區貼過的連結，淺水區照樣能貼。跟 XP／關鍵字觸發完全無關，不給也不扣 XP。

```
/dupe watch zone:深水區 channel:#深水區          ← 單一頻道；選分類＝整個分類底下都算同一區
/dupe watch zone:淺水區 channel:#淺水區
/dupe scan  zone:深水區 per-channel:1000         ← 把既有歷史連結補進紀錄（只記錄，不刪訊息）
/dupe purge zone:深水區 per-channel:1000         ← 預覽：歷史上已經重複的有哪些（不動任何東西）
/dupe purge zone:深水區 per-channel:1000 confirm:true   ← 真的把那些重複訊息刪掉
/dupe view                                       ← 分區、監看頻道、已記筆數、統計
/dupe mode  zone:深水區 action:只提示不刪             ← 預設是靜默刪除，不通知當事人
/dupe delete-notice zone:深水區 enabled:true sticker:又不仔細看   ← 刪除時 @ 當事人、說台詞並貼出伺服器貼圖
/dupe check link:<網址>                          ← 查這條是不是已經被記下來、誰先貼的
/dupe forget link:<網址> [zone:深水區]           ← 放掉紀錄，之後可以再貼
/dupe clear zone:深水區 confirm:true             ← 清空該區紀錄（分區與監看頻道留著）
/dupe remove-zone zone:深水區 confirm:true
/dupe ignore-domain action:add domain:tenor.com
```

### 怎麼判斷「一樣」

比對的不是原始字串，是**正規化後的鑰匙**，所以換個寫法照樣擋得住：

| 這些都算同一條 |
|---|
| `x.com` / `twitter.com` / `vxtwitter` / `fxtwitter` / `fixupx` / `xcancel` 的同一則推文（也不管 `?s=20`、`/photo/1`） |
| `pixiv.net/artworks/123`、`/en/artworks/123`、舊版 `member_illust.php?illust_id=123` |
| `youtu.be/ID`、`youtube.com/watch?v=ID`、`/shorts/ID`、含 `?t=`／`?si=` 的 |
| `iwara.tv/video/<id>/標題` 去掉標題；`e-hentai` ↔ `exhentai` 同一本；`nhentai` 去頁碼 |
| rule34／gelbooru 等看 `id`；kemono 換域名（party／su／cr）算同一個；instagram `reel` ↔ `p` |
| 其他網站走通用規則：去 `www.`、去尾斜線、去 `#fragment`、砍 `utm_*`／`fbclid` 之類追蹤參數、參數排序後比對，`http` 與 `https` 同一條 |

**不列入去重**：Discord 訊息跳轉連結、以及忽略清單上的網域（預設 `tenor.com`、`giphy.com`，
反應圖不該被當重複貼文）。清單用 `/dupe ignore-domain` 增減，比對含子網域。

### 清理既有的重複（`/dupe purge`）

`scan` 只建紀錄，**不會回頭刪**上線前就已經重複的貼文。要清歷史用 `purge`：

- **不加 `confirm` 就是預覽**：回報會刪幾則、列出前 8 則（重複的那則與留下的那則各一個跳轉連結），完全不動資料也不寫紀錄。
- 加 `confirm:true` 才真的刪。會把整區所有頻道的訊息抓下來**跨頻道照時間排序**再處理，
  所以每條連結留的是**整區最早**那則（在哪個頻道都一樣），不是各頻道各留一則。
- **釘選訊息一律不動**（通常是刻意留著的），會另外回報幾則被跳過。
- 被刪的那則如果還帶了別的連結，那些連結**不佔紀錄**，會歸給後面還活著的貼文。
- 刪訊之間留 350ms，單次上限 **400 則**（避免撞到 interaction 逾時）；達到上限會提示再跑一次。
- 缺 Manage Messages 的頻道會被列出來、不刪；看不到或不能讀歷史的頻道也會列出來。
- **刪掉的訊息救不回來。** 建議先跑一次預覽看清單，再加 `confirm:true`。

### 行為細節

- **一則訊息裡只要有一條連結重複，整則就被刪**，而且這則訊息的其他連結**不會**被記錄（避免留下佔位紀錄）。
- **刪除通知**：`/dupe delete-notice` 開啟後，刪掉重複時會發一則訊息「@當事人 台詞」，並附上選定的伺服器貼圖。
  台詞預設是 `你的鏈接重複了 :DoraCare:`，可用 `message:` 改（填 `default` 恢復）；`:表情名稱:` 會換成這個伺服器的
  自訂表情，找不到就照原樣送出文字。貼圖被刪或發不出去時只發台詞。這則通知不會自動刪除；`/dupe purge` 清歷史時不發。
- **預設刪掉就不吭聲**：不通知當事人、不在頻道留任何訊息，只寫一行 log。唯一會發話的情況是
  「該刪但刪不掉」（缺 Manage Messages）或整區設成**只提示不刪**——那條提示會 mention 當事人
  並附原貼文跳轉連結，預設 20 秒後自刪（`notice-seconds:0` 連這個也關掉）。
- **原始貼文被刪 → 自動放掉那條連結**，之後同一條可以重新貼（批次刪訊同理）。
  Bot 離線時被刪、事件沒收到的那種，會在下次有人貼同一條時**現場去抓原貼文確認**，
  確定不在了就放掉紀錄並放行；只是抓不到（權限／網路）則一律當它還在，寧可擋下。
- **編輯後才貼上重複連結也會擋**；編輯掉的舊連結會從紀錄裡放掉。
- 分類與單一頻道同時設定時，**頻道的設定優先**（查找順序：討論串 → 母頻道 → 分類）。
  論壇頻道的貼文（討論串）跟著母頻道算同一區。
- **預覽 Bot 的訊息會一起刪**：重複訊息被刪時（含 `/dupe purge`），ermiana 回覆它的預覽和緊接著發的附加連結也會刪掉，比刪除晚到的也一樣。只提示不刪的模式不動它們。需要 Bot 在該頻道有「管理訊息」與「讀取訊息歷史」權限。換成別的 Bot 用環境變數 `PREVIEW_BOT_IDS`（逗號分隔的使用者 ID），設成空字串就關閉。
- Bot／Webhook 的訊息不列入去重。一個頻道只能屬於一區，重複 `watch` 會搬區並提示。
- **缺 Manage Messages 權限時刪不掉**：會退成只提示，並在提示裡與 log 寫明原因（同一頻道只警告一次）。
- `scan` 只寫紀錄、不刪任何既有訊息；掃不到的頻道（Bot 看不到或不能讀歷史）會列在結果裡。
  同一條連結留**整區最早**那則（跨頻道照時間排序後寫入）。

## AI 創作者過濾（`/ai-filter`，Owner 追加）

在指定頻道偵測 pixiv／X 上 AI 創作者的連結或 tag，命中就刪除。跟 XP／去重各自獨立；
訊息被刪時，既有的 `messageDelete` 會一併取消 pending XP 與去重紀錄。

```
/ai-filter watch channel:#繪圖分享             ← 單一頻道；選分類＝底下全部（討論串跟著母頻道）
/ai-filter log-channel channel:#mod-log        ← 建議設定，刪了什麼、為什麼都記在這裡
/ai-filter mode action:只記錄不刪              ← 試運行；確認沒誤判再改回「刪除訊息」
/ai-filter check text:<連結或 #tag>            ← 試判定，不刪任何東西
/ai-filter creator action:封鎖 target:@handle  ← 也接受作者頁／作品連結、pixiv 使用者 ID
/ai-filter creator action:放行 target:<連結>   ← 誤判時用，優先於所有自動判定
/ai-filter keyword action:add value:AIイラスト
/ai-filter view
```

### 判定規則（第一個命中就停）

| 來源 | 命中條件 |
|---|---|
| 訊息文字 | `#tag` 含清單上的關鍵字（一般句子裡提到不算，所以「這是 AI 生成嗎」不會被刪） |
| tag 連結 | `pixiv.net/tags/…`、`x.com/hashtag/…` 的 tag 含關鍵字 |
| pixiv 作品 | 封鎖名單；pixiv 官方 `aiType = 2`（AI 生成）；作品 tag 含關鍵字；或作者符合下一列 |
| pixiv 作者頁 | 封鎖名單；公開的最近作品至少 3 件、其中至少 60% 標記 AI（含 `pixiv.me` 短網址） |
| X 推文 | 封鎖名單；推文的 `#tag` 或 AI 創作者寫法；或作者簡介／顯示名稱符合下一列 |
| X 個人頁 | 封鎖名單；簡介／顯示名稱含關鍵字或 AI 創作者寫法（`3D+AI`、`AI artist`、`AI NSFW animator`、`animator using AI`、`made with AI`）；或簡介連到封鎖名單上的 Patreon／標明的小號 |
| Patreon 連結 | 只看封鎖名單 |

**疑似（只發到紀錄頻道，永遠不刪）**：X 簡介／顯示名稱單獨提到 AI、帳號有以底線分隔的 `AI` 標記（例如 `Aisora_AI`），或推文是「角色 - 作品」加一行 `sfw`／`nsfw` 的固定文案。
手繪作者也可能這樣寫，所以由管理員判斷，要擋就 `/ai-filter creator action:封鎖`。沒設紀錄頻道時只寫 log。

用 `/ai-filter creator` 封鎖 X 帳號時，簡介裡的 Patreon 與標明的小號（`SFW Acc: x.com/…` 這種）會一併封鎖，
回覆會列出來；一般提到別人的連結不會連坐。

`vxtwitter`／`fxtwitter`／`fixupx` 等鏡像站與去重共用同一份網域清單。關鍵字比對不分大小寫、全半形，
忽略空格／底線／連字號；**禁止使用／訓練 AI 的聲明不當成 AI 證據，也不因該聲明發疑似通知**。
支援中英日文，例如 `AI使用禁止`、`請不要把我的任何作品拿去餵低能AI`、`AI学習禁止`、`Do not use my artwork to train AI`。
否定只影響同一句／子句，訊息與推文的 `#tag` 也保留原句上下文；若另一句明確寫 `AI artist` 或使用 `#AIart`，仍會命中。
這是文字規則判斷；只有 `_AI` 帳號標記時只報疑似，已確認的 AI 創作者可用 `/ai-filter creator action:封鎖 target:@Aisora_AI` 加入名單。

執行 `npm test` 可驗證保護聲明、混合 AI 創作宣告、hashtag 上下文、X 名稱與帳號標記，以及刪除／放行流程；測試使用記憶體資料庫與模擬查詢。

### 限制

- **查不到就放行**：逾時、對方服務掛掉、作品已刪都不會刪訊息，只寫 log 並計入 `/ai-filter view` 的「無法判定」。
- **pixiv 是匿名查詢**：Bot 不登入，R-18 作品很可能查不到（→ 放行），作者的公開作品統計也看不到 R-18。
  封鎖名單能擋作者頁，但查不到的作品連結無法對應到作者。上線後請用 `check` 實測幾條。
- **X 沒有官方 AI 標記**：只能靠 tag、簡介與名單，沒標示的 AI 帳號要手動封鎖。
  推文資料來自第三方服務 `api.fxtwitter.com`，它停擺時 X 只剩「網址帶帳號＋封鎖名單」有效。
- **不分析圖片**：直接上傳的圖不會被判定。只處理新訊息與編輯，不回頭掃歷史。
- 查詢結果快取在記憶體（成功 6 小時、失敗 10 分鐘），重啟清空；名單與關鍵字改了立即生效。
- 單則訊息最多查 10 條連結；釘選訊息不動。刪除一律靜默，不通知當事人。需要 **Manage Messages**。

## 規則（預設值 = MEE6）

- 每則有效訊息隨機 **15–25 XP**，同一人 **60 秒冷卻**（per-user，不是全服一把鎖）。
- `xpForNext(lvl) = 5·lvl² + 50·lvl + 100`。
- 資料庫存**總累計 XP**，`level` 只是冗餘快取，一律從 `total_xp` 反推。
- 一次跨多級只公告最終等級。
- 給角色失敗只寫 log，不回滾 XP（人已經升級了，事後 `/sync-roles` 補）。
- `/give-xp`、`/set-level` 走管理通道，不受 defer／重複／最短字數限制，但仍寫 `last_xp_at`（17.8）。

> Handoff 文件第 5.2 節的 Lv.50 / Lv.100 累計值（約 189,300 / 651,500）**是錯的**。
> 實際為 **268,375** 與 **1,899,250**（閉式解與逐項加總都驗過）。
> 文件自己也註明高等級數字不該當權威，以程式為準。

## 備份

`deployment_datas/discord-leveling-bot/` 整個複製走即可（WAL 模式，連 `-wal` `-shm` 一起）。
XP 是成員情感資產，弄丟比 Bot 掛掉嚴重。建議每天一份、保留 14 天。

## 資料庫遷移

`src/lib/db.js` 開機時會自己補欄位（`ALTER TABLE`）並記在 `schema_meta`，不需要手動跑 migration。
v1.1 新增 `guild_settings` 的六個防刷欄位與 `member_levels.last_content_hash`。
v1.2 新增 `guild_settings.media_bonus_xp` 與 `media_bonus_channels` 表。
`trigger_responses` 表為關鍵字自動回應。舊的 `sticker_triggers`（只能放貼圖）會在開機時
一次性搬進新表並保留編號與冷卻，記在 `schema_meta` 的 `trigger-responses-migrated`；
舊表保留不刪，確認無誤後可自行清掉。
`reaction_awards` 表與 `guild_settings` 的 `reaction_xp`／`reaction_dedup` 為反應 XP。
`ignored_users` 表為個別成員排除（`CREATE TABLE IF NOT EXISTS`，舊 DB 開機自動建，無需手動）。
連結加成新增 `guild_settings` 的 `link_bonus_xp`／`link_bonus_cooldown_ms`／`link_bonus_scope`、
`member_levels.last_link_bonus_at`，以及 `link_bonus_domains` 表。既有伺服器會一次性寫入五個預設網域
（記在 `schema_meta` 的 `link-domains-seed`，之後自己刪掉不會被塞回來）。

連結去重新增 `dupe_zones`／`dupe_zone_channels`／`dupe_links`／`dupe_ignored_domains` 四張表
（都是 `CREATE TABLE IF NOT EXISTS`，舊 DB 開機自動建，不動既有資料）。第一次建分區時會把預設忽略網域
（`tenor.com`／`giphy.com`）寫進去，記在 `schema_meta` 的 `dupe-ignore-seed:<guild_id>`，之後自己刪掉不會被塞回來。

AI 過濾新增 `ai_filter_settings`／`ai_filter_channels`／`ai_filter_creators`／`ai_filter_keywords` 四張表
（同樣開機自動建）。預設關鍵字第一次用到時寫入，記在 `schema_meta` 的 `ai-keywords-seed:<guild_id>`，之後自己刪掉不會被塞回來。

一次性動作：既有伺服器若 `min_length` 還停在舊預設 0，會被套用為 17.11 的建議值 5，
並在 `schema_meta` 記 `v1.1-antiabuse-defaults`，所以之後 Owner 自己改回 0 不會再被蓋掉。

## 還沒做（Phase 2+）

語音 XP、Rank Card 出圖、頻道／角色個別倍率、MEE6 匯入腳本、網頁排行榜。
