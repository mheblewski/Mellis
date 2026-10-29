import XCTest
@testable import GlucoMindCore

final class PatientColorTests: XCTestCase {
    func testColourIsStableAndIgnoresCase() {
        let id = "8E0B5C2A-1D3F-4A6B-9C7D-0E1F2A3B4C5D"
        XCTAssertEqual(PatientColor.forPatient(id: id), PatientColor.forPatient(id: id.lowercased()))
    }

    func testEveryFamilyIsReachable() {
        let colours = Set((0..<200).map { PatientColor.forPatient(id: "patient-\($0)") })
        XCTAssertEqual(colours, Set(PatientColor.allCases))
    }

    func testPaletteOrderIsTealPetrolSageSlateAmber() {
        XCTAssertEqual(PatientColor.allCases.map(\.tint), [.teal, .petrol, .sage, .slate, .amber])
    }
}
