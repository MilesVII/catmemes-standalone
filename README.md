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
src/server/   Hono app, routes (api.ts is the worker's api.ts verbatim), node:sqlite adapter
src/page/     frontend, copied from the worker project unchanged
public/       index.html, styles.css, favicon.png (+ built index.js)
scripts/      one-off migration helpers
deploy/       systemd unit and nginx server block
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
`admin` with an empty password (same as the worker's `create` migration).
Sign in, then change it from the dashboard.

## Migrating from Cloudflare

1. Export D1 and load it (the dump must go into a fresh database):

   ```bash
   wrangler d1 export gatos --remote --output=backup.sql   # in the worker project
   npm run db:import -- ../backup.sql                      # add --replace to overwrite
   ```

2. Pull media from the still-running worker into `MEDIA_DIR` (resumable):

   ```bash
   npm run media:pull -- https://catmemes.<account>.workers.dev
   ```

   Alternatively `rclone sync` the R2 bucket straight into `MEDIA_DIR`; keys
   map 1:1 to file names.

3. Point the feeder at the new host and give it the same `x-feed-token` value
   you put into `FEED_TOKEN`.

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

Back up `data/` (the SQLite file plus `media/`). SQLite runs in WAL mode, so
copy the database with `sqlite3 data/gatos.db ".backup backup.db"` rather than
`cp` while the service is running.

## Behaviour notes

- Node's bundled SQLite is compiled with `SQLITE_DQS=0`, so string literals in
  raw SQL must be single-quoted. The one such literal in the posts query was
  adjusted; D1 accepted either.
- Media responses now carry a sniffed `content-type` and a long-lived
  `cache-control`, and missing keys answer 404 instead of an empty 200.
- Two indexes on `pairs(post)` and `pairs(tag)` are created on startup
  (`CREATE INDEX IF NOT EXISTS`); the D1 schema had none.
- `/proxy` still fetches an arbitrary URL supplied by the caller, exactly as
  before. Consider restricting it if the host should not reach internal
  networks.
