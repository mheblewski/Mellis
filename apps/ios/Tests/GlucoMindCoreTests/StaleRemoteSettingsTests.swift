import XCTest
@testable import GlucoMindCore

/// Remote-control settings of a patient that no longer exists (a reinstalled server, a restored backup with new ids,
/// another pairing) must not block a visible patient; two visible patients still never share a Trio / Loop / secret.
final class StaleRemoteSettingsTests: XCTestCase {
    private let token = String(repeating: "ab", count: 32)

    private var trioTarget: TrioRemoteTarget {
        TrioRemoteTarget(status: "READY", device_token: token, bundle_id: "org.nightscout.ABCDE12345.trio", team_id: "ABCDE12345", apns_environment: "production", profile_uploaded_at: nil, remote_commands: nil, build_expires_at: nil)
    }

    private var loopTarget: LoopRemoteTarget {
        LoopRemoteTarget(status: "READY", device_token: token, bundle_id: "com.ABCDE12345.loopkit.Loop", team_id: "ABCDE12345", apns_environment: "production", profile_uploaded_at: nil, max_bolus_u: 6)
    }

    private let otpURL = "otpauth://totp/Loop?secret=JBSWY3DPEHPK3PXP&issuer=Loop"

    private func trioSettings() -> TrioRemoteSettings {
        TrioRemoteSettings(sharedSecret: "family-secret", pinnedTrio: PinnedTrio(target: trioTarget, at: Date()))
    }

    private func loopSettings() -> LoopRemoteSettings {
        LoopRemoteSettings(otpURL: otpURL, pinnedLoop: PinnedLoop(target: loopTarget, teamID: "ABCDE12345", at: Date()))
    }

    // MARK: - Guards

    func testTrioStalePatientIsIgnoredByTheGuard() throws {
        let store = InMemoryTrioRemoteSettingsStore()
        try store.save(trioSettings(), patientID: "old-A")
        let mine = trioSettings()
        try store.save(mine, patientID: "new-B")
        let scope = RemotePatientScope(visiblePatientIDs: ["NEW-B"])
        XCTAssertEqual(TrioPatientGuard.pin(settings: mine, target: trioTarget, patientID: "new-B", store: store, scope: scope), .confirmed)
        XCTAssertFalse(TrioPatientGuard.secretUsedByOtherPatient("family-secret", patientID: "new-B", store: store, scope: scope))
    }

    func testTrioVisibleDuplicateIsStillBlocked() throws {
        let store = InMemoryTrioRemoteSettingsStore()
        try store.save(trioSettings(), patientID: "a")
        let mine = trioSettings()
        let scope = RemotePatientScope(visiblePatientIDs: ["a", "b"])
        XCTAssertEqual(TrioPatientGuard.pin(settings: mine, target: trioTarget, patientID: "b", store: store, scope: scope), .usedByOtherPatient)
        XCTAssertTrue(TrioPatientGuard.secretUsedByOtherPatient(" family-secret ", patientID: "b", store: store, scope: scope))
    }

    func testTrioUnknownListCountsEveryPatient() throws {
        let store = InMemoryTrioRemoteSettingsStore()
        try store.save(trioSettings(), patientID: "old-A")
        let scope = RemotePatientScope()
        XCTAssertEqual(TrioPatientGuard.pin(settings: trioSettings(), target: trioTarget, patientID: "new-B", store: store, scope: scope), .usedByOtherPatient)
        XCTAssertTrue(TrioPatientGuard.secretUsedByOtherPatient("family-secret", patientID: "new-B", store: store, scope: scope))
        // The message says what to do when that patient is gone.
        XCTAssertTrue(TrioPatientGuard.message(.usedByOtherPatient, patientName: "Zosia")!.contains("listy pacjentów"))
    }

    func testLoopStalePatientIsIgnoredByTheGuard() throws {
        let store = InMemoryLoopRemoteSettingsStore()
        try store.save(loopSettings(), patientID: "old-A")
        let mine = loopSettings()
        let scope = RemotePatientScope(visiblePatientIDs: ["new-B"])
        XCTAssertEqual(LoopPatientGuard.pin(settings: mine, target: loopTarget, patientID: "new-B", store: store, scope: scope), .confirmed)
        XCTAssertFalse(LoopPatientGuard.secretUsedByOtherPatient(otpURL, patientID: "new-B", store: store, scope: scope))
    }

    func testLoopVisibleDuplicateIsStillBlocked() throws {
        let store = InMemoryLoopRemoteSettingsStore()
        try store.save(loopSettings(), patientID: "a")
        let scope = RemotePatientScope(visiblePatientIDs: ["a", "b"])
        XCTAssertEqual(LoopPatientGuard.pin(settings: loopSettings(), target: loopTarget, patientID: "b", store: store, scope: scope), .usedByOtherPatient)
        XCTAssertTrue(LoopPatientGuard.secretUsedByOtherPatient(otpURL, patientID: "b", store: store, scope: scope))
    }

    // MARK: - Cleanup

    func testSuccessfulListRemovesOnlyUnknownPatients() throws {
        let trio = InMemoryTrioRemoteSettingsStore()
        let loop = InMemoryLoopRemoteSettingsStore()
        try trio.save(trioSettings(), patientID: "old-A")
        try trio.save(trioSettings(), patientID: "new-B")
        try loop.save(loopSettings(), patientID: "old-C")
        try loop.save(loopSettings(), patientID: "new-D")
        let scope = RemotePatientScope()
        let removed = RemoteSettingsCleanup.patientListLoaded(.success(["NEW-B", "new-D"]), scope: scope, trioStore: trio, loopStore: loop)
        XCTAssertEqual(Set(removed), ["old-a", "old-c"])
        XCTAssertEqual(try trio.patientIDs(), ["new-b"])
        XCTAssertEqual(try loop.patientIDs(), ["new-d"])
        XCTAssertEqual(scope.visiblePatientIDs, ["new-b", "new-d"])
    }

    func testFailedOrEmptyListRemovesNothing() throws {
        struct Offline: Error {}
        let trio = InMemoryTrioRemoteSettingsStore()
        let loop = InMemoryLoopRemoteSettingsStore()
        try trio.save(trioSettings(), patientID: "a")
        try loop.save(loopSettings(), patientID: "b")
        let scope = RemotePatientScope()
        XCTAssertEqual(RemoteSettingsCleanup.patientListLoaded(.failure(Offline()), scope: scope, trioStore: trio, loopStore: loop), [])
        XCTAssertEqual(RemoteSettingsCleanup.patientListLoaded(.success([]), scope: scope, trioStore: trio, loopStore: loop), [])
        XCTAssertEqual(RemoteSettingsCleanup.removeSettings(notIn: [], trioStore: trio, loopStore: loop), [])
        XCTAssertEqual(try trio.patientIDs(), ["a"])
        XCTAssertEqual(try loop.patientIDs(), ["b"])
        XCTAssertNil(scope.visiblePatientIDs, "the guards keep counting every patient")
    }

    func testUnpairClearsEveryPatient() throws {
        let trio = InMemoryTrioRemoteSettingsStore()
        let loop = InMemoryLoopRemoteSettingsStore()
        try trio.save(trioSettings(), patientID: "a")
        try trio.save(trioSettings(), patientID: "b")
        try loop.save(loopSettings(), patientID: "c")
        XCTAssertEqual(Set(RemoteSettingsCleanup.removeAll(trioStore: trio, loopStore: loop)), ["a", "b", "c"])
        XCTAssertEqual(try trio.patientIDs(), [])
        XCTAssertEqual(try loop.patientIDs(), [])
    }

    func testAnotherServerClearsEveryPatientButTheFirstPairingOnlyRemembers() throws {
        let suite = "StaleRemoteSettingsTests-\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let trio = InMemoryTrioRemoteSettingsStore()
        let loop = InMemoryLoopRemoteSettingsStore()
        try trio.save(trioSettings(), patientID: "a")
        try loop.save(loopSettings(), patientID: "a")
        let home = URL(string: "https://mellis.example.com")!
        XCTAssertFalse(RemoteSettingsCleanup.serverChanged(to: home, defaults: defaults, trioStore: trio, loopStore: loop))
        XCTAssertFalse(RemoteSettingsCleanup.serverChanged(to: URL(string: "https://MELLIS.example.com:443")!, defaults: defaults, trioStore: trio, loopStore: loop))
        XCTAssertEqual(try trio.patientIDs(), ["a"])
        XCTAssertTrue(RemoteSettingsCleanup.serverChanged(to: URL(string: "https://other.example.com")!, defaults: defaults, trioStore: trio, loopStore: loop))
        XCTAssertEqual(try trio.patientIDs(), [])
        XCTAssertEqual(try loop.patientIDs(), [])
    }

    /// The owner's case: settings of the fresh install's patient A stay on the phone, the restored server shows patient
    /// B with the same Trio. After the list loads, B's Trio can be confirmed and A's settings are gone.
    func testRestoredServerWithNewPatientIDResolvesAfterTheListLoads() throws {
        let trio = InMemoryTrioRemoteSettingsStore()
        let loop = InMemoryLoopRemoteSettingsStore()
        try trio.save(trioSettings(), patientID: "patient-A")
        let scope = RemotePatientScope()
        var b = TrioRemoteSettings(sharedSecret: "family-secret")
        XCTAssertEqual(TrioPatientGuard.pin(settings: b, target: trioTarget, patientID: "patient-B", store: trio, scope: scope), .usedByOtherPatient)
        RemoteSettingsCleanup.patientListLoaded(.success(["patient-B"]), scope: scope, trioStore: trio, loopStore: loop)
        XCTAssertEqual(TrioPatientGuard.pin(settings: b, target: trioTarget, patientID: "patient-B", store: trio, scope: scope), .needsConfirmation)
        b.pinnedTrio = PinnedTrio(target: trioTarget, at: Date())
        XCTAssertEqual(TrioPatientGuard.pin(settings: b, target: trioTarget, patientID: "patient-B", store: trio, scope: scope), .confirmed)
        XCTAssertFalse(TrioPatientGuard.secretUsedByOtherPatient("family-secret", patientID: "patient-B", store: trio, scope: scope))
        XCTAssertNil(try trio.load(patientID: "patient-A"))
    }
}
