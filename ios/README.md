# Soundive iOS

Native SwiftUI foundation for the Soundive iPhone app.

## Current foundation

- SwiftUI app entry point
- Five-tab navigation: 首页 / 专辑 / 专题 / 乐评 / 我的
- Shared Soundive design tokens
- Native home-screen prototype
- Placeholder module screens ready for CloudBase integration

## Open in Xcode

Open `ios/Soundive/Soundive.xcodeproj` in Xcode and build the `Soundive` scheme against an iPhone simulator.

## Next development phases

1. Connect the existing Soundive backend through a secure API layer.
2. Replace placeholder albums and reviews with live data.
3. Add authentication and account linking.
4. Implement rating, review, like and reply mutations.
5. Add native editorial article rendering.
6. Configure signing, icons, privacy metadata and App Store submission assets.

Do not place CloudBase secrets or privileged server credentials directly in the iOS app bundle.
