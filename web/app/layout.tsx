import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'Barscope | 韵镜',
  description: '中文说唱专辑、乐评、专题与社区。',
}

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  )
}
