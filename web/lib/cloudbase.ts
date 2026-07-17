// Same Tencent CloudBase environment the WeChat Mini Program uses (miniprogram/app.ts) — the web
// client calls the exact same cloud functions, so there is one backend for both surfaces.
const ENV_ID = 'dev021031-d3guj7zom3f13f9e8'

let appInstance: any = null
let authReady: Promise<void> | null = null

// @cloudbase/js-sdk ships separate browser/Node builds. Next.js server-renders Client Components
// once on the server too, and its module resolution picks the Node build there — which imports
// jsonwebtoken/ws that aren't installed (they're only needed for the Node Admin SDK, not this
// anonymous browser flow). A dynamic import deferred until this code actually runs client-side
// keeps the SDK out of the server render path entirely.
function loadSdk() {
  return import('@cloudbase/js-sdk')
}

async function getApp() {
  if (!appInstance) {
    const { default: cloudbase } = await loadSdk()
    appInstance = cloudbase.init({ env: ENV_ID })
  }
  return appInstance
}

// Cloud functions are called from an authenticated context even for anonymous readers — CloudBase
// requires some signed-in identity before callFunction succeeds. The environment must have
// anonymous login enabled (云开发控制台 → 登录授权 → 匿名登录) for this to work.
function ensureAuth(): Promise<void> {
  if (!authReady) {
    authReady = getApp().then((app) => {
      const auth = app.auth({ persistence: 'local' })
      return auth.signInAnonymously().then(() => undefined)
    })
  }
  return authReady
}

// Mirrors wx.cloud.callFunction's eventual `.result` shape, so cloud function response handling
// reads the same way it does in the Mini Program.
export async function callFunction<T = any>(name: string, data?: Record<string, any>): Promise<T> {
  await ensureAuth()
  const app = await getApp()
  const res = await app.callFunction({ name, data })
  return res.result as T
}
