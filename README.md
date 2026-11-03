# catmemes, standalone

Self-hosted port of the Cloudflare worker: the same page, the same API, but
running on **Node 24 + Hono + Kysely + SQLite** (Node's built-in `node:sqlite`,
no native addons) with media stored as plain files.

| worker                 | standalone                                            |
| ---------------------- | ----------------------------------------------------- |
| D1 (`gatos`)           | SQLite file, `DB_PATH` (default `./data/gatos.db`)     |
| R2 (`gatoStore`)       | directory, `MEDIA_DIR` (default `./data/media`)        |
| KV `feed-token`        | `FEED_TOKEN` environment variable                      |
| static assets `page/`  | `public/` served by Hono                               |

URLs are unchanged (`/r2/<key>` for media, `/feed/r2/<key>` and `/feed/post`
for the feeder, `/api/*` for the page), so the frontend and the feeder scripts
work as they are.

## Layout

```
src/server/   Hono app (index.ts), route logic (api.ts), schema (db.ts), node:sqlite adapter
src/page/     frontend, bundled by esbuild into public/index.js
public/       index.html, styles.css, favicon.png (+ built index.js)
scripts/      backup, restore, password reset, Telegram importer, transcript import
deploy/       systemd units (server, import timer) and nginx server block
```

The server runs its TypeScript sources directly through Node's type stripping,
so there is no server build step. Only the page needs bundling (`npm run build`).

## Local run

```bash
npm install
npm run build
cp .env.example .env     # set FEED_TOKEN, COOKIE_SECURE=false for plain http
npm start                # http://127.0.0.1:3000
```

`npm run dev` rebuilds the page on change and restarts the server on change.
`npm run typecheck` type-checks the server and scripts.

On first start with no database the schema is created along with the user
`admin` with an empty password. Sign in, then change it from the dashboard.
A forgotten password is reset from the shell, which also ends every session
of that user:

```bash
node --env-file-if-exists=.env scripts/reset-pw.ts admin 'new password'
```

## Ubuntu VPS deployment

```bash
# Node 24
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt-get install -y nodejs nginx

# app
sudo useradd --system --home /opt/catmemes --shell /usr/sbin/nologin catmemes
sudo mkdir -p /opt/catmemes && sudo chown catmemes:catmemes /opt/catmemes
sudo -u catmemes git clone <repo> /opt/catmemes/src-checkout   # or rsync this directory
# ... place the contents of standalone/ in /opt/catmemes, then:
cd /opt/catmemes
sudo -u catmemes npm ci
sudo -u catmemes npm run build
sudo -u catmemes cp .env.example .env && sudo -u catmemes nano .env   # FEED_TOKEN!

# service
sudo cp deploy/catmemes.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now catmemes
sudo journalctl -u catmemes -f

# reverse proxy + TLS
sudo cp deploy/nginx.conf /etc/nginx/sites-available/catmemes
sudo sed -i 's/memes.example.com/your.domain/' /etc/nginx/sites-available/catmemes
sudo ln -s /etc/nginx/sites-available/catmemes /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo apt-get install -y certbot python3-certbot-nginx
sudo certbot --nginx -d your.domain
```

## Backup and restore

A backup is one `.tar.gz` with the database and every media file. It can be
taken while the service is running: the database is copied with SQLite's
`VACUUM INTO`, which gives a consistent snapshot.

```bash
sudo -u catmemes npm run backup                            # ./backups/catmemes-<timestamp>.tar.gz
sudo -u catmemes npm run backup -- /var/backups/catmemes/  # into a directory
```

Restoring replaces the database and merges media. Files from the archive are
added or overwritten, and files that exist only on disk are kept. The current
database is kept next to it as `gatos.db.before-restore-<timestamp>`. The
script refuses to run while the server answers, so stop it first:

```bash
sudo systemctl stop catmemes
sudo -u catmemes npm run restore -- backups/catmemes-20261012-040000.tar.gz
sudo systemctl start catmemes
```

The archive is checked before anything is replaced. A truncated file or a
database that fails SQLite's integrity check aborts the restore with the
current database untouched. Entries outside `media/` with unexpected names
are ignored. The archives are plain tar files, so `tar -tzf` lists them.

For nightly backups, add a line to the service user's crontab
(`sudo crontab -u catmemes -e`), pruning archives older than two weeks:

```
0 4 * * * cd /opt/catmemes && node --env-file-if-exists=.env scripts/backup.ts >> backups/backup.log 2>&1 && find backups -name 'catmemes-*.tar.gz' -mtime +14 -delete
```

## Importing posts from Telegram

`npm run fetch` (`scripts/fetch-posts.ts`) reads the channel named by
`TG_CHANNEL` with a regular Telegram account and writes new posts straight
into the database and the media directory. No HTTP, no feed token. The old
`/feed/*` endpoints still exist for the external feeder; leave `FEED_TOKEN`
unset to disable them.

### One-time setup

1. Create an application at https://my.telegram.org to get an api id and hash.
2. On your own machine, sign in once and copy the printed session string:

   ```bash
   TG_API_ID=... TG_API_HASH=... node scripts/tg-login.ts
   ```

   The string is full access to that account, so use a throwaway account.
   Reading a public channel needs nothing special.
3. Put `TG_API_ID`, `TG_API_HASH` and `TG_SESSION` into `.env` on the server.
4. Install the timer, which runs the import daily at 05:00 as the service user:

   ```bash
   sudo cp deploy/catmemes-fetch.service deploy/catmemes-fetch.timer /etc/systemd/system/
   sudo systemctl daemon-reload
   sudo systemctl enable --now catmemes-fetch.timer
   sudo systemctl start catmemes-fetch.service    # one run right now
   systemctl list-timers catmemes-fetch.timer     # when the next run is
   journalctl -u catmemes-fetch -n 50
   ```

`npm ci` prints warnings about skipped install scripts (`bufferutil`,
`utf-8-validate`); those are optional native speed-ups and the importer works
without them.

### How it stays exact

Telegram occasionally times out on a download. The importer is built so a
hiccup can only delay posts, never skip them or leave media missing:

- Posts are handled in id order and the run stops at the first post whose
  media could not be fetched after three retries (3 s, 10 s, 30 s apart, 60 s
  timeout each). The script exits 1 and the next run starts at that post.
- A post row is written only after every one of its media files is on disk,
  so the page never shows a post with a missing picture.
- The cursor (highest message id fully handled) is stored in the `meta` table
  as `tg-cursor` and only moves past posts that were stored or had nothing to
  store (text-only and video messages are skipped, as before). On the first
  run it is derived from the newest post in the database; if that post is an
  album, the cursor is placed after the album's last message so it is not
  imported again.
- An album arrives as several messages. A post is imported once its messages
  are at least two minutes old and it does not touch the end of a full batch
  of 100, where the rest of it may still be beyond the window.
- When anything was imported, the tag coverage snapshot is recomputed, since
  new posts shift every page.

Media is saved as the channel's 800 px rendition under
`tg<message id>-<index>`, like the old feeder did; converting to WebP is left
to your own script.

## Search by picture contents

The search bar on the posts tab searches the text found in the pictures and
a list of keywords describing them, both produced by the transcriber bot
(@cats_po_rzhat_bot, linked in the sidebar and credited above the results).
Tag search moved to the tags tab: typing there narrows the tag list, Enter
or the button lists the posts with that tag. Links look like `#q=<text>`
and `#tag=<name>`.

### Storage

Transcripts live in their own table, one row per Telegram message, i.e. per
picture. An album is one post here but several messages there, each with its
own transcript, and the bot usually transcribes a picture before the daily
import has fetched its post. `transcripts.post` names the post once it is
known: when a transcript arrives for a known post, or when the importer
stores a post (it links waiting transcripts of all the album's messages).

### How matching works

- Words are lower-cased, `ё` is folded to `е`, and Russian words are
  reduced to their stem with the Snowball stemmer, so `врачом` finds
  `врач` and `коробке` finds `коробка`. The stems go into an SQLite FTS5
  index; results are ranked by relevance (bm25), newest first among equals.
- A query word missing from the index is widened to words starting with it
  and to indexed words one typo away (two for long words), so `инжинер`
  still finds `инженер`.
- Every word has to match. If no post has them all, the posts with most of
  them are listed instead. Prepositions and conjunctions in a query are
  ignored.
- Words found on different pictures of one album count for the album.

### Initial import

The bot's database (`memes-<date>.db`) is imported once. It is safe to run
while the service is up and to run again: entries are replaced, not added
twice.

```bash
sudo -u catmemes npm run import-transcripts -- /path/to/memes-2026-11-03.db
```

It reads `channel_memes` for the channel in `TG_CHANNEL` (keywords) with the
text of its latest `meme_ocr` pass. Manually added memes there have no
channel post and are skipped. Pictures the archive does not have stay
unlinked and simply never show up.

### Endpoint for the bot

`POST /api/transcript` adds or replaces the transcript of one message. It is
protected by its own secret, `TRANSCRIPT_TOKEN`, sent as the
`x-transcript-token` header; without it the endpoint answers 503.

```bash
curl -X POST https://your.domain/api/transcript \
  -H "x-transcript-token: $TRANSCRIPT_TOKEN" -H "content-type: application/json" \
  -d '{"message": 16859, "text": "МАМА: ОН БУДЕТ ВРАЧОМ", "keywords": ["кот", "врач"]}'
```

- `message`: the message id in the channel (an album's pictures have their own).
- `text`: the text in the picture, up to 8000 characters; may be empty.
- `keywords`: a list of strings, or one comma-separated string like the
  bot's `channel_memes.tags`; optional, up to 300 of up to 200 characters.

The answer is `{"post": "tg16859" | null, "replaced": true | false}`; `post`
is null while the post has not been imported yet. Bad input answers 400 with
a short reason, a wrong or missing token 401.

## Tag suggestions

Visitors who are not signed in can propose tags; admins promote or discard them.

- **Getting a token.** The "предложить теги" button asks `/api/suggest/token`
  for a suggester token, stored as an HttpOnly cookie for 7 days. Only one
  token is handed out publicly per 6 hours across the whole site; others see
  how long to wait. Admins can bypass this with "issue suggester link", which
  produces a `/#suggest=<token>` link to give to someone. Opening it stores
  the token and switches the page into suggestion mode.
- **Suggesting.** In suggestion mode every post shows a tag input. Suggestions
  live in their own `suggestions` table until approved. Each token can make up
  to 300, names are capped at 64 characters, and a tag the post already has
  (regular or suggested) is refused.
- **Search and tag list.** Tag search goes by name and also finds posts
  where the name is a pending suggestion. The tag list shows pending counts
  as an italic `+N` next to the approved count, and names that exist only as
  suggestions get a dashed outline. Search URLs are now `#tag=<name>`; old
  `#search=<id>` links still work and are rewritten on load. The API still
  accepts a numeric `search` as a tag id.
- **Voting.** Suggested tags render with a dashed outline. The author sees a
  delete button; everyone else sees − and +. Votes are keyed by a salted hash
  of the client address, so one vote per address, and getting a token does not
  grant a second vote. Behind nginx the address comes from `X-Real-IP`, which
  is trusted only when the request arrives from loopback.
- **Moderation.** Signed-in admins see `+up −down` tallies with approve and
  reject buttons on every suggested tag, and "posts with suggestions" filters
  the list down to the review queue. Approving goes through the regular tag
  attach logic; attaching the same tag by hand also clears the suggestion.

Tallies are only sent to admins. Votes, suggestions and tokens can be wiped
with plain SQL (`DELETE FROM votes; DELETE FROM suggestions; ...`) without
touching real tags.

## Tag coverage chart

Every visitor sees a contribution-style grid under the posts: one cell per
page of the full feed, ten pages per column, shaded by how many posts on that
page have at least one tag. Hover for the exact count, click a cell to jump to
that page (this leaves any active search). The numbers are a stored snapshot
that comes with every `/api/posts` response. It changes only when an admin
presses "recalculate tag coverage" (`recalculateCoverage: true`), and the
chart shows when that last happened. Until the first recalculation there is
no chart.

## Tag management

Signed-in admins get a "Tags" block in the dashboard:

- **Rename.** Type the tag (the field autocompletes from the tag list) and
  the new name. If the new name is already a tag, the page asks whether to
  merge: every post of the old tag gets the new one, posts that had both keep
  one, and the old tag disappears. Pending suggestions of the old name are
  renamed too, unless the post already has the new tag or the same name
  suggested. A search for the old name follows the rename.
- **Delete everywhere.** Removes the tag from every post and drops pending
  suggestions of the same name, after a confirmation that shows the post
  count. This cannot be undone, so take a backup first when in doubt. The
  stored coverage snapshot is recomputed on the way, since whole pages may
  have lost their only tag.

Both go through `/api/tag/rename` and `/api/tag/delete`, one transaction
each. Removing a tag from a single post is still a right click on it.

## Behaviour notes

- Node's bundled SQLite is compiled with `SQLITE_DQS=0`, so string literals in
  raw SQL must be single-quoted. The one such literal in the posts query was
  adjusted; D1 accepted either.
- Media responses now carry a sniffed `content-type` and a long-lived
  `cache-control`, and missing keys answer 404 instead of an empty 200.
- Indexes are created on startup (`CREATE INDEX IF NOT EXISTS`): a unique
  one on `pairs(post, tag)` (duplicate rows from before it existed are
  folded first), `pairs(tag)`, `posts(time, id)` for the feed order and
  `suggestions(name)` for search and pending counts. The D1 schema had none.
- Passwords are stored as salted scrypt hashes. Rows from the worker era hold
  an unsalted SHA-512 digest; those still sign in and are re-hashed on the
  first successful sign-in.
- The worker's `/proxy` endpoint, which fetched any URL given to it, is
  gone; nothing in the page used it.
- `TG_CHANNEL` names the Telegram channel the feeder pulls from; it is only
  used to build the "source" link of new posts.
- The suggestion tables (`suggesters`, `suggestions`, `votes`, `meta`) are
  created on startup with `CREATE TABLE IF NOT EXISTS`, so existing databases
  upgrade by restarting the service.
- Posts with the same `time` are now ordered by id as a tie-breaker, so pages
  and the coverage chart agree. Attaching a tag a post already has no longer
  creates a duplicate pair.
- After tagging, the page used to fall back to a full reload when the set of
  posts changed. It now re-renders the list instead, which keeps the admin
  session and filters.

### Troubleshooting the unit

`Failed to load environment files: No such file or directory` means systemd
could not see the file named in `EnvironmentFile=`. Check two things:

1. The path matches where you actually put the app. `systemctl cat catmemes`
   shows the unit as installed, `sudo ls -la /opt/catmemes` shows the files
   (`ls` hides dotfiles without `-a`).
2. The app is not hidden by the sandbox. systemd loads `EnvironmentFile=` only
   after applying `ProtectHome=`/`ProtectSystem=`, so an install under `/home`
   with `ProtectHome=true` fails exactly like this. Use `ProtectHome=read-only`
   (the shipped default) or remove the line, and make sure `ReadWritePaths=`
   names the real `data/` directory.

After editing the unit: `sudo systemctl daemon-reload && sudo systemctl restart catmemes`,
then `journalctl -u catmemes -n 50`.
