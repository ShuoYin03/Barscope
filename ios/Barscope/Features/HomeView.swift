import SwiftUI

struct HomeView: View {
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 32) {
                VStack(alignment: .leading, spacing: 10) {
                    Text("BARSCOPE")
                        .font(.system(size: 38, weight: .black, design: .default))
                    Text("韵镜 · 中文说唱乐评与社区")
                        .font(.caption)
                        .tracking(1.2)
                        .foregroundStyle(BarscopeTheme.secondaryText)
                }

                VStack(alignment: .leading, spacing: 18) {
                    Text("NOW · 今日热议")
                        .font(.caption.bold())
                        .tracking(1.8)
                        .foregroundStyle(BarscopeTheme.accent)
                    RoundedRectangle(cornerRadius: 2)
                        .fill(BarscopeTheme.surface)
                        .frame(height: 300)
                        .overlay(alignment: .bottomLeading) {
                            VStack(alignment: .leading, spacing: 8) {
                                Text("THE RECORD EVERYONE\nIS TALKING ABOUT")
                                    .font(.system(size: 30, weight: .black))
                                Text("真实数据接入后，这里展示今日热议专辑与社区动态。")
                                    .foregroundStyle(BarscopeTheme.secondaryText)
                            }
                            .padding(22)
                        }
                }

                SectionLabel(side: "SIDE A", title: "近期发行")
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 14) {
                        ForEach(0..<4, id: \.self) { index in
                            VStack(alignment: .leading, spacing: 8) {
                                Rectangle()
                                    .fill(BarscopeTheme.surface)
                                    .frame(width: 156, height: 156)
                                    .overlay(alignment: .bottomLeading) {
                                        Text("0\(index + 1)")
                                            .font(.title.bold())
                                            .foregroundStyle(BarscopeTheme.accent)
                                            .padding(12)
                                    }
                                Text("专辑占位")
                                    .font(.headline)
                                Text("ARTIST")
                                    .font(.caption)
                                    .foregroundStyle(BarscopeTheme.secondaryText)
                            }
                        }
                    }
                }

                SectionLabel(side: "SIDE B", title: "最新评论")
                VStack(spacing: 0) {
                    ForEach(0..<3, id: \.self) { index in
                        HStack(alignment: .top, spacing: 14) {
                            Circle()
                                .fill(BarscopeTheme.surface)
                                .frame(width: 42, height: 42)
                            VStack(alignment: .leading, spacing: 7) {
                                Text(index == 0 ? "金鱼" : "BARSCOPE USER")
                                    .font(.subheadline.bold())
                                Text("这里将同步小程序中的真实评分、评论、点赞与回复。")
                                    .font(.subheadline)
                                    .foregroundStyle(BarscopeTheme.secondaryText)
                            }
                            Spacer()
                            Text(index == 0 ? "9.0" : "8.8")
                                .font(.title2.bold())
                                .foregroundStyle(BarscopeTheme.accent)
                        }
                        .padding(.vertical, 16)
                        Divider().overlay(Color.white.opacity(0.1))
                    }
                }
            }
            .padding(20)
        }
        .background(BarscopeTheme.background.ignoresSafeArea())
        .toolbar(.hidden, for: .navigationBar)
    }
}
