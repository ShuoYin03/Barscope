import SwiftUI

@main
struct BarscopeApp: App {
    var body: some Scene {
        WindowGroup {
            RootTabView()
                .preferredColorScheme(.dark)
        }
    }
}

struct RootTabView: View {
    var body: some View {
        TabView {
            NavigationStack { HomeView() }
                .tabItem { Label("首页", systemImage: "house") }
            NavigationStack { AlbumsView() }
                .tabItem { Label("专辑", systemImage: "square.stack") }
            NavigationStack { EditorialView() }
                .tabItem { Label("专题", systemImage: "newspaper") }
            NavigationStack { ReviewsView() }
                .tabItem { Label("乐评", systemImage: "text.bubble") }
            NavigationStack { ProfileView() }
                .tabItem { Label("我的", systemImage: "person") }
        }
        .tint(BarscopeTheme.accent)
    }
}
