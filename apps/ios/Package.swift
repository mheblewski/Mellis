// swift-tools-version: 5.10
import PackageDescription

let package = Package(
    name: "GlucoMindiOS",
    platforms: [
        .iOS(.v17),
        .macOS(.v14)
    ],
    products: [
        .library(name: "GlucoMindCore", targets: ["GlucoMindCore"]),
        .executable(name: "GlucoMindApp", targets: ["GlucoMindApp"])
    ],
    targets: [
        .target(
            name: "GlucoMindCore",
            path: "Sources/GlucoMindCore"
        ),
        .executableTarget(
            name: "GlucoMindApp",
            dependencies: ["GlucoMindCore"],
            path: "Sources/GlucoMindApp",
            exclude: ["Info.plist"]
        ),
        .testTarget(
            name: "GlucoMindCoreTests",
            dependencies: ["GlucoMindCore"],
            path: "Tests/GlucoMindCoreTests"
        ),
        .testTarget(
            name: "GlucoMindAppTests",
            dependencies: ["GlucoMindApp", "GlucoMindCore"],
            path: "Tests/GlucoMindAppTests"
        )
    ]
)
