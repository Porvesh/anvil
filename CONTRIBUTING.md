# Contributing

Use Node.js 20.9 or newer.

```bash
npm ci
cp .env.example .env
npm run db:migrate
npm run seed
npm run dev
```

Set `BYOK_ENCRYPTION_KEY` in `.env` to a random value of at least 32 characters.
Provider and mail credentials are optional for local development.

Before opening a pull request, run:

```bash
npm run check
npm run build
```

Keep changes focused, add tests when behavior changes, and use a conventional
commit subject such as `feat: add topic filtering` or `fix: reject expired tokens`.
