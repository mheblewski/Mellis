import CoreGraphics
import XCTest
@testable import GlucoMindCore

final class WatchChartLayoutTests: XCTestCase {
    private func sample(_ minute: Double, _ value: Double = 100) -> WatchChartLayout.Sample {
        WatchChartLayout.Sample(at: minute * 60, value: value)
    }

    func testHeightIsFixedLogarithmicAndClamped() {
        XCTAssertEqual(WatchChartLayout.height(of: 40), 0, accuracy: 0.0001)
        XCTAssertEqual(WatchChartLayout.height(of: 400), 1, accuracy: 0.0001)
        XCTAssertEqual(WatchChartLayout.height(of: 126.49), 0.5, accuracy: 0.001)
        XCTAssertEqual(WatchChartLayout.height(of: 20), 0, accuracy: 0.0001)
        XCTAssertEqual(WatchChartLayout.height(of: 600), 1, accuracy: 0.0001)
    }

    func testOneMissedReadingStaysALine() {
        let samples = [sample(0), sample(5), sample(15), sample(20)]
        XCTAssertEqual(WatchChartLayout.parts(samples, now: 20 * 60), [.line(samples)])
    }

    func testGapOverTheSmoothLimitGetsAConnector() {
        let samples = [sample(0), sample(5), sample(18), sample(23)]
        XCTAssertEqual(WatchChartLayout.parts(samples, now: 23 * 60), [
            .line([samples[0], samples[1]]),
            .connector(samples[1], samples[2]),
            .line([samples[2], samples[3]]),
        ])
    }

    func testGapsAtTheLimitsBelongToTheShorterKind() {
        let smooth = [sample(0), sample(12.5)]
        XCTAssertEqual(WatchChartLayout.parts(smooth, now: 12.5 * 60), [.line(smooth)])
        let connected = [sample(0), sample(30)]
        XCTAssertEqual(WatchChartLayout.parts(connected, now: 30 * 60), [
            .dot(connected[0]),
            .connector(connected[0], connected[1]),
            .dot(connected[1]),
        ])
    }

    func testLongGapIsAnAbsenceBetweenTwoLines() {
        let samples = [sample(0), sample(5), sample(45), sample(50)]
        XCTAssertEqual(WatchChartLayout.parts(samples, now: 50 * 60), [
            .line([samples[0], samples[1]]),
            .absence(from: 5 * 60, to: 45 * 60),
            .line([samples[2], samples[3]]),
        ])
    }

    func testTimeSinceTheLastReadingCountsAsAnAbsence() {
        let samples = [sample(0), sample(5)]
        XCTAssertEqual(WatchChartLayout.parts(samples, now: 17 * 60), [.line(samples)])
        XCTAssertEqual(WatchChartLayout.parts(samples, now: 18 * 60), [.line(samples), .absence(from: 5 * 60, to: 18 * 60)])
    }

    func testRepeatedTimesAreDroppedAndNoSamplesDrawNothing() {
        XCTAssertEqual(WatchChartLayout.parts([sample(0), sample(0, 120), sample(5)], now: 5 * 60), [.line([sample(0), sample(5)])])
        XCTAssertEqual(WatchChartLayout.parts([], now: 0), [])
    }

    func testCurvePassesThroughEveryPointAndStaysBetweenNeighbours() {
        let points = [CGPoint(x: 0, y: 40), CGPoint(x: 10, y: 38), CGPoint(x: 20, y: 10), CGPoint(x: 30, y: 12), CGPoint(x: 40, y: 12), CGPoint(x: 50, y: 30)]
        let curve = WatchChartLayout.curve(through: points)
        XCTAssertEqual(curve.map(\.end), Array(points.dropFirst()))
        for (segment, start) in zip(curve, points) {
            let low = min(start.y, segment.end.y) - 0.0001
            let high = max(start.y, segment.end.y) + 0.0001
            XCTAssertTrue((low...high).contains(segment.control1.y), "\(segment)")
            XCTAssertTrue((low...high).contains(segment.control2.y), "\(segment)")
        }
    }

    func testTwoPointsAreAStraightLineAndOnePointIsNoCurve() {
        let curve = WatchChartLayout.curve(through: [CGPoint(x: 0, y: 0), CGPoint(x: 30, y: 30)])
        XCTAssertEqual(curve, [WatchChartLayout.CurveSegment(control1: CGPoint(x: 10, y: 10), control2: CGPoint(x: 20, y: 20), end: CGPoint(x: 30, y: 30))])
        XCTAssertEqual(WatchChartLayout.curve(through: [CGPoint(x: 0, y: 0)]), [])
    }
}
