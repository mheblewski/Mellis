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
}
