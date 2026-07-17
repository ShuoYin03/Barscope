# Barscope Web

Next.js App Router + TypeScript web foundation for Barscope / 韵镜.

## Local development

```bash
cd web
npm install
npm run dev
```

Then open `http://localhost:3000`.

## Current routes

- `/` — homepage foundation
- `/albums` — album library placeholder
- `/reviews` — community reviews placeholder
- `/artists` — artist directory placeholder
- `/features` — editorial placeholder
- `/profile` — profile placeholder

## Data layer

The web app shares the same Tencent CloudBase environment as the WeChat Mini
Program, but talks to it server-side instead of from the browser:

- `lib/cloudbase-server.ts` — server-only `@cloudbase/node-sdk` client,
  authenticated with a CloudBase API key (`CLOUDBASE_SECRET_ID` /
  `CLOUDBASE_SECRET_KEY`). Never imported from client components.
- `app/api/cloud-function/route.ts` — a same-origin API route that proxies
  `callFunction` requests to CloudBase using the server credentials above. Only
  a fixed allowlist of read-only, public cloud functions can be called through
  it (see `ALLOWED_FUNCTIONS` in that file).
- `lib/cloudbase.ts` — the client-side `callFunction(name, data)` helper that
  components import; it just `fetch`s the API route above.

This avoids CloudBase's browser Web SDK entirely, which sidesteps the
Web安全域名 (CORS domain allowlist) requirement — adding domains to that
allowlist requires a paid CloudBase plan on this environment.

### Local setup

1. In the CloudBase console, go to **API Key 配置** and create a SecretId /
   SecretKey pair.
2. Create `web/.env.local` (already gitignored) with:
   ```
   CLOUDBASE_SECRET_ID=your-secret-id
   CLOUDBASE_SECRET_KEY=your-secret-key
   ```
3. Restart `npm run dev`.

## Next phase

1. Reuse remaining album, review, artist, feature and user data from the Mini
   Program backend (reviews feed, artist directory, editorial features).
2. Add dynamic routes for albums, artists and editorial stories.
3. Add responsive mobile navigation and authentication.
