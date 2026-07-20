// Call this from onLoad of ANY page a 专题 (features) list card can navigate to — including future
// ones. It's how that feature's 浏览 count on the 专题 list gets populated; skipping it means the
// card will always show 0 views no matter how much traffic the page gets. See BASE_FEATURES in
// pages/features/index.ts for the convention this pairs with.
export function trackFeatureView(featureId: string) {
  if (!featureId) return
  wx.cloud.callFunction({
    name: 'manageFeatureStats',
    data: { action: 'track_view', featureId },
    success: (res: any) => {
      const r = res.result || {}
      if (!r.success) console.error('[featureStats] track view failed', featureId, r)
    },
    fail: (err: any) => console.error('[featureStats] track view call failed', featureId, err),
  } as any)
}

export function trackFeatureShare(featureId: string) {
  if (!featureId) return
  wx.cloud.callFunction({
    name: 'manageFeatureStats',
    data: { action: 'track_share', featureId },
    success: (res: any) => {
      const r = res.result || {}
      if (!r.success) console.error('[featureStats] track share failed', featureId, r)
    },
    fail: (err: any) => console.error('[featureStats] track share call failed', featureId, err),
  } as any)
}
