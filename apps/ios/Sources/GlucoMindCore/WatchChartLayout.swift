import CoreGraphics
import Foundation

/// The rules of the complication's chart, apart from its drawing: the height of a value, what happens over a gap in the
/// readings, and the curve through them. Shared with the watch targets (project.yml).
public enum WatchChartLayout {
    public struct Sample: Equatable {
        public let at: TimeInterval
        public let value: Double

        public init(at: TimeInterval, value: Double) {
            self.at = at
            self.value = value
        }
    }

    public enum Part: Equatable {
        /// Readings close enough for one curve.
        case line([Sample])
        /// A lone reading between gaps.
        case dot(Sample)
        /// A short gap: the two ends are joined by dots.
        case connector(Sample, Sample)
        /// A long gap, or the time since the last reading: dots along the chart's bottom edge.
        case absence(from: TimeInterval, to: TimeInterval)
    }

    public struct CurveSegment: Equatable {
        public let control1: CGPoint
        public let control2: CGPoint
        public let end: CGPoint
    }

    /// One missed 5-minute reading (with some delay) is still a line.
    public static let smoothGap: TimeInterval = 12.5 * 60
    public static let connectedGap: TimeInterval = 30 * 60

    static let lowestValue = 40.0
    static let highestValue = 400.0

    /// A value's height in the chart, 0 at the bottom and 1 at the top: fixed and logarithmic, so the same height always
    /// means the same glucose and the low range gets room.
    public static func height(of value: Double) -> Double {
        let clamped = min(highestValue, max(lowestValue, value))
        return log(clamped / lowestValue) / log(highestValue / lowestValue)
    }

    /// The samples in time order, split by their gaps; the last part says how long there has been no reading.
    public static func parts(_ samples: [Sample], now: TimeInterval) -> [Part] {
        var parts: [Part] = []
        var run: [Sample] = []
        func closeRun() {
            if run.count == 1 {
                parts.append(.dot(run[0]))
            } else if run.count > 1 {
                parts.append(.line(run))
            }
            run = []
        }
        for sample in samples {
            guard let previous = run.last else {
                run = [sample]
                continue
            }
            guard sample.at > previous.at else { continue }
            let gap = sample.at - previous.at
            if gap > smoothGap {
                closeRun()
                parts.append(gap > connectedGap ? .absence(from: previous.at, to: sample.at) : .connector(previous, sample))
            }
            run.append(sample)
        }
        let last = run.last
        closeRun()
        if let last, now - last.at > smoothGap {
            parts.append(.absence(from: last.at, to: now))
        }
        return parts
    }

    /// A curve through every point that never goes above or below its neighbours (Fritsch–Butland), so the smoothing
    /// shows no value that was not read. The points go left to right.
    public static func curve(through points: [CGPoint]) -> [CurveSegment] {
        guard points.count > 1 else { return [] }
        let steps = zip(points, points.dropFirst()).map { ($0.x, $0.y, $1.x, $1.y) }.map { x0, y0, x1, y1 in
            (width: x1 - x0, slope: (y1 - y0) / (x1 - x0))
        }
        var tangents = [CGFloat](repeating: 0, count: points.count)
        tangents[0] = steps[0].slope
        tangents[points.count - 1] = steps[steps.count - 1].slope
        for i in 1..<max(1, points.count - 1) {
            let before = steps[i - 1]
            let after = steps[i]
            guard before.slope * after.slope > 0 else { continue }
            let total = before.width + after.width
            tangents[i] = 3 * total / ((2 * after.width + before.width) / before.slope + (after.width + 2 * before.width) / after.slope)
        }
        return steps.indices.map { i in
            let third = steps[i].width / 3
            return CurveSegment(
                control1: CGPoint(x: points[i].x + third, y: points[i].y + tangents[i] * third),
                control2: CGPoint(x: points[i + 1].x - third, y: points[i + 1].y - tangents[i + 1] * third),
                end: points[i + 1]
            )
        }
    }
}
