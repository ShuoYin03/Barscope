import { NextRequest, NextResponse } from 'next/server'
import { callFunctionServer } from '@/lib/cloudbase-server'

// This proxy runs with admin-level CloudBase credentials (server-only), so it must not blindly
// forward any function name — only read-only, public catalog functions are reachable through it.
// Anything that writes data, requires a real logged-in user, or is admin-gated needs its own route
// with proper auth, not this generic passthrough.
const ALLOWED_FUNCTIONS = new Set([
  'getAlbums',
  'getLatestAlbums',
  'getReviews',
  'getCharts',
  'getCatalogStats',
  'getArtists',
  'getArtist',
  'getOnThisDay',
])

export async function POST(req: NextRequest) {
  let body: any
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ success: false, error: 'Invalid JSON body' }, { status: 400 })
  }

  const name = String(body?.name || '')
  if (!ALLOWED_FUNCTIONS.has(name)) {
    return NextResponse.json({ success: false, error: `Function not allowed: ${name}` }, { status: 403 })
  }

  try {
    const result = await callFunctionServer(name, body?.data || {})
    return NextResponse.json(result)
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err?.message || 'Cloud function call failed' }, { status: 500 })
  }
}
