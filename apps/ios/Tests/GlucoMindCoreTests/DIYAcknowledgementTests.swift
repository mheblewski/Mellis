import XCTest
@testable import GlucoMindCore

final class DIYAcknowledgementTests: XCTestCase {
    func testTheNoticeIsTheOwnersText() {
        XCTAssertEqual(DIYAcknowledgement.notice, "Mellis to projekt DIY, nie wyrób medyczny. Używasz go na własną odpowiedzialność; decyzje o leczeniu podejmujesz Ty.")
        XCTAssertEqual(DIYAcknowledgement.acceptTitle, "Rozumiem i akceptuję")
    }

    func testUserDefaultsRememberEachScopeOnceWithItsFirstDate() throws {
        let suite = "mellis.diy-test.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let store = UserDefaultsDIYAcknowledgementStore(defaults: defaults)
        XCTAssertFalse(store.isAccepted(.pairing))
        XCTAssertFalse(store.isAccepted(.remoteBolus))

        let first = Date(timeIntervalSince1970: 1_793_000_000)
        store.acceptIfNeeded(.pairing, at: first)
        store.acceptIfNeeded(.pairing, at: first.addingTimeInterval(3600))
        XCTAssertEqual(store.acceptedAt(.pairing), first)
        XCTAssertFalse(store.isAccepted(.remoteBolus))

        // Another instance (the next launch) reads the same answer.
        XCTAssertEqual(UserDefaultsDIYAcknowledgementStore(defaults: defaults).acceptedAt(.pairing), first)
        XCTAssertEqual(defaults.double(forKey: "mellis.diy-acknowledgement.pairing.v1"), first.timeIntervalSince1970)
    }
}
