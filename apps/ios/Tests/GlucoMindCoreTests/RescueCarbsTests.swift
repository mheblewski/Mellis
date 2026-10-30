import Combine
import XCTest
@testable import GlucoMindCore

@MainActor
final class RescueCarbsTests: XCTestCase {
    // MARK: Decoding

    func testDecodesTheDoseWarningsAndToleratesTheirAbsence() throws {
        let withWarnings = try JSONDecoder().decode(RescueCarbsProposal.self, from: Data(#"{"carbs_g":16,"basis":"TRIO_CARBS_REQ","explanation":["Trio liczy 16 g"],"warnings":["Dużo aktywnej insuliny (IOB 9 j): sprawdź, czy nie brakuje wpisu węglowodanów w Trio."]}"#.utf8))
        XCTAssertEqual(withWarnings.carbs_g, 16)
        XCTAssertEqual(withWarnings.warnings.count, 1)
        let older = try JSONDecoder().decode(RescueCarbsProposal.self, from: Data(#"{"carbs_g":3,"basis":"FORMULA","explanation":[]}"#.utf8))
        XCTAssertEqual(older.warnings, [])
    }

    func testDecodesTheAlertBlockAndTheChatCards() throws {
        let conversation = try JSONDecoder().decode(ConversationResponse.self, from: RescueConversationAPI.conversationData())
        let rescue = try XCTUnwrap(conversation.rescue_carbs)
        XCTAssertEqual(rescue.alert_id, "alert-1")
        XCTAssertEqual(rescue.levelKind, .predictedLow)
        XCTAssertEqual(rescue.title, "Możliwe niedocukrzenie")
        XCTAssertEqual(rescue.glucose_readings.count, 3)
        XCTAssertEqual(rescue.glucose_readings.first?.value, 95)
        XCTAssertEqual(rescue.prediction.first?.time, "2026-10-20T12:05:00.000Z")
        XCTAssertEqual(rescue.proposal?.explanation.count, 3)
        XCTAssertEqual(rescue.proposedGrams, 4)
        XCTAssertEqual(rescue.proposalLine, "Proponuję 4 g węglowodanów")
        // The latest reading, with the change per 5 min from the alert.
        XCTAssertEqual(rescue.glucoseLine, "78 mg/dL · −6 / 5 min")
        XCTAssertEqual(rescue.predictionLine, "ok. \(HypoFormat.time("2026-10-20T12:20:00.000Z")) może spaść poniżej 70 mg/dL")
        XCTAssertFalse(rescue.isTreated)
        XCTAssertNil(rescue.treatmentLine(loop: LoopSystemKind.trio.names))
        XCTAssertNil(rescue.closedLine)

        let card = try XCTUnwrap(conversation.messages.last?.rescue_carb_proposals?.first)
        XCTAssertEqual(card.carbs_g, 8)
        XCTAssertEqual(card.status, "PROPOSED")
        XCTAssertNil(RescueCarbProposalCard.decidedLine(proposal: card, treatment: nil))
    }

    func testOtherConversationsAndOlderServersHaveNoAlert() throws {
        let json = #"{"id":"c","patient_id":"p","awaiting_user_answer":false,"pending_question":null,"messages":[{"id":"m","role":"ASSISTANT","message_type":"ASSISTANT_MESSAGE","content":"Hej","created_at":"2026-10-20T12:00:00Z"}],"analysis_id":null,"recommendation_id":null}"#
        let conversation = try JSONDecoder().decode(ConversationResponse.self, from: Data(json.utf8))
        XCTAssertNil(conversation.rescue_carbs)
        XCTAssertNil(conversation.messages.first?.rescue_carb_proposals)
    }

    func testUnknownValuesAndBrokenDetailsDoNotBreakTheConversation() throws {
        let json = """
        {"id":"c","patient_id":"p","awaiting_user_answer":false,"pending_question":null,"analysis_id":null,"recommendation_id":null,
         "messages":[{"id":"m","role":"ASSISTANT","message_type":"ASSISTANT_MESSAGE","content":"Hej","created_at":"2026-10-20T12:00:00Z",
           "rescue_carb_proposals":[{"id":"r1","carbs_g":"dużo","status":"SOMETHING_NEW"}]}],
         "rescue_carbs":{"alert_id":"a","status":"PAUSED","level":"VERY_LOW_SOON","proposal":{"carbs_g":"x"},"glucose_readings":[{"observed_at":"2026-10-20T12:00:00Z"}],"treatment":{"carbs_g":null}}}
        """
        let conversation = try JSONDecoder().decode(ConversationResponse.self, from: Data(json.utf8))
        let rescue = try XCTUnwrap(conversation.rescue_carbs)
        XCTAssertEqual(rescue.levelKind, .predictedLow, "an unknown level reads as the mildest title")
        XCTAssertEqual(rescue.status, "PAUSED")
        XCTAssertEqual(rescue.glucose_readings, [], "a broken curve is left out")
        XCTAssertNil(rescue.treatment)
        XCTAssertNil(rescue.proposedGrams)
        XCTAssertEqual(rescue.proposalLine, "Brak profilu terapii — sprawdź glukozę")
        let card = try XCTUnwrap(conversation.messages.first?.rescue_carb_proposals?.first)
        XCTAssertEqual(card.id, "r1")
        XCTAssertFalse(card.isAccepted)
        XCTAssertFalse(card.isSuperseded)
    }

    func testWithoutATherapyProfileThereIsNoDose() throws {
        let json = #"{"alert_id":"a","status":"NOTIFIED","level":"LOW_NOW","glucose_mgdl":64,"delta_per_5min":-3,"proposal":{"carbs_g":null,"basis":"NO_PROFILE","explanation":[]},"glucose_readings":[],"prediction":[]}"#
        let rescue = try JSONDecoder().decode(ConversationRescueCarbs.self, from: Data(json.utf8))
        XCTAssertEqual(rescue.title, "Niedocukrzenie")
        XCTAssertNil(rescue.proposedGrams)
        XCTAssertEqual(rescue.proposalLine, "Brak profilu terapii — sprawdź glukozę")
        XCTAssertEqual(rescue.glucoseLine, "64 mg/dL · −3 / 5 min")
        XCTAssertNil(rescue.predictionLine)
    }

    func testAnOngoingLowShowsNoForecast() throws {
        // 2026-10-20 19:26: 64 mg/dL, Trio's curve below 70 from its next point and down to its floor of 39.
        let json = #"{"alert_id":"a","status":"NOTIFIED","level":"LOW_NOW","glucose_mgdl":64,"glucose_at":"2026-10-20T17:25:00.000Z","delta_per_5min":-4,"predicted_min_mgdl":39,"predicted_low_at":"2026-10-20T17:29:00.000Z","glucose_readings":[{"observed_at":"2026-10-20T17:20:00.000Z","value":68},{"observed_at":"2026-10-20T17:25:00.000Z","value":64}],"prediction":[{"at":"2026-10-20T17:24:00.000Z","value":64},{"at":"2026-10-20T17:29:00.000Z","value":58},{"at":"2026-10-20T17:34:00.000Z","value":49},{"at":"2026-10-20T17:39:00.000Z","value":39}]}"#
        let rescue = try JSONDecoder().decode(ConversationRescueCarbs.self, from: Data(json.utf8))
        XCTAssertNil(rescue.predictionLine)
        XCTAssertEqual(rescue.chartForecast, [])
    }

    func testTheForecastStopsAtSeventyAndAtThePresent() throws {
        let json = #"{"alert_id":"a","status":"NOTIFIED","level":"PREDICTED_LOW","glucose_mgdl":82,"glucose_at":"2026-10-20T12:00:00.000Z","predicted_min_mgdl":39,"predicted_low_at":"2026-10-20T12:15:00.000Z","glucose_readings":[{"observed_at":"2026-10-20T11:55:00.000Z","value":88},{"observed_at":"2026-10-20T12:00:00.000Z","value":82}],"prediction":[{"at":"2026-10-20T12:00:00.000Z","value":82},{"at":"2026-10-20T12:05:00.000Z","value":78},{"at":"2026-10-20T12:10:00.000Z","value":72},{"at":"2026-10-20T12:15:00.000Z","value":64},{"at":"2026-10-20T12:20:00.000Z","value":52},{"at":"2026-10-20T12:25:00.000Z","value":39}]}"#
        let rescue = try JSONDecoder().decode(ConversationRescueCarbs.self, from: Data(json.utf8))
        XCTAssertEqual(rescue.predictionLine, "ok. \(HypoFormat.time("2026-10-20T12:15:00.000Z")) może spaść poniżej 70 mg/dL")
        XCTAssertEqual(rescue.chartForecast.map(\.value), [78, 72, 64])

        // Later readings: past the forecast crossing and still above 70, the old forecast is no longer shown.
        let later = json.replacingOccurrences(of: #""prediction""#, with: #""latest_glucose":{"observed_at":"2026-10-20T12:16:00.000Z","value":74},"prediction""#)
        let stale = try JSONDecoder().decode(ConversationRescueCarbs.self, from: Data(later.utf8))
        XCTAssertNil(stale.predictionLine)
        XCTAssertEqual(stale.chartForecast, [])
    }

    func testTreatedAndClosedAlertsSaySo() throws {
        let treated = ConversationRescueCarbs(
            alert_id: "a", status: "TREATED", level: "URGENT_LOW",
            treatment: RescueCarbsTreatment(carbs_g: 6, given_at: "2026-10-20T12:05:00.000Z", logged_by: "Ewa", source: "ALERT")
        )
        XCTAssertEqual(treated.title, "Pilne: niedocukrzenie")
        XCTAssertEqual(treated.treatmentLine(loop: LoopSystemKind.trio.names), "Podano 6 g o \(HypoFormat.time("2026-10-20T12:05:00.000Z")) · Ewa · tylko w Mellis")
        var inTrio = RescueCarbsTreatment(carbs_g: 6, given_at: "2026-10-20T12:05:00.000Z", logged_by: "Ewa", source: "ALERT")
        inTrio.in_loop = true
        XCTAssertEqual(ConversationRescueCarbs(alert_id: "a", status: "TREATED", level: "URGENT_LOW", treatment: inTrio).treatmentLine(loop: LoopSystemKind.trio.names), "Podano 6 g o \(HypoFormat.time("2026-10-20T12:05:00.000Z")) · Ewa · w Trio")
        XCTAssertNil(treated.closedLine)

        let card = ConversationRescueCarbProposal(id: "r1", carbs_g: 8, status: "PROPOSED")
        XCTAssertEqual(RescueCarbProposalCard.decidedLine(proposal: card, treatment: treated.treatment), "Wpisano 6 g")
        let accepted = ConversationRescueCarbProposal(id: "r1", carbs_g: 6, status: "ACCEPTED")
        XCTAssertEqual(RescueCarbProposalCard.decidedLine(proposal: accepted, treatment: nil), "Zatwierdzono")
        XCTAssertEqual(RescueCarbProposalCard.decidedLine(proposal: accepted, treatment: treated.treatment), "Zatwierdzono · wpisano 6 g")

        // Closed without a treatment: the state is shown and logging stays possible.
        let resolved = ConversationRescueCarbs(alert_id: "a", status: "RESOLVED", level: "PREDICTED_LOW")
        XCTAssertTrue(resolved.isClosedWithoutTreatment)
        XCTAssertNotNil(resolved.closedLine)
        XCTAssertTrue(ConversationRescueCarbs(alert_id: "a", status: "EXPIRED", level: "PREDICTED_LOW").isClosedWithoutTreatment)
    }

    func testAChatCardWithoutAnAlertIsConfirmedInGlucoMindOnly() async throws {
        let api = ChatRescueAPI()
        let model = ConversationViewModel(apiClient: api.client, patientID: "patient-1", conversationID: "conv-chat", pollInterval: .milliseconds(1))
        await model.loadConversation()
        XCTAssertNil(model.rescueCarbs, "an ordinary conversation has no alert block")
        let card = try XCTUnwrap(model.conversation?.messages.last?.rescue_carb_proposals?.first)
        XCTAssertNil(RescueCarbProposalCard.decidedLine(proposal: card, treatment: nil))

        let closes = await model.logRescueCarbs(carbsG: 8, givenAt: Date(timeIntervalSince1970: 1_792_497_600), proposalID: "r1")

        XCTAssertTrue(closes)
        XCTAssertNil(model.rescueCarbsError)
        XCTAssertEqual(api.postPath, "/v1/patients/patient-1/conversations/conv-chat/rescue-carb-proposals/r1/accept")
        let sent = try XCTUnwrap(JSONSerialization.jsonObject(with: XCTUnwrap(api.lastPostBody)) as? [String: Any])
        XCTAssertEqual(sent["carbs_g"] as? Double, 8)
        XCTAssertEqual(sent["given_at"] as? String, "2026-10-20T12:00:00.000Z")
        let logged = try XCTUnwrap(model.conversation?.messages.last?.rescue_carb_proposals?.first)
        XCTAssertEqual(logged.logged?.carbs_g, 8)
        XCTAssertEqual(
            RescueCarbProposalCard.decidedLine(proposal: logged, treatment: nil),
            "Wpisano 8 g o \(HypoFormat.time("2026-10-20T12:00:00.000Z")) · tylko w Mellis"
        )
    }

    func testEveryMessageSaysThisBuildCanConfirmChatRescueCards() throws {
        let body = try JSONEncoder().encode(UserMessageSubmissionRequest(content: "Dałem soczek"))
        let sent = try XCTUnwrap(JSONSerialization.jsonObject(with: body) as? [String: Any])
        XCTAssertEqual(sent["rescue_cards"] as? Bool, true)
    }

    func testGramsAreWholeOrHalfFromOneToFifty() {
        XCTAssertEqual(RescueCarbsFormat.parseGrams("4"), 4)
        XCTAssertEqual(RescueCarbsFormat.parseGrams("7,5"), 7.5)
        XCTAssertEqual(RescueCarbsFormat.parseGrams("7.5"), 7.5)
        XCTAssertNil(RescueCarbsFormat.parseGrams("0,5"))
        XCTAssertNil(RescueCarbsFormat.parseGrams("51"))
        XCTAssertNil(RescueCarbsFormat.parseGrams("4,2"))
        XCTAssertNil(RescueCarbsFormat.parseGrams(""))
        XCTAssertEqual(RescueCarbsFormat.grams(7.5), "7,5")
    }

    // MARK: Logging

    func testLoggingShowsTheTreatmentAndRefreshesTheMealsTab() async throws {
        let api = RescueConversationAPI()
        let model = ConversationViewModel(apiClient: api.client, patientID: "patient-1", conversationID: "conv-rescue", pollInterval: .milliseconds(1))
        let live = LiveUpdates(patientID: "patient-1", requestFactory: { URLRequest(url: URL(string: "https://x")!) }, transport: SilentEventStream(), retryDelays: [.seconds(60)])
        model.bindLiveUpdates(live)
        var changes: [LiveChange] = []
        let subscription = live.changes.sink { changes.append($0) }
        defer { subscription.cancel() }
        await model.loadConversation()
        XCTAssertEqual(model.rescueCarbs?.isTreated, false)

        let closes = await model.logRescueCarbs(carbsG: 6, givenAt: Date(timeIntervalSince1970: 1_792_497_600), proposalID: "r1")

        XCTAssertTrue(closes)
        XCTAssertNil(model.rescueCarbsError)
        XCTAssertEqual(model.rescueCarbs?.treatment?.carbs_g, 6)
        XCTAssertEqual(model.rescueCarbs?.treatment?.logged_by, "Piotr")
        XCTAssertTrue(changes.contains(.changed(kind: "meals", id: nil)), "the meals tab re-reads its entries")
        let body = try XCTUnwrap(api.lastPostBody)
        let sent = try XCTUnwrap(JSONSerialization.jsonObject(with: body) as? [String: Any])
        XCTAssertEqual(sent["carbs_g"] as? Double, 6)
        XCTAssertEqual(sent["proposal_id"] as? String, "r1")
        XCTAssertEqual(sent["given_at"] as? String, "2026-10-20T12:00:00.000Z")
        XCTAssertEqual(api.postPath, "/v1/patients/patient-1/conversations/conv-rescue/rescue-carbs")
    }

    func testNiePodajeShowsTheDecisionAndStillAllowsLogging() async throws {
        let api = RescueConversationAPI()
        let model = ConversationViewModel(apiClient: api.client, patientID: "patient-1", conversationID: "conv-rescue", pollInterval: .milliseconds(1))
        await model.loadConversation()
        XCTAssertEqual(model.rescueCarbs?.canDecline, true)

        await model.declineRescueCarbs()

        XCTAssertEqual(api.declinePath, "/v1/patients/patient-1/conversations/conv-rescue/rescue-carbs/decline")
        let rescue = try XCTUnwrap(model.rescueCarbs)
        XCTAssertTrue(rescue.isDeclined)
        XCTAssertFalse(rescue.canDecline)
        XCTAssertFalse(rescue.isTreated)
        XCTAssertTrue(rescue.declinedLine?.hasPrefix("Bez dosłodzenia · ") == true)
        XCTAssertTrue(rescue.declinedLine?.hasSuffix(" · Piotr") == true)
        XCTAssertEqual(rescue.declineFollowUpLine, "Przypomnienie nie przyjdzie. Nowe ostrzeżenie — jeśli glukoza spadnie poniżej 70.")
        XCTAssertNil(model.rescueCarbsNotice)
        XCTAssertFalse(model.isDecliningRescueCarbs)

        // Changed their mind: the carbs are logged and the decision no longer shows.
        let closes = await model.logRescueCarbs(carbsG: 4, givenAt: nil)
        XCTAssertTrue(closes)
        XCTAssertEqual(model.rescueCarbs?.isDeclined, false)
        XCTAssertEqual(model.rescueCarbs?.isTreated, true)
    }

    func testNiePodajeWithAnEmptyBlockInTheAnswerIsSavedAndReadAgain() async throws {
        let api = RescueConversationAPI()
        api.declineAnswersEmptyBlock = true
        let model = ConversationViewModel(apiClient: api.client, patientID: "patient-1", conversationID: "conv-rescue", pollInterval: .milliseconds(1))
        await model.loadConversation()

        await model.declineRescueCarbs()

        XCTAssertNil(model.rescueCarbsNotice, "a saved decision is not reported as failed")
        XCTAssertEqual(model.rescueCarbs?.isDeclined, true, "the block was read again")
    }

    func testNiePodajeAfterTheOtherCaregiverLoggedCarbs() async {
        let api = RescueConversationAPI()
        api.postStatus = 409
        let model = ConversationViewModel(apiClient: api.client, patientID: "patient-1", conversationID: "conv-rescue", pollInterval: .milliseconds(1))
        await model.loadConversation()

        await model.declineRescueCarbs()

        XCTAssertEqual(model.rescueCarbsNotice, "Dosłodzenie już wpisane (Ewa)")
        XCTAssertEqual(model.rescueCarbs?.isTreated, true)
        XCTAssertEqual(model.rescueCarbs?.isDeclined, false)
    }

    func testTheAlertsDoseIsSentWithoutACard() throws {
        let body = try JSONEncoder().encode(RescueCarbsLogRequest(carbs_g: 4, given_at: nil, proposal_id: nil))
        let sent = try XCTUnwrap(JSONSerialization.jsonObject(with: body) as? [String: Any])
        XCTAssertTrue(sent["proposal_id"] is NSNull)
        XCTAssertNil(sent["given_at"])
    }

    func testTheOtherCaregiverLoggedFirst() async {
        let api = RescueConversationAPI()
        api.postStatus = 409
        let model = ConversationViewModel(apiClient: api.client, patientID: "patient-1", conversationID: "conv-rescue", pollInterval: .milliseconds(1))
        await model.loadConversation()
        let readsBefore = api.conversationReads

        let closes = await model.logRescueCarbs(carbsG: 4, givenAt: nil)

        XCTAssertTrue(closes, "nothing to retry: the sheet closes and the block shows theirs")
        XCTAssertEqual(model.rescueCarbsNotice, "Dosłodzenie już wpisane (Ewa)")
        XCTAssertNil(model.rescueCarbsError)
        XCTAssertGreaterThan(api.conversationReads, readsBefore)
    }

    func testANetworkErrorKeepsTheSheetOpen() async {
        let api = RescueConversationAPI()
        api.failPostWithTransport = true
        let model = ConversationViewModel(apiClient: api.client, patientID: "patient-1", conversationID: "conv-rescue", pollInterval: .milliseconds(1))
        await model.loadConversation()

        let closes = await model.logRescueCarbs(carbsG: 4, givenAt: nil)

        XCTAssertFalse(closes)
        XCTAssertEqual(model.rescueCarbsError, "Brak połączenia — nic nie zapisano. Spróbuj ponownie.")
        XCTAssertEqual(model.rescueCarbs?.isTreated, false)
        XCTAssertFalse(model.isLoggingRescueCarbs)
    }

    func testGramsOutsideTheRangeAreNotSent() async {
        let api = RescueConversationAPI()
        let model = ConversationViewModel(apiClient: api.client, patientID: "patient-1", conversationID: "conv-rescue", pollInterval: .milliseconds(1))
        await model.loadConversation()

        let closes = await model.logRescueCarbs(carbsG: 60, givenAt: nil)

        XCTAssertFalse(closes)
        XCTAssertNil(api.lastPostBody)
        XCTAssertNotNil(model.rescueCarbsError)
    }
}

// MARK: - Notification settings

@MainActor
final class DeviceNotificationSettingsTests: XCTestCase {
    func testLoadsAndSavesThisPhonesToggle() async throws {
        let api = SettingsAPI()
        let model = DeviceNotificationSettingsViewModel(apiClient: api.client, patientID: "p1", deviceID: "device-1")

        await model.load()
        XCTAssertTrue(model.isLoaded)
        XCTAssertFalse(model.rescueCarbAlertsEnabled, "off by default")
        XCTAssertEqual(api.requests.first, "GET /v1/patients/p1/devices/device-1/notification-settings")

        await model.setRescueCarbAlertsEnabled(true)
        XCTAssertTrue(model.rescueCarbAlertsEnabled)
        XCTAssertEqual(api.requests.last, "PUT /v1/patients/p1/devices/device-1/notification-settings")
        let sent = try XCTUnwrap(JSONSerialization.jsonObject(with: XCTUnwrap(api.lastBody)) as? [String: Any])
        XCTAssertEqual(sent["rescue_carb_alerts_enabled"] as? Bool, true)
        XCTAssertNil(sent["answer_ready_push_enabled"], "only the switch changed is sent")
    }

    func testTheAnswerReadyPushIsOnByDefaultAndSavedOnItsOwn() async throws {
        let api = SettingsAPI()
        let model = DeviceNotificationSettingsViewModel(apiClient: api.client, patientID: "p1", deviceID: "device-1")

        await model.load()
        XCTAssertTrue(model.answerReadyPushEnabled, "on by default")

        await model.setAnswerReadyPushEnabled(false)
        XCTAssertFalse(model.answerReadyPushEnabled)
        XCTAssertFalse(model.rescueCarbAlertsEnabled)
        let sent = try XCTUnwrap(JSONSerialization.jsonObject(with: XCTUnwrap(api.lastBody)) as? [String: Any])
        XCTAssertEqual(sent["answer_ready_push_enabled"] as? Bool, false)
        XCTAssertNil(sent["rescue_carb_alerts_enabled"])
        XCTAssertNil(sent["hypo_report_push_enabled"], "the retired hypo summary switch is never sent")
    }

    func testTheReservoirPushIsOnByDefaultSavedOnItsOwnAndHiddenForOlderServers() async throws {
        let api = SettingsAPI()
        let model = DeviceNotificationSettingsViewModel(apiClient: api.client, patientID: "p1", deviceID: "device-1")

        await model.load()
        XCTAssertTrue(model.hasReservoirPush)
        XCTAssertTrue(model.reservoirPushEnabled, "on by default")

        await model.setReservoirPushEnabled(false)
        XCTAssertFalse(model.reservoirPushEnabled)
        let sent = try XCTUnwrap(JSONSerialization.jsonObject(with: XCTUnwrap(api.lastBody)) as? [String: Any])
        XCTAssertEqual(sent["reservoir_push_enabled"] as? Bool, false)
        XCTAssertNil(sent["answer_ready_push_enabled"])
        XCTAssertNil(sent["rescue_carb_alerts_enabled"])

        let older = SettingsAPI()
        older.reservoirEnabled = nil
        let oldModel = DeviceNotificationSettingsViewModel(apiClient: older.client, patientID: "p1", deviceID: "device-1")
        await oldModel.load()
        XCTAssertFalse(oldModel.hasReservoirPush, "the switch is hidden: the server sends no such push")
    }

    func testAnUnknownDeviceRegistersAgainAndRetries() async {
        let api = SettingsAPI()
        api.registered = false
        var registrations = 0
        let model = DeviceNotificationSettingsViewModel(apiClient: api.client, patientID: "p1", deviceID: "device-1") {
            registrations += 1
            api.registered = true
        }

        await model.load()

        XCTAssertEqual(registrations, 1)
        XCTAssertTrue(model.isLoaded)
        XCTAssertNil(model.errorMessage)
    }

    func testWithoutNotificationsAllowedTheToggleStaysOff() async {
        let api = SettingsAPI()
        api.registered = false
        let model = DeviceNotificationSettingsViewModel(apiClient: api.client, patientID: "p1", deviceID: "device-1")

        await model.load()

        XCTAssertFalse(model.isLoaded)
        XCTAssertEqual(model.errorMessage, "Najpierw zezwól na powiadomienia")
        await model.setRescueCarbAlertsEnabled(true)
        XCTAssertFalse(model.rescueCarbAlertsEnabled, "a toggle that was never read is not saved")
    }

    func testAFailedSaveTurnsTheToggleBack() async {
        let api = SettingsAPI()
        let model = DeviceNotificationSettingsViewModel(apiClient: api.client, patientID: "p1", deviceID: "device-1")
        await model.load()
        api.failPut = true

        await model.setRescueCarbAlertsEnabled(true)

        XCTAssertFalse(model.rescueCarbAlertsEnabled)
        XCTAssertEqual(model.errorMessage, "Nie udało się zapisać. Spróbuj ponownie.")
    }
}

// MARK: - Fakes

/// An ordinary conversation with one rescue carb card the answer prepared (no alert).
private final class ChatRescueAPI {
    private(set) var lastPostBody: Data?
    private(set) var postPath: String?
    private var logged = false

    lazy var client = APIClient(
        baseURL: URL(string: "https://api.example.com")!,
        authorizationMode: .none,
        httpClient: RescueClosureHTTPClient { [unowned self] request in
            let path = request.url?.path ?? ""
            let card = self.logged
                ? #"{"id":"r1","carbs_g":10,"status":"ACCEPTED","logged":{"carbs_g":8,"given_at":"2026-10-20T12:00:00.000Z"}}"#
                : #"{"id":"r1","carbs_g":10,"reason":"Sok przy 65.","status":"PROPOSED"}"#
            if path.hasSuffix("/conversations/conv-chat") && request.httpMethod == "GET" {
                let json = """
                {"id":"conv-chat","patient_id":"patient-1","origin":"USER","trigger_type":null,"conversation_type":"USER_INITIATED",
                 "awaiting_user_answer":false,"pending_question":null,"analysis_id":null,"recommendation_id":null,
                 "messages":[{"id":"a1","role":"ASSISTANT","message_type":"ASSISTANT_MESSAGE","content":"Wpisz 10 g kartą.","created_at":"2026-10-20T12:03:00Z",
                   "rescue_carb_proposals":[\(card)]}]}
                """
                return (Data(json.utf8), 200)
            }
            if path.hasSuffix("/rescue-carb-proposals/r1/accept") && request.httpMethod == "POST" {
                self.lastPostBody = request.httpBody
                self.postPath = path
                self.logged = true
                return (Data(#"{"proposal":{"id":"r1","carbs_g":10,"status":"ACCEPTED","logged":{"carbs_g":8,"given_at":"2026-10-20T12:00:00.000Z"},"alert_id":null}}"#.utf8), 200)
            }
            return (Data(), 404)
        }
    )
}

private final class RescueConversationAPI {
    var postStatus = 200
    var failPostWithTransport = false
    private(set) var lastPostBody: Data?
    private(set) var postPath: String?
    private(set) var conversationReads = 0
    private(set) var declinePath: String?
    var declineAnswersEmptyBlock = false
    private var treated = false
    private var declined = false

    lazy var client = APIClient(
        baseURL: URL(string: "https://api.example.com")!,
        authorizationMode: .none,
        httpClient: RescueClosureHTTPClient { [unowned self] request in
            let path = request.url?.path ?? ""
            if path.hasSuffix("/conversations/conv-rescue") && request.httpMethod == "GET" {
                self.conversationReads += 1
                return (Self.conversationData(treated: self.treated, declined: self.declined), 200)
            }
            if path.hasSuffix("/conversations/conv-rescue/rescue-carbs/decline") && request.httpMethod == "POST" {
                self.declinePath = path
                if self.postStatus == 409 {
                    self.treated = true
                    return (Data(#"{"type":"https://mellis.invalid/problems/rescue_already_logged","title":"Dosłodzenie już wpisane (Ewa)","status":409,"code":"RESCUE_ALREADY_LOGGED","instance":"/x"}"#.utf8), 409)
                }
                self.declined = true
                if self.declineAnswersEmptyBlock { return (Data(#"{"rescue_carbs":{}}"#.utf8), 200) }
                return (Data(#"{"rescue_carbs":\#(Self.block(treated: false, declined: true))}"#.utf8), 200)
            }
            if path.hasSuffix("/conversations/conv-rescue/rescue-carbs") && request.httpMethod == "POST" {
                if self.failPostWithTransport {
                    throw APIClientError.transport("offline")
                }
                self.lastPostBody = request.httpBody
                self.postPath = path
                if self.postStatus == 409 {
                    self.treated = true
                    return (Data(#"{"type":"https://mellis.invalid/problems/rescue_already_logged","title":"Dosłodzenie już wpisane (Ewa)","status":409,"code":"RESCUE_ALREADY_LOGGED","instance":"/x"}"#.utf8), 409)
                }
                self.treated = true
                return (Data(#"{"rescue_carbs":\#(Self.block(treated: true))}"#.utf8), 200)
            }
            return (Data(), 404)
        }
    )

    static func block(treated: Bool, declined: Bool = false) -> String {
        let decline = declined && !treated ? #"{"declined_at":"2026-10-20T12:02:00.000Z","declined_by":"Piotr"}"# : "null"
        let treatment = treated ? #"{"event_id":"e1","carbs_g":6,"given_at":"2026-10-20T12:00:00.000Z","logged_by":"Piotr","logged_at":"2026-10-20T12:01:00.000Z","source":"CHAT_CARD","proposal_id":"r1"}"# : "null"
        return """
        {"alert_id":"alert-1","status":"\(treated ? "TREATED" : "NOTIFIED")","level":"PREDICTED_LOW","trigger_source":"TRIO_PREDICTION",
         "detected_at":"2026-10-20T12:00:00.000Z","glucose_mgdl":82,"glucose_at":"2026-10-20T12:00:00.000Z","delta_per_5min":-6,
         "predicted_min_mgdl":58,"predicted_low_at":"2026-10-20T12:20:00.000Z","minutes_to_low":20,
         "proposal":{"carbs_g":4,"min_g":3,"max_g":7,"basis":"FORMULA","csf_mgdl_per_g":10,"isf_mgdl_per_u":150,"icr_g_per_u":15,"iob_u":0.8,"cob_g":0,"trio_carbs_req_g":null,
           "explanation":["Prognoza: 58 mg/dL za ok. 20 min","1 g podnosi o ok. 10 mg/dL (ISF 150 / ICR 15)","(90 − 58) / 10 = 3,2 → 4 g (zakres 3–7 g)"]},
         "glucose_readings":[{"observed_at":"2026-10-20T11:50:00.000Z","value":95},{"observed_at":"2026-10-20T11:55:00.000Z","value":88},{"observed_at":"2026-10-20T12:00:00.000Z","value":82}],
         "prediction":[{"at":"2026-10-20T12:05:00.000Z","value":70}],
         "latest_glucose":{"value":78,"observed_at":"2026-10-20T12:04:00.000Z"},
         "treatment":\(treatment),"declined":\(decline),"notified_at":"2026-10-20T12:00:30.000Z","reminder_sent_at":null}
        """
    }

    static func conversationData(treated: Bool = false, declined: Bool = false) -> Data {
        let json = """
        {"id":"conv-rescue","patient_id":"patient-1","origin":"SYSTEM","trigger_type":"RESCUE_CARBS","conversation_type":"TRIGGER_INITIATED",
         "awaiting_user_answer":false,"pending_question":null,"analysis_id":null,"recommendation_id":null,
         "messages":[{"id":"a1","role":"ASSISTANT","message_type":"ASSISTANT_MESSAGE","content":"Proponuję 8 g.","created_at":"2026-10-20T12:03:00Z",
           "rescue_carb_proposals":[{"id":"r1","carbs_g":8,"reason":"Po WF-ie.","status":"PROPOSED","created_at":"2026-10-20T12:03:00Z"}]}],
         "rescue_carbs":\(block(treated: treated, declined: declined))}
        """
        return Data(json.utf8)
    }
}

private final class SettingsAPI {
    var registered = true
    var failPut = false
    private var enabled = false
    private var answerReadyEnabled = true
    private(set) var requests: [String] = []
    private(set) var lastBody: Data?
    /// "Zbiornik insuliny"; nil = a server without it.
    var reservoirEnabled: Bool? = true

    lazy var client = APIClient(
        baseURL: URL(string: "https://api.example.com")!,
        authorizationMode: .none,
        httpClient: RescueClosureHTTPClient { [unowned self] request in
            self.requests.append("\(request.httpMethod ?? "") \(request.url?.path ?? "")")
            guard self.registered else {
                return (Data(#"{"type":"x","title":"Device not found","status":404,"code":"RESOURCE_NOT_FOUND"}"#.utf8), 404)
            }
            if request.httpMethod == "PUT" {
                if self.failPut { return (Data(), 500) }
                self.lastBody = request.httpBody
                let body = request.httpBody.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }
                self.enabled = body?["rescue_carb_alerts_enabled"] as? Bool ?? self.enabled
                self.answerReadyEnabled = body?["answer_ready_push_enabled"] as? Bool ?? self.answerReadyEnabled
                self.reservoirEnabled = body?["reservoir_push_enabled"] as? Bool ?? self.reservoirEnabled
            }
            // Servers still send the retired hypo summary switch: it is not read. An older server has no reservoir switch.
            let reservoir = self.reservoirEnabled.map { #","reservoir_push_enabled":\#($0)"# } ?? ""
            return (Data(#"{"device_id":"device-1","rescue_carb_alerts_enabled":\#(self.enabled),"hypo_report_push_enabled":true,"answer_ready_push_enabled":\#(self.answerReadyEnabled)\#(reservoir)}"#.utf8), 200)
        }
    )
}

private struct SilentEventStream: EventStreamTransport {
    func lines(for request: URLRequest) async throws -> AsyncThrowingStream<String, Error> {
        AsyncThrowingStream { _ in }
    }
}

private final class RescueClosureHTTPClient: HTTPClient {
    private let handler: (URLRequest) async throws -> (Data, Int)

    init(handler: @escaping (URLRequest) async throws -> (Data, Int)) {
        self.handler = handler
    }

    func perform(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        let (data, status) = try await handler(request)
        let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: nil)!
        return (data, response)
    }
}
