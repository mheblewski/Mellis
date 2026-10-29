import CryptoKit
import XCTest
@testable import GlucoMindCore

/// Loop's commands (loop-support-plan.md, stage 3). The transport is a recorder and Loop's answers are played from the
/// shapes of LoopKit's NightscoutService: nothing is ever sent to APNs or to a Loop.
@MainActor
final class LoopRemoteCommandTests: XCTestCase {
    private let testP8 = """
-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQg5kpsG6l2lB3pXegW
TOEyzMynfZFbKhNZTvtLTc6ncRqhRANCAATSjMU+b9Vk63O+VHbF24kH2SHnToGl
e+wzF+Enyzzw2H9lpubtBRWyT0oYcYym3TOR4XxAKiz2ZGjOnS2Sv+gi
-----END PRIVATE KEY-----
"""
    /// RFC 6238's SHA-1 secret ("12345678901234567890") as Loop's QR code carries it.
    private let otpURL = "otpauth://totp/Loop?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&algorithm=SHA1&digits=6&period=30"
    private let identity = GlucoMindPushIdentity(bundleID: "pl.glucomind.ios", teamID: "TEAM123456", productionEnvironment: false)
    private let start = ISO8601DateFormatter().date(from: "2026-10-28T12:00:05Z")!

    // MARK: - Passwords, pushes, answers

    func testMakesLoopsOneTimePasswordsFromItsQRCode() throws {
        let otp = try XCTUnwrap(LoopOTP(url: otpURL))
        // RFC 6238 test vectors (SHA-1), last 6 of the 8 digits.
        XCTAssertEqual(otp.password(at: Date(timeIntervalSince1970: 59)), "287082")
        XCTAssertEqual(otp.password(at: Date(timeIntervalSince1970: 1_111_111_109)), "081804")
        XCTAssertEqual(otp.password(at: Date(timeIntervalSince1970: 2_000_000_000)), "279037")
        // Loop's QR codes are SHA1, 6 digits, 30 s: anything else would make passwords Loop refuses.
        XCTAssertNil(LoopOTP(url: "otpauth://totp/Loop?secret=GEZDGNBV&algorithm=SHA256"))
        XCTAssertNil(LoopOTP(url: "otpauth://hotp/Loop?secret=GEZDGNBV"))
        XCTAssertNil(LoopOTP(url: "https://example.com"))
    }

    func testBuildsLoopsCarbsAndBolusPushesWithAnAnswerAddressOnlyLoopCanRead() throws {
        let target = LoopRemoteTarget(status: "READY", device_token: String(repeating: "cd", count: 32), bundle_id: "com.ABCDE12345.loopkit.Loop", team_id: "ABCDE12345", apns_environment: "production", profile_uploaded_at: nil, max_bolus_u: 6)
        let back = TrioReturnNotification(productionEnvironment: false, deviceToken: "cafe", bundleId: "pl.glucomind.ios", teamId: "TEAM123456", keyId: "KEY1234567", apnsKey: testP8)
        let token = try APNsAuthToken(keyID: "KEY1234567", teamID: "ABCDE12345", p8: testP8)
        let carbs = try LoopCommandRequestBuilder.request(step: .carbs, carbsG: 40, insulinU: 4, carbsAt: nil, otp: "123456", commandID: "C0FFEE00-0000-4000-8000-000000000001", returnNotification: back, target: target, teamID: "ABCDE12345", authToken: token, now: start)
        XCTAssertEqual(carbs.url?.absoluteString, "https://api.push.apple.com/3/device/\(String(repeating: "cd", count: 32))")
        XCTAssertEqual(carbs.value(forHTTPHeaderField: "apns-topic"), "com.ABCDE12345.loopkit.Loop")
        XCTAssertEqual(carbs.value(forHTTPHeaderField: "apns-expiration"), "0")
        let body = try XCTUnwrap(JSONSerialization.jsonObject(with: carbs.httpBody!) as? [String: Any])
        XCTAssertEqual(body["carbs-entry"] as? Int, 40)
        XCTAssertEqual(body["absorption-time"] as? Double, 3)
        XCTAssertEqual(body["start-time"] as? String, "2026-10-28T12:00:05.000Z")
        XCTAssertEqual(body["expiration"] as? String, "2026-10-28T12:05:05.000Z")
        XCTAssertEqual(body["otp"] as? String, "123456")
        XCTAssertEqual(body["remote-address"] as? String, "Mellis:c0ffee00-0000-4000-8000-000000000001:carbs")
        XCTAssertNil(body["bolus-entry"])
        XCTAssertEqual((body["aps"] as? [String: Any])?["content-available"] as? Int, 1)
        // Loop reads the answer's address with the same password (OTPSecureMessenger).
        let decrypted = try LoopReturnEncryption.decrypt(body["encrypted_return_notification"] as! String, otp: "123456")
        let info = try XCTUnwrap(JSONSerialization.jsonObject(with: decrypted) as? [String: Any])
        // Loop's ReturnNotificationInfo keys (snake_case): with other names Loop cannot decode it and never answers.
        XCTAssertEqual(Set(info.keys), ["production_environment", "device_token", "bundle_id", "team_id", "key_id", "apns_key"])
        XCTAssertEqual(info["device_token"] as? String, "cafe")
        XCTAssertEqual(info["team_id"] as? String, "TEAM123456")
        XCTAssertEqual(info["production_environment"] as? Bool, false)
        XCTAssertThrowsError(try LoopReturnEncryption.decrypt(body["encrypted_return_notification"] as! String, otp: "654321"))

        let bolus = try LoopCommandRequestBuilder.request(step: .bolus, carbsG: 40, insulinU: Decimal(string: "2.35")!, carbsAt: nil, otp: "654321", commandID: "c1", returnNotification: back, target: target, teamID: "ABCDE12345", authToken: token, now: start)
        let bolusBody = try XCTUnwrap(JSONSerialization.jsonObject(with: bolus.httpBody!) as? [String: Any])
        XCTAssertEqual(bolusBody["bolus-entry"] as? Double, 2.35)
        XCTAssertNil(bolusBody["carbs-entry"])
        // A key of another team than the one that built Loop is never used.
        let otherTeam = try APNsAuthToken(keyID: "KEY1234567", teamID: "ZZZZZ99999", p8: testP8)
        XCTAssertThrowsError(try LoopCommandRequestBuilder.request(step: .bolus, carbsG: 0, insulinU: 1, carbsAt: nil, otp: "1", commandID: "c1", returnNotification: back, target: target, teamID: "ABCDE12345", authToken: otherTeam, now: start))
    }

    func testReadsLoopsAnswerAndNotTriosAsLoops() {
        let loop: [AnyHashable: Any] = ["command_status": "failed", "command_type": "bolus", "timestamp": 1.0, "aps": ["alert": ["title": "Command Failed", "body": "Command failed: Exceeds maximum allowed bolus in settings"]]]
        XCTAssertEqual(LoopReply.parse(userInfo: loop), LoopReply(success: false, step: .bolus, message: "Command failed: Exceeds maximum allowed bolus in settings"))
        XCTAssertNil(LoopReply.parse(userInfo: ["command_status": "success", "aps": ["alert": ["body": "Bolus started"]]]))
    }

    func testUsesEachPasswordOnceAndKnowsTheTeamThatBuiltLoop() {
        var settings = LoopRemoteSettings(otpURL: otpURL, apnsKeyID: "KEY1234567", apnsKeyP8: testP8)
        // 25 s of this period left: the previous period's password first (Loop still takes it), then this period's.
        let current = LoopOTP.counter(at: start)
        let first = settings.unusedPassword(at: start)
        XCTAssertEqual(first?.counter, current - 1)
        settings.markUsed(counter: first!.counter)
        XCTAssertEqual(settings.unusedPassword(at: start)?.counter, current)
        settings.markUsed(counter: current)
        XCTAssertNil(settings.unusedPassword(at: start))
        XCTAssertEqual(settings.unusedPassword(at: start.addingTimeInterval(30))?.counter, current + 1)
        // Too little of the period left for the earlier one to reach Loop in time: only this period's.
        let fresh = LoopRemoteSettings(otpURL: otpURL, apnsKeyID: "KEY1234567", apnsKeyP8: testP8)
        XCTAssertEqual(fresh.unusedPassword(at: start.addingTimeInterval(20))?.counter, current)
        let workspace = LoopRemoteTarget(status: "READY", device_token: "ab", bundle_id: "com.ABCDE12345.loopkit.Loop", team_id: "ABCDE12345", apns_environment: "sandbox", profile_uploaded_at: nil, max_bolus_u: 3)
        XCTAssertEqual(settings.loopTeamID(target: workspace), "ABCDE12345")
        let custom = LoopRemoteTarget(status: "READY", device_token: "ab", bundle_id: "pl.example.Loop", team_id: nil, apns_environment: "sandbox", profile_uploaded_at: nil, max_bolus_u: nil)
        XCTAssertNil(settings.loopTeamID(target: custom))
        XCTAssertTrue(settings.problems(loop: custom).contains { $0.hasPrefix("Wpisz Team ID") })
        settings.teamID = "ABCDE12345"
        XCTAssertEqual(settings.loopTeamID(target: custom), "ABCDE12345")
        // The phone's limit is never looser than Loop's own.
        XCTAssertTrue(settings.problems(loop: workspace).contains { $0.contains("większy niż w Loopie") })
    }

    // MARK: - The sender

    private final class Clock: @unchecked Sendable {
        var now: Date
        init(_ now: Date) { self.now = now }
    }

    private func makeSender(api: LoopFakeAPI, transport: LoopRecordingTransport, pending: LoopMemoryPendingStore, notifier: LoopRecordingNotifier, waiter: LoopReplyWaiter, clock: Clock, store: InMemoryLoopRemoteSettingsStore = InMemoryLoopRemoteSettingsStore()) -> LoopRemoteCommandSender {
        var settings = LoopRemoteSettings(otpURL: otpURL, apnsKeyID: "KEY1234567", apnsKeyP8: testP8, returnKeyID: "RET1234567", returnKeyP8: testP8, maxBolusUnits: 6, maxCarbsGrams: 120)
        settings.pinnedLoop = PinnedLoop(tokenHash: PinnedTrio.hash(String(repeating: "cd", count: 32)), bundleID: "com.ABCDE12345.loopkit.Loop", teamID: "ABCDE12345", pinnedAt: start)
        settings.limitsReviewed = true
        try? store.save(settings, patientID: "p1")
        return LoopRemoteCommandSender(patientID: "p1", api: api, settingsStore: store, transport: transport, biometrics: LoopFixedBiometrics(), identity: identity, deviceID: "device-1", pushToken: { "cafe" }, pendingStore: pending, notifier: notifier, replies: waiter, now: { clock.now }, sleep: { seconds in clock.now = clock.now.addingTimeInterval(seconds) }, carbsConfirmationTimeout: 0.3)
    }

    private let meal = RemoteCommandDraft(source: .bolusScreen, carbsG: 40, insulinU: 4, acknowledgedWarnings: [])

    /// Plays Loop's answer to the carbs as soon as the sender waits for it.
    private func answerCarbs(_ reply: LoopReply?, waiter: LoopReplyWaiter, clock: Clock, after seconds: TimeInterval = 4) {
        Task { @MainActor in
            while !waiter.isWaiting(commandID: "c1", step: .carbs) { await Task.yield() }
            clock.now = clock.now.addingTimeInterval(seconds)
            if let reply { waiter.deliver(reply, commandID: "c1") }
        }
    }

    func testAMealGoesAsCarbsThenTheBolusOnceLoopConfirmedTheCarbs() async throws {
        let api = LoopFakeAPI(now: start), transport = LoopRecordingTransport(), pending = LoopMemoryPendingStore(), notifier = LoopRecordingNotifier(), waiter = LoopReplyWaiter(), clock = Clock(start)
        answerCarbs(LoopReply(success: true, step: .carbs, message: "Carbs entry of 40.0 g delivered successfully"), waiter: waiter, clock: clock)
        let sender = makeSender(api: api, transport: transport, pending: pending, notifier: notifier, waiter: waiter, clock: clock)
        let bolusSent = expectation(forNotification: .loopBolusPushSent, object: "c1")
        let outcome = await sender.send(meal)
        // Returned once the carbs left: the screen follows the command while the bolus waits for Loop.
        guard case .sent = outcome else { return XCTFail("\(outcome)") }
        await sender.bolusTask?.value
        await fulfillment(of: [bolusSent], timeout: 1)
        XCTAssertEqual(api.authorized?.driver, "LOOP")
        XCTAssertEqual(transport.bodies.map { $0["carbs-entry"] != nil ? "carbs" : "bolus" }, ["carbs", "bolus"])
        // Two pushes, two passwords: Loop refuses one twice.
        let passwords = transport.bodies.compactMap { $0["otp"] as? String }
        XCTAssertEqual(passwords.count, 2)
        XCTAssertNotEqual(passwords[0], passwords[1])
        XCTAssertEqual(pending.pending?.loopStep, .bolus)
        XCTAssertEqual(api.sentReports, [true])
    }

    func testNoBolusWithoutLoopsConfirmationOfTheCarbs() async {
        // Loop refused the carbs: the bolus never goes.
        let refusedAPI = LoopFakeAPI(now: start), refused = LoopRecordingTransport(), waiter = LoopReplyWaiter(), clock = Clock(start)
        answerCarbs(LoopReply(success: false, step: .carbs, message: "Command failed: Exceeds maximum allowed carbs"), waiter: waiter, clock: clock)
        let refusedSender = makeSender(api: refusedAPI, transport: refused, pending: LoopMemoryPendingStore(), notifier: LoopRecordingNotifier(), waiter: waiter, clock: clock)
        _ = await refusedSender.send(meal)
        await refusedSender.bolusTask?.value
        XCTAssertEqual(refused.bodies.count, 1)

        // No answer in time: the bolus is withheld and the caregiver told to check Loop.
        let silent = LoopRecordingTransport(), pending = LoopMemoryPendingStore(), notifier = LoopRecordingNotifier(), silentWaiter = LoopReplyWaiter()
        let silentAPI = LoopFakeAPI(now: start)
        let silentSender = makeSender(api: silentAPI, transport: silent, pending: pending, notifier: notifier, waiter: silentWaiter, clock: Clock(start))
        _ = await silentSender.send(meal)
        await silentSender.bolusTask?.value
        XCTAssertEqual(silent.bodies.count, 1)
        XCTAssertEqual(pending.pending?.bolusWithheld, true)
        // The server is told too: the other caregivers never read "the insulin may have been given".
        XCTAssertEqual(silentAPI.withheldReports.count, 1)
        XCTAssertTrue(notifier.events.contains { $0.contains("⚠️ Bolus nie został wysłany") })

        // A confirmation too late after the carbs: no bolus either.
        let late = LoopRecordingTransport(), lateWaiter = LoopReplyWaiter(), lateClock = Clock(start)
        answerCarbs(LoopReply(success: true, step: .carbs, message: "ok"), waiter: lateWaiter, clock: lateClock, after: LoopRemoteCommandSender.bolusLatestAfterCarbs + 10)
        let lateSender = makeSender(api: LoopFakeAPI(now: start), transport: late, pending: LoopMemoryPendingStore(), notifier: LoopRecordingNotifier(), waiter: lateWaiter, clock: lateClock)
        _ = await lateSender.send(meal)
        await lateSender.bolusTask?.value
        XCTAssertEqual(late.bodies.count, 1)

        // Loop answered the carbs before the sender began to wait: the answer is kept, the bolus goes.
        let quick = LoopRecordingTransport(), quickWaiter = LoopReplyWaiter()
        quickWaiter.deliver(LoopReply(success: true, step: .carbs, message: "ok"), commandID: "c1")
        let quickSender = makeSender(api: LoopFakeAPI(now: start), transport: quick, pending: LoopMemoryPendingStore(), notifier: LoopRecordingNotifier(), waiter: quickWaiter, clock: Clock(start))
        _ = await quickSender.send(meal)
        await quickSender.bolusTask?.value
        XCTAssertEqual(quick.bodies.count, 2)
    }

    func testAnAnswerToAnotherPushIsNotThisCommandsAnswer() async {
        // Meal B waits for Loop to store its carbs; a late "bolus started" (meal A's) arrives meanwhile.
        let api = LoopFakeAPI(now: start)
        let pendingStore = LoopMemoryPendingStore()
        var pending = PendingRemoteCommand(patientID: "p1", commandID: "c1", carbsG: 40, insulinU: 4, sentAt: start)
        pending.driver = "LOOP"
        pending.loopStep = .carbs
        pending.loopStepSentAt = start
        pendingStore.pending = pending
        let waiter = LoopReplyWaiter()
        let handler = TrioReplyHandler(api: api, pendingStore: pendingStore, notifier: LoopRecordingNotifier(), loopReplies: waiter, now: { self.start.addingTimeInterval(3) })
        _ = await handler.handle(userInfo: ["command_status": "success", "command_type": "bolus", "aps": ["alert": ["body": "Bolus started"]]], key: "late-a", deliveredAt: start.addingTimeInterval(2))
        XCTAssertTrue(api.replyReports.isEmpty)
        XCTAssertEqual(pendingStore.pending?.loopStep, .carbs)

        // B's bolus left at +20 s: an answer delivered before that push is not B's either.
        pending.loopStep = .bolus
        pending.loopStepSentAt = start.addingTimeInterval(20)
        pendingStore.pending = pending
        _ = await handler.handle(userInfo: ["command_status": "success", "command_type": "bolus", "aps": ["alert": ["body": "Bolus started"]]], key: "late-a2", deliveredAt: start.addingTimeInterval(10))
        XCTAssertTrue(api.replyReports.isEmpty)
        // B's own answer counts.
        _ = await handler.handle(userInfo: ["command_status": "success", "command_type": "bolus", "aps": ["alert": ["body": "Bolus started"]]], key: "b", deliveredAt: start.addingTimeInterval(23))
        XCTAssertEqual(api.replyReports.map(\.step), [.bolus])
    }

    func testAnswersAreReportedPerStepAndALateCarbsConfirmationSettlesTheWithheldBolus() async {
        let api = LoopFakeAPI(now: start)
        let pendingStore = LoopMemoryPendingStore()
        var pending = PendingRemoteCommand(patientID: "p1", commandID: "c1", carbsG: 40, insulinU: 4, sentAt: start)
        pending.driver = "LOOP"
        pending.loopStep = .carbs
        pending.bolusWithheld = true
        pendingStore.pending = pending
        let notifier = LoopRecordingNotifier()
        let handler = TrioReplyHandler(api: api, pendingStore: pendingStore, notifier: notifier, loopReplies: LoopReplyWaiter(), now: { self.start.addingTimeInterval(200) })
        let handled = await handler.handle(userInfo: ["command_status": "success", "command_type": "carbs", "aps": ["alert": ["body": "Carbs entry of 40.0 g delivered successfully"]]], key: "n1", deliveredAt: start.addingTimeInterval(150))
        XCTAssertTrue(handled)
        XCTAssertEqual(api.replyReports.map(\.step), [.bolus])
        XCTAssertEqual(api.replyReports.first?.success, false)
        XCTAssertNil(pendingStore.pending)
        XCTAssertTrue(notifier.events.contains { $0.contains("❌ Bolus nie został podany") })
    }
}

// MARK: - Doubles

private final class LoopFakeAPI: RemoteCommandsAPI {
    let now: Date
    var authorized: RemoteCommandAuthorizeRequest?
    var sentReports: [Bool] = []
    var replyReports: [(success: Bool, message: String, step: LoopCommandStep)] = []
    var withheldReports: [String] = []

    init(now: Date) { self.now = now }

    func command(status: String, message: String? = nil) -> RemoteCommand {
        let formatter = ISO8601DateFormatter()
        return RemoteCommand(id: "c1", patient_id: "p1", status: status, status_message: message, source: "BOLUS_SCREEN", carbs_g: 40, insulin_u: 4, icr_g_per_u: 10, meal_description: nil, conversation_id: nil, proposal_id: nil, sent_by_me: true, authorized_at: formatter.string(from: now), send_deadline: formatter.string(from: now.addingTimeInterval(600)), sent_at: nil, answered_at: nil, meal_record_id: nil, loop_action_id: nil, warnings: [])
    }

    func previewRemoteCommand(patientID: String, carbsG: Int, insulinU: Decimal?, bolusStep: Decimal, mealInMinutes: Int?, proposalID: String?) async throws -> RemoteCommandPreview { fatalError() }
    func authorizeRemoteCommand(patientID: String, request: RemoteCommandAuthorizeRequest) async throws -> RemoteCommand {
        authorized = request
        return command(status: "AUTHORIZED")
    }
    func reportRemoteCommandSent(patientID: String, commandID: String, accepted: Bool, message: String?) async throws -> RemoteCommand {
        sentReports.append(accepted)
        return command(status: accepted ? "SENT" : "SEND_FAILED")
    }
    func reportRemoteCommandReply(patientID: String, commandID: String, success: Bool, message: String) async throws -> RemoteCommand { fatalError("Loop answers name their step") }
    func reportRemoteCommandReply(patientID: String, commandID: String, success: Bool, message: String, step: LoopCommandStep) async throws -> RemoteCommand {
        replyReports.append((success, message, step))
        if step == .carbs && success { return command(status: "TRIO_ACCEPTED") }
        return command(status: success ? "SUCCEEDED" : (step == .bolus ? "PARTIAL" : "REJECTED"), message: success ? "Bolus podany" : "Błąd: \(message)")
    }
    func reportLoopBolusWithheld(patientID: String, commandID: String, message: String) async throws -> RemoteCommand {
        withheldReports.append(message)
        return command(status: "NO_REPLY")
    }
    func listRemoteCommands(patientID: String, limit: Int) async throws -> [RemoteCommand] { [] }
    func getRemoteCommand(patientID: String, commandID: String) async throws -> RemoteCommand { command(status: "SENT") }
    func getTrioRemoteTarget(patientID: String) async throws -> TrioRemoteTargetResponse { fatalError("a Loop command never reads Trio's address") }
    func getLoopRemoteTarget(patientID: String) async throws -> LoopRemoteTargetResponse {
        LoopRemoteTargetResponse(patient_id: "p1", loop: LoopRemoteTarget(status: "READY", device_token: String(repeating: "cd", count: 32), bundle_id: "com.ABCDE12345.loopkit.Loop", team_id: "ABCDE12345", apns_environment: "production", profile_uploaded_at: nil, max_bolus_u: 6), pump_bolus_step: nil)
    }
}

private final class LoopRecordingTransport: APNsTransport {
    var requests: [URLRequest] = []
    var bodies: [[String: Any]] { requests.compactMap { $0.httpBody.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] } } }
    func send(_ request: URLRequest) async throws -> (status: Int, body: Data) {
        requests.append(request)
        return (200, Data())
    }
}

private struct LoopFixedBiometrics: BiometricGate {
    func confirm(reason: String) async -> BiometricResult { .confirmed }
}

private final class LoopMemoryPendingStore: PendingRemoteCommandStore {
    var pending: PendingRemoteCommand?
    var handledReplyKeys: [String] = []
}

private final class LoopRecordingNotifier: RemoteCommandNotifier {
    var events: [String] = []
    func commandSent(commandID: String, patientID: String, summary: String) { events.append("sent \(commandID)") }
    func scheduleNoReply(commandID: String, patientID: String, after seconds: TimeInterval) { events.append("noreply \(commandID)") }
    func cancelNoReply(commandID: String) { events.append("cancel \(commandID)") }
    func commandFinished(commandID: String, patientID: String, title: String, body: String) { events.append("finished \(title) | \(body)") }
    func removeDelivered(identifiers: [String]) {}
}
