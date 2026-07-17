// Client components call this exactly like before (mirrors wx.cloud.callFunction's `.result`
// shape), but it now goes through our own /api/cloud-function route instead of talking to
// CloudBase's Web SDK directly from the browser. That route runs server-side with the Node SDK —
// same-origin fetch from here, so there's no CORS / Web安全域名 check to satisfy, and no paid
// upgrade required. See web/lib/cloudbase-server.ts for the actual cloud function call.
export async function callFunction<T = any>(name: string, data?: Record<string, any>): Promise<T> {
  const res = await fetch('/api/cloud-function', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, data }),
  })
  return res.json() as Promise<T>
}
