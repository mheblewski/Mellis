import XCTest
@testable import GlucoMindCore

/// "Do posiłku: …" (meal-attach.v1): the button's name, and the join after the caregiver confirms.
@MainActor
final class MealAttachTests: XCTestCase {
    private final class AttachAPI: MealAttachAPI {
        var target: MealAttachTarget?
        var described: Bool? = false
        var gone = false
        var mergeFails = false
        var merged: [(ids: [String], split: MealMergeSplitChoice?)] = []

        func getMealAttachTarget(patientID: String, mealID: String) async throws -> MealAttachTargetResponse {
            if gone { throw APIClientError.notFound(nil) }
            return MealAttachTargetResponse(patient_id: patientID, described: described, meal_name: described == true ? "Lody waniliowe" : nil, target: target)
        }
        var mergedCarbs: [MealMergeCarbsChoice?] = []
        func mergeMeals(patientID: String, mealIDs: [String], resetConfirmed: Bool, split: MealMergeSplitChoice?, carbs: MealMergeCarbsChoice?) async throws -> MealMergeResponse {
            if mergeFails { throw URLError(.notConnectedToInternet) }
            mergedCarbs.append(carbs)
            merged.append((mealIDs, split))
            let json = #"{"patient_id":"p","meal_id":"lunch","item":{"meal_id":"lunch","started_at":"2026-11-03T11:45:00Z","title":"Pizza","carbs_g":75,"insulin_total_u":7.5,"source":"CHAT","conversation_id":null,"has_macros":true,"reminders":[]}}"#
            return try JSONDecoder().decode(MealMergeResponse.self, from: Data(json.utf8))
        }
    }

    private func target(name: String?, split: Bool = false) -> MealAttachTarget {
        // 12:45 in the test's time zone.
        var components = DateComponents(year: 2026, month: 11, day: 3, hour: 12, minute: 45)
        components.timeZone = .current
        let start = ServerDate.string(Calendar(identifier: .gregorian).date(from: components)!)
        return MealAttachTarget(meal_id: "lunch", started_at: start, short_name: name, carbs_g: 60, insulin_total_u: 6, split: split)
    }

    func testTheButtonNamesTheMealByItsShortNameElseByItsTime() {
        XCTAssertEqual(target(name: "Pizza margherita").buttonTitle, "Do posiłku: Pizza margherita")
        XCTAssertEqual(target(name: "Pizza margherita").joinedName, "Pizza margherita o 12:45")
        XCTAssertEqual(target(name: nil).buttonTitle, "Do posiłku o 12:45")
        XCTAssertEqual(target(name: "  ").buttonTitle, "Do posiłku o 12:45")
        XCTAssertEqual(target(name: nil).joinedName, "posiłek o 12:45")
    }

    private func carbsTarget() -> MealAttachTarget {
        MealAttachTarget(meal_id: "lunch", started_at: "2026-11-03T11:45:00Z", short_name: "Kluski", carbs_g: 32, insulin_total_u: 2.5, split: false, carbs: .init(kept_g: 32, added_g: 10, loop_g: 20))
    }

    func testTheAnswerGoesWithTheJoinAndTheCardSaysTheMealsCarbs() async {
        for (choice, carbs) in [(MealMergeCarbsChoice.included, 32.0), (.extra, 42.0)] {
            let api = AttachAPI()
            api.target = carbsTarget()
            let model = BolusMealAttachModel(undoSeconds: 0)
            await model.load(api: api, patientID: "p", mealID: "dose")
            model.beginAttaching(carbs: choice)
            XCTAssertEqual(model.joinedCarbs, carbs)
            await model.attach(api: api, patientID: "p")
            XCTAssertEqual(api.mergedCarbs, [choice])
            XCTAssertEqual(model.joinedCarbs, carbs, "the card keeps saying it")
        }
    }

    func testCofnijSendsNothingAndOffersTheJoinAgain() async {
        let api = AttachAPI()
        api.target = carbsTarget()
        let model = BolusMealAttachModel(undoSeconds: 30)
        await model.load(api: api, patientID: "p", mealID: "dose")
        model.beginAttaching(carbs: .included)
        XCTAssertTrue(model.canUndo)
        XCTAssertFalse(model.needsDescription)
        let attaching = Task { await model.attach(api: api, patientID: "p") }
        await Task.yield()
        await Task.yield()
        model.undo()
        XCTAssertEqual(model.offeredTarget?.meal_id, "lunch")
        XCTAssertNil(model.joinedCarbs)
        attaching.cancel()
        await attaching.value
        XCTAssertTrue(api.merged.isEmpty, "nothing reached the server")
    }

    func testASecondAnswerAfterCofnijWaitsForItsOwnTime() async {
        let api = AttachAPI()
        api.target = carbsTarget()
        let model = BolusMealAttachModel(undoSeconds: 0.2)
        await model.load(api: api, patientID: "p", mealID: "dose")
        model.beginAttaching(carbs: .included)
        let first = Task { await model.attach(api: api, patientID: "p") }
        try? await Task.sleep(for: .milliseconds(100))
        model.undo()
        model.beginAttaching(carbs: .extra)
        let second = Task { await model.attach(api: api, patientID: "p") }
        await first.value
        XCTAssertTrue(api.merged.isEmpty, "the first answer's time says nothing about the second")
        await second.value
        XCTAssertEqual(api.mergedCarbs, [.extra])
    }

    func testLeavingTheScreenSendsTheJoinWithoutWaiting() async {
        let api = AttachAPI()
        api.target = carbsTarget()
        let model = BolusMealAttachModel(undoSeconds: 30)
        await model.load(api: api, patientID: "p", mealID: "dose")
        model.beginAttaching(carbs: .extra)
        let attaching = Task { await model.attach(api: api, patientID: "p") }
        await Task.yield()
        await Task.yield()
        await model.finishNow()
        XCTAssertEqual(api.mergedCarbs, [.extra])
        XCTAssertFalse(model.canUndo, "too late for \"Cofnij\"")
        guard case .attached = model.state else { return XCTFail("attached expected") }
        attaching.cancel()
        await attaching.value
        XCTAssertEqual(api.merged.count, 1, "sent once")
    }

    func testTheWordsOfTheQuestion() {
        let asked = MealMergeCarbsText(.init(kept_g: 32, added_g: 10, loop_g: 20), loopLocative: "Trio")
        XCTAssertEqual(asked.context, "Posiłek ma 32\u{00A0}g, a w Trio wpisano 20\u{00A0}g.")
        XCTAssertEqual(asked.question, "Czy te 10\u{00A0}g było już wliczone w 32\u{00A0}g?")
        XCTAssertEqual(asked.includedResult, "zostaje 32\u{00A0}g")
        XCTAssertEqual(asked.extraResult, "razem 42\u{00A0}g")
        XCTAssertEqual(MealMergeCarbsText(.init(kept_g: 32, added_g: 10), loopLocative: "Trio").context, "Posiłek ma 32\u{00A0}g.")
        let larger = MealMergeCarbsText(.init(kept_g: 8, added_g: 10), loopLocative: "Trio")
        XCTAssertEqual(larger.context, "Posiłek ma 8\u{00A0}g, a ten wpis ma 10\u{00A0}g.")
        XCTAssertEqual(larger.includedTitle, "Razem 10\u{00A0}g")
        XCTAssertEqual(larger.extraTitle, "Razem 18\u{00A0}g")
    }

    func testNoBiggerMealOffersNothing() async {
        let api = AttachAPI()
        let model = BolusMealAttachModel(undoSeconds: 0)
        await model.load(api: api, patientID: "p", mealID: "dose")
        XCTAssertEqual(model.state, .none)
        XCTAssertNil(model.offeredTarget)
    }

    func testTheDoseJoinsTheEarlierMealKeepingASplit() async {
        let api = AttachAPI()
        api.target = target(name: "Pizza margherita", split: true)
        let model = BolusMealAttachModel(undoSeconds: 0)
        await model.load(api: api, patientID: "p", mealID: "dose")
        XCTAssertEqual(model.offeredTarget?.meal_id, "lunch")
        await model.attach(api: api, patientID: "p")
        XCTAssertEqual(api.merged.first?.ids, ["lunch", "dose"], "the earlier meal first, the dose's meal joins it")
        XCTAssertEqual(api.merged.first?.split, .keep)
        guard case .attached? = Optional(model.state) else { return XCTFail("attached expected") }
        XCTAssertNil(model.offeredTarget, "no button once joined")
    }

    func testAFailedJoinCanBeTriedAgain() async {
        let api = AttachAPI()
        api.target = target(name: nil)
        api.mergeFails = true
        let model = BolusMealAttachModel(undoSeconds: 0)
        await model.load(api: api, patientID: "p", mealID: "dose")
        await model.attach(api: api, patientID: "p")
        guard case .failed = model.state else { return XCTFail("failed expected") }
        XCTAssertEqual(model.offeredTarget?.meal_id, "lunch", "the button stays to try again")
    }

    func testDescribingTheMealEndsBothButtons() async {
        let api = AttachAPI()
        api.target = target(name: "Pizza margherita")
        let model = BolusMealAttachModel(undoSeconds: 0)
        await model.load(api: api, patientID: "p", mealID: "dose")
        XCTAssertTrue(model.needsDescription)
        XCTAssertNotNil(model.offeredTarget)
        api.described = true
        await model.load(api: api, patientID: "p", mealID: "dose")
        XCTAssertTrue(model.needsDescription, "the same meal is not read again without force")
        await model.load(api: api, patientID: "p", mealID: "dose", force: true)
        XCTAssertFalse(model.needsDescription)
        XCTAssertNil(model.offeredTarget, "a described meal is a meal of its own: no \"Do posiłku\" either")
    }

    func testAMealMergedElsewhereDropsBothButtons() async {
        let api = AttachAPI()
        api.target = target(name: "Pizza margherita")
        let model = BolusMealAttachModel(undoSeconds: 0)
        await model.load(api: api, patientID: "p", mealID: "dose")
        api.gone = true
        await model.load(api: api, patientID: "p", mealID: "dose", force: true)
        XCTAssertFalse(model.needsDescription)
        XCTAssertNil(model.offeredTarget)
    }

    func testAJoinHereStaysJoinedWhenTheMealIsReadAgain() async {
        let api = AttachAPI()
        api.target = target(name: "Pizza margherita")
        let model = BolusMealAttachModel(undoSeconds: 0)
        await model.load(api: api, patientID: "p", mealID: "dose")
        await model.attach(api: api, patientID: "p")
        api.gone = true
        await model.load(api: api, patientID: "p", mealID: "dose", force: true)
        guard case .attached = model.state else { return XCTFail("attached expected") }
        XCTAssertFalse(model.needsDescription)
    }

    func testConfirmingTheJoinHidesOpiszPosilekBeforeTheJoinStarts() async {
        let api = AttachAPI()
        api.target = target(name: "Frytki McDonald's")
        let model = BolusMealAttachModel(undoSeconds: 0)
        await model.load(api: api, patientID: "p", mealID: "dose")
        XCTAssertTrue(model.needsDescription)
        model.beginAttaching()
        guard case .undoable = model.state else { return XCTFail("shown as joined at once") }
        XCTAssertFalse(model.needsDescription, "no \"Opisz posiłek\" while the dialog closes")
        await model.attach(api: api, patientID: "p")
        guard case .attached = model.state else { return XCTFail("attached expected") }
        XCTAssertEqual(api.merged.count, 1)
    }

    func testAJoinedDoseLinkedToItsNewMealStaysJoined() async {
        let api = AttachAPI()
        api.target = target(name: "McNuggets z frytkami")
        let model = BolusMealAttachModel(undoSeconds: 0)
        await model.load(api: api, patientID: "p", mealID: "dose")
        model.beginAttaching()
        await model.attach(api: api, patientID: "p")
        // The server moves the dose to the joined meal: the card reads that meal id next.
        api.described = false
        await model.load(api: api, patientID: "p", mealID: "lunch")
        guard case .attached = model.state else { return XCTFail("still joined expected") }
        XCTAssertFalse(model.needsDescription, "no \"Opisz posiłek\" for the joined meal")
    }

    func testADescribedMealKeepsItsNameForTheConfirmation() async {
        let api = AttachAPI()
        let model = BolusMealAttachModel(undoSeconds: 0)
        await model.load(api: api, patientID: "p", mealID: "dose")
        XCTAssertNil(model.mealName)
        api.described = true
        await model.load(api: api, patientID: "p", mealID: "dose", force: true)
        XCTAssertTrue(model.mealDescribed)
        XCTAssertEqual(model.mealName, "Lody waniliowe")
        XCTAssertEqual(model.currentMealID, "dose", "the confirmation opens the dose's own meal")
    }

    func testTheNextBolusStartsWithoutTheLastOnesMeal() async {
        let api = AttachAPI()
        let model = BolusMealAttachModel(undoSeconds: 0)
        model.follow(commandID: "rc1")
        api.described = true
        await model.load(api: api, patientID: "p", mealID: "dose")
        XCTAssertTrue(model.mealDescribed)
        XCTAssertEqual(model.mealName, "Lody waniliowe")
        model.follow(commandID: "rc1")
        XCTAssertTrue(model.mealDescribed, "the same bolus keeps its meal")
        model.follow(commandID: "rc2")
        XCTAssertFalse(model.mealDescribed)
        XCTAssertNil(model.mealName)
        XCTAssertNil(model.currentMealID)
        XCTAssertTrue(model.needsDescription, "the new bolus waits for its own meal (\"Zapisuję posiłek…\")")
    }
}
