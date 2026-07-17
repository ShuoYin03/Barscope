import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  // @cloudbase/js-sdk is browser-only for our usage (anonymous auth + callFunction), but it ships
  // a Node build that pulls in jsonwebtoken/ws for the server-side Admin SDK flow we don't use.
  // Webpack statically resolves that Node build during the server/SSR compile even though the code
  // path is only ever invoked client-side (inside useEffect) — marking it external stops Next from
  // bundling/resolving it for the server, matching the documented fix for dual browser/Node SDKs.
  serverExternalPackages: ['@cloudbase/js-sdk'],
}

export default nextConfig
