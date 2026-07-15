/// <reference path="./types/index.d.ts" />

interface RapUserInfo {
  openId: string
  nickName: string
  avatarUrl: string
  coverUrl?: string
  type: 'critic' | 'normal' | 'admin'
  bio?: string
  reviewCount: number
}

interface Album {
  _id: string
  title: string
  artist: string
  coverUrl: string
  releaseYear: number
  genres: string[]
  avgScore: number
  reviewCount: number
  trackCount?: number
}

interface Review {
  _id: string
  albumId: string
  userId: string
  userType: 'critic' | 'normal'
  userNickName: string
  userAvatarUrl: string
  rating: number
  content: string
  likes: number
  isPinned: boolean
  createdAt: string
  albumTitle?: string
}

interface ChartItem {
  rank: number
  albumId: string
  albumTitle: string
  albumArtist: string
  coverUrl: string
  releaseYear: number
  avgScore: number
  trend: 'up' | 'down' | 'new' | 'same'
  trendValue: number
}

interface IAppOption {
  globalData: {
    userInfo: RapUserInfo | null
    userType: 'critic' | 'normal' | 'admin'
    isAdmin: boolean
    statusBarHeight: number
    topbarHeight: number
  }
}