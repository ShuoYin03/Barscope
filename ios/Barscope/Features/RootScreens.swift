import SwiftUI

private struct PlaceholderScreen: View {
    let side: String
    let title: String
    let description: String

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 22) {
                Text("BARSCOPE / \(side)")
                    .font(.caption.bold())
                    .tracking(1.8)
                    .foregroundStyle(BarscopeTheme.accent)
                Text(title)
                    .font(.system(size: 44, weight: .black))
                Text(description)
                    .font(.body)
                    .foregroundStyle(BarscopeTheme.secondaryText)
                    .lineSpacing(7)
                Rectangle()
                    .fill(BarscopeTheme.surface)
                    .frame(height: 360)
                    .overlay {
                        Text("NATIVE MODULE\nCOMING NEXT")
                            .multilineTextAlignment(.center)
                            .font(.headline.bold())
                            .tracking(1.5)
                    }
            }
            .padding(20)
        }
        .background(BarscopeTheme.background.ignoresSafeArea())
        .navigationTitle(title)
        .navigationBarTitleDisplayMode(.inline)
    }
}

struct AlbumsView: View {
    var body: some View {
        PlaceholderScreen(side: "SIDE A", title: "专辑", description: "专辑库、筛选、搜索、评分与专辑详情将在这里接入现有 Barscope 数据。")
    }
}

struct EditorialView: View {
    var body: some View {
        PlaceholderScreen(side: "SIDE B", title: "专题", description: "Review、Feature、Interview 与年度企划会在原生 App 中拥有更沉浸的阅读体验。")
    }
}

struct ReviewsView: View {
    var body: some View {
        PlaceholderScreen(side: "SIDE C", title: "乐评", description: "最新评论、热门评论、点赞、回复与社区动态将在这里同步。")
    }
}

struct ProfileView: View {
    var body: some View {
        PlaceholderScreen(side: "SIDE D", title: "我的", description: "个人主页、评分记录、收藏、成就与 Editorial 投稿入口将在这里汇总。")
    }
}
