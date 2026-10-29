import XCTest
@testable import GlucoMindCore

final class BolusProposalDecodingTests: XCTestCase {
    func testAnAnswerCarriesItsBolusCardAndTheCommandSentFromIt() throws {
        let json = """
        {"id":"m2","role":"ASSISTANT","message_type":"ASSISTANT_MESSAGE","content":"Na naleśniki: W 46 g, 3,8 j.","created_at":"2026-10-19T12:00:00Z",
         "bolus_proposals":[{"id":"b1","purpose":"MEAL","carbs_g":46,"insulin_u":3.8,"icr_g_per_u":12,"icr_insulin_u":3.8,
           "meal_description":"Naleśniki z serem ×2",
           "meal":{"description":"Naleśniki z serem ×2","items":[{"name":"Naleśnik z serem","grams":240,"carbs_g":46,"protein_g":22,"fat_g":14,"source":"DIABCALC"}],"macros":{"carbs_g":46,"protein_g":22,"fat_g":14}},
           "reason":"Obiad.","warnings":[{"code":"RECENT_BOLUS","message":"Bolus 1 j podano 10 min temu."}],
           "expires_at":"2026-10-19T12:15:00.000Z","state":"SENT",
           "command":{"id":"rc1","status":"SUCCEEDED","status_message":"Bolus podany","carbs_g":46,"insulin_u":3.8,"meal_record_id":"meal1","sent_by_me":true}}]}
        """.data(using: .utf8)!
        let message = try JSONDecoder().decode(ConversationMessage.self, from: json)
        let card = try XCTUnwrap(message.bolus_proposals?.first)
        XCTAssertEqual(card.command?.meal_record_id, "meal1")
        let base = card.draftBase(conversationID: "c1")
        XCTAssertEqual(base.insulinU, Decimal(string: "3.8"))
        XCTAssertEqual(base.source, .chatCard)
        XCTAssertEqual(base.proposalID, "b1")
        XCTAssertEqual(base.meal?.items?.first?.name, "Naleśnik z serem")
    }

    func testACardLoweredForAFallingGlucoseSaysWhy() throws {
        let json = """
        {"id":"b1","purpose":"MEAL","carbs_g":46,"insulin_u":3.3,"icr_g_per_u":12,"icr_insulin_u":3.8,"meal_description":"Mleczna kanapka","meal":null,
         "reason":null,"warnings":[],"expires_at":"2026-10-21T12:15:00Z","state":"PROPOSED","command":null,
         "dose_adjustment":{"summary":"Trio prognozuje spadek do 70 mg/dL (cel 100), więc 6 g z posiłku pokryje spadek: insulina tylko na pozostałe 40 g (mniej o 0,5 j).","reduced_by_u":0.5,"covered_carbs_g":6,"forecast_low_mgdl":70,"target_mgdl":100}}
        """.data(using: .utf8)!
        let card = try JSONDecoder().decode(ConversationBolusProposal.self, from: json)
        XCTAssertEqual(card.dose_adjustment?.covered_carbs_g, 6)
        XCTAssertEqual(card.doseBreakdown, "ICR 12 → 3,8 j − 0,5 j")
        XCTAssertEqual(card.draftBase(conversationID: "c1").insulinU, Decimal(string: "3.3"))
    }

    func testACardCarriesTheCaregiversCorrectionItsRiskAndItsWarningsIntoTheConfirmation() throws {
        let json = """
        {"id":"b1","purpose":"MEAL","carbs_g":46,"insulin_u":5.75,"icr_g_per_u":12,"icr_insulin_u":3.8,"meal_description":"Naleśniki","meal":null,
         "reason":null,"warnings":[{"code":"FORECAST_LOW","key":"k1","message":"Prognoza z tą kartą: ok. 52 mg/dL za ok. 95 min, ryzyko ciężkiego niedocukrzenia (zakłada, że pętla nic więcej nie zmieni).","severity":"DANGER"},{"code":"CORRECTION_STACKING","key":"k2","message":"Trio samo dokłada insulinę.","severity":"WARNING"}],
         "expires_at":"2026-10-22T12:15:00Z","state":"PROPOSED","command":null,"dose_adjustment":null,
         "risk":{"min_mgdl":52,"min_in_minutes":95,"level":"VERY_LOW","baseline_min_mgdl":180},
         "correction":{"dose_u":1.95,"breakdown":"(248 − 100) / 60 − IOB 0,5 j = 1,95 j"}}
        """.data(using: .utf8)!
        let card = try JSONDecoder().decode(ConversationBolusProposal.self, from: json)
        XCTAssertEqual(card.risk?.isRisky, true)
        XCTAssertEqual(card.correction?.dose_u, 1.95)
        XCTAssertEqual(card.warnings.first?.isDanger, true)
        XCTAssertEqual(card.warnings.last?.isDanger, false)
        XCTAssertEqual(card.doseBreakdown, "ICR 12 → 3,8 j + 1,95 j")
        let draft = card.draftBase(conversationID: "c1")
        XCTAssertEqual(draft.cardWarnings.count, 2)
        XCTAssertTrue(draft.cardWarningsMatch(carbsG: 46, insulinU: Decimal(string: "5.75")!))
        // Changed in the confirmation: the card's warnings were made for the card's amounts.
        let changed = draft.with(carbsG: 46, insulinU: Decimal(string: "4")!)
        XCTAssertEqual(changed.cardWarnings.count, 2)
        XCTAssertFalse(changed.cardWarningsMatch(carbsG: 46, insulinU: Decimal(string: "4")!))
    }

    func testALaterPartWaitsForTheConditionTheCaregiverChose() throws {
        let json = """
        {"id":"b1","purpose":"MEAL","carbs_g":23,"insulin_u":0,"icr_g_per_u":12,"icr_insulin_u":1.9,"meal_description":"Bułka","meal":null,
         "reason":"Połowa węgli teraz.","warnings":[],"expires_at":"2026-10-22T12:15:00Z","state":"PROPOSED","command":null,
         "split":{"kind":"DEFERRED_INSULIN","policy_version":"later-plan.v1","now_percent":100,"later_after_minutes":15,"total_carbs_g":23,"total_insulin_u":1.4,"later_carbs_g":0,"later_insulin_u":1.4,"trigger":"GLUCOSE_RISING","wait_minutes":180,"drop_cover_g":6}}
        """.data(using: .utf8)!
        let card = try JSONDecoder().decode(ConversationBolusProposal.self, from: json)
        XCTAssertEqual(card.split?.laterTrigger, "GLUCOSE_RISING")
        XCTAssertEqual(card.split?.wait_minutes, 180)
        XCTAssertEqual(LaterTriggerText.condition(trigger: "GLUCOSE_RISING", thresholdMgdl: nil), "gdy glukoza zacznie rosnąć")
        XCTAssertEqual(LaterTriggerText.short(trigger: "GLUCOSE_ABOVE", afterMinutes: 15, thresholdMgdl: 180), "> 180")
        let older = try JSONDecoder().decode(SplitBolusPlan.self, from: #"{"kind":"DEFERRED_INSULIN","now_percent":100,"later_after_minutes":15,"total_carbs_g":45,"total_insulin_u":5.6,"later_carbs_g":0,"later_insulin_u":5.6}"#.data(using: .utf8)!)
        XCTAssertEqual(older.laterTrigger, "GLUCOSE_STOPPED_FALLING")
    }

    func testADeferredMealBolusSendsTheCarbsNowAndRemindsAboutTheWholeDoseLater() throws {
        let json = """
        {"id":"b1","purpose":"MEAL","carbs_g":45,"insulin_u":0,"icr_g_per_u":8,"icr_insulin_u":5.6,"meal_description":"Makaron z sosem pomidorowym","meal":null,
         "reason":null,"warnings":[{"code":"FAST_CARBS_FIRST","key":"k","message":"Glukoza 148 mg/dL spadnie poniżej 70 za ok. 24 min: najpierw 16 g szybkich węglowodanów."}],
         "expires_at":"2026-10-21T12:15:00Z","state":"PROPOSED","command":null,
         "split":{"kind":"DEFERRED_INSULIN","policy_version":"deferred-bolus.v1","now_percent":100,"later_after_minutes":15,"total_carbs_g":45,"total_insulin_u":5.6,"later_carbs_g":0,"later_insulin_u":5.6}}
        """.data(using: .utf8)!
        let card = try JSONDecoder().decode(ConversationBolusProposal.self, from: json)
        XCTAssertEqual(card.split?.isDeferred, true)
        // No "ICR → 5,6 j − 5,6 j": the dose comes later.
        XCTAssertNil(card.doseBreakdown)
        let base = card.draftBase(conversationID: "c1")
        XCTAssertEqual(base.carbsG, 45)
        XCTAssertEqual(base.insulinU, 0)

        let detailJSON = """
        {"id":"p1","kind":"DEFERRED_INSULIN","status":"NOTIFIED","due_at":"2026-10-21T09:20:00.000Z","delay_minutes":15,"now_percent":100,"carbs_g":0,"planned_insulin_u":5.6,
         "first_carbs_g":45,"first_insulin_u":0,"resolved_at":null,"resolved_by_name":null,"given_insulin_u":null,"sending":false,"meal_started_at":"2026-10-21T09:05:00.000Z",
         "icr_at_plan":8,"estimate":{"as_of":"2026-10-21T09:30:00.000Z","icr_g_per_u":8,"insulin_for_carbs_u":5.6,"loop_extra_u":0.1,"smb_u":0.1,"temp_basal_extra_u":0,"insulin_u":5.5},"command":null}
        """.data(using: .utf8)!
        let plan = try JSONDecoder().decode(PlannedBolusDetail.self, from: detailJSON)
        XCTAssertTrue(plan.summary.isDeferred)
        XCTAssertEqual(plan.summary.doseCarbsG, 45)
        XCTAssertEqual(plan.summary.statusLine, "Czas na bolus")
        // Insulin alone: the carbs are already in Trio.
        XCTAssertEqual(plan.draftBase().carbsG, 0)
        XCTAssertEqual(plan.draftBase().insulinU, Decimal(string: "5.5"))
        XCTAssertTrue(PlannedBolusView.reason(plan).hasPrefix("45 g / ICR 8 "))
    }

    func testOlderServersSendNoCards() throws {
        let json = #"{"id":"m2","role":"ASSISTANT","message_type":"ASSISTANT_MESSAGE","content":"Hej","created_at":"2026-10-19T12:00:00Z"}"#.data(using: .utf8)!
        XCTAssertNil(try JSONDecoder().decode(ConversationMessage.self, from: json).bolus_proposals)
    }

    func testAFailedRetryNeverOffersTheWholeCardAgain() throws {
        // An older server showed the bolus-only retry whose send failed: the card is "PROPOSED" again, but its whole dose
        // (the carbs Trio kept with it) must not be offered.
        let json = """
        {"id":"b1","purpose":"MEAL","carbs_g":45,"insulin_u":3,"icr_g_per_u":15,"icr_insulin_u":3,"meal_description":"Kanapka","meal":null,
         "reason":null,"warnings":[],"expires_at":"2026-10-19T16:00:00Z","state":"PROPOSED",
         "command":{"id":"rc2","status":"SEND_FAILED","status_message":"Nie udało się wysłać polecenia.","carbs_g":0,"insulin_u":3,"meal_record_id":null,"sent_by_me":true,"follows_command_id":"rc1","retry_until":null}}
        """.data(using: .utf8)!
        let card = try JSONDecoder().decode(ConversationBolusProposal.self, from: json)
        XCTAssertFalse(card.canGiveDraft)
        XCTAssertNil(card.retryBase(conversationID: "c1"))

        // The server now shows the refusal before the failed send: its bolus-only retry.
        let partial = try JSONDecoder().decode(ConversationBolusProposal.self, from: """
        {"id":"b1","purpose":"MEAL","carbs_g":45,"insulin_u":3,"icr_g_per_u":15,"icr_insulin_u":3,"meal_description":"Kanapka","meal":null,
         "reason":null,"warnings":[],"expires_at":"2026-10-19T16:00:00Z","state":"SENT",
         "command":{"id":"rc1","status":"PARTIAL","status_message":"Węglowodany zapisane w Trio, bolus odrzucony","carbs_g":45,"insulin_u":3,"meal_record_id":"meal1","sent_by_me":true,"follows_command_id":null,"retry_until":"2026-10-19T16:30:00Z"}}
        """.data(using: .utf8)!)
        let retry = try XCTUnwrap(partial.retryBase(conversationID: "c1"))
        XCTAssertEqual(retry.carbsG, 0)
        XCTAssertEqual(retry.followsCommandID, "rc1")

        // A card whose first send never left may be given as it is.
        let unsent = ConversationBolusProposal.SentCommand(id: "rc0", status: "SEND_FAILED", status_message: nil, carbs_g: 45, insulin_u: 3, meal_record_id: nil, sent_by_me: true)
        XCTAssertNil(unsent.follows_command_id)
    }

    func testARefusedBolusIsRetriedAloneWhenTrioKeptTheCarbs() throws {
        let json = """
        {"id":"b1","purpose":"MEAL","carbs_g":20,"insulin_u":2.4,"icr_g_per_u":8,"icr_insulin_u":2.5,"meal_description":"Kanapka","meal":null,
         "reason":null,"warnings":[],"expires_at":"2026-10-19T16:00:00Z","state":"SENT",
         "command":{"id":"rc1","status":"PARTIAL","status_message":"Węglowodany zapisane w Trio, bolus odrzucony","carbs_g":20,"insulin_u":2.4,"meal_record_id":"meal1","sent_by_me":true,"retry_until":"2026-10-19T16:30:00Z"}}
        """.data(using: .utf8)!
        let card = try JSONDecoder().decode(ConversationBolusProposal.self, from: json)
        let retry = try XCTUnwrap(card.retryBase(conversationID: "c1"))
        XCTAssertEqual(retry.carbsG, 0)
        XCTAssertEqual(retry.insulinU, Decimal(string: "2.4"))
        XCTAssertEqual(retry.followsCommandID, "rc1")
        XCTAssertEqual(retry.proposalID, "b1")
        XCTAssertNil(retry.meal)
    }

    func testTheCardSaysHowTheDoseWasCountedAndHowFarTheCommandGot() throws {
        func card(insulin: Double = 2.8, carbs: Int = 20, command: String?) throws -> ConversationBolusProposal {
            let json = """
            {"id":"b1","purpose":"MEAL","carbs_g":\(carbs),"insulin_u":\(insulin),"icr_g_per_u":8,"icr_insulin_u":2.5,"meal_description":"Kanapka","meal":null,
             "reason":"Kanapka i lekki wzrost.","warnings":[],"expires_at":"2026-10-19T16:00:00Z","state":"\(command == nil ? "PROPOSED" : "SENT")",
             "command":\(command ?? "null")}
            """
            return try JSONDecoder().decode(ConversationBolusProposal.self, from: Data(json.utf8))
        }
        func command(_ status: String, carbs: Int = 20, insulin: Double = 2.8, meal: String? = nil, mealState: String? = nil) -> String {
            #"{"id":"rc1","status":"\#(status)","status_message":null,"carbs_g":\#(carbs),"insulin_u":\#(insulin),"meal_record_id":\#(meal.map { "\"\($0)\"" } ?? "null"),"sent_by_me":true,"meal_state":\#(mealState.map { "\"\($0)\"" } ?? "null")}"#
        }
        func states(_ card: ConversationBolusProposal) -> [String] {
            card.progressSteps(loop: LoopSystemKind.trio.names).map { "\($0.title):\($0.state)" }
        }

        XCTAssertEqual(try card(command: nil).doseBreakdown, "ICR 8 → 2,5 j + 0,3 j")
        XCTAssertEqual(try card(insulin: 2.25, command: nil).doseBreakdown, "ICR 8 → 2,5 j − 0,25 j")
        XCTAssertEqual(try card(insulin: 2.5, command: nil).doseBreakdown, "ICR 8 → 2,5 j")
        XCTAssertNil(try card(carbs: 0, command: nil).doseBreakdown)
        XCTAssertEqual(try card(command: nil).progressSteps(loop: LoopSystemKind.trio.names), [])

        XCTAssertEqual(states(try card(command: command("AUTHORIZED"))), ["Wysłano:active", "Podano:waiting", "Zapisano:waiting"])
        XCTAssertEqual(states(try card(command: command("SENT"))), ["Wysłano:done", "Podano:active", "Zapisano:waiting"])
        XCTAssertEqual(states(try card(command: command("SUCCEEDED", mealState: "SAVING"))), ["Wysłano:done", "Podano:done", "Zapisano:active"])
        XCTAssertEqual(states(try card(command: command("SUCCEEDED", meal: "m1"))), ["Wysłano:done", "Podano:done", "Zapisano:done"])
        // Trio kept the carbs and refused the bolus: the meal is still saved from them.
        XCTAssertEqual(states(try card(command: command("PARTIAL", meal: "m1"))), ["Wysłano:done", "Podano:failed", "Zapisano:done"])
        XCTAssertEqual(states(try card(command: command("NO_REPLY", mealState: "NOT_FOUND"))), ["Wysłano:done", "Podano:unknown", "Zapisano:unknown"])
        XCTAssertEqual(states(try card(command: command("SEND_FAILED"))), ["Wysłano:failed", "Podano:waiting", "Zapisano:waiting"])
        // A correction has no meal step; carbs alone are "in Trio", not "given".
        XCTAssertEqual(states(try card(carbs: 0, command: command("SUCCEEDED", carbs: 0))), ["Wysłano:done", "Podano:done"])
        XCTAssertEqual(states(try card(insulin: 0, command: command("SUCCEEDED", insulin: 0))), ["Wysłano:done", "W Trio:done", "Zapisano:waiting"])

        // The sent amounts replace the proposed ones (the caregiver may have changed the dose).
        let edited = try card(command: command("SUCCEEDED", insulin: 2))
        XCTAssertEqual(edited.shownInsulinU, 2)
        XCTAssertEqual(edited.shownCarbsG, 20)
    }

    func testAMessageSaysBolusCardsOnlyFromAPhoneThatCanGiveTheDose() throws {
        let ready = try JSONSerialization.jsonObject(with: JSONEncoder().encode(UserMessageSubmissionRequest(content: "Ile podać?", bolusCards: true))) as? [String: Any]
        XCTAssertEqual(ready?["bolus_cards"] as? Bool, true)
        let notReady = try JSONSerialization.jsonObject(with: JSONEncoder().encode(UserMessageSubmissionRequest(content: "Ile podać?"))) as? [String: Any]
        XCTAssertNil(notReady?["bolus_cards"], "left out, so the server prepares no cards")
    }

    func testAMessageCarriesThePhoneLimitsOnlyWithBolusCards() throws {
        let limits = PhoneSendLimits(maxBolusUnits: Decimal(string: "4.5")!, maxCarbsGrams: 80)
        let ready = try JSONSerialization.jsonObject(with: JSONEncoder().encode(UserMessageSubmissionRequest(content: "Ile podać?", bolusCards: true, phoneLimits: limits))) as? [String: Any]
        let sent = ready?["phone_limits"] as? [String: Any]
        XCTAssertEqual(sent?["max_bolus_u"] as? Double, 4.5)
        XCTAssertEqual(sent?["max_carbs_g"] as? Int, 80)
        let notReady = try JSONSerialization.jsonObject(with: JSONEncoder().encode(UserMessageSubmissionRequest(content: "Ile podać?", phoneLimits: limits))) as? [String: Any]
        XCTAssertNil(notReady?["phone_limits"])
    }

    func testACardWithSeveralLaterPartsListsTheFurtherOnes() throws {
        let json = """
        {"id":"b1","purpose":"MEAL","carbs_g":28,"insulin_u":1.8,"icr_g_per_u":8,"icr_insulin_u":3.5,"meal_description":"Pół małej pizzy","meal":null,
         "reason":null,"warnings":[],"expires_at":"2026-10-22T12:15:00Z","state":"PROPOSED","command":null,
         "split":{"kind":"DEFERRED_INSULIN","now_percent":100,"later_after_minutes":10,"total_carbs_g":40,"total_insulin_u":5,"later_carbs_g":0,"later_insulin_u":1.8,"trigger":"AFTER_MINUTES","fixed_insulin_u":1.8,
                  "more_parts":[{"kind":"SPLIT","now_percent":70,"later_after_minutes":60,"total_carbs_g":40,"total_insulin_u":5,"later_carbs_g":12,"later_insulin_u":1.5,"trigger":"AFTER_MINUTES"}]}}
        """.data(using: .utf8)!
        let card = try JSONDecoder().decode(ConversationBolusProposal.self, from: json)
        XCTAssertEqual(card.split?.furtherPartLines, ["za 60 min: 12 g, ok. 1,5 j"])
    }

    func testACardListsEveryReminderItSet() throws {
        let json = """
        {"id":"b1","purpose":"MEAL","carbs_g":28,"insulin_u":1.8,"icr_g_per_u":8,"icr_insulin_u":3.5,"meal_description":"Pół pizzy","meal":null,
         "reason":null,"warnings":[],"expires_at":"2026-10-22T12:15:00Z","state":"SENT","command":null,
         "planned_parts":[
           {"id":"p0","status":"NOTIFIED","due_at":"2026-10-22T11:00:00Z","delay_minutes":10,"now_percent":100,"carbs_g":0,"planned_insulin_u":1.8,"first_carbs_g":28,"first_insulin_u":1.8,"resolved_at":null,"resolved_by_name":null,"given_insulin_u":null,"sending":false,"kind":"DEFERRED_INSULIN","meal_record_id":"m1","part_index":0},
           {"id":"p1","status":"SCHEDULED","due_at":"2026-10-22T11:50:00Z","delay_minutes":60,"now_percent":70,"carbs_g":12,"planned_insulin_u":1.5,"first_carbs_g":28,"first_insulin_u":1.8,"resolved_at":null,"resolved_by_name":null,"given_insulin_u":null,"sending":false,"kind":"SPLIT","meal_record_id":"m1","part_index":1}],
         "wbt_reminder":{"meal_id":"m1","remind_at":"2099-10-22T13:20:00Z","status":"SCHEDULED","enabled":true,"source":"AUTO"}}
        """.data(using: .utf8)!
        let card = try JSONDecoder().decode(ConversationBolusProposal.self, from: json)
        XCTAssertEqual(card.planned_parts?.count, 2)
        XCTAssertEqual(card.planned_parts?.last?.meal_record_id, "m1")
        XCTAssertTrue(card.planned_parts?.last?.canGive == true)
        XCTAssertEqual(card.wbt_reminder?.isPending, true)
    }

    func testTheCardTimelineShowsEveryDoseAndTheWbtReminder() throws {
        let unsent = """
        {"id":"b1","purpose":"MEAL","carbs_g":28,"insulin_u":1.8,"icr_g_per_u":8,"icr_insulin_u":3.5,"meal_description":"Pół pizzy","meal":null,
         "reason":null,"warnings":[],"expires_at":"2026-10-22T12:15:00Z","state":"PROPOSED","command":null,
         "split":{"kind":"DEFERRED_INSULIN","now_percent":100,"later_after_minutes":10,"total_carbs_g":40,"total_insulin_u":5,"later_carbs_g":0,"later_insulin_u":1.8,"trigger":"AFTER_MINUTES","fixed_insulin_u":1.8,
                  "more_parts":[{"kind":"SPLIT","now_percent":70,"later_after_minutes":60,"total_carbs_g":40,"total_insulin_u":5,"later_carbs_g":12,"later_insulin_u":1.5,"trigger":"AFTER_MINUTES"}]},
         "wbt_plan":{"units":1.8,"standard_dose_u":0.7,"auto":true,"after_minutes":150}}
        """.data(using: .utf8)!
        let card = try JSONDecoder().decode(ConversationBolusProposal.self, from: unsent)
        XCTAssertEqual(card.timelineSteps(loop: LoopSystemKind.trio.names).map(\.time), ["Teraz", "za 10 min", "za 60 min", "za ok. 2,5 h"])
        XCTAssertEqual(card.timelineSteps(loop: LoopSystemKind.trio.names).map(\.detail), ["1,8 j · 28 g", "1,8 j", "ok. 1,5 j · 12 g", "WBT ok. 0,7 j"])
        XCTAssertNil(card.timelineSteps(loop: LoopSystemKind.trio.names).first?.symbol)

        // Carbs alone are an entry, not a dose.
        let carbsOnly = try JSONDecoder().decode(ConversationBolusProposal.self, from: Data(String(data: unsent, encoding: .utf8)!.replacingOccurrences(of: #""insulin_u":1.8,"icr"#, with: #""insulin_u":0,"icr"#).utf8))
        XCTAssertEqual(carbsOnly.timelineSteps(loop: LoopSystemKind.trio.names).first?.detail, "Wpis 28 g do Trio")
        XCTAssertEqual(carbsOnly.timelineSteps(loop: LoopSystemKind.trio.names).first?.note, "bez insuliny")
        XCTAssertEqual(carbsOnly.timelineSteps(loop: LoopSystemKind.trio.names).first?.symbol, "square.and.pencil")
        XCTAssertNil(card.timelineSteps(loop: LoopSystemKind.trio.names).last?.action)

        let sentJSON = String(data: unsent, encoding: .utf8)!
            .replacingOccurrences(of: #""state":"PROPOSED","command":null"#, with: #""state":"SENT","command":{"id":"c1","status":"SUCCEEDED","status_message":"Bolus podany","carbs_g":28,"insulin_u":1.8,"meal_record_id":"m1","sent_by_me":true}"#)
            .replacingOccurrences(of: #""wbt_plan""#, with: #""wbt_reminder":{"meal_id":"m1","remind_at":"2099-10-22T13:20:00Z","status":"SCHEDULED","enabled":true},"planned_parts":[{"id":"p1","status":"SCHEDULED","due_at":"2026-10-22T11:50:00Z","delay_minutes":60,"now_percent":70,"carbs_g":12,"planned_insulin_u":1.5,"first_carbs_g":28,"first_insulin_u":1.8,"resolved_at":null,"resolved_by_name":null,"given_insulin_u":null,"sending":false,"kind":"SPLIT","meal_record_id":"m1"}],"wbt_plan""#)
        let sent = try JSONDecoder().decode(ConversationBolusProposal.self, from: Data(sentJSON.utf8))
        let steps = sent.timelineSteps(loop: LoopSystemKind.trio.names)
        XCTAssertEqual(steps.map(\.state), [.done, .planned, .planned])
        XCTAssertEqual(steps[1].actionTitle, "Wyłącz")
        XCTAssertEqual(steps[2].action, .setWbtReminder(mealID: "m1", enabled: false))
        XCTAssertTrue(steps[2].isWbt)
    }

    func testACardCarriesThePlanChartWithItsStepsAsMarkers() throws {
        let json = """
        {"id":"b1","purpose":"MEAL","carbs_g":7,"insulin_u":0.85,"icr_g_per_u":8.1,"icr_insulin_u":0.85,"meal_description":"Kromka","meal":null,
         "reason":null,"warnings":[],"expires_at":"2026-10-23T08:36:00Z","state":"PROPOSED","command":null,
         "forecast_chart":{"policy_version":"card-forecast.v1","start":"2026-10-23T08:21:00.000Z","step_minutes":5,
           "baseline":[94,93,92],"with_plan":[94,96,99],"band":[0,6,9],
           "events":[{"at_minutes":0,"kind":"NOW","carbs_g":7,"insulin_u":0.85,"conditional":false},
                     {"at_minutes":25,"kind":"LATER","carbs_g":6,"insulin_u":0.7,"conditional":false},
                     {"at_minutes":150,"kind":"WBT","carbs_g":0,"insulin_u":0.55,"conditional":false}]}}
        """.data(using: .utf8)!
        let card = try JSONDecoder().decode(ConversationBolusProposal.self, from: json)
        let chart = try XCTUnwrap(card.forecast_chart)
        XCTAssertEqual(chart.points(chart.with_plan ?? []).map(\.value), [94, 96, 99])
        XCTAssertEqual(chart.events.map(CardForecastChart.label), ["0,85 j · 7 g", "ok. 0,7 j · 6 g", "WBT ok. 0,55 j"])
        XCTAssertEqual(CardForecastChart.label(.init(at_minutes: 0, kind: "NOW", carbs_g: 7, insulin_u: 0, conditional: false)), "Wpis 7 g")
    }

    func testALoopOnlyCardChartAndItsRiskSayWhatTheyAre() throws {
        let json = """
        {"id":"b2","purpose":"CORRECTION","carbs_g":0,"insulin_u":2,"icr_g_per_u":10,"icr_insulin_u":null,"meal_description":null,"meal":null,
         "reason":null,"warnings":[],"expires_at":"2026-10-23T08:36:00Z","state":"PROPOSED","command":null,
         "risk":{"min_mgdl":39,"min_in_minutes":180,"level":"VERY_LOW","baseline_min_mgdl":125,"basis":"DOSE_TOTAL","loop_name":"Trio"},
         "forecast_chart":{"policy_version":"card-forecast.v1","start":"2026-10-23T08:21:00.000Z","step_minutes":5,
           "baseline":[140,132,125],"dose_line":"LOOP_ONLY","with_plan":null,"total_with_plan":39,"loop_name":"Trio","band":[0,6,9],
           "events":[{"at_minutes":0,"kind":"NOW","carbs_g":0,"insulin_u":2,"conditional":false}]}}
        """.data(using: .utf8)!
        let card = try JSONDecoder().decode(ConversationBolusProposal.self, from: json)
        let chart = try XCTUnwrap(card.forecast_chart)
        XCTAssertTrue(chart.isLoopOnly)
        XCTAssertNil(chart.with_plan)
        XCTAssertEqual(chart.total_with_plan, 39)
        XCTAssertEqual(card.risk?.headline, "Prognoza Trio + pełne działanie karty: ok. 39 mg/dL")
        let older = ConversationBolusProposal.Risk(min_mgdl: 55, min_in_minutes: 30, level: "LOW", baseline_min_mgdl: 90)
        XCTAssertEqual(older.headline, "Prognoza: min. ok. 55 mg/dL za ok. 30 min")
    }
}
