import SwiftUI

/// The screen over the app while it starts, on the deep teal of the launch screen whatever the system theme, in the
/// very middle of the screen: the amber drop appears, the hummingbird
/// comes in calmly to it, "Mellis" sharpens below (as on an empty new conversation), the bird hovers, sips from the
/// drop and looks down at the name. When the app is ready it darts off along its beak straight out of the hover, wings
/// beating, while the screen dissolves into the app. The script is HummingbirdChoreography.
public struct LaunchSplash: View {
    private let start: Date
    private let leaveAt: Date?
    private let hurried: Bool
    /// A fixed moment instead of the clock: for snapshots.
    private let frozenTime: TimeInterval?
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    public init(start: Date, leaveAt: Date?, hurried: Bool, frozenTime: TimeInterval? = nil) {
        self.start = start
        self.leaveAt = leaveAt
        self.hurried = hurried
        self.frozenTime = frozenTime
    }

    public var body: some View {
        Group {
            if let frozenTime {
                frame(at: frozenTime)
            } else {
                TimelineView(.animation) { timeline in
                    frame(at: timeline.date.timeIntervalSince(start))
                }
            }
        }
        // Centred on the whole screen, not the safe area.
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .ignoresSafeArea()
        .allowsHitTesting(leaveAt == nil)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Mellis, wczytuję")
    }

    private func frame(at t: TimeInterval) -> some View {
        let script = HummingbirdChoreography.Script(
            entrance: true,
            leaveAt: leaveAt.map { $0.timeIntervalSince(start) },
            hurried: hurried,
            reduceMotion: reduceMotion
        )
        let word = wordmark(at: t, script)
        return ZStack {
            Brand.splashBackground
                .opacity(backgroundOpacity(at: t, script))
            VStack(spacing: 0) {
                HummingbirdCanvas(size: 140, pose: HummingbirdChoreography.pose(at: t, script))
                BrandWordmark.text()
                    .font(.system(size: 38, weight: .bold))
                    .tracking(word.tracking)
                    .blur(radius: word.blur)
                    .opacity(word.opacity)
                    .offset(y: word.offset)
                    .padding(.top, 14)
            }
            // On the deep teal the bird and the name are always their on-dark versions (bird-on-dark.svg), in light
            // mode too.
            .environment(\.colorScheme, .dark)
        }
    }

    /// The name sharpens out of a blur with its letters drawing together, after the bird has braked; it leaves the
    /// same way, first, as the bird darts.
    private func wordmark(at t: Double, _ s: HummingbirdChoreography.Script) -> (opacity: Double, blur: CGFloat, tracking: CGFloat, offset: CGFloat) {
        let reveal = HummingbirdChoreography.smooth((t - (s.reduceMotion ? 0.1 : 0.25)) / 0.4)
        var leave = 0.0
        if let leaveAt = s.leaveAt, t > leaveAt {
            let l = t - leaveAt
            leave = s.hurried || s.reduceMotion
                ? HummingbirdChoreography.smooth(l / HummingbirdChoreography.hurriedDuration)
                : HummingbirdChoreography.smooth(l / 0.2)
        }
        if s.reduceMotion { return (reveal * (1 - leave), 0, 0, 0) }
        return (
            reveal * (1 - leave),
            CGFloat(8 * (1 - reveal) + 6 * leave),
            CGFloat(6 * (1 - reveal) + 2 * leave),
            CGFloat(8 * (1 - reveal) + 4 * leave)
        )
    }

    private func backgroundOpacity(at t: Double, _ s: HummingbirdChoreography.Script) -> Double {
        guard let leaveAt = s.leaveAt, t > leaveAt else { return 1 }
        let l = t - leaveAt
        if s.hurried || s.reduceMotion { return 1 - HummingbirdChoreography.smooth(l / HummingbirdChoreography.hurriedDuration) }
        return 1 - HummingbirdChoreography.smooth((l - 0.1) / 0.26)
    }

    /// How long the leave takes, for the splash's owner to remove it after.
    public static func leaveDuration(hurried: Bool, reduceMotion: Bool) -> TimeInterval {
        hurried || reduceMotion ? HummingbirdChoreography.hurriedDuration : HummingbirdChoreography.leaveDuration
    }
}
