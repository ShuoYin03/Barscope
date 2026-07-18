import SwiftUI

enum BarscopeTheme {
    static let background = Color(red: 0.03, green: 0.025, blue: 0.035)
    static let surface = Color(red: 0.075, green: 0.06, blue: 0.055)
    static let accent = Color(red: 0.83, green: 0.31, blue: 0.12)
    static let primaryText = Color(red: 0.96, green: 0.93, blue: 0.89)
    static let secondaryText = Color(red: 0.58, green: 0.53, blue: 0.49)
}

struct SectionLabel: View {
    let side: String
    let title: String

    var body: some View {
        HStack(alignment: .firstTextBaseline) {
            Text(side.uppercased())
                .font(.caption2.bold())
                .tracking(1.6)
                .foregroundStyle(BarscopeTheme.accent)
            Text(title.uppercased())
                .font(.title2.bold())
            Spacer()
        }
    }
}
