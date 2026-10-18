# GymBot setup

Do these steps once. Copy `.env.example` to `.env.local` if you work without Vercel env pull.

## 1. Telegram bot
1. In Telegram, open @BotFather and send `/newbot`. Copy the token to `TELEGRAM_BOT_TOKEN`.
2. Get your numeric user ID (for example from @userinfobot). Put it in `ALLOWED_TELEGRAM_USER_ID`.
3. Open a chat with your new bot and press Start. The bot cannot message you before this.

## 2. Supabase
1. Create a new project. Choose an EU region (this project is in eu-west-1, Ireland; keep `regions` in vercel.json next to it: `dub1`).
2. Go to Connect, then Connection string.
3. Copy the **Session pooler** URI (port 5432) to both `DATABASE_URL` and `MIGRATION_DATABASE_URL`.
   Do not use the transaction pooler (6543): postgres-js pipelines concurrent queries and it hangs.
   The direct host is IPv6 by default (IPv4 is a paid add-on), so use the session pooler.
4. In both URIs, replace `[YOUR-PASSWORD]` with your database password. Percent-encode special
   characters in the password (for example `@` becomes `%40`, `#` becomes `%23`).
   The pooler user is `postgres.<project-ref>`, not plain `postgres`.

Examples (host depends on your region):

```
DATABASE_URL=postgresql://postgres.abcdefghij:PASSWORD@aws-0-eu-west-1.pooler.supabase.com:5432/postgres
MIGRATION_DATABASE_URL=postgresql://postgres.abcdefghij:PASSWORD@aws-0-eu-west-1.pooler.supabase.com:5432/postgres
```

## 3. API keys
- Anthropic: create a key at console.anthropic.com. Put it in `ANTHROPIC_API_KEY`.
- Voice notes (speech to text):
  1. Create a key at console.groq.com (API Keys). Put it in `GROQ_API_KEY`.
  2. Set `STT_PROVIDER=groq` (default model `whisper-large-v3-turbo`). To use OpenAI instead, set `STT_PROVIDER=openai` and `OPENAI_API_KEY` (`whisper-1`).
  3. Optional: `STT_DAILY_SECONDS_CAP` (default 1800) is the most voice seconds transcribed per day. A single note is limited to 120 s.
  4. Add the same variables in Vercel. Without a key, voice notes get a "voice isn't configured" reply and text still works.
- Migration 0006 (`job_runs`, and `input_source`/`transcript` on `pending_actions`) is needed for M6. Apply it with `pnpm db:migrate` only after the user's OK.

## 4. Secrets
Generate two random secrets:

```
openssl rand -hex 32   # TELEGRAM_WEBHOOK_SECRET
openssl rand -hex 32   # CRON_SECRET
```

## 5. Vercel
1. `pnpm dlx vercel link`
2. Add every variable from `.env.example` except `TEST_DATABASE_URL` in the Vercel dashboard (Settings, Environment Variables)
   for Production and Development.
3. `pnpm dlx vercel env pull .env.local`

## 6. Local database (Docker)
```
pnpm db:up
```
This starts Postgres 17 on port 54329 with databases `gymbot` and `gymbot_test`.
Test URL: `postgres://postgres:postgres@localhost:54329/gymbot_test`.
`docker/init-db.sql` runs only when the volume is first created. To reset, run `docker compose down -v`.

## Restore from a backup
Use this when the Supabase project is lost. The restore script writes only into an empty database that is already migrated. It refuses anything else.

1. Create a new Supabase project. Copy its session pooler URI (port 5432).
2. Migrate it: `MIGRATION_DATABASE_URL=<new URI> pnpm db:migrate`.
3. Download the latest backup file from the Telegram chat (the Sunday message).
4. Dry run. It does everything and rolls back:
   ```
   RESTORE_DATABASE_URL=<new URI> pnpm backup:restore <file> --allow-remote --dry-run
   ```
   Check the target, the backup date and age, and the row counts.
5. Ask yourself if the age is acceptable: data written after the backup date is lost. Then run the same command without `--dry-run`.
6. In Vercel, set `DATABASE_URL` to the new URI and redeploy.
7. Check `/api/health` (see Verify).

Each remote write (migrate, restore, Vercel change, redeploy) needs your explicit OK.

`RESTORE_DATABASE_URL` has no fallback, so a restore can never hit the database in `DATABASE_URL` by mistake. A host that is not local needs `--allow-remote`.

Local rehearsal (restore into a third, empty database, never the one you backed up):
1. `pnpm db:up`. If the local `gymbot` database is empty, migrate it: `MIGRATION_DATABASE_URL=postgres://postgres:postgres@localhost:54329/gymbot pnpm db:migrate`.
2. `DATABASE_URL=postgres://postgres:postgres@127.0.0.1:54329/gymbot pnpm backup` (writes a file in `backups/`). Set `DATABASE_URL` here because `.env.local` holds production. Backing up production instead is read-only, but only do it with your OK.
3. Create an empty database: `docker exec gymbot-db-1 psql -U postgres -c "create database gymbot_restore"`.
4. Migrate it: `MIGRATION_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:54329/gymbot_restore pnpm db:migrate`.
5. Dry run: `RESTORE_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:54329/gymbot_restore pnpm backup:restore backups/<file>.json --dry-run`.
6. The same command without `--dry-run`.

After deploying M9, run `pnpm telegram:setup <url>` so `/usage` and `/export` appear in the command menu.

## Verify
1. `pnpm check:setup`. Every line should show a green check.
2. Deploy: `pnpm dlx vercel deploy --prod` (or push to the connected Git branch).
3. Check the health endpoint:
   ```
   curl -H "Authorization: Bearer $CRON_SECRET" https://<your-app>.vercel.app/api/health
   ```
   Expected: `{"ok":true,"db":"up","time":...}`. Without the header you get 401.
4. `pnpm demo:m0`. A message "GymBot setup OK" arrives in Telegram.

Not part of M0: webhook registration (`setWebhook` with the secret token) and the
cron-job.org scheduler come in milestone 2.

## Vercel limits
Checked on 2026-10-17 at https://vercel.com/docs/functions/configuring-functions/duration
(page last updated 2026-08-24).

With Fluid compute (on by default), the function duration on the Hobby plan is:

| Plan | Default | Maximum |
|------|---------|---------|
| Hobby | 300 s | 300 s |

So `maxDuration: 90` for the Telegram webhook is allowed on Hobby (a Claude loop can take about 40 s).
SPEC rule: lease = maxDuration + 60 s. With maxDuration 90 s the lease is 150 s.
Set `maxDuration` per function in `vercel.json` (`functions`) when the webhook is added in M2.
