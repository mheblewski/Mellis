import Foundation
import SwiftUI
#if canImport(UIKit)
import UIKit
#endif

/// Shows an answer while the model writes it, the way chat apps do: the text moves forward at the pace it arrives,
/// kept a moment behind so the server's chunks (a few a second) never show as jumps or pauses, it never slows down
/// toward the end, and every new character fades in over a quarter of a second.
@MainActor
public final class TextRevealer: ObservableObject {
    /// The text shown now (a prefix of the target).
    @Published public private(set) var displayed = ""
    /// Opacity of the last shown characters, oldest first; empty once they are all fully visible.
    @Published public private(set) var tailOpacities: [Double] = []
    /// True once the whole final text is shown and faded in: the answer's extras (suggestions, cost, proposal) can appear.
    @Published public private(set) var isFinished = false

    private var target: [Character] = []
    private var shown = 0
    private var position: Double = 0
    private var velocity: Double = 0
    private var revealedAt: [TimeInterval] = []
    private var sourceComplete = false
    /// Characters per second the text has been arriving at (smoothed), and when it last grew.
    private var arrivalRate: Double = 0
    private var lastArrival: TimeInterval?
    private var frameDriver: FrameDriver?
    private var lastTick: TimeInterval = 0
    private let now: () -> TimeInterval

    static let fadeDuration: TimeInterval = 0.25
    /// Slowest pace while text is waiting to be shown (characters per second).
    static let minimumPace: Double = 60
    /// How far behind the arriving text the reveal stays, as time at the arrival pace: enough to bridge the gap to
    /// the next chunk without stopping.
    static let bufferTime: Double = 0.35
    /// A lag above the buffer is worked off over about this long (gently, not in a burst).
    static let correctionTime: Double = 0.8
    /// Text that stopped growing this long ago is probably complete: it is finished without slowing down.
    static let quietTime: TimeInterval = 0.5

    public init(now: @escaping () -> TimeInterval = { ProcessInfo.processInfo.systemUptime }) {
        self.now = now
    }

    /// The text written so far. A changed beginning (the model started over) keeps only what still matches.
    public func setTarget(_ text: String) {
        let characters = Array(text)
        recordArrival(of: characters.count - target.count)
        var common = 0
        while common < min(shown, characters.count), characters[common] == target[common] {
            common += 1
        }
        if common < shown {
            shown = common
            position = Double(common)
            revealedAt = Array(revealedAt.suffix(common))
        }
        target = characters
        if shown < target.count || !tailOpacities.isEmpty {
            isFinished = false
        }
        publish()
        startIfNeeded()
    }

    /// The stored answer arrived: show the rest at the same pace, then report finished.
    public func complete(with text: String) {
        sourceComplete = true
        setTarget(text)
        updateFinished()
    }

    private func recordArrival(of added: Int) {
        guard added > 0 else { return }
        let time = now()
        if let lastArrival {
            let interval = max(time - lastArrival, 0.05)
            let instant = Double(added) / interval
            arrivalRate = arrivalRate == 0 ? instant : arrivalRate + (instant - arrivalRate) * 0.3
        }
        lastArrival = time
    }

    private func startIfNeeded() {
        guard frameDriver == nil, shown < target.count || !tailOpacities.isEmpty else { return }
        lastTick = now()
        frameDriver = FrameDriver { [weak self] in self?.tick() }
    }

    /// One frame (public for tests).
    public func tick() {
        let time = now()
        let dt = min(max(time - lastTick, 0), 0.1)
        lastTick = time
        let backlog = Double(target.count) - position
        if backlog > 0 {
            // Follow the arrival pace, a buffer behind; a larger lag is worked off gently.
            let buffer = arrivalRate * Self.bufferTime
            var desired = max(Self.minimumPace, arrivalRate + (backlog - buffer) / Self.correctionTime)
            let ending = sourceComplete || lastArrival.map { time - $0 > Self.quietTime } ?? false
            if ending {
                // Nothing more is coming: keep the pace to the last character (and finish within a second).
                desired = max(desired, velocity, backlog)
            }
            let easing = min(1, dt * 6)
            velocity = ending ? max(velocity, velocity + (desired - velocity) * easing) : velocity + (desired - velocity) * easing
            position = min(Double(target.count), position + velocity * dt)
            let newShown = Int(position)
            if newShown > shown {
                for _ in shown..<newShown { revealedAt.append(time) }
                shown = newShown
            }
        } else {
            velocity = 0
        }
        // Keep only the characters still fading in.
        revealedAt = revealedAt.filter { time - $0 < Self.fadeDuration }
        publish()
        updateFinished()
        if shown >= target.count && revealedAt.isEmpty {
            frameDriver?.stop()
            frameDriver = nil
        }
    }

    private func publish() {
        let text = String(target[0..<shown])
        if text != displayed { displayed = text }
        let time = now()
        let opacities = revealedAt.map { min(1, max(0.08, (time - $0) / Self.fadeDuration)) }
        if opacities != tailOpacities { tailOpacities = opacities }
    }

    private func updateFinished() {
        let finished = sourceComplete && shown >= target.count && revealedAt.isEmpty
        if finished != isFinished { isFinished = finished }
    }

    deinit {
        frameDriver?.stop()
    }
}

/// Calls back once per screen frame (at most 60 a second), also while a finger scrolls: the run loop then runs in its
/// tracking mode, in which a plain timer does not fire and the text would stand still until the finger lifts.
@MainActor
final class FrameDriver {
    #if canImport(UIKit)
    private var link: CADisplayLink?
    private let target: Target
    #else
    private var timer: Timer?
    #endif

    init(onFrame: @escaping @MainActor () -> Void) {
        #if canImport(UIKit)
        target = Target(onFrame: onFrame)
        let link = CADisplayLink(target: target, selector: #selector(Target.frame))
        link.preferredFrameRateRange = CAFrameRateRange(minimum: 30, maximum: 60, preferred: 60)
        link.add(to: .main, forMode: .common)
        self.link = link
        #else
        let timer = Timer(timeInterval: 1.0 / 60.0, repeats: true) { _ in
            MainActor.assumeIsolated { onFrame() }
        }
        RunLoop.main.add(timer, forMode: .common)
        self.timer = timer
        #endif
    }

    nonisolated func stop() {
        MainActor.assumeIsolated {
            #if canImport(UIKit)
            link?.invalidate()
            link = nil
            #else
            timer?.invalidate()
            timer = nil
            #endif
        }
    }

    #if canImport(UIKit)
    /// CADisplayLink holds its target strongly: a separate object, so the revealer can go away.
    private final class Target: NSObject {
        let onFrame: @MainActor () -> Void
        init(onFrame: @escaping @MainActor () -> Void) { self.onFrame = onFrame }
        @objc func frame() {
            MainActor.assumeIsolated { onFrame() }
        }
    }
    #endif
}

/// Revealers by the caregiver message they answer, kept for a screen's lifetime: the stored answer continues from
/// where its draft got to instead of appearing at once.
@MainActor
public final class TextRevealStore: ObservableObject {
    private var revealers: [String: TextRevealer] = [:]

    public init() {}

    public func revealer(for replyTo: String) -> TextRevealer {
        let key = replyTo.lowercased()
        if let existing = revealers[key] { return existing }
        let revealer = TextRevealer()
        revealers[key] = revealer
        return revealer
    }

    /// The revealer of an answer that was being written on this screen, if any.
    public func existing(for replyTo: String?) -> TextRevealer? {
        replyTo.flatMap { revealers[$0.lowercased()] }
    }
}

public enum StreamingMarkdown {
    /// Text cut mid-markup would flash raw symbols: a trailing run of `*`, `#`, `_` or backticks waits for the next
    /// characters, and an open `**` is closed so the bold part is already bold while it is written.
    static func displayable(_ text: String) -> String {
        var result = text
        while let last = result.last, "*#_`".contains(last) {
            result.removeLast()
        }
        if result.components(separatedBy: "**").count % 2 == 0 {
            result += "**"
        }
        return result
    }

    /// The last characters of an attributed text get the given opacities (oldest first), fading the newest in.
    public static func fadeTail(_ attributed: AttributedString, opacities: [Double]) -> AttributedString {
        guard !opacities.isEmpty else { return attributed }
        var result = attributed
        var index = result.characters.endIndex
        for opacity in opacities.reversed() {
            guard index > result.characters.startIndex else { break }
            let previous = result.characters.index(before: index)
            result[previous..<index].foregroundColor = Color.primary.opacity(opacity)
            index = previous
        }
        return result
    }
}
