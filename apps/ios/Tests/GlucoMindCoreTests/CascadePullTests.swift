import XCTest
@testable import GlucoMindCore

@MainActor
final class CascadePullTests: XCTestCase {
    func testTheRingStaysFullAfterReleaseOnceTheRefreshStartedAndEmptiesOnTheNextDrag() async {
        let pull = PullModel()
        var refreshes = 0

        pull.drag(distance: 400) { refreshes += 1 }
        XCTAssertTrue(pull.triggered)
        XCTAssertTrue(pull.refreshing)

        pull.release()
        XCTAssertEqual(pull.state, PullState())
        XCTAssertTrue(pull.triggered, "the ring keeps its final state while it fades out")

        pull.drag(distance: 10) { refreshes += 1 }
        XCTAssertFalse(pull.triggered, "a new drag starts with an empty ring")
    }

    /// The spinner shows at the refresh point (5993fdd); only the data waits until the list has bounced back.
    func testAListReloadsOnlyAfterTheFingerLiftsButShowsTheSpinnerAtOnce() async throws {
        let pull = PullModel()
        var refreshes = 0

        pull.track(overscroll: 120, interacting: true, threshold: 80) { refreshes += 1 }
        XCTAssertTrue(pull.triggered)
        XCTAssertTrue(pull.refreshing, "the spinner shows at the refresh point")
        XCTAssertEqual(refreshes, 0, "nothing reloads under the finger")

        pull.track(overscroll: 90, interacting: false, threshold: 80) { refreshes += 1 }
        XCTAssertEqual(refreshes, 0, "it waits for the list to bounce back")
        try await Task.sleep(for: .milliseconds(450))
        XCTAssertEqual(refreshes, 1)
    }

    func testAShortPullDoesNotRefreshAndLeavesTheRingEmpty() {
        let pull = PullModel()
        pull.drag(distance: 30) {}
        pull.release()
        XCTAssertFalse(pull.triggered)
        XCTAssertFalse(pull.refreshing)
    }

    /// The dashboard refreshes at a fixed, short finger distance, not at a rubber-banded gap (64 pt of gap took about
    /// 200 pt of finger).
    func testTheDashboardRefreshesAtAFixedFingerDistance() {
        let pull = PullModel()
        pull.drag(distance: PullModel.threshold - 1) {}
        XCTAssertFalse(pull.triggered)
        XCTAssertLessThan(pull.state.offset, pull.state.travel, "the cards resist, the finger distance does not")
        pull.drag(distance: PullModel.threshold) {}
        XCTAssertTrue(pull.triggered)
        XCTAssertLessThanOrEqual(PullModel.threshold, 120, "reachable with a thumb on any phone")
    }

    /// The list's own bounce resists more and more (80 pt of bounce took about 300 pt of finger): the refresh goes by
    /// the finger, counted from where the list reached its top.
    func testAListRefreshesByTheFingerNotByTheBounce() {
        let pull = PullModel()
        // The finger first scrolls the list 200 pt back to its top, then pulls on.
        pull.track(overscroll: -200, finger: 0, interacting: true) {}
        pull.track(overscroll: 0, finger: 200, interacting: true) {}
        pull.track(overscroll: 2, finger: 204, interacting: true) {}
        pull.track(overscroll: 40, finger: 200 + PullModel.threshold - 1, interacting: true) {}
        XCTAssertFalse(pull.triggered, "the scroll back to the top does not count")
        XCTAssertEqual(pull.state.offset, 40, "the gap follows the bounce")
        pull.track(overscroll: 41, finger: 200 + PullModel.threshold, interacting: true) {}
        XCTAssertTrue(pull.triggered, "a small bounce is enough once the finger pulled far enough")
    }

    /// The list at its top reports no frame before the bounce: the whole pan counts (the first reported frame is
    /// already 30 pt down, its bounce only 16 pt).
    func testAPullFromTheTopCountsFromTheStartOfThePan() {
        let pull = PullModel()
        pull.track(overscroll: 16, finger: 30, interacting: true) {}
        XCTAssertEqual(pull.state.travel, 30)
        pull.track(overscroll: 52, finger: PullModel.threshold, interacting: true) {}
        XCTAssertTrue(pull.triggered)
    }

    func testAListPullStartsCountingAgainAfterGoingBackAboveTheTop() {
        let pull = PullModel()
        pull.track(overscroll: 10, finger: 20, interacting: true) {}
        pull.track(overscroll: 30, finger: 60, interacting: true) {}
        pull.track(overscroll: -50, finger: -20, interacting: true) {}
        pull.track(overscroll: -1, finger: 25, interacting: true) {}
        pull.track(overscroll: 5, finger: 30, interacting: true) {}
        pull.track(overscroll: 30, finger: 25 + PullModel.threshold - 1, interacting: true) {}
        XCTAssertFalse(pull.triggered)
        XCTAssertEqual(pull.state.travel, PullModel.threshold - 1)
    }

    func testTheRingEmptiesWithTheBounceAfterRelease() {
        let pull = PullModel()
        pull.track(overscroll: 1, finger: 0, interacting: true) {}
        pull.track(overscroll: 30, finger: 60, interacting: true) {}
        pull.track(overscroll: 15, interacting: false) {}
        XCTAssertEqual(pull.state.travel, 30, "half the bounce left, half the progress")
        pull.track(overscroll: 0, interacting: false) {}
        XCTAssertEqual(pull.state, PullState())
    }

    /// The ring never rises above the gap's top edge, which is the top bar (or the Dynamic Island).
    func testTheRingNeverSitsAboveTheGap() {
        XCTAssertEqual(PullIndicator.ringOffset(gap: 0), 0)
        XCTAssertEqual(PullIndicator.ringOffset(gap: 10), 0)
        XCTAssertEqual(PullIndicator.ringOffset(gap: 60), 19)
    }

    /// Before the list reported its inset (0), the ring went to the very top of the screen, behind the Dynamic Island.
    func testTheListRingStaysBelowTheSafeArea() {
        XCTAssertEqual(ListPullGeometry.indicatorTop(insetTop: 0, safeAreaTop: 62), 62)
        XCTAssertEqual(ListPullGeometry.indicatorTop(insetTop: 230, safeAreaTop: 62), 230)
    }
}
