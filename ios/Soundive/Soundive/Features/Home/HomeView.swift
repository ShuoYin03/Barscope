import SwiftUI

struct HomeView: View {

    var body: some View {

        NavigationStack {

            ScrollView {

                VStack(alignment: .leading, spacing: 24) {

                    Text("Soundive")
                        .font(.soundiveTitle)
                        .foregroundStyle(Color.soundiveText)


                    Text("Discover new sounds")
                        .font(.soundiveBody)
                        .foregroundStyle(Color.soundiveSecondaryText)


                    Text("Featured")
                        .font(.soundiveHeadline)
                        .foregroundStyle(Color.soundiveText)


                    AlbumCard(
                        albumName: "Sample Album",
                        artistName: "Sample Artist",
                        rating: 8.5
                    )


                }
                .padding()

            }
            .background(Color.soundiveBackground)
            .navigationBarHidden(true)

        }
    }
}


#Preview {
    HomeView()
}
