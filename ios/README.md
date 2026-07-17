# Barscope iOS

Native SwiftUI foundation for the Barscope iPhone app.

## Current foundation

- SwiftUI app entry point
- Five-tab navigation: 首页 / 专辑 / 专题 / 乐评 / 我的
- Shared Barscope design tokens
- Native home-screen prototype
- Placeholder module screens ready for CloudBase integration

## Open in Xcode

The repository currently contains the Swift source foundation, but not a generated `.xcodeproj` file.

1. Open Xcode and choose **Create a new Xcode project**.
2. Select **iOS > App**.
3. Product Name: `Barscope`
4. Interface: `SwiftUI`
5. Language: `Swift`
6. Save the generated project inside the repository's `ios/` directory.
7. Add the Swift files under `ios/Barscope/` to the Xcode target, replacing the generated app entry file with `BarscopeApp.swift`.
8. Build and run on an iPhone simulator.

## Next development phases

1. Connect the existing Barscope backend through a secure API layer.
2. Replace placeholder albums and reviews with live data.
3. Add authentication and account linking.
4. Implement rating, review, like and reply mutations.
5. Add native editorial article rendering.
6. Configure signing, icons, privacy metadata and App Store submission assets.

Do not place CloudBase secrets or privileged server credentials directly in the iOS app bundle.
