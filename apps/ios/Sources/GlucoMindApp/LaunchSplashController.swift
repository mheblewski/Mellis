import Foundation
import SwiftUI
import GlucoMindCore
#if canImport(UIKit)
import UIKit
#endif

/// When the launch splash leaves: after the bird has flown in and taken its first sip, once the first screen has something to show
/// (the dashboard's data, or a screen without data: sign-in, an error, the patient list), and never later than
/// `maximum`. A notification tapped at launch sends it away at once: an alert must not wait for the bird.
@MainActor
final class LaunchSplashController: ObservableObject {
    enum Phase { case showing, leaving, gone }
    enum Readiness { case loading, waitingForContent, ready }

    static let shared = LaunchSplashController()

    /// The whole little scene (HummingbirdChoreography): the calm arrival, the first sip, a look down at the name and a
    /// blink.
    static let minimum: TimeInterval = 1.4
    static let maximum: TimeInterval = 5

    @Published private(set) var phase: Phase = .showing
    @Published private(set) var leaveAt: Date?
    @Published private(set) var hurried = false

    let shownAt = Date()
    private var readiness: Readiness = .loading
    private var contentReady = false

    private init() {
        Task { [weak self] in
            try? await Task.sleep(for: .seconds(Self.minimum))
            self?.evaluate()
            try? await Task.sleep(for: .seconds(Self.maximum - Self.minimum))
            self?.leave()
        }
    }

    func update(_ readiness: Readiness) {
        self.readiness = readiness
        evaluate()
    }

    /// The dashboard has its first data (or its error).
    func markContentReady() {
        contentReady = true
        evaluate()
    }

    /// A notification opens a screen: no waiting.
    func hurry() {
        guard phase == .showing else { return }
        hurried = true
        leave()
    }

    private func evaluate() {
        guard phase == .showing, Date().timeIntervalSince(shownAt) >= Self.minimum else { return }
        switch readiness {
        case .loading: return
        case .waitingForContent: if contentReady { leave() }
        case .ready: leave()
        }
    }

    private func leave() {
        guard phase == .showing else { return }
        phase = .leaving
        leaveAt = Date()
        #if canImport(UIKit)
        let reduceMotion = UIAccessibility.isReduceMotionEnabled
        #else
        let reduceMotion = false
        #endif
        let duration = LaunchSplash.leaveDuration(hurried: hurried, reduceMotion: reduceMotion)
        Task { [weak self] in
            try? await Task.sleep(for: .seconds(duration))
            self?.phase = .gone
        }
    }
}
