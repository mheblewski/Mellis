import XCTest
@testable import GlucoMindCore

/// The reservoir by how long its insulin lasts (reservoir-level.v1, reservoir-alerts.v1).
final class ReservoirLevelTests: XCTestCase {
    private let now = ISO8601DateFormatter().date(from: "2026-10-29T12:00:00Z")!
    private let patientID = "11111111-1111-4111-8111-111111111111"

    private func dashboard(units: Double, hoursLeft: Double?, level: String?) -> DashboardResponse {
        DashboardResponse(
            patient_id: patientID,
            generated_at: "2026-10-29T12:00:00Z",
            glucose: nil,
            readings: [],
            time_in_range: nil,
            pump: DashboardPump(battery_percent: 68, reservoir_units: units, reservoir_full_units: 160, reservoir_hours_left: hoursLeft,
                                reservoir_level: level, last_read_at: "2026-10-29T11:58:00Z"),
            site_changed_at: nil,
            sensor_started_at: nil
        )
    }

    private func reservoir(_ d: DashboardResponse) throws -> DashboardGlance.EquipmentItem {
        try XCTUnwrap(DashboardGlance.equipment(d, now: now).first { $0.kind == .reservoir })
    }

    func testDurationInPolish() {
        XCTAssertEqual(DashboardFormat.reservoirDuration(hours: 52.8), "na ok. 2 dni")
        XCTAssertEqual(DashboardFormat.reservoirDuration(hours: 48), "na ok. 2 dni")
        XCTAssertEqual(DashboardFormat.reservoirDuration(hours: 130), "na ok. 5 dni")
        XCTAssertEqual(DashboardFormat.reservoirDuration(hours: 47.9), "na ok. 47 godz.")
        XCTAssertEqual(DashboardFormat.reservoirDuration(hours: 14.6), "na ok. 14 godz.")
        XCTAssertEqual(DashboardFormat.reservoirDuration(hours: 6), "na ok. 6 godz.")
        XCTAssertEqual(DashboardFormat.reservoirDuration(hours: 0.5), "na mniej niż 1 godz.")
        XCTAssertEqual(DashboardFormat.polishDays(1), "dzień")
        XCTAssertEqual(DashboardFormat.polishDays(2), "dni")
        XCTAssertEqual(DashboardFormat.polishDays(5), "dni")
    }

    func testTheServersLevelAndDurationWin() throws {
        // 22 U is yellow by the old fixed 25 U, but lasts 2 days at this patient's use.
        let fine = try reservoir(dashboard(units: 22, hoursLeft: 52.8, level: "normal"))
        XCTAssertEqual(fine.level, .normal)
        XCTAssertEqual(fine.value, "22 j")
        XCTAssertEqual(fine.note, "na ok. 2 dni")
        XCTAssertNil(fine.hint)

        let yellow = try reservoir(dashboard(units: 40, hoursLeft: 14.2, level: "warning"))
        XCTAssertEqual(yellow.level, .warning)
        XCTAssertEqual(yellow.headline, "Zbiornik 40 j")
        XCTAssertEqual(yellow.hint, "na ok. 14 godz. · wymień dziś")

        let red = try reservoir(dashboard(units: 12, hoursLeft: 6, level: "alarm"))
        XCTAssertEqual(red.level, .alarm)
        XCTAssertEqual(red.hint, "na ok. 6 godz. · wymień teraz")
    }

    func testOlderServersKeepTheFixedThresholds() throws {
        let old = try reservoir(dashboard(units: 22, hoursLeft: nil, level: nil))
        XCTAssertEqual(old.level, .warning)
        XCTAssertEqual(old.note, "insuliny")
        XCTAssertEqual(old.hint, "wymień dziś")
        // A level without hours (the percent fallback on the server) colours it without a duration.
        let percent = try reservoir(dashboard(units: 9, hoursLeft: nil, level: "alarm"))
        XCTAssertEqual(percent.level, .alarm)
        XCTAssertEqual(percent.hint, "wymień teraz")
    }

    func testDecodesTheNewFieldsAndWorksWithoutThem() throws {
        let new = #"{"battery_percent":51,"reservoir_units":12.5,"reservoir_full_units":160,"reservoir_hours_left":7.5,"reservoir_level":"alarm","last_read_at":"2026-10-29T11:58:00Z"}"#
        let pump = try JSONDecoder().decode(DashboardPump.self, from: Data(new.utf8))
        XCTAssertEqual(pump.reservoir_hours_left, 7.5)
        XCTAssertEqual(pump.reservoirLevel, .alarm)
        let old = #"{"battery_percent":51,"reservoir_units":12.5,"reservoir_full_units":160,"last_read_at":"2026-10-29T11:58:00Z"}"#
        let oldPump = try JSONDecoder().decode(DashboardPump.self, from: Data(old.utf8))
        XCTAssertNil(oldPump.reservoir_hours_left)
        XCTAssertEqual(oldPump.reservoirLevel, .warning)
    }

    func testTheLiveActivityUsesTheSameLevel() throws {
        let state = GlucoseActivityState(dashboard: dashboard(units: 22, hoursLeft: 52.8, level: "normal"), now: now)
        XCTAssertEqual(state.reservoirLevel, "normal")
        let item = try XCTUnwrap(state.equipment(now: now).first { $0.kind == .reservoir })
        XCTAssertEqual(item.level, .normal)
        XCTAssertEqual(item.note, "na ok. 2 dni")
        // A push from an older server has neither key.
        let json = #"{"glucose":120,"reservoir":22,"reservoirFull":160,"readings":[],"boluses":[]}"#
        let old = try JSONDecoder().decode(GlucoseActivityState.self, from: Data(json.utf8))
        XCTAssertNil(old.reservoirLevel)
        XCTAssertEqual(old.equipment(now: now).first { $0.kind == .reservoir }?.level, .warning)
    }

    func testTheReservoirPushOpensTheEquipmentList() {
        let payload: [AnyHashable: Any] = ["gluco": [
            "type": "reservoir_low", "patientId": patientID, "level": "alarm",
            "routePath": "/patients/\(patientID)", "universalLink": "\(AppLink.origin)/patients/\(patientID)/equipment",
        ]]
        XCTAssertEqual(AppRoute.parse(pushPayload: payload), .equipment(patientID: patientID))
        // From the bell: the same routing.
        let bell = NotificationHistoryPayload(type: "reservoir_low", patientId: patientID, routePath: "/patients/\(patientID)",
                                              universalLink: "\(AppLink.origin)/patients/\(patientID)/equipment")
        XCTAssertEqual(AppRoute.parse(pushPayload: bell.pushUserInfo), .equipment(patientID: patientID))
    }

    func testTheSwitchIsOnByDefaultAndHiddenForOlderServers() throws {
        let new = #"{"device_id":"d1","rescue_carb_alerts_enabled":false,"answer_ready_push_enabled":true,"reservoir_push_enabled":true}"#
        XCTAssertEqual(try JSONDecoder().decode(DeviceNotificationSettings.self, from: Data(new.utf8)).reservoir_push_enabled, true)
        let old = #"{"device_id":"d1","rescue_carb_alerts_enabled":false,"answer_ready_push_enabled":true}"#
        XCTAssertNil(try JSONDecoder().decode(DeviceNotificationSettings.self, from: Data(old.utf8)).reservoir_push_enabled)
    }
}
