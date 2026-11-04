import Foundation
#if canImport(WidgetKit)
import WidgetKit
#endif

/// Tells the home-screen widget to read its data again: a new reading while the app is open, a sign-in or a sign-out.
/// Reloads asked for while the app is in the foreground do not count against the widget's daily budget. The Apple
/// Watch is checked too (a sign-in gives it a watch token, WatchSessionBridge).
enum HomeWidgetReloader {
    static func reload() {
        #if canImport(WidgetKit) && os(iOS)
        WidgetCenter.shared.reloadAllTimelines()
        #endif
        Task { @MainActor in WatchSessionBridge.shared.sync() }
    }
}
