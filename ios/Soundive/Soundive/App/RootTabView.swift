import SwiftUI

struct RootTabView: View {

    var body: some View {
        TabView {

            Text("Home")
                .tabItem {
                    Image(systemName: "house")
                    Text("Home")
                }

            Text("Explore")
                .tabItem {
                    Image(systemName: "magnifyingglass")
                    Text("Explore")
                }

            Text("Charts")
                .tabItem {
                    Image(systemName: "chart.bar")
                    Text("Charts")
                }

            Text("Favorites")
                .tabItem {
                    Image(systemName: "heart")
                    Text("Favorites")
                }

            Text("Profile")
                .tabItem {
                    Image(systemName: "person")
                    Text("Profile")
                }
        }
    }
}
