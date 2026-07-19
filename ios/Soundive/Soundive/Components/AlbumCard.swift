import SwiftUI

struct AlbumCard: View {
    
    var albumName: String
    var artistName: String
    var rating: Double
    
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            
            RoundedRectangle(cornerRadius: 16)
                .fill(Color.soundiveCard)
                .frame(height: 180)
                .overlay {
                    Text("Album Cover")
                        .foregroundStyle(.gray)
                }
            
            Text(albumName)
                .font(.soundiveHeadline)
                .foregroundStyle(Color.soundiveText)
            
            Text(artistName)
                .font(.soundiveCaption)
                .foregroundStyle(Color.soundiveSecondaryText)
            
            HStack {
                Image(systemName: "star.fill")
                
                Text(String(format: "%.1f", rating))
            }
            .font(.soundiveCaption)
            .foregroundStyle(Color.soundivePrimary)        }
        .padding()
        .background(Color.soundiveCard)
        .clipShape(
            RoundedRectangle(cornerRadius: 20)
        )
    }
}


#Preview {
    AlbumCard(
        albumName: "Sample Album",
        artistName: "Sample Artist",
        rating: 8.5
    )
}
