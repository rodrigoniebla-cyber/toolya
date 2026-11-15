// swift-tools-version:5.9
// toolya-display — use the DJI Goggles 3 as an external display on macOS.
// Build: `swift build -c release` (Xcode command line tools, macOS 13+).
import PackageDescription

let package = Package(
    name: "toolya-display",
    platforms: [.macOS(.v13)],
    targets: [
        // Declarations for CoreGraphics' private virtual-display classes
        // (the API BetterDisplay / DeskPad use to create a real extra monitor).
        .target(
            name: "CGVirtualDisplayPrivate",
            path: "Sources/CGVirtualDisplayPrivate",
            linkerSettings: [.linkedFramework("CoreGraphics"), .linkedFramework("Foundation")]
        ),
        .executableTarget(
            name: "toolya-display",
            dependencies: ["CGVirtualDisplayPrivate"],
            path: "Sources/toolya-display",
            linkerSettings: [
                .linkedFramework("ScreenCaptureKit"),
                .linkedFramework("VideoToolbox"),
                .linkedFramework("CoreMedia"),
                .linkedFramework("ImageIO"),
            ]
        ),
    ]
)
