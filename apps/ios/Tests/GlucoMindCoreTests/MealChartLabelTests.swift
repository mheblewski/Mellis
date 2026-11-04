import XCTest
@testable import GlucoMindCore

/// The meal chart's labels: entries closer than a label's width share one column (two boluses a minute apart drew
/// one label over the other).
final class MealChartLabelTests: XCTestCase {
    private let start = Date(timeIntervalSince1970: 1_800_000_000)

    func testEntriesAMinuteApartShareOneColumnInTimeOrder() {
        let dates = [start.addingTimeInterval(60), start, start.addingTimeInterval(3 * 3600)]
        XCTAssertEqual(MealOverviewChart.labelGroups(dates, span: 2.5 * 3600), [[1, 0], [2]])
    }

    func testEntriesFurtherApartThanALabelKeepTheirOwn() {
        let dates = [start, start.addingTimeInterval(30 * 60), start.addingTimeInterval(60 * 60)]
        XCTAssertEqual(MealOverviewChart.labelGroups(dates, span: 2.5 * 3600), [[0], [1], [2]])
    }

    func testAGroupIsMeasuredFromItsFirstEntry() {
        // 0, 10 and 20 minutes on a 2.5 h chart (a label is about 18 min): the third starts a new column.
        let dates = [start, start.addingTimeInterval(10 * 60), start.addingTimeInterval(20 * 60)]
        XCTAssertEqual(MealOverviewChart.labelGroups(dates, span: 2.5 * 3600), [[0, 1], [2]])
    }
}
