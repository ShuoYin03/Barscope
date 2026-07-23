// SWR（stale-while-revalidate）云函数缓存工具
//
// 目标：页面打开时先用本地缓存立即渲染（秒开），同时在缓存过期时后台静默刷新。
// - TTL 内：命中缓存直接返回，不发起云调用（省调用 + 秒开）
// - 超过 TTL：先返回旧缓存渲染，再后台跑云函数刷新（秒开 + 保持新鲜）
// - 无缓存：直接跑云函数（首次加载，无法避免）
//
// 缓存存的是云函数返回的 res.result 原样，页面拿到的和直接调用一致。

const PREFIX = 'swr_cache_'

interface CacheEntry {
  v: any // 云函数 res.result
  t: number // 写入时间戳
}

interface SwrOptions {
  ttl: number // 毫秒；缓存在此时间内视为新鲜
}

interface SwrMeta {
  fromCache: boolean // 本次数据来自缓存
  stale: boolean // 该缓存已过期（后台正在刷新）
}

interface CallSpec {
  name: string
  data: Record<string, any>
  ttl: number
}

function makeKey(name: string, data: Record<string, any>): string {
  let dataKey = ''
  try {
    dataKey = JSON.stringify(data || {})
  } catch (e) {
    dataKey = ''
  }
  return `${PREFIX}${name}_${dataKey}`
}

function readEntry(key: string): CacheEntry | null {
  try {
    const entry = wx.getStorageSync(key)
    if (entry && typeof entry === 'object' && 'v' in entry && 't' in entry) return entry as CacheEntry
  } catch (e) {
    /* ignore */
  }
  return null
}

// 只缓存成功结果：明确 success===false（含网络失败兜底）不写缓存，下次重试。
function isCacheable(value: any): boolean {
  return !!value && value.success !== false
}

function writeEntry(key: string, value: any): void {
  if (!isCacheable(value)) return
  try {
    wx.setStorageSync(key, { v: value, t: Date.now() } as CacheEntry)
  } catch (e) {
    /* 存储写满等异常忽略，退化为无缓存 */
  }
}

function callFn(name: string, data: Record<string, any>): Promise<any> {
  return wx.cloud
    .callFunction({ name, data })
    .then((res: any) => (res && res.result !== undefined ? res.result : { success: false }))
    .catch((err: any) => {
      console.warn(`[cloudCache] ${name} failed`, err)
      return { success: false }
    })
}

/**
 * SWR 单个云函数调用。onResult 最多被调用两次：
 * 命中过期缓存时先回调缓存（fromCache:true, stale:true），刷新完成后再回调新鲜数据。
 * TTL 内命中只回调一次缓存；无缓存只回调一次新鲜数据。
 */
export function swrCall(
  name: string,
  data: Record<string, any>,
  opts: SwrOptions,
  onResult: (result: any, meta: SwrMeta) => void,
): Promise<any> {
  const key = makeKey(name, data)
  const entry = readEntry(key)
  const now = Date.now()
  const hasCacheHit = !!entry
  const fresh = hasCacheHit && now - (entry as CacheEntry).t < opts.ttl

  if (hasCacheHit) onResult((entry as CacheEntry).v, { fromCache: true, stale: !fresh })

  if (!hasCacheHit || !fresh) {
    return callFn(name, data).then((result: any) => {
      writeEntry(key, result)
      onResult(result, { fromCache: false, stale: false })
      return result
    })
  }

  return Promise.resolve((entry as CacheEntry).v)
}

/**
 * SWR 批量调用（用于首页这种一次 Promise.all 多个云函数的场景）。
 * onResults 最多被调用两次：全部命中缓存时先回调一组缓存结果，
 * 任一过期/缺失则后台并行刷新全部并再回调一组新鲜结果。
 * results 顺序与 specs 一致。
 */
export function swrAll(
  specs: CallSpec[],
  onResults: (results: any[], meta: { fromCache: boolean }) => void,
): Promise<void> {
  const now = Date.now()
  const items = specs.map((s) => {
    const key = makeKey(s.name, s.data)
    const entry = readEntry(key)
    return { s, key, entry }
  })

  const allCached = items.every((it) => !!it.entry)
  const anyStale = items.some((it) => !it.entry || now - (it.entry as CacheEntry).t >= it.s.ttl)

  if (allCached) {
    onResults(items.map((it) => (it.entry as CacheEntry).v), { fromCache: true })
  }

  if (!allCached || anyStale) {
    return Promise.all(items.map((it) => callFn(it.s.name, it.s.data))).then((results: any[]) => {
      results.forEach((result, i) => writeEntry(items[i].key, result))
      onResults(results, { fromCache: false })
    })
  }

  return Promise.resolve()
}

/** 是否存在该云函数的缓存（不论是否过期）。用于决定要不要显示 loading。 */
export function hasCache(name: string, data: Record<string, any>): boolean {
  return !!readEntry(makeKey(name, data))
}

/** 手动使某个云函数的缓存失效（例如用户提交后需要下次强制刷新）。 */
export function invalidateCache(name: string, data: Record<string, any>): void {
  try {
    wx.removeStorageSync(makeKey(name, data))
  } catch (e) {
    /* ignore */
  }
}
