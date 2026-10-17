# GymBot setup

Do these steps once. Copy `.env.example` to `.env.local` if you work without Vercel env pull.

## 1. Telegram bot
1. In Telegram, open @BotFather and send `/newbot`. Copy the token to `TELEGRAM_BOT_TOKEN`.
2. Get your numeric user ID (for example from @userinfobot). Put it in `ALLOWED_TELEGRAM_USER_ID`.
3. Open a chat with your new bot and press Start. The bot cannot message you before this.

## 2. Supabase
1. Create a new project. Choose an EU region (this project is in eu-west-1, Ireland; keep `regions` in vercel.json next to it: `dub1`).
2. Go to Connect, then Connection string.
3. Copy the **Transaction pooler** URI (port 6543) to `DATABASE_URL`.
4. Copy the **Session pooler** URI (port 5432) to `MIGRATION_DATABASE_URL`.
   The direct host is IPv6 by default (IPv4 is a paid add-on), so use the session pooler.
5. In both URIs, replace `[YOUR-PASSWORD]` with your database password. Percent-encode special
   characters in the password (for example `@` becomes `%40`, `#` becomes `%23`).
   The pooler user is `postgres.<project-ref>`, not plain `postgres`.

Examples (host depends on your region):

```
DATABASE_URL=postgresql://postgres.abcdefghij:PASSWORD@aws-0-eu-west-1.pooler.supabase.com:6543/postgres
MIGRATION_DATABASE_URL=postgresql://postgres.abcdefghij:PASSWORD@aws-0-eu-west-1.pooler.supabase.com:5432/postgres
```

## 3. API keys
- Anthropic: create a key at console.anthropic.com. Put it in `ANTHROPIC_API_KEY`.
- Groq or OpenAI: needed later (voice, milestone 6). Set `STT_PROVIDER` and the matching key.

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

So `maxDuration: 60` for the Telegram webhook is allowed on Hobby.
SPEC rule: lease = maxDuration + 60 s. With maxDuration 60 s the lease stays 120 s.
Set `maxDuration` per function in `vercel.json` (`functions`) when the webhook is added in M2.
