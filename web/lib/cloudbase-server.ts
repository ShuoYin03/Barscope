import 'server-only'
import cloudbase from '@cloudbase/node-sdk'

// Same Tencent CloudBase environment the WeChat Mini Program uses (miniprogram/app.ts). Server-to-
// server calls (Node SDK + API key) aren't subject to the Web安全域名/CORS check that the browser
// JS SDK requires — that check only applies to browser-origin requests, and adding a domain to
// that allowlist is gated behind a paid plan on this environment. Calling from the Next.js server
// instead sidesteps it entirely, for free, and keeps the env ID / credentials off the client.
const ENV_ID = 'dev021031-d3guj7zom3f13f9e8'

let app: ReturnType<typeof cloudbase.init> | null = null

function getApp() {
  if (!app) {
    const secretId = process.env.CLOUDBASE_SECRET_ID
    const secretKey = process.env.CLOUDBASE_SECRET_KEY
    if (!secretId || !secretKey) {
      throw new Error('Missing CLOUDBASE_SECRET_ID / CLOUDBASE_SECRET_KEY environment variables (see web/README.md)')
    }
    app = cloudbase.init({ env: ENV_ID, secretId, secretKey })
  }
  return app
}

export async function callFunctionServer<T = any>(name: string, data?: Record<string, any>): Promise<T> {
  const res = await getApp().callFunction({ name, data: data || {} })
  return res.result as T
}
