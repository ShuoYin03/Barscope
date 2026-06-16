const cloudCall = <T>(name: string, data?: object): Promise<T> =>
  new Promise((resolve, reject) => {
    wx.cloud.callFunction({
      name,
      data: data ?? {},
      success: (res: any) => resolve(res.result as T),
      fail: reject,
    })
  })

export const api = {
  getAlbums: (params?: { genre?: string; page?: number; limit?: number }) =>
    cloudCall<{ list: Album[]; total: number }>('getAlbums', params),

  getCharts: (period: 'weekly' | 'monthly' | 'annual') =>
    cloudCall<ChartItem[]>('getCharts', { period }),

  getAlbumDetail: (id: string) =>
    cloudCall<Album>('getAlbums', { id }),

  getReviews: (albumId: string, page?: number) =>
    cloudCall<{ list: Review[]; total: number }>('getReviews', { albumId, page }),

  submitReview: (albumId: string, rating: number, content: string) =>
    cloudCall<{ success: boolean }>('submitReview', { albumId, rating, content }),

  getUserInfo: () =>
    cloudCall<RapUserInfo>('getUserInfo'),
}
