import SwiftUI

/// A test install (Info.plist GMTestEnvironment = YES, set in Config.local.xcconfig) draws a red frame around the whole
/// screen, above sheets and alerts, so it is never mistaken for the production app.
enum TestEnvironment {
    static let isEnabled = (Bundle.main.object(forInfoDictionaryKey: "GMTestEnvironment") as? String)?.uppercased() == "YES"
}

#if canImport(UIKit)
import UIKit

/// Put in the root view's background: once it is in a window, it opens a separate window above everything with the
/// frame. That window takes no touches.
struct TestEnvironmentFrameInstaller: UIViewRepresentable {
    func makeUIView(context: Context) -> InstallerView { InstallerView() }
    func updateUIView(_ uiView: InstallerView, context: Context) {}

    final class InstallerView: UIView {
        private var frameWindow: UIWindow?

        override func didMoveToWindow() {
            super.didMoveToWindow()
            guard frameWindow == nil, let scene = window?.windowScene else { return }
            let overlay = PassthroughWindow(windowScene: scene)
            overlay.windowLevel = .alert + 1
            overlay.backgroundColor = .clear
            let host = UIHostingController(rootView: TestEnvironmentFrameView())
            host.view.backgroundColor = .clear
            overlay.rootViewController = host
            overlay.isHidden = false
            frameWindow = overlay
        }
    }
}

private final class PassthroughWindow: UIWindow {
    override func hitTest(_ point: CGPoint, with event: UIEvent?) -> UIView? { nil }
}

private struct TestEnvironmentFrameView: View {
    var body: some View {
        // Close to the screen corners of current iPhones; the outer edge is clipped by the display anyway.
        RoundedRectangle(cornerRadius: 56, style: .continuous)
            .strokeBorder(Color.red, lineWidth: 5)
            .ignoresSafeArea()
            .allowsHitTesting(false)
    }
}
#endif
