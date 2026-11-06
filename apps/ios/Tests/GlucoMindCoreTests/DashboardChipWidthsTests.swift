import XCTest
@testable import GlucoMindCore

final class DashboardChipWidthsTests: XCTestCase {
    private let free = 354.0 // A 402 pt phone.

    func testShortValuesAreEqual() {
        XCTAssertEqual(DashboardChipWidths.widths(needs: [86, 70, 90], free: free), [118, 118, 118])
    }

    func testBasalWithAPlanIsClearlyWiderWithRoomInside() {
        let widths = DashboardChipWidths.widths(needs: [86, 62, 123], free: free)
        XCTAssertEqual(widths[0], widths[1])
        XCTAssertGreaterThanOrEqual(widths[2], 123 + 16)
        XCTAssertGreaterThanOrEqual(widths[2] - widths[0], 30)
        XCTAssertEqual(widths.reduce(0, +), free, accuracy: 0.001)
    }

    func testContentThatJustFitsItsShareStillGetsRoom() {
        // 112 of 118 would be equal but squeezed.
        let widths = DashboardChipWidths.widths(needs: [86, 62, 112], free: free)
        XCTAssertGreaterThan(widths[2], widths[0])
        XCTAssertGreaterThanOrEqual(widths[2], free * 0.40)
    }

    func testANarrowPhoneNeverCutsAValue() {
        // A 375 pt phone with a long IOB and basal plan: the room inside goes first.
        let needs = [100.0, 90, 130]
        let widths = DashboardChipWidths.widths(needs: needs, free: 327)
        for (width, need) in zip(widths, needs) { XCTAssertGreaterThanOrEqual(width + 0.001, need) }
        XCTAssertEqual(widths.reduce(0, +), 327, accuracy: 0.001)
    }

    func testTwoLongChipsBothGetWhatTheyNeed() {
        let needs = [125.0, 62, 130]
        let widths = DashboardChipWidths.widths(needs: needs, free: free)
        for (width, need) in zip(widths, needs) { XCTAssertGreaterThanOrEqual(width + 0.001, need) }
        XCTAssertEqual(widths.reduce(0, +), free, accuracy: 0.001)
    }

    func testTwoChipsWithoutBasal() {
        XCTAssertEqual(DashboardChipWidths.widths(needs: [86, 62], free: free), [177, 177])
    }
}
