#if DEBUG
import Foundation
import GlucoMindCore

/// GLUCOMIND_UI_FIXTURES_DOCS=1: screenshots for the public user documentation. The fixtures' names are fictional
/// (patients "Ania (podgląd)" and "Kuba (podgląd)", caregivers "Tomek" and "Ania"); in this mode every fixture answer,
/// live event, the Live Activity fixture and the device-mode debug scenes show patient "Zosia" and second patient
/// "Kuba" and drop the "(podgląd)" suffix. Debug builds only.
enum DocsScreenshotNames {
    static let environmentKey = "GLUCOMIND_UI_FIXTURES_DOCS"

    static var isActive: Bool { ProcessInfo.processInfo.environment[environmentKey] == "1" }

    /// Only the patient "Ania (podgląd)" becomes "Zosia": the caregiver "Ania" keeps her name.
    private static let replacements: [(pattern: String, with: String)] = [
        (#"\bAnia \(podgląd\)"#, "Zosia"),
        (#"\bKuba \(podgląd\)"#, "Kuba"),
        // The patient is a girl in the docs: the fixtures' masculine verbs follow.
        (#"\bzjadł\b"#, "zjadła"),
        (#"\bBył godzinę\b"#, "Była godzinę"),
    ]

    static func apply(_ text: String) -> String {
        guard isActive else { return text }
        return replacements.reduce(text) { text, rule in
            text.replacingOccurrences(of: rule.pattern, with: rule.with, options: .regularExpression)
        }
    }
}

/// Debug-only, network-free API stand-in for visual checks in the simulator. Enabled only with
/// AUTH_MODE=disabled (local debug builds) plus GLUCOMIND_UI_FIXTURES=1 in the launch environment; every request
/// is answered from the fixtures below and nothing leaves the device.
final class UIPreviewFixtureHTTPClient: HTTPClient, @unchecked Sendable {
    static let environmentKey = "GLUCOMIND_UI_FIXTURES"

    private let lock = NSLock()
    private var cancelled = false
    /// Names and pins changed from the history list (PATCH), seeded with one AI name and one pinned conversation.
    private var names: [String: String] = ["conv-long": "Podsumowanie dnia", "conv-error": "Nocne niskie cukry"]
    private var pinnedAt: [String: TimeInterval] = ["conv-error": -3_600]
    /// "Wyłącz tę część" on the burger's split bolus.
    private var burgerPartSkipped = false
    /// Messages sent in "conv-long", "conv-hypo", "conv-meal", "conv-rescue" and the meal chat, by conversation or meal; each gets its answer three
    /// seconds later.
    private var sentMessages: [String: [(content: String, photoIDs: [String], sentAt: Date)]] = [:]
    /// Photos uploaded to a conversation (POST photos), served back by id.
    private var conversationPhotos: [String: Data] = [:]
    private let now = Date()

    private static let patientID = "11111111-1111-4111-8111-111111111111"
    /// Pushes need UUIDs (xcrun simctl push in the simulator): these stand for the named conversations below.
    static let pushConversationAliases = [
        "c0000000-0000-4000-8000-000000000001": "conv-hypo",
        "c0000000-0000-4000-8000-000000000002": "conv-rescue",
        "c0000000-0000-4000-8000-000000000003": "conv-long",
        "c0000000-0000-4000-8000-000000000004": "conv-meal",
    ]

    // MARK: Answers (stored after 3 s, streamed as live drafts before that)

    static let longAnswer = """
    ## Podsumowanie dnia
    Glikemia była przez większość dnia w zakresie docelowym (**86% czasu** między 70 a 180 mg/dL).

    - Rano: stabilnie, ok. 110 mg/dL.
    - Po obiedzie: wzrost do 182 mg/dL około 14:30, powrót do zakresu po ok. 90 minutach.
    - Wieczorem: łagodny spadek do 78 mg/dL bez hipoglikemii.

    Możliwe, że posiłek o 13:45 zawierał więcej węglowodanów niż wpisane 45 g — brakuje jednak opisu posiłku, więc to tylko hipoteza.

    ```
    TIR 08:00–20:00   86%
    średnia           128 mg/dL
    CV                24%
    ```

    Nie mam danych o aktywności fizycznej, więc jej wpływu nie oceniam.
    """
    static let wbtAnswer = "Glukoza 160 mg/dL, ale od pół godziny powoli spada, a w pętli jest jeszcze 0,8 j IOB. Proponuję 0,5 j zamiast standardowych 0,85 j. Podasz ją kartą poniżej."

    static let hypoAnswer = """
    Spadek zaczął się około 2,5 godziny po posiłku, gdy insulina z bolusa działała już najmocniej. Możliwe, że dawka była trochę za duża względem tego, co zostało zjedzone — to jednak tylko jedno z wyjaśnień.

    - Najniżej: 57 mg/dL, po ok. 35 minutach glikemia wróciła powyżej 70.
    - Zapisano 10 g węglowodanów na podniesienie cukru.
    - Po leczeniu glikemia wzrosła do ok. 150 mg/dL, co może oznaczać trochę za dużo węglowodanów na hipo.

    Jeśli podobny spadek powtórzy się po tym samym posiłku, warto omówić z diabetologiem przelicznik na ten posiłek.
    """
    static let emptyAnswer = "Dziś glikemia była w zakresie przez 86% czasu, bez hipoglikemii."
    static let mealChatReply = "Uwzględniłem sok. Razem wychodzi ok. 84 g węglowodanów, 21 g białka i 24 g tłuszczu."

    /// Open live event streams (live-updates.v1), fed by the scenarios below.
    private var streams: [UUID: AsyncThrowingStream<String, Error>.Continuation] = [:]
    /// Meal edits: description overrides and caregiver content revisions by meal id (both caregivers' saves).
    private var mealDescriptions: [String: String] = [:]
    private var mealRevisions: [String: Int] = [:]
    /// Meals the other caregiver confirmed (values saved) in the scenario below.
    private var mealsConfirmed: Set<String> = []
    private var otherCaregiverScheduled = false
    /// The meal change card of "conv-meal" (Zatwierdź / Odrzuć / Cofnij), and the values saved with "Popraw".
    private var mealActionStatus = "PROPOSED"
    private var mealActionEdit: [String: Any]?
    /// The rescue carbs logged in "conv-rescue" (POST rescue-carbs), echoed back as the alert's treatment.
    private var rescueTreatment: (grams: Double, givenAt: String, proposalID: String?)?
    /// "Nie podaję" in "conv-rescue" (POST rescue-carbs/decline).
    private var rescueDeclinedAt: String?
    /// "Ostrzeżenia o możliwym hipo" in Settings (PUT notification-settings); off by default, as on the server.
    private var rescueAlertsEnabled = false
    /// "Gotowa odpowiedź" in Settings; on by default, as on the server.
    private var answerReadyPushEnabled = true
    /// "Zbiornik insuliny" in Settings; on by default, as on the server.
    private var reservoirPushEnabled = true
    /// "Rok urodzenia" by patient (PUT birth-year); Ania has one, Kuba is asked for it.
    /// GLUCOMIND_UI_FIXTURES_NO_BIRTH_YEAR=1 leaves Ania without one too (the screen that asks for it).
    private var birthYears: [String: Int] = ProcessInfo.processInfo.environment["GLUCOMIND_UI_FIXTURES_NO_BIRTH_YEAR"] == "1" ? [:] : [UIPreviewFixtureHTTPClient.patientID: 2016]
    /// "Instrukcje dla Mellis" (GET/PUT /v1/me/ai-preferences); starts as a parent without own text.
    /// GLUCOMIND_UI_FIXTURES_NO_AI_PREFERENCES=1 answers 404, as a server without it (Settings shows no row).
    private var aiPreferences = UserAiPreferences(role: .parent, instructions: "")

    /// GLUCOMIND_UI_FIXTURES_SELF_GRANT=owner | owner-awaiting | member: Zdalny bolus in device mode for a person without
    /// remote bolus yet (an owner who turns it on for themself, a grant waiting for Face ID, a member). Settings build
    /// the device-mode sharing model for it; nothing is signed or sent to a loop.
    static var selfGrantRole: String? { ProcessInfo.processInfo.environment["GLUCOMIND_UI_FIXTURES_SELF_GRANT"] }
    /// off | awaiting | on
    private var selfGrantState = UIPreviewFixtureHTTPClient.selfGrantRole == "owner-awaiting" ? "awaiting" : "off"

    private func selfGrantYou() -> String {
        let owner = Self.selfGrantRole != "member"
        let state = lock.withLock { selfGrantState }
        let grant: String
        switch state {
        case "awaiting": grant = #"{"granted_by":"preview-user","granted_at":"2026-10-30T08:00:00.000Z","confirmed_at":null,"effective":false}"#
        case "on": grant = #"{"granted_by":"preview-user","granted_at":"2026-10-30T08:00:00.000Z","confirmed_at":"2026-10-30T08:00:10.000Z","effective":true}"#
        default: grant = #"{"granted_by":null,"granted_at":null,"confirmed_at":null,"effective":false}"#
        }
        return #"{"user_id":"preview-user","display_name":"Tomek","is_owner":\#(owner),"permissions":{"glucose_alerts":true,"ai_chat_meals":true,"manage_sharing":\#(owner),"remote_commands":\#(state == "on")},"remote_bolus":\#(grant),"is_you":true,"devices":[]}"#
    }

    private func selfGrantPeople() -> String {
        let owner = Self.selfGrantRole != "member"
        return #"{"patient_id":"\#(Self.patientID)","you_are_owner":\#(owner),"people":[\#(selfGrantYou())],"invitations":[]}"#
    }

    func perform(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        // A conversation opened from a simulated push uses its UUID alias; its actions answer as the named fixture.
        let path = Self.pushConversationAliases.reduce(request.url?.path ?? "") { path, alias in
            path.replacingOccurrences(of: "/conversations/\(alias.key)/", with: "/conversations/\(alias.value)/")
        }
        let method = request.httpMethod ?? "GET"
        // Sending takes as long as it does on the server, so the pending message stays visible for a moment.
        try await Task.sleep(for: .milliseconds(method == "POST" && path.hasSuffix("/messages") ? 1_500 : 250))
        // GLUCOMIND_UI_FIXTURES_SLOW_OPEN=<seconds>: the dashboard and the Bolus form's check answer that late (opening).
        if path.hasSuffix("/remote-commands/preview") || path.hasSuffix("/dashboard"),
           let seconds = ProcessInfo.processInfo.environment["GLUCOMIND_UI_FIXTURES_SLOW_OPEN"].flatMap(Double.init) {
            try await Task.sleep(for: .seconds(seconds))
        }
        // GLUCOMIND_UI_FIXTURES_SLOW_PREVIEW=<seconds>: the Bolus form's check with carbs answers that late (its loader).
        if path.hasSuffix("/remote-commands/preview"), let seconds = ProcessInfo.processInfo.environment["GLUCOMIND_UI_FIXTURES_SLOW_PREVIEW"].flatMap(Double.init),
           (URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?.queryItems?.first { $0.name == "carbs_g" }?.value ?? "0") != "0" {
            try await Task.sleep(for: .seconds(seconds))
        }
        if method == "GET", path.contains("/conversations/"), let range = path.range(of: "/photos/") {
            let photo = lock.withLock { conversationPhotos[String(path[range.upperBound...])] }
            let response = HTTPURLResponse(url: request.url!, statusCode: photo == nil ? 404 : 200, httpVersion: nil, headerFields: ["Content-Type": "image/jpeg"])!
            return (photo ?? Data(), response)
        }
        let query = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?.queryItems ?? []
        let (status, body) = path.hasSuffix("/remote-commands/preview")
            ? (200, remoteCommandPreview(query: query))
            : path.hasSuffix("/dashboard/time-in-range")
            ? try await timeInRange(days: query.first { $0.name == "days" }?.value.flatMap(Int.init) ?? 1)
            : route(path: path, method: method, body: request.httpBody)
        let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: ["Content-Type": "application/json"])!
        return (Data(DocsScreenshotNames.apply(body).utf8), response)
    }

    private func route(path: String, method: String, body: Data?) -> (Int, String) {
        let base = "/v1/patients/\(Self.patientID)"
        if method == "PATCH", path.hasPrefix("\(base)/conversations/") {
            let id = String(path.dropFirst("\(base)/conversations/".count))
            let changes = body.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] } ?? [:]
            lock.withLock {
                if let title = changes["title"] as? String { names[id] = title }
                if let pinned = changes["pinned"] as? Bool { pinnedAt[id] = pinned ? now.timeIntervalSinceNow : nil }
            }
            return (204, "")
        }
        switch (method, path) {
        case ("GET", "/v1/app-config"):
            // GLUCOMIND_UI_FIXTURES_OLD_APP=1 shows the update banner (minimum build above any real build).
            let minBuild = ProcessInfo.processInfo.environment["GLUCOMIND_UI_FIXTURES_OLD_APP"] == "1" ? 1_000_000 : 0
            return (200, #"{"ios":{"min_build":\#(minBuild),"update_message":"Ta wersja aplikacji jest nieaktualna. Zainstaluj nową wersję, żeby korzystać z nowych ekranów (np. hipo)."}}"#)
        case ("GET", "/v1/me/patients"):
            // GLUCOMIND_UI_FIXTURES_PATIENTS_ERROR=1 (or =dialog, "Odłącz ten telefon" asked): the server does not
            // answer ("Brak listy pacjentów", 1.0.5).
            if ProcessInfo.processInfo.environment["GLUCOMIND_UI_FIXTURES_PATIENTS_ERROR"] != nil {
                return (503, #"{"title":"Service Unavailable","status":503}"#)
            }
            // GLUCOMIND_UI_FIXTURES_LONG_NAME=1 gives the first patient a name too long for the top bar.
            let name = ProcessInfo.processInfo.environment["GLUCOMIND_UI_FIXTURES_LONG_NAME"] == "1" ? "Aleksandra Wiśniewska-Kowalczyk (podgląd)" : "Ania (podgląd)"
            // GLUCOMIND_UI_FIXTURES_ONE_PATIENT=1 leaves only the first patient (no patient list, no chevron).
            let years = lock.withLock { birthYears }
            let year = { (id: String) in years[id].map(String.init) ?? "null" }
            let kuba = "22222222-2222-4222-8222-222222222222"
            let other = ProcessInfo.processInfo.environment["GLUCOMIND_UI_FIXTURES_ONE_PATIENT"] == "1" ? "" : #",{"patient_id":"\#(kuba)","display_name":"Kuba (podgląd)","birth_year":\#(year(kuba))}"#
            return (200, #"{"user_id":"preview-user","user_display_name":"Tomek","patients":[{"patient_id":"\#(Self.patientID)","display_name":"\#(name)","birth_year":\#(year(Self.patientID))}\#(other)]}"#)
        case ("GET", "/v1/me/ai-preferences"), ("PUT", "/v1/me/ai-preferences"):
            if ProcessInfo.processInfo.environment["GLUCOMIND_UI_FIXTURES_NO_AI_PREFERENCES"] == "1" {
                return (404, #"{"title":"Not Found","status":404}"#)
            }
            if method == "PUT" {
                guard let edited = body.flatMap({ try? JSONDecoder().decode(UserAiPreferences.self, from: $0) }), !edited.isInstructionsTooLong else {
                    return (400, #"{"title":"Validation failed","status":400}"#)
                }
                lock.withLock { aiPreferences = UserAiPreferences(role: edited.role, instructions: edited.instructions.trimmingCharacters(in: .whitespacesAndNewlines)) }
            }
            let stored = lock.withLock { aiPreferences }
            return (200, String(decoding: (try? JSONEncoder().encode(stored)) ?? Data("{}".utf8), as: UTF8.self))
        case ("GET", "\(base)/people") where Self.selfGrantRole != nil:
            return (200, selfGrantPeople())
        case ("PUT", "\(base)/people/preview-user") where Self.selfGrantRole != nil:
            // "Włącz zdalny bolus dla siebie": the owner's own grant, waiting for the Face ID confirmation.
            lock.withLock { selfGrantState = "awaiting" }
            return (200, #"{"member":\#(selfGrantYou())}"#)
        case ("GET", "\(base)/capabilities") where Self.selfGrantRole != nil:
            let enabled = lock.withLock { selfGrantState } == "on"
            return (200, #"{"patient_id":"\#(Self.patientID)","loop_system":{"kind":"TRIO","version":"0.5.1"},"remote_commands":{"enabled":\#(enabled),"reason":"\#(enabled ? "ENABLED" : "CAREGIVER_NOT_PERMITTED")","driver":"TRIO"}}"#)
        case ("GET", "\(base)/capabilities") where ProcessInfo.processInfo.environment["GLUCOMIND_UI_FIXTURES_LOOP"] == "1":
            // GLUCOMIND_UI_FIXTURES_LOOP=1: a patient on Loop, its commands through Loop's driver (texts name Loop).
            return (200, #"{"patient_id":"\#(Self.patientID)","loop_system":{"kind":"LOOP","version":"3.14.11"},"remote_commands":{"enabled":true,"reason":"ENABLED","driver":"LOOP"}}"#)
        case ("GET", "\(base)/remote-control/loop") where ProcessInfo.processInfo.environment["GLUCOMIND_UI_FIXTURES_LOOP"] == "1":
            return (200, #"{"patient_id":"\#(Self.patientID)","loop":{"status":"READY","device_token":"\#(String(repeating: "cd", count: 32))","bundle_id":"com.ABCDE12345.loopkit.Loop","team_id":"ABCDE12345","apns_environment":"production","profile_uploaded_at":null,"max_bolus_u":5},"pump_bolus_step":0.05}"#)
        case ("GET", "\(base)/remote-control/trio") where ProcessInfo.processInfo.environment["GLUCOMIND_UI_FIXTURES_REMOTE"] == "1":
            // Trio's address as a Nightscout profile shows it (made-up token and team), for "Zdalne sterowanie Trio".
            return (200, #"{"patient_id":"\#(Self.patientID)","trio":{"status":"READY","device_token":"\#(String(repeating: "ab", count: 32))","bundle_id":"org.nightscout.ABCDE12345.trio","team_id":"ABCDE12345","apns_environment":"production","profile_uploaded_at":"\#(iso(-20 * 60))","remote_commands":["bolus","meal"],"build_expires_at":null},"pump_bolus_step":0.05}"#)
        case ("GET", "\(base)/capabilities") where ProcessInfo.processInfo.environment["GLUCOMIND_UI_FIXTURES_REMOTE"] == "1":
            // GLUCOMIND_UI_FIXTURES_REMOTE=1 shows "Zdalne sterowanie Trio" in Settings (nothing is ever sent from fixtures).
            return (200, #"{"patient_id":"\#(Self.patientID)","remote_commands":{"enabled":true,"reason":"ENABLED"}}"#)
        case ("GET", "\(base)/remote-commands") where ProcessInfo.processInfo.environment["GLUCOMIND_UI_FIXTURES_REMOTE"] == "1":
            // Commands "sent" with GLUCOMIND_UI_FIXTURES_SEND, as Trio answers them (UIPreviewFixtureSender).
            let items = UIPreviewFixtureSender.commands.items(patientID: Self.patientID)
            let encoded = String(decoding: (try? JSONEncoder().encode(items)) ?? Data("[]".utf8), as: UTF8.self)
            return (200, #"{"patient_id":"\#(Self.patientID)","items":\#(encoded)}"#)
        case ("GET", "\(base)/pending-investigation"):
            return (200, #"{"patient_id":"\#(Self.patientID)","pending_investigation":null}"#)
        case ("GET", "\(base)/pending-questions"):
            // No question cards wait for an answer.
            return (200, #"{"patient_id":"\#(Self.patientID)","items":[]}"#)
        case ("GET", "\(base)/conversations"):
            return (200, conversationList())
        case ("POST", "\(base)/conversations"):
            // "Nowa rozmowa" opens the empty conversation (its starter cards).
            return (200, #"{"conversation":\#(emptyConversation())}"#)
        case ("GET", "\(base)/notifications"):
            return (200, notificationHistory())
        case ("GET", "\(base)/dashboard"):
            return (200, dashboard())
        case ("GET", "\(base)/meals/journal"):
            return (200, #"{"patient_id":"\#(Self.patientID)","items":[\#(journalItems().joined(separator: ","))],"next_before":null}"#)
        case ("GET", "\(base)/meals/journal/days"):
            let offsets: [TimeInterval] = [-10 * 60, -5 * 3_600, -26 * 3_600, -4 * 86_400, -5 * 86_400, -6 * 86_400, -7 * 86_400, -8 * 86_400, -9 * 86_400, -10 * 86_400]
            let starts = offsets.map { offset -> String in "\"" + iso(offset) + "\"" }.joined(separator: ",")
            return (200, #"{"patient_id":"\#(Self.patientID)","starts":[\#(starts)]}"#)
        case ("GET", "\(base)/meals/search"):
            return (200, #"{"patient_id":"\#(Self.patientID)","query":"pizza","items":[\#(journalItem("meal-pizza", title: "Pizza margherita, 2 kawałki", minutesAgo: 300, carbs: 60, insulin: 7.2, source: "CHAT", reminders: "", extra: #","glucose_peak_mgdl":212,"glucose_min_mgdl":118"#))]}"#)
        case ("GET", "\(base)/meals/meal-bolus/overview"):
            return (200, mealOverview("meal-bolus"))
        case ("GET", "\(base)/meals/meal-pizza/overview"):
            return (200, mealOverview("meal-pizza"))
        case ("GET", "\(base)/meals/\(Self.burgerMeal)/overview"):
            return (200, burgerOverview())
        case ("POST", "\(base)/devices"):
            return (200, "{}")
        default:
            break
        }

        if method == "POST", path.hasPrefix("\(base)/conversations/conv-processing/messages/"), path.hasSuffix("/cancel") {
            lock.withLock { cancelled = true }
            return (200, #"{"result":"CANCELLED","message_id":"msg-processing","conversation":\#(processingConversation())}"#)
        }

        if method == "POST", path.hasPrefix("\(base)/conversations/"), path.hasSuffix("/photos") {
            let payload = body.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] } ?? [:]
            guard let data = (payload["data_base64"] as? String).flatMap({ Data(base64Encoded: $0) }) else {
                return (400, #"{"title":"Validation failed","status":400}"#)
            }
            let photoID = "photo-\(UUID().uuidString.lowercased())"
            lock.withLock { conversationPhotos[photoID] = data }
            return (200, #"{"patient_id":"\#(Self.patientID)","photo_id":"\#(photoID)"}"#)
        }

        // The meal's WBT screen and its conversation (wbt-chat.v1): the pizza's proposal, then a chat that offers less.
        if path.hasPrefix("\(base)/meals/"), path.hasSuffix("/wbt-suggestion") {
            let mealID = String(path.dropFirst("\(base)/meals/".count).dropLast("/wbt-suggestion".count))
            return (200, wbtSuggestion(mealID: mealID))
        }
        if method == "POST", path.hasPrefix("\(base)/meals/"), path.hasSuffix("/wbt-conversation") {
            let mealID = String(path.dropFirst("\(base)/meals/".count).dropLast("/wbt-conversation".count))
            return (200, #"{"patient_id":"\#(Self.patientID)","meal_id":"\#(mealID)","conversation_id":"conv-wbt"}"#)
        }

        for conversationID in ["conv-long", "conv-hypo", "conv-empty", "conv-wbt", "conv-meal", "conv-rescue"] where method == "POST" && path == "\(base)/conversations/\(conversationID)/messages" {
            let index = recordSent(body, in: conversationID)
            let answer = conversationID == "conv-long" ? Self.longAnswer : conversationID == "conv-hypo" ? Self.hypoAnswer : conversationID == "conv-wbt" ? Self.wbtAnswer : conversationID == "conv-meal" ? Self.longAnswer : Self.emptyAnswer
            streamAnswer(thread: "conversation", id: conversationID, replyTo: "sent-\(index)", text: answer, changeKind: "conversation")
            let sent = message("sent-\(index)", role: "USER", type: "USER_MESSAGE", content: sentContent(body), secondsAgo: 0, extra: sentMessageExtra(photoIDs: sentPhotoIDs(body)))
            let conversation = conversationID == "conv-long" ? longAnswerConversation() : conversationID == "conv-hypo" ? hypoConversation() : conversationID == "conv-wbt" ? wbtConversation() : conversationID == "conv-meal" ? mealChangeConversation() : conversationID == "conv-rescue" ? rescueConversation() : emptyConversation()
            return (200, #"{"message":\#(sent),"conversation":\#(conversation),"decision":"DIRECT_RESPONSE"}"#)
        }

        if path.hasPrefix("\(base)/meals/"), path.hasSuffix("/chat") {
            if method == "POST" {
                let index = recordSent(body, in: "meal-chat")
                let mealID = String(path.dropFirst("\(base)/meals/".count).dropLast("/chat".count))
                streamAnswer(thread: "meal_chat", id: mealID, replyTo: "mc-sent-\(index)", text: Self.mealChatReply, changeKind: "meal_chat")
            }
            return (200, mealChat(mealID: String(path.dropFirst("\(base)/meals/".count).dropLast("/chat".count))))
        }

        if path.hasPrefix("\(base)/meals/"), (method == "PUT" && path.hasSuffix("/description")) || (method == "POST" && path.hasSuffix("/correct")) {
            let mealID = String(path.dropFirst("\(base)/meals/".count).split(separator: "/").first ?? "")
            let input = body.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] } ?? [:]
            let current = lock.withLock { mealRevisions[mealID] ?? 1 }
            if let expected = input["expected_revision"] as? Int, expected != current {
                return (409, #"{"type":"https://mellis.invalid/problems/stale_write","title":"MEAL_CHANGED","status":409,"code":"STALE_WRITE"}"#)
            }
            lock.withLock {
                if let description = input["description"] as? String { mealDescriptions[mealID] = description }
                mealRevisions[mealID] = current + 1
            }
            return (200, #"{"patient_id":"\#(Self.patientID)","meal":\#(currentMealJSON(mealID))}"#)
        }

        if method == "GET", path.hasPrefix("\(base)/conversations/") {
            let requested = String(path.dropFirst("\(base)/conversations/".count))
            switch Self.pushConversationAliases[requested] ?? requested {
            case "conv-long": return (200, longAnswerConversation())
            case "conv-processing": return (200, processingConversation())
            case "conv-failed": return (200, failedConversation())
            case "conv-empty": return (200, emptyConversation())
            case "conv-hypo": return (200, hypoConversation())
            case "conv-wbt": return (200, wbtConversation())
            case "conv-meal": return (200, mealChangeConversation())
            case "conv-rescue": return (200, rescueConversation())
            case "conv-error": return (503, #"{"title":"Service Unavailable","status":503}"#)
            default: return (404, #"{"title":"Not Found","status":404}"#)
            }
        }

        if method == "POST", path == "\(base)/conversations/conv-rescue/rescue-carbs/decline" {
            if lock.withLock({ rescueTreatment != nil }) {
                return (409, #"{"type":"https://mellis.invalid/problems/rescue_already_logged","title":"Dosłodzenie już wpisane (Tomek)","status":409,"code":"RESCUE_ALREADY_LOGGED"}"#)
            }
            lock.withLock { if rescueDeclinedAt == nil { rescueDeclinedAt = iso(0) } }
            emit("change", ["kind": "conversation", "id": "conv-rescue"])
            return (200, #"{"rescue_carbs":\#(rescueCarbsBlock())}"#)
        }

        if method == "POST", path == "\(base)/conversations/conv-rescue/rescue-carbs" {
            let input = body.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] } ?? [:]
            let already = lock.withLock { rescueTreatment != nil }
            if already {
                return (409, #"{"type":"https://mellis.invalid/problems/rescue_already_logged","title":"Dosłodzenie już wpisane (Tomek)","status":409,"code":"RESCUE_ALREADY_LOGGED"}"#)
            }
            guard let grams = (input["carbs_g"] as? NSNumber)?.doubleValue, grams >= 1, grams <= 50 else {
                return (422, #"{"type":"https://mellis.invalid/problems/validation_error","title":"carbs_g","status":422,"code":"VALIDATION_ERROR"}"#)
            }
            lock.withLock { rescueTreatment = (grams, input["given_at"] as? String ?? iso(0), input["proposal_id"] as? String) }
            emit("change", ["kind": "conversation", "id": "conv-rescue"])
            emit("change", ["kind": "meals", "id": NSNull()])
            return (200, #"{"rescue_carbs":\#(rescueCarbsBlock())}"#)
        }

        if method == "PUT", path.hasPrefix("/v1/patients/"), path.hasSuffix("/birth-year"),
           let input = body.flatMap({ try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }), let year = input["birth_year"] as? Int {
            let patientID = String(path.dropFirst("/v1/patients/".count).dropLast("/birth-year".count))
            lock.withLock { birthYears[patientID] = year }
            return (200, #"{"patient_id":"\#(patientID)","birth_year":\#(year)}"#)
        }

        if path.hasPrefix("\(base)/devices/"), path.hasSuffix("/notification-settings") {
            let deviceID = String(path.dropFirst("\(base)/devices/".count).dropLast("/notification-settings".count))
            if method == "PUT", let input = body.flatMap({ try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }) {
                lock.withLock {
                    if let enabled = input["rescue_carb_alerts_enabled"] as? Bool { rescueAlertsEnabled = enabled }
                    if let enabled = input["answer_ready_push_enabled"] as? Bool { answerReadyPushEnabled = enabled }
                    if let enabled = input["reservoir_push_enabled"] as? Bool { reservoirPushEnabled = enabled }
                }
            }
            let (alerts, answerReady, reservoir) = lock.withLock { (rescueAlertsEnabled, answerReadyPushEnabled, reservoirPushEnabled) }
            return (200, #"{"device_id":"\#(deviceID)","rescue_carb_alerts_enabled":\#(alerts),"answer_ready_push_enabled":\#(answerReady),"reservoir_push_enabled":\#(reservoir)}"#)
        }

        if method == "POST", path.hasPrefix("\(base)/conversations/conv-meal/meal-actions/meal-action-1/") {
            let verb = path.split(separator: "/").last.map(String.init) ?? ""
            let edited = (body.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] })?["edited"] as? [String: Any]
            lock.withLock {
                switch (verb, mealActionStatus) {
                case ("apply", "PROPOSED"):
                    mealActionStatus = "APPLIED"
                    mealActionEdit = edited
                case ("reject", "PROPOSED"):
                    mealActionStatus = "REJECTED"
                case ("undo", "APPLIED"):
                    mealActionStatus = "UNDONE"
                default:
                    break
                }
            }
            return (200, #"{"patient_id":"\#(Self.patientID)","meal_action":\#(mealActionCard())}"#)
        }

        // A meal notification opens the meal first (GET), then its page.
        if method == "GET", [Self.pizzaMeal, Self.lunchMeal].contains(where: { path == "\(base)/meals/\($0)" }) {
            return (200, #"{"patient_id":"\#(Self.patientID)","meal":\#(currentMealJSON(String(path.dropFirst("\(base)/meals/".count))))}"#)
        }
        if method == "GET", path == "\(base)/meals/\(Self.burgerMeal)" {
            return (200, #"{"patient_id":"\#(Self.patientID)","meal":\#(burgerMealJSON())}"#)
        }

        if path == "\(base)/meals/\(Self.burgerMeal)/planned-bolus" {
            return (200, burgerPlannedBolus())
        }
        if method == "POST", path == "\(base)/meals/\(Self.burgerMeal)/planned-bolus/skip" {
            lock.withLock { burgerPartSkipped = true }
            return (200, burgerPlannedBolus())
        }
        if method == "POST", path.hasSuffix("/messages") {
            return (503, #"{"title":"Service Unavailable","status":503}"#)
        }

        return (404, #"{"title":"Not Found","status":404}"#)
    }

    // MARK: - Fixtures

    private func iso(_ offsetSeconds: TimeInterval) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.string(from: now.addingTimeInterval(offsetSeconds))
    }

    private func conversationList() -> String {
        let (isCancelled, names, pinnedAt) = lock.withLock { (cancelled, self.names, self.pinnedAt) }
        func item(_ id: String, minutesAgo: Double, status: String, title: String? = nil, origin: String = "USER", type: String = "USER_INITIATED", trigger: String = "null") -> String {
            let titleJSON = title.map { #""\#($0)""# } ?? "null"
            let nameJSON = names[id].map { #""\#($0)""# } ?? "null"
            let pinnedJSON = pinnedAt[id].map { #""\#(iso($0))""# } ?? "null"
            return #"{"id":"\#(id)","title":\#(nameJSON),"pinned_at":\#(pinnedJSON),"title_preview":\#(titleJSON),"patient_id":"\#(Self.patientID)","episode_id":null,"trigger_id":null,"origin":"\#(origin)","trigger_type":\#(trigger),"thread_state_version":"conv-v1","awaiting_user_answer":false,"conversation_type":"\#(type)","workflow_status":"ACTIVE","analysis_id":null,"recommendation_id":null,"created_at":"\#(iso(-minutesAgo * 60))","updated_at":"\#(iso(-minutesAgo * 60 + 30))","activity_status":"\#(status)","activity_checked_at":"\#(iso(0))"}"#
        }
        let items = [
            item("conv-long", minutesAgo: 2, status: "COMPLETED", title: "Jak minął dzisiejszy dzień?"),
            item("conv-processing", minutesAgo: 5, status: isCancelled ? "CANCELLED" : "PROCESSING", title: "Dlaczego po obiedzie cukier tak wzrósł?"),
            item("conv-failed", minutesAgo: 40, status: "FAILED", title: "Porównaj ten tydzień z poprzednim."),
            item("conv-meal", minutesAgo: 1, status: "COMPLETED", title: "Zamiast zupy zjadł naleśniki"),
            item("conv-rescue", minutesAgo: 0.5, status: "COMPLETED", title: "Możliwe niedocukrzenie", origin: "SYSTEM", type: "TRIGGER_INITIATED", trigger: #""RESCUE_CARBS""#),
            item("conv-hypo", minutesAgo: 180, status: "NONE", title: "Hipo", origin: "SYSTEM", type: "TRIGGER_INITIATED", trigger: #""HYPO_DETECTED""#),
            item("conv-empty", minutesAgo: 60 * 26, status: "EMPTY"),
            item("conv-error", minutesAgo: 60 * 72, status: "COMPLETED", title: "Czy w nocy były niskie cukry?"),
        ]
        return #"{"patient_id":"\#(Self.patientID)","items":[\#(items.joined(separator: ","))],"next_cursor":null}"#
    }

    /// The Bolus form's check with its chart (ISF 100, ICR 8, DIA 8 h), for the default dashboard's 124 mg/dL with
    /// 1.85 U IOB and 23 g COB. By default as the server draws it without FORECAST_CALIBRATION (bolus-forecast.v7: only
    /// the loop's line, the dose checked by its full effect); GLUCOMIND_UI_FIXTURES_FORECAST=model draws the line with
    /// the dose (fitted-v1's maths).
    private func remoteCommandPreview(query: [URLQueryItem]) -> String {
        let value = { (name: String) in query.first { $0.name == name }?.value.flatMap(Double.init) }
        let carbs = Int(value("carbs_g") ?? 0)
        // GLUCOMIND_UI_FIXTURES_DOSE=normal|high_iob|falling: the calculator's scenario (dose-calculator.v1).
        let dose = doseFixture(carbs: carbs)
        let insulin = value("insulin_u") ?? (dose.flatMap { $0.defaultU } ?? ((Double(carbs) / 8 / 0.05).rounded(.down) * 5).rounded() / 100)
        let (isf, icr, dia, peak, start) = (100.0, 8.0, 480.0, 75.0, -3.0 * 60)
        let tau = peak * (1 - peak / dia) / (1 - 2 * peak / dia), a = 2 * tau / dia, s = 1 / (1 - a + (1 + a) * exp(-dia / tau))
        let onBoard = { (t: Double) -> Double in t <= 0 ? 1 : t >= dia ? 0 : 1 - s * (1 - a) * ((t * t / (tau * dia * (1 - a)) - t / tau - 1) * exp(-t / tau) + 1) }
        let mealIn = value("meal_in_minutes") ?? 10
        let absorbed = { (t: Double) -> Double in let eaten = t - mealIn; return eaten <= 0 ? 0 : 1 - (1 + eaten / 40) * exp(-eaten / 40) }
        let minutes = stride(from: 0.0, through: 180, by: 5).map { $0 }
        let (g0, fall) = (dose?.glucose ?? 124, dose?.per5 ?? 0)
        let baseline = minutes.map { t in Int((g0 + 12 * (1 - exp(-t / 60)) - 0.06 * t + (fall < 0 ? fall / 5 * min(t, 40) : 0)).rounded()) }
        let withDose = minutes.enumerated().map { index, t in
            Int((Double(baseline[index]) + 0.7 * Double(carbs) * isf / icr * absorbed(t - 3) - insulin * isf * (1 - onBoard(t - 3))).rounded())
        }
        let band = minutes.map { Int(((ProcessInfo.processInfo.environment["GLUCOMIND_UI_FIXTURES_FORECAST"] == "model" ? 21.9 : 25.4) * ($0 / 30).squareRoot()).rounded()) }
        let model = ProcessInfo.processInfo.environment["GLUCOMIND_UI_FIXTURES_FORECAST"] == "model"
        let lowLine = model ? withDose : baseline
        let lowIndex = lowLine.indices.first { $0 > 0 && lowLine[$0] < 70 }
        let typed = carbs > 0 || insulin > 0
        let total = typed ? String(max(39, Int((Double(baseline.last ?? 124) + Double(carbs) * isf / icr - insulin * isf).rounded()))) : "null"
        let ints = { (values: [Int]) in "[" + values.map(String.init).joined(separator: ",") + "]" }
        // GLUCOMIND_UI_FIXTURES_WARNINGS=owner: the owner's 2026-10-30 case (a dose above the calculator while falling):
        // the loop's line below 70, the glucose and its trend, a bolus 10 min ago and the dose above the data.
        let ownerCase = ProcessInfo.processInfo.environment["GLUCOMIND_UI_FIXTURES_WARNINGS"] == "owner" && insulin > 0
        let lowAt = ownerCase ? #""\#(iso(38 * 60))""# : lowIndex.map { #""\#(iso(start + Double($0) * 300))""# } ?? "null"
        let insulinText = RemoteCommandFormat.units(insulin)
        let warnings = ownerCase ? [
            #"{"code":"GLUCOSE_FALLING_OR_LOW","key":"GLUCOSE_FALLING_OR_LOW:fixture","message":"Glukoza 180 mg/dL, zmiana -19 na 5 min."}"#,
            #"{"code":"RECENT_BOLUS","key":"RECENT_BOLUS:fixture","message":"Bolus 1,2 j podano 10 min temu."}"#,
            #"{"code":"DOSE_ABOVE_CALCULATOR","key":"DOSE_ABOVE_CALCULATOR:fixture","severity":"DANGER","message":"\#(insulinText) j to o \#(insulinText) j więcej, niż wychodzi z danych (dawka obniżona na spadek glukozy: 0 j (prognoza ok. 65 mg/dL)). W ostatnich 120 min podano 3,8 j. Większa dawka grozi niedocukrzeniem."}"#,
        ].joined(separator: ",") : ""
        let forecast = #"{"policy_version":"bolus-forecast.v7","start":"\#(iso(start))","step_minutes":5,"baseline_source":"LOOP","dose_line":"\#(model ? "MODEL" : "LOOP_ONLY")","baseline":\#(ints(baseline)),"with_dose":\#(typed && model ? ints(withDose) : "null"),"total_with_dose":\#(total),"band":\#(ints(band)),"low_at":\#(lowAt),"low_from_dose":\#(model && lowIndex != nil),"carbs_g":\#(carbs),"insulin_u":\#(insulin),"meal_in_minutes":\#(Int(mealIn))}"#
        let glucoseJSON = dose.map { #"{"value":\#(Int($0.glucose)),"observed_at":"\#(iso(start))","delta":\#(Int($0.per5)),"direction":"\#($0.direction)"}"# } ?? #"{"value":124,"observed_at":"\#(iso(start))","delta":1,"direction":"Flat"}"#
        let context = #"{"now":"\#(iso(0))","glucose":\#(glucoseJSON),"lowest_recent_glucose":121,"loop":{"iob_units":\#(dose?.iob ?? 1.85),"cob_grams":\#(dose == nil ? 23 : 0),"observed_at":"\#(iso(-120))"},"last_bolus":null,"bolus_history_known":true,"recent_remote_bolus":null,"icr_g_per_u":8,"in_flight_command_id":null}"#
        let icrInsulin = carbs > 0 ? String(((Double(carbs) / 8 / 0.05).rounded(.down) * 5).rounded() / 100) : "null"
        let calculation = dose.map { #","dose_calculation":\#($0.json)"# } ?? ""
        return #"{"carbs_g":\#(carbs),"insulin_u":\#(insulin),"icr_g_per_u":8,"icr_insulin_u":\#(icrInsulin),"context":\#(context),"blocks":[],"warnings":[\#(warnings)],"bolus_step":0.05,"bolus_step_source":"SETTINGS","forecast":\#(forecast)\#(calculation)}"#
    }

    /// The calculator of the server (dose-calculator.v2) for the fixture's ICR 8 and ISF 100, target 100: normal (IOB
    /// 0,1 j, carbs / ICR stays), high_iob (IOB 1,85 j), falling (98 mg/dL, −9 per 5 min, a drop of 10 g) or high (210
    /// mg/dL rising +4 per 5 min, IOB 0,6 j: the opt-in correction behind ±, at 0 g and on top of a meal).
    private func doseFixture(carbs: Int) -> (glucose: Double, per5: Double, direction: String, iob: Double, defaultU: Double?, json: String)? {
        guard let scenario = ProcessInfo.processInfo.environment["GLUCOMIND_UI_FIXTURES_DOSE"] else { return nil }
        let floor5 = { (units: Double) in max(0, ((units / 0.05) + 1e-6).rounded(.down) * 5 / 100) }
        let comma = { (units: Double) in RemoteCommandFormat.units(units) }
        let (glucose, per5, direction, iob): (Double, Double, String, Double) = scenario == "high_iob" ? (124, 1, "Flat", 1.85) : scenario == "falling" ? (98, -9, "SingleDown", 0.4) : scenario == "high" ? (210, 4, "FortyFiveUp", 0.6) : (124, 1, "Flat", 0.1)
        // dose-calculator.v2's higher dose: half of (glucose [+ trend at 0 g] − 100) / 100 − IOB, at most 1 j.
        let higher = { (base: Double, withTrend: Bool) -> String in
            guard scenario == "high" else { return "" }
            let trend = withTrend ? per5 * 3 : 0
            let full = (glucose + trend - 100) / 100 - iob
            let half = 0.5 * max(0, full)
            let extra = floor5(min(1, half))
            let iobText = ", aktywna insulina \(comma(iob))\u{00A0}j"
            let summary = withTrend
                ? "Korekta: +\(comma(extra))\u{00A0}j (połowa wyliczenia: glukoza \(Int(glucose)) i rośnie\(iobText))"
                : "+\(comma(extra))\u{00A0}j korekty do przelicznika (glukoza \(Int(glucose))\(iobText))"
            let trendText = withTrend ? " + \(Int(trend))" : ""
            let correction = "0,5 × ((\(Int(glucose))\(trendText) − 100) / 100 − IOB \(comma(iob)) j) = \(comma((half * 100).rounded() / 100)) j → \(comma(extra)) j"
            let formula = withTrend ? "Korekta: \(correction)" : "\(carbs) g / ICR 8 = \(comma(base)) j; korekta: \(correction); razem \(comma(base + extra)) j"
            return #","higher_u":\#(((base + extra) * 100).rounded() / 100),"higher_reason_code":"\#(withTrend ? "CORRECTION_ONLY" : "MEAL_TOP_UP")","higher_summary":"\#(summary)","higher_formula":"\#(formula)""#
        }
        guard carbs > 0 else {
            return (glucose, per5, direction, iob, nil, #"{"default_u":0,"icr_dose_u":null,"calculator_u":0,"limited_by":"ICR","summary":"","calculated":true\#(higher(0, true))}"#)
        }
        let icrDose = floor5(Double(carbs) / 8)
        let trend = per5 * 3
        let calculator = floor5(Double(carbs) / 8 + (glucose + trend - 100) / 100 - iob)
        var defaultU = min(icrDose, calculator)
        var limited = calculator < icrDose ? "CALCULATOR" : "ICR"
        let said = trend <= -10 ? " i spada" : ""
        var summary = limited == "ICR"
            ? "Z przelicznika \(comma(icrDose)) j · kalkulator pętli \(comma(calculator)) j (IOB \(comma(iob)) j, glukoza \(Int(glucose))\(said))."
            : "Kalkulator pętli: \(comma(calculator)) j zamiast \(comma(icrDose)) j z przelicznika — IOB \(comma(iob)) j, glukoza \(Int(glucose))\(said)."
        var short = limited == "ICR"
            ? "Z przelicznika"
            : "↓ \(comma(((icrDose - calculator) * 100).rounded() / 100))\u{00A0}j mniej niż z przelicznika (\(comma(icrDose))\u{00A0}j): aktywna insulina"
        if scenario == "falling" {
            let drop = floor5(Double(max(0, carbs - 10)) / 8)
            if drop < defaultU {
                defaultU = drop
                limited = "DROP"
                summary = "Mniej na spadek: \(comma(drop)) j zamiast \(comma(icrDose)) j z przelicznika — prognoza ok. 78 mg/dL (cel 100)."
                short = "↓ \(comma(((icrDose - drop) * 100).rounded() / 100))\u{00A0}j mniej niż z przelicznika (\(comma(icrDose))\u{00A0}j): glukoza spada"
            }
        }
        let trendText = trend == 0 ? "" : " \(trend > 0 ? "+" : "−") \(Int(abs(trend)))"
        let formula = "\(carbs) g / ICR 8 + (\(Int(glucose))\(trendText) − 100) / 100 − IOB \(comma(iob)) j = \(comma(calculator)) j"
        let reason = limited == "DROP" ? #""FALLING""# : limited == "CALCULATOR" ? #""ACTIVE_INSULIN""# : "null"
        let json = #"{"reason_code":\#(reason),"default_u":\#(defaultU),"icr_dose_u":\#(icrDose),"calculator_u":\#(calculator),"limited_by":"\#(limited)","summary":"\#(summary)","short_summary":"\#(short)","formula":"\#(formula)","calculated":true\#(limited == "ICR" ? higher(icrDose, false) : "")}"#
        return (glucose, per5, direction, iob, defaultU, json)
    }

    /// The breakdown's 7 and 14 days, after a second (its loader). GLUCOMIND_UI_FIXTURES_TIR=fail fails them.
    private func timeInRange(days: Int) async throws -> (Int, String) {
        try await Task.sleep(for: .seconds(1))
        if ProcessInfo.processInfo.environment["GLUCOMIND_UI_FIXTURES_TIR"] == "fail" {
            return (503, #"{"title":"Service Unavailable","status":503}"#)
        }
        let (counts, coverage) = days == 14 ? ("[22,61,2510,820,190]", 91) : ("[9,25,1380,420,95]", 64)
        let values = counts.dropFirst().dropLast().split(separator: ",").map { Int($0)! }
        return (200, #"{"patient_id":"\#(Self.patientID)","days":\#(days),"from":"\#(iso(-Double(days) * 86_400))","to":"\#(iso(0))","readings_count":\#(values.reduce(0, +)),"counts":{"very_low":\#(values[0]),"low":\#(values[1]),"in_range":\#(values[2]),"high":\#(values[3]),"very_high":\#(values[4])},"sensor_coverage_percent":\#(coverage)}"#)
    }

    /// The dashboard. GLUCOMIND_UI_FIXTURES_DASHBOARD=warning or alarm shows the yellow or red thresholds.
    private func dashboard() -> String {
        let variant = ProcessInfo.processInfo.environment["GLUCOMIND_UI_FIXTURES_DASHBOARD"] ?? "normal"
        let curve: [Double]
        let (readingAgo, direction, pumpAgo, battery, reservoirDefault, siteHours, sensorHours, tir): (Double, String, Double, Int, Double, Double, Double, (Int, Int, Int))
        switch variant {
        case "warning":
            curve = [112, 131, 168, 196, 209, 198, 175, 152, 136, 128, 125, 130, 136, 131, 121, 115, 119, 132, 156, 179, 192, 196, 200, 203]
            (readingAgo, direction, pumpAgo, battery, reservoirDefault, siteHours, sensorHours, tir) = (12, "FortyFiveUp", 8, 27, 18, 57, 222, (4, 64, 32))
        case "alarm":
            curve = [180, 221, 258, 262, 231, 190, 156, 140, 136, 142, 150, 149, 141, 133, 131, 137, 150, 181, 220, 241, 226, 185, 141, 106, 81, 66, 60, 58]
            (readingAgo, direction, pumpAgo, battery, reservoirDefault, siteHours, sensorHours, tir) = (17, "DoubleDown", 21, 15, 6, 77, 243, (9, 45, 46))
        default:
            curve = [150, 171, 176, 168, 151, 137, 130, 127, 124, 121, 122, 124, 123, 122, 124, 125, 123, 122, 122, 124]
            (readingAgo, direction, pumpAgo, battery, reservoirDefault, siteHours, sensorHours, tir) = (3, "Flat", 2, 68, 112, 28, 122, (2, 81, 17))
        }
        // A reading every 5 minutes for 24 h, like Nightscout: the curve's points interpolated, with a little CGM noise.
        let latest = -readingAgo * 60
        var readings: [(TimeInterval, Double)] = []
        for step in 0..<288 {
            let position = Double(step) / 287 * Double(curve.count - 1)
            let index = min(Int(position), curve.count - 2)
            let fraction = position - Double(index)
            let value = curve[index] + (curve[index + 1] - curve[index]) * fraction + (step == 287 ? 0 : sin(Double(step) * 1.7) * 2)
            readings.append((latest - Double(287 - step) * 300, value))
        }
        let last = curve.last ?? 120
        let readingsJSON = readings.map { #"{"at":"\#(iso($0.0))","value":\#(Int($0.1.rounded()))}"# }.joined(separator: ",")
        let delta = Int((readings[readings.count - 1].1 - readings[readings.count - 2].1).rounded())
        let glucose = #"{"value":\#(Int(last)),"unit":"mg/dL","direction":"\#(direction)","observed_at":"\#(iso(latest))","delta":\#(delta)}"#
        let tirJSON = #"{"hours":24,"readings_count":288,"low_percent":\#(tir.0),"in_range_percent":\#(tir.1),"high_percent":\#(tir.2)}"#
        // GLUCOMIND_UI_FIXTURES_RESERVOIR=<units>: another reservoir level (55 U lasts ~44 h: "1 dzień i 20 godz.").
        let reservoir = ProcessInfo.processInfo.environment["GLUCOMIND_UI_FIXTURES_RESERVOIR"].flatMap(Double.init) ?? reservoirDefault
        // How long the reservoir lasts at 30 U a day, and its level, as the server computes them (reservoir-level.v1).
        let hoursLeft = (reservoir / (30.0 / 24) * 10).rounded() / 10
        let reservoirLevel = hoursLeft < 8 ? "alarm" : hoursLeft < 24 ? "warning" : "normal"
        let pump = #"{"battery_percent":\#(battery),"reservoir_units":\#(reservoir),"reservoir_full_units":160,"reservoir_hours_left":\#(hoursLeft),"reservoir_level":"\#(reservoirLevel)","last_read_at":"\#(iso(-pumpAgo * 60))"}"#
        let (iob, cob) = variant == "warning" ? (3.4, 41) : variant == "alarm" ? (0.15, 0) : (1.85, 23)
        let loop = #"{"iob_units":\#(iob),"cob_grams":\#(cob),"observed_at":"\#(iso(-pumpAgo * 60))"}"#
        // Insulin of the last 24 h: a meal bolus with SMBs after it every few hours, basal with suspends and highs.
        var boluses: [String] = []
        var smbs: [String] = []
        for (hoursAgo, units) in [(23.0, 5.0), (15.5, 3.0), (9.0, 4.5), (2.6, 3.5)] {
            boluses.append(#"{"at":"\#(iso(-hoursAgo * 3_600))","units":\#(units)}"#)
            // A correction and a second part shortly after (summed on 12 h and 24 h).
            if hoursAgo == 15.5 || hoursAgo == 9.0 {
                boluses.append(#"{"at":"\#(iso(-(hoursAgo - 0.3) * 3_600))","units":0.6}"#)
                boluses.append(#"{"at":"\#(iso(-(hoursAgo - 0.6) * 3_600))","units":1.2}"#)
            }
            for (step, smb) in [0.4, 0.3, 0.3, 0.2, 0.1].enumerated() {
                smbs.append(#"{"at":"\#(iso(-hoursAgo * 3_600 + Double(step + 1) * 1_500))","units":\#(smb)}"#)
            }
        }
        var basal: [String] = []
        let rates = [0.6, 0.6, 0.0, 0.8, 1.2, 0.6, 0.6, 0.0, 0.0, 0.6, 1.0, 0.6]
        for (index, rate) in rates.enumerated() {
            let from = -24 * 3_600 + Double(index) * 7_200
            basal.append(#"{"start":"\#(iso(from))","end":"\#(iso(from + 7_200))","rate":\#(rate)}"#)
        }
        let insulin = #"{"boluses":[\#(boluses.joined(separator: ","))],"smbs":[\#(smbs.joined(separator: ","))],"basal":[\#(basal.joined(separator: ","))]}"#
        return #"{"patient_id":"\#(Self.patientID)","generated_at":"\#(iso(0))","glucose":\#(glucose),"readings":[\#(readingsJSON)],"time_in_range":\#(tirJSON),"pump":\#(pump),"loop":\#(loop),"insulin":\#(insulin),"site_changed_at":"\#(iso(-siteHours * 3_600))","sensor_started_at":"\#(iso(-sensorHours * 3_600))"\#(historyImport)}"#
    }

    /// GLUCOMIND_UI_FIXTURES_HISTORY_IMPORT=<percent>: the server is still reading the Nightscout history (1.0.5).
    private var historyImport: String {
        guard let raw = ProcessInfo.processInfo.environment["GLUCOMIND_UI_FIXTURES_HISTORY_IMPORT"], let percent = Int(raw) else { return "" }
        return #","nightscout_history":{"status":"LOADING","progress_percent":\#(percent)}"#
    }

    // MARK: Meals: a meal to describe, a described one and a split bolus.

    private static let pizzaMeal = "55555555-5555-4555-8555-555555555551"
    private static let lunchMeal = "55555555-5555-4555-8555-555555555552"
    /// A split bolus: 60% given 50 min ago, the second part due in 40 min, the WBT reminder after it.
    static let burgerMeal = "55555555-5555-4555-8555-555555555553"
    private static let burgerPlan = "77777777-7777-4777-8777-777777777771"

    private func burgerMealJSON() -> String {
        let wbt = #"{"fat_protein_units":5.3,"auto_threshold_met":true,"reminder":{"enabled":true,"source":"AUTO","remind_at":"\#(iso(100 * 60))","status":"SCHEDULED"}}"#
        let macros = #"{"carbs":{"grams":60,"origin":"CAREGIVER"},"protein":{"grams":32,"origin":"CAREGIVER"},"fat":{"grams":44,"origin":"CAREGIVER"}}"#
        return #"{"meal_id":"\#(Self.burgerMeal)","content_revision":1,"status":"CORRECTED","started_at":"\#(iso(-50 * 60))","source_carbs_g":36,"description":"Burger wołowy z frytkami","has_photo":false,"macros":\#(macros),"pending_proposal_id":null,"proposal_in_progress":false,"proposal_failed":false,"trusted":true,"wbt":\#(wbt)}"#
    }

    private func burgerPlannedBolus() -> String {
        let skipped = lock.withLock { burgerPartSkipped }
        let estimate = #"{"as_of":"\#(iso(0))","icr_g_per_u":8,"insulin_for_carbs_u":3,"loop_extra_u":0.4,"smb_u":0.4,"temp_basal_extra_u":0,"insulin_u":2.6}"#
        let plan = #"{"id":"\#(Self.burgerPlan)","status":"\#(skipped ? "SKIPPED" : "NOTIFIED")","due_at":"\#(iso(40 * 60))","delay_minutes":90,"now_percent":60,"carbs_g":24,"planned_insulin_u":2.4,"first_carbs_g":36,"first_insulin_u":3.6,"resolved_at":\#(skipped ? #""\#(iso(0))""# : "null"),"resolved_by_name":\#(skipped ? #""Tomek""# : "null"),"given_insulin_u":null,"sending":false,"meal_started_at":"\#(iso(-50 * 60))","icr_at_plan":10,"estimate":\#(skipped ? "null" : estimate),"command":null}"#
        return #"{"patient_id":"\#(Self.patientID)","meal":\#(burgerMealJSON()),"planned_bolus":\#(plan)}"#
    }

    private func mealJSON(id: String, minutesAgo: Double, description: String?, trusted: Bool) -> String {
        let (override, revision, confirmed) = lock.withLock { (mealDescriptions[id], mealRevisions[id] ?? 1, mealsConfirmed.contains(id)) }
        let trusted = trusted || confirmed
        let macros = trusted
            ? #"{"carbs":{"grams":62.3,"origin":"CAREGIVER"},"protein":{"grams":21,"origin":"CAREGIVER"},"fat":{"grams":24,"origin":"CAREGIVER"}}"#
            : #"{"carbs":{"grams":null,"origin":null},"protein":{"grams":null,"origin":null},"fat":{"grams":null,"origin":null}}"#
        let wbt = trusted ? #"{"fat_protein_units":2.6,"auto_threshold_met":true,"reminder":{"enabled":true,"source":"AUTO","remind_at":"\#(iso(-minutesAgo * 60 + 150 * 60))","status":"SENT"}}"# : "null"
        let desc = (override ?? description).map { #""\#($0)""# } ?? "null"
        return #"{"meal_id":"\#(id)","content_revision":\#(revision),"status":"\#(trusted ? "CORRECTED" : "AWAITING_DESCRIPTION")","started_at":"\#(iso(-minutesAgo * 60))","source_carbs_g":50,"description":\#(desc),"has_photo":false,"macros":\#(macros),"pending_proposal_id":null,"proposal_in_progress":false,"proposal_failed":false,"trusted":\#(trusted),"wbt":\#(wbt)}"#
    }

    private func clock(minutesAgo: Double) -> String {
        let formatter = DateFormatter()
        formatter.dateFormat = "HH:mm"
        return formatter.string(from: now.addingTimeInterval(-minutesAgo * 60))
    }

    /// The bell: one push of each kind, none read yet on a fresh install (red dot on first launch).
    private func notificationHistory() -> String {
        let meal = "44444444-4444-4444-8444-444444444444"
        func item(_ id: String, type: String, title: String, body: String, minutesAgo: Double, payload: String) -> String {
            #"{"id":"\#(id)","type":"\#(type)","title":"\#(title)","body":"\#(body)","sent_at":"\#(iso(-minutesAgo * 60))","payload":{"type":"\#(type)","patientId":"\#(Self.patientID)",\#(payload)}}"#
        }
        let items = [
            item("n-wbt", type: "wbt_reminder", title: "Przypomnienie o WBT", body: "Pizza o 12:10: czas na insulinę na tłuszcz i białko.", minutesAgo: 4, payload: #""mealId":"\#(Self.pizzaMeal)","routePath":"/patients/\#(Self.patientID)/meals/\#(Self.pizzaMeal)/wbt""#),
            item("n-meal", type: "meal_description", title: "Co było w tym posiłku?", body: "Zapisano nowe węglowodany. Opisz posiłek lub dodaj zdjęcie, a zaproponuję makroskładniki do Twojego zatwierdzenia.", minutesAgo: 150, payload: #""mealId":"\#(meal)","routePath":"/patients/\#(Self.patientID)/meals/\#(meal)""#),
            item("n-rescue", type: "rescue_carbs", title: "Możliwe niedocukrzenie", body: "Ok. \(clock(minutesAgo: -20)) może spaść poniżej 70 · proponuję 4 g", minutesAgo: 1, payload: #""conversationId":"conv-rescue","alertId":"alert-preview","routePath":"/patients/\#(Self.patientID)/conversations/conv-rescue""#),
            item("n-hypo", type: "conversation_question", title: "Hipo o 9:12 · najniżej 57 mg/dL", body: "Opisz, co się działo przed spadkiem i czym go leczono.", minutesAgo: 180, payload: #""conversationId":"conv-hypo","questionId":"hypo_report""#),
            item("n-old", type: "conversation_question", title: "Mellis potrzebuje odpowiedzi", body: "Mam pytanie dotyczące hipo. Twoja odpowiedź pomoże mi lepiej przeanalizować sytuację.", minutesAgo: 60 * 30, payload: #""conversationId":"conv-error","questionId":"q-old""#),
        ]
        return #"{"patient_id":"\#(Self.patientID)","items":[\#(items.joined(separator: ","))]}"#
    }

    private func message(_ id: String, role: String, type: String, content: String, secondsAgo: TimeInterval, extra: String = "") -> String {
        let escaped = content
            .replacingOccurrences(of: "\\", with: "\\\\")
            .replacingOccurrences(of: "\"", with: "\\\"")
            .replacingOccurrences(of: "\n", with: "\\n")
        return #"{"id":"\#(id)","role":"\#(role)","message_type":"\#(type)","content":"\#(escaped)","created_at":"\#(iso(-secondsAgo))"\#(extra)}"#
    }

    private func conversation(id: String, messages: [String], processing: String = "null", awaiting: Bool = false, pendingQuestion: String = "null", origin: String = "USER") -> String {
        #"{"id":"\#(id)","patient_id":"\#(Self.patientID)","origin":"\#(origin)","awaiting_user_answer":\#(awaiting),"pending_question":\#(pendingQuestion),"messages":[\#(messages.joined(separator: ","))],"processing":\#(processing)}"#
    }

    private func sentContent(_ body: Data?) -> String {
        let payload = body.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] } ?? [:]
        return payload["content"] as? String ?? ""
    }

    private func sentPhotoIDs(_ body: Data?) -> [String] {
        let payload = body.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] } ?? [:]
        return payload["photo_ids"] as? [String] ?? []
    }

    /// The fields of a message sent by the caregiver: its author and the photos it carries.
    private func sentMessageExtra(photoIDs: [String]) -> String {
        let photos = photoIDs.map { #""\#($0)""# }.joined(separator: ",")
        return #","response_status":null,"analysis_cancellable":false,"author_display_name":"Tomek","photo_ids":[\#(photos)]"#
    }

    @discardableResult
    private func recordSent(_ body: Data?, in thread: String) -> Int {
        let content = sentContent(body)
        let photoIDs = sentPhotoIDs(body)
        return lock.withLock {
            sentMessages[thread, default: []].append((content, photoIDs, Date()))
            return sentMessages[thread]!.count - 1
        }
    }

    /// Each sent message, and its answer once three seconds have passed; the processing step while one is pending.
    private func sentConversationMessages(in conversationID: String, answer: String, extra: String) -> (messages: [String], processing: String) {
        let sent = lock.withLock { sentMessages[conversationID] ?? [] }
        var messages: [String] = []
        var processing = "null"
        for (index, sentMessage) in sent.enumerated() {
            let age = Date().timeIntervalSince(sentMessage.sentAt)
            messages.append(message("sent-\(index)", role: "USER", type: "USER_MESSAGE", content: sentMessage.content, secondsAgo: age, extra: sentMessageExtra(photoIDs: sentMessage.photoIDs)))
            if age >= 3 {
                messages.append(message("sent-answer-\(index)", role: "ASSISTANT", type: "ASSISTANT_MESSAGE", content: answer, secondsAgo: age - 3, extra: extra))
            } else {
                processing = #"{"status":"PROCESSING","current_step":{"execution_id":"exec-sent","sequence":1,"type":"ANALYZING_REQUEST","status":"STARTED","label":"Analizuję pytanie","tool":null,"detail":null,"time_range":null,"started_at":"\#(iso(-age))","completed_at":null},"steps":[]}"#
            }
        }
        return (messages, processing)
    }

    /// Every meal's chat (shown with the pizza meal): one earlier exchange, then each sent message gets a proposal three seconds later.
    private func mealChat(mealID: String) -> String {
        func chatMessage(_ id: String, role: String, content: String, secondsAgo: TimeInterval, proposal: String = "null") -> String {
            #"{"id":"\#(id)","role":"\#(role)","content":"\#(content)","photo_ids":[],"proposal":\#(proposal),"question":null,"author_display_name":null,"reply_to_message_id":null,"created_at":"\#(iso(-secondsAgo))"}"#
        }
        let proposal = #"{"items":[{"name":"Pizza margherita","grams":250,"carbs_g":62.3,"protein_g":21,"fat_g":24,"source":"DIABCALC"},{"name":"Sok jabłkowy","grams":200,"carbs_g":22,"protein_g":0.2,"fat_g":0.1,"source":"ESTIMATE"}],"carbs_g":84.3,"protein_g":21.2,"fat_g":24.1,"confidence":"MEDIUM","assumptions":"Przyjąłem 2 kawałki pizzy po ok. 125 g i szklankę soku. Jeśli sok był rozcieńczony albo pizza miała grubsze ciasto, wartości będą inne.","proposal_id":null}"#
        var messages = [
            chatMessage("mc-1", role: "USER", content: "Pizza margherita, dwa kawałki", secondsAgo: 600),
            chatMessage("mc-2", role: "ASSISTANT", content: "Dwa kawałki margherity to ok. 62 g węglowodanów.", secondsAgo: 580),
        ]
        let sent = lock.withLock { sentMessages["meal-chat"] ?? [] }
        var pending = false
        for (index, sentMessage) in sent.enumerated() {
            let age = Date().timeIntervalSince(sentMessage.sentAt)
            messages.append(chatMessage("mc-sent-\(index)", role: "USER", content: sentMessage.content, secondsAgo: age))
            if age >= 3 {
                messages.append(chatMessage("mc-answer-\(index)", role: "ASSISTANT", content: Self.mealChatReply, secondsAgo: age - 3, proposal: proposal))
            } else {
                pending = true
            }
        }
        let meal = currentMealJSON(mealID)
        return #"{"patient_id":"\#(Self.patientID)","meal":\#(meal),"messages":[\#(messages.joined(separator: ","))],"reply_pending":\#(pending),"reply_failed":false}"#
    }

    /// Empty until a message is sent; each one gets a short answer.
    /// A conversation in which the AI prepared a meal change (conversation-meal-actions.v1): the card under its answer.
    private func mealChangeConversation() -> String {
        // Each sent message gets the long answer with the burger's bolus card again (tall cards above the next turn).
        let (sent, processing) = sentConversationMessages(in: "conv-meal", answer: Self.longAnswer, extra: #","bolus_proposals":[\#(splitBolusCard())]"#)
        return conversation(id: "conv-meal", messages: [
            message("u-meal", role: "USER", type: "USER_MESSAGE", content: "Zamiast ostatniego posiłku zjadł dwa naleśniki z twarogiem", secondsAgo: 90, extra: #","response_status":null,"analysis_cancellable":false,"author_display_name":"Tomek""#),
            message("a-meal", role: "ASSISTANT", type: "ASSISTANT_MESSAGE", content: "Przygotowałem zmianę obiadu z 13:10: zamiast zupy pomidorowej dwa naleśniki z twarogiem, W 36,3 g (DiabCalc). Zapisze się dopiero po „Zatwierdź” na karcie poniżej. Pętla dostała 30 g, więc zjadł ok. 6 g więcej.", secondsAgo: 60, extra: #","meal_actions":[\#(mealActionCard())]"#),
            message("u-burger", role: "USER", type: "USER_MESSAGE", content: "Ile podać na burgera wołowego z frytkami?", secondsAgo: 40, extra: #","response_status":null,"analysis_cancellable":false,"author_display_name":"Tomek""#),
            message("a-burger", role: "ASSISTANT", type: "ASSISTANT_MESSAGE", content: "Burger z frytkami ma dużo tłuszczu (44 g) i białka (32 g), więc wchłania się wolniej: cała dawka od razu grozi spadkiem w pierwszej godzinie [S1]. Proponuję podać to w trzech krokach: teraz 36 g i 1,8 j (połowa dawki na te węgle), za 10 min drugie 1,8 j, a po ok. 90 min resztę węgli, 24 g, z ok. 2,4 j [S2]. Przypomnienia przyjdą do Was obojga; dawkę na 24 g przeliczę wtedy z aktualnego ICR. Insulina na WBT zostaje osobno, jak zwykle.", secondsAgo: 20, extra: #","metadata":{"user_message_id":"u-burger"},"bolus_proposals":[\#(splitBolusCard())]"#),
        ] + sent, processing: processing)
    }

    private func splitBolusCard() -> String {
        let split = #"{"kind":"DEFERRED_INSULIN","policy_version":"later-plan.v1","now_percent":100,"later_after_minutes":10,"total_carbs_g":60,"total_insulin_u":6,"later_carbs_g":0,"later_insulin_u":1.8,"trigger":"AFTER_MINUTES","fixed_insulin_u":1.8,"more_parts":[{"kind":"SPLIT","policy_version":"later-plan.v1","now_percent":60,"later_after_minutes":90,"total_carbs_g":60,"total_insulin_u":6,"later_carbs_g":24,"later_insulin_u":2.4,"trigger":"AFTER_MINUTES"}]}"#
        return #"{"id":"bp-burger","purpose":"MEAL","carbs_g":36,"insulin_u":1.8,"icr_g_per_u":10,"icr_insulin_u":3.6,"meal_description":"Burger wołowy z frytkami","meal":null,"reason":"Dużo tłuszczu i białka: połowa dawki teraz, druga za 10 min, reszta węgli po 90 min.","warnings":[],"expires_at":"\#(iso(15 * 60))","state":"PROPOSED","command":null,"split":\#(split),"planned_bolus":null,"wbt_plan":{"units":4.2,"standard_dose_u":1.25,"auto":true,"after_minutes":150}}"#
    }

    private func mealActionCard() -> String {
        let (status, edit) = lock.withLock { (mealActionStatus, mealActionEdit) }
        let number = { (key: String, fallback: Double) -> String in
            guard let edit else { return String(fallback) }
            return (edit[key] as? Double).map { String($0) } ?? "null"
        }
        let items = edit == nil
            ? #"[{"name":"Naleśnik","grams":120,"carbs_g":34.2,"protein_g":7.8,"fat_g":8.4,"source":"DIABCALC"},{"name":"Twaróg półtłusty","grams":60,"carbs_g":2.1,"protein_g":11.1,"fat_g":2.4,"source":"DIABCALC"}]"#
            : "null"
        let description = (edit?["description"] as? String).map { #""\#($0)""# } ?? #""Naleśnik (120 g), Twaróg półtłusty (60 g)""#
        let before = #"{"kind":"CONTENT","status":"CONFIRMED","description":"Zupa pomidorowa","items":null,"carbs_g":30,"protein_g":10,"fat_g":8,"fat_protein_units":1.1}"#
        let after = #"{"kind":"CONTENT","description":\#(description),"items":\#(items),"carbs_g":\#(number("carbs_g", 36.3)),"protein_g":\#(number("protein_g", 18.9)),"fat_g":\#(number("fat_g", 10.8)),"fat_protein_units":1.7}"#
        let warning = #"{"code":"LOOP_CARBS_DIFFER","message":"Pętla dostała 30 g węglowodanów, a zjedzone to 36,3 g (6,3 g więcej). Wpisu w pętli to nie zmienia."}"#
        let decidedBy = status == "PROPOSED" ? "null" : #""Tomek""#
        return #"{"id":"meal-action-1","user_message_id":"u-meal","operation":"REPLACE_CONTENT","status":"\#(status)","title":"Zmiana posiłku · Zupa pomidorowa (13:10)","reason":"Opiekun napisał, że zamiast zupy zjadł dwa naleśniki z twarogiem.","before":\#(before),"after":\#(after),"warnings":[\#(warning)],"meal_id":"\#(Self.pizzaMeal)","carb_event_id":null,"loop_action_id":null,"can_apply":\#(status == "PROPOSED"),"can_edit":\#(status == "PROPOSED"),"can_undo":\#(status == "APPLIED"),"decided_by":\#(decidedBy),"decided_at":null,"undone_at":null,"created_at":"\#(iso(-60))"}"#
    }

    /// The pizza's WBT proposal (the screen): the standard dose, no history yet.
    private func wbtSuggestion(mealID: String) -> String {
        let result = #"{"basis":"STANDARD","dose_units":0.85,"carbs_equivalent_g":9,"rationale":"Za mało historii: standardowo 30% insuliny na WBT. Glukoza 160 mg/dL, stabilna.","history_cases_used":0,"history_cases":[]}"#
        return #"{"patient_id":"\#(Self.patientID)","meal":\#(currentMealJSON(mealID)),"suggestion":{"id":"wbt-s1","status":"DONE","result":\#(result)},"remote_command":null}"#
    }

    /// The pizza's WBT conversation: each answer proposes 0,5 j, the newest one can be given.
    private func wbtConversation() -> String {
        let sent = lock.withLock { sentMessages["conv-wbt"] ?? [] }
        let answered = sent.indices.filter { Date().timeIntervalSince(sent[$0].sentAt) >= 3 }
        let newest = answered.last
        let extra = { (index: Int) -> String in
            #","metadata":{"user_message_id":"sent-\#(index)"},"wbt_proposal":{"suggestion_id":"wbt-chat-\#(index)","meal_id":"\#(Self.pizzaMeal)","dose_units":0.5,"carbs_equivalent_g":5,"rationale":"Glukoza spada od pół godziny: mniej niż standardowe 0,85 j.","warnings":[],"newest":\#(index == newest),"command":null}"#
        }
        var messages: [String] = []
        var processing = "null"
        for (index, sentMessage) in sent.enumerated() {
            let age = Date().timeIntervalSince(sentMessage.sentAt)
            messages.append(message("sent-\(index)", role: "USER", type: "USER_MESSAGE", content: sentMessage.content, secondsAgo: age, extra: ""))
            if age >= 3 {
                messages.append(message("sent-answer-\(index)", role: "ASSISTANT", type: "ASSISTANT_MESSAGE", content: Self.wbtAnswer, secondsAgo: age - 3, extra: extra(index)))
            } else {
                processing = #"{"status":"PROCESSING","current_step":{"execution_id":"exec-sent","sequence":1,"type":"ANALYZING_REQUEST","status":"STARTED","label":"Analizuję pytanie","tool":null,"detail":null,"time_range":null,"started_at":"\#(iso(-age))","completed_at":null},"steps":[]}"#
            }
        }
        return #"{"id":"conv-wbt","patient_id":"\#(Self.patientID)","origin":"USER","trigger_type":"MEAL_WBT","awaiting_user_answer":false,"pending_question":null,"messages":[\#(messages.joined(separator: ","))],"processing":\#(processing),"wbt":{"meal_id":"\#(Self.pizzaMeal)"}}"#
    }

    private func emptyConversation() -> String {
        let (messages, processing) = sentConversationMessages(in: "conv-empty", answer: Self.emptyAnswer, extra: "")
        return conversation(id: "conv-empty", messages: messages, processing: processing)
    }

    /// The meal as every endpoint returns it (with both caregivers' edits).
    private func currentMealJSON(_ mealID: String) -> String {
        mealID == Self.lunchMeal
            ? mealJSON(id: Self.lunchMeal, minutesAgo: 90, description: nil, trusted: false)
            : mealJSON(id: Self.pizzaMeal, minutesAgo: 300, description: "Pizza margherita", trusted: true)
    }

    private func longAnswerConversation() -> String {
        let cost = #","ai_cost":{"status":"KNOWN","amount":0.0123,"currency":"PLN","pricing_version":"preview","provider":"fake","model":"fake"}"#
        let (followUps, processing) = sentConversationMessages(in: "conv-long", answer: Self.longAnswer, extra: cost)
        return conversation(id: "conv-long", messages: [
            message("u-1", role: "USER", type: "USER_MESSAGE", content: "Jak minął dzisiejszy dzień?", secondsAgo: 180, extra: #","response_status":null,"analysis_cancellable":false"#),
            message("a-1", role: "ASSISTANT", type: "ASSISTANT_MESSAGE", content: Self.longAnswer, secondsAgo: 150, extra: cost),
            message("u-2", role: "USER", type: "USER_MESSAGE", content: "A co z posiłkiem po obiedzie?", secondsAgo: 120, extra: #","response_status":null,"analysis_cancellable":false"#),
            message("a-2", role: "ASSISTANT", type: "ASSISTANT_MESSAGE", content: "Wpis z Nightscout mówi o 45 g węglowodanów. Bez opisu posiłku nie potrafię ocenić, czy to była pełna ilość.", secondsAgo: 100, extra: cost),
        ] + followUps, processing: processing)
    }

    private func processingConversation() -> String {
        let isCancelled = lock.withLock { cancelled }
        let extra = isCancelled
            ? #","response_status":"CANCELLED","analysis_cancellable":false"#
            : #","response_status":null,"analysis_cancellable":true"#
        let step = { (type: String, status: String, label: String, startedAgo: TimeInterval) in
            #"{"execution_id":"exec-preview","sequence":1,"type":"\#(type)","status":"\#(status)","label":"\#(label)","tool":null,"detail":null,"time_range":null,"started_at":"\#(self.iso(-startedAgo))","completed_at":null}"#
        }
        let processing = isCancelled ? "null" : #"{"status":"PROCESSING","current_step":\#(step("REQUESTING_EVIDENCE", "STARTED", "Sprawdzam insulinę · dziś 06:00–14:00", 9)),"steps":[\#(step("ANALYZING_REQUEST", "SUCCEEDED", "Analizuję pytanie", 25)),\#(step("REQUESTING_EVIDENCE", "SUCCEEDED", "Sprawdzam glikemię · dziś 06:00–14:00", 18)),\#(step("REQUESTING_EVIDENCE", "STARTED", "Sprawdzam insulinę · dziś 06:00–14:00", 9))]}"#
        return conversation(id: "conv-processing", messages: [
            message("msg-processing", role: "USER", type: "USER_MESSAGE", content: "Dlaczego po obiedzie cukier tak wzrósł?", secondsAgo: 30, extra: extra),
        ], processing: processing)
    }

    private func failedConversation() -> String {
        let processing = #"{"status":"FAILED","current_step":{"execution_id":"exec-failed","sequence":3,"type":"FAILED","status":"FAILED","label":"Nie udało się przygotować odpowiedzi","tool":null,"detail":null,"time_range":null,"started_at":"\#(iso(-2400))","completed_at":"\#(iso(-2380))"},"steps":[]}"#
        return conversation(id: "conv-failed", messages: [
            message("u-f", role: "USER", type: "USER_MESSAGE", content: "Porównaj ten tydzień z poprzednim.", secondsAgo: 2410, extra: #","response_status":null,"analysis_cancellable":false"#),
        ], processing: processing)
    }

    /// A rescue carbs alert (rescue-carbs.v1): predicted low in 20 min, 4 g by the formula; POST rescue-carbs logs it.
    private func rescueCarbsBlock() -> String {
        let treatment = lock.withLock { rescueTreatment }
        let declinedAt = lock.withLock { rescueDeclinedAt }
        // Every 5 min from 2 h before the alert (5 min ago) until now, falling to 82.
        let values = [148, 150, 151, 149, 147, 146, 144, 141, 139, 137, 134, 131, 128, 125, 122, 119, 116, 112, 108, 104, 100, 96, 92, 88, 85, 82]
        let readings = values.enumerated().map { index, value in
            #"{"observed_at":"\#(iso(Double(index - values.count + 1) * 5 * 60))","value":\#(value)}"#
        }
        let forecast = [76, 70, 65, 61, 58, 59, 62].enumerated().map { index, value in
            #"{"at":"\#(iso(Double(index + 1) * 5 * 60))","value":\#(value)}"#
        }
        let explanation = #"["Prognoza: 58 mg/dL za ok. 20 min","1 g podnosi o ok. 10 mg/dL (ISF 150 / ICR 15)","(90 − 58) / 10 = 3,2 → 4 g (zakres 3–7 g)"]"#
        let proposal = #"{"carbs_g":4,"min_g":3,"max_g":7,"basis":"FORMULA","csf_mgdl_per_g":10,"isf_mgdl_per_u":150,"icr_g_per_u":15,"iob_u":0.8,"cob_g":0,"trio_carbs_req_g":null,"explanation":\#(explanation)}"#
        let declinedJSON = treatment == nil ? declinedAt.map { #"{"declined_at":"\#($0)","declined_by":"Tomek"}"# } ?? "null" : "null"
        let treatmentJSON = treatment.map { #"{"event_id":"rescue-entry","carbs_g":\#($0.grams),"given_at":"\#($0.givenAt)","logged_by":"Tomek","logged_at":"\#(iso(0))","source":"\#($0.proposalID == nil ? "ALERT" : "CHAT_CARD")","proposal_id":\#($0.proposalID.map { "\"\($0)\"" } ?? "null")}"# } ?? "null"
        return #"{"alert_id":"alert-preview","status":"\#(treatment == nil ? "NOTIFIED" : "TREATED")","level":"PREDICTED_LOW","trigger_source":"TRIO_PREDICTION","detected_at":"\#(iso(-5 * 60))","glucose_mgdl":85,"glucose_at":"\#(iso(-5 * 60))","delta_per_5min":-4,"predicted_min_mgdl":58,"predicted_low_at":"\#(iso(20 * 60))","minutes_to_low":20,"proposal":\#(proposal),"glucose_readings":[\#(readings.joined(separator: ","))],"prediction":[\#(forecast.joined(separator: ","))],"latest_glucose":{"value":82,"observed_at":"\#(iso(0))"},"treatment":\#(treatmentJSON),"declined":\#(declinedJSON),"notified_at":"\#(iso(-5 * 60))","reminder_sent_at":null}"#
    }

    /// The alert's conversation: the system message with the computation, a question, and an answer with a card.
    private func rescueConversation() -> String {
        let (sent, processing) = sentConversationMessages(in: "conv-rescue", answer: Self.emptyAnswer, extra: "")
        let card = #"{"id":"rescue-card-1","carbs_g":6,"reason":"Po WF-ie spada szybciej niż zwykle: 6 g zamiast 4 g.","status":"PROPOSED","created_at":"\#(iso(-60))"}"#
        let messages = [
            message("s-rescue", role: "SYSTEM", type: "SYSTEM_MESSAGE", content: "Możliwe niedocukrzenie: ok. \(clock(minutesAgo: -20)) może spaść do 58 mg/dL. Proponuję 4 g.", secondsAgo: 300),
            message("u-rescue", role: "USER", type: "USER_MESSAGE", content: "Był godzinę temu na WF-ie, dać więcej?", secondsAgo: 120, extra: #","response_status":null,"analysis_cancellable":false,"author_display_name":"Tomek""#),
            message("a-rescue", role: "ASSISTANT", type: "ASSISTANT_MESSAGE", content: "Po wysiłku wrażliwość na insulinę jest większa, a pętla już zatrzymała bazę. Proponuję 6 g zamiast 4 g i kontrolę glukozy po 15 min.", secondsAgo: 60, extra: #","rescue_carb_proposals":[\#(card)]"#),
        ] + sent
        return #"{"id":"conv-rescue","patient_id":"\#(Self.patientID)","origin":"SYSTEM","trigger_type":"RESCUE_CARBS","conversation_type":"TRIGGER_INITIATED","awaiting_user_answer":false,"pending_question":null,"messages":[\#(messages.joined(separator: ","))],"processing":\#(processing),"rescue_carbs":\#(rescueCarbsBlock())}"#
    }

    /// A hypo conversation from before: the episode with its CGM curve above its chat.
    private func hypoConversation() -> String {
        let start = -3 * 3_600.0
        let values = [112, 104, 96, 88, 79, 71, 64, 59, 57, 61, 68, 76, 88, 104, 121, 138, 149, 152, 147, 139]
        let readings = values.enumerated().map { index, value in
            #"{"observed_at":"\#(iso(start - 50 * 60 + Double(index) * 10 * 60))","glucose_mgdl":\#(value)}"#
        }
        let (sentMessages, processing) = sentConversationMessages(in: "conv-hypo", answer: Self.hypoAnswer, extra: "")
        let hypo = #"{"episode_id":"episode-preview","state":"CLOSED","severity":"L1","started_at":"\#(iso(start))","ended_at":"\#(iso(start + 35 * 60))","duration_minutes":35,"minimum_glucose":57,"glucose_readings":[\#(readings.joined(separator: ","))]}"#
        return #"{"id":"conv-hypo","patient_id":"\#(Self.patientID)","episode_id":"episode-preview","origin":"SYSTEM","trigger_type":"HYPO_DETECTED","conversation_type":"TRIGGER_INITIATED","awaiting_user_answer":false,"pending_question":null,"messages":[\#(sentMessages.joined(separator: ","))],"processing":\#(processing),"hypo":\#(hypo)}"#
    }
}

// MARK: - Live events (simulator checks of live-updates.v1)

extension UIPreviewFixtureHTTPClient: EventStreamTransport {
    /// GLUCOMIND_UI_FIXTURES_OTHER_CAREGIVER=1: 20 s after the stream opens "Ania" describes the meal waiting in "Do
    /// zrobienia", so the meals tab refreshes live and a save from an edit sheet opened before that is refused.
    static let otherCaregiverKey = "GLUCOMIND_UI_FIXTURES_OTHER_CAREGIVER"

    func lines(for request: URLRequest) async throws -> AsyncThrowingStream<String, Error> {
        let (stream, continuation) = AsyncThrowingStream<String, Error>.makeStream()
        let id = UUID()
        lock.withLock { streams[id] = continuation }
        continuation.onTermination = { [weak self] _ in
            guard let self else { return }
            self.lock.withLock { self.streams[id] = nil }
        }
        for line in ["event: ready", #"data: {"heartbeat_s":15,"live":true}"#, ""] {
            continuation.yield(line)
        }
        scheduleOtherCaregiverIfNeeded()
        return stream
    }

    fileprivate func emit(_ event: String, _ payload: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: payload), let json = String(data: data, encoding: .utf8) else { return }
        let continuations = lock.withLock { Array(streams.values) }
        for continuation in continuations {
            continuation.yield("event: \(event)")
            continuation.yield("data: \(DocsScreenshotNames.apply(json))")
            continuation.yield("")
        }
    }

    /// Writes the answer as drafts from 0.7 s to 2.7 s after the message, then announces the stored answer (3 s).
    fileprivate func streamAnswer(thread: String, id: String, replyTo: String, text: String, changeKind: String) {
        Task {
            try? await Task.sleep(for: .milliseconds(700))
            let characters = Array(text)
            var written = ""
            let steps = 10
            for step in 1...steps {
                let prefix = String(characters[0..<(characters.count * step / steps)])
                let delta = String(prefix.dropFirst(written.count))
                emit("draft", ["thread": thread, "id": id, "reply_to": replyTo, "offset": written.utf16.count, "delta": delta])
                written = prefix
                try? await Task.sleep(for: .milliseconds(200))
            }
            try? await Task.sleep(for: .milliseconds(400))
            emit("change", ["kind": changeKind, "id": id])
            emit("draft", ["thread": thread, "id": id, "cleared": true])
        }
    }

    private func scheduleOtherCaregiverIfNeeded() {
        guard ProcessInfo.processInfo.environment[Self.otherCaregiverKey] == "1" else { return }
        let first = lock.withLock { () -> Bool in
            defer { otherCaregiverScheduled = true }
            return !otherCaregiverScheduled
        }
        guard first else { return }
        Task {
            try? await Task.sleep(for: .seconds(20))
            let meal = Self.lunchMeal
            lock.withLock {
                mealDescriptions[meal] = "Kanapki z szynką i ogórkiem (Ania)"
                mealsConfirmed.insert(meal)
                mealRevisions[meal] = (mealRevisions[meal] ?? 1) + 1
            }
            emit("change", ["kind": "meal", "id": meal])
            emit("change", ["kind": "meal_chat", "id": meal])
        }
    }
}

/// Debug-only stand-in for sending a bolus (Face ID, the server, APNs) in visual checks: nothing leaves the device.
/// GLUCOMIND_UI_FIXTURES_SEND=success|rejected|partial|noreply picks Trio's answer; the fixtures' GET /remote-commands
/// then reports the command as SENT, TRIO_ACCEPTED and the answer, as the server does while Trio works.
final class UIPreviewFixtureSender: RemoteCommandSending {
    static let environmentKey = "GLUCOMIND_UI_FIXTURES_SEND"
    /// Set when the app runs on UIPreviewFixtureHTTPClient: only then may the Bolus tab use this sender.
    nonisolated(unsafe) static var isActive = false
    static let commands = UIPreviewSimulatedCommands()

    func send(_ draft: RemoteCommandDraft) async -> RemoteSendOutcome {
        try? await Task.sleep(for: .milliseconds(1_200))
        let scenario = ProcessInfo.processInfo.environment[Self.environmentKey] ?? "success"
        // A retry of the insulin after carbs-only goes through, so the whole path can be seen.
        let command = Self.commands.add(draft, scenario: draft.followsCommandID == nil ? scenario : "success")
        if ProcessInfo.processInfo.environment["GLUCOMIND_UI_FIXTURES_LOOP"] == "1", draft.carbsG > 0, draft.insulinU > 0, scenario != "noreply" {
            // Loop's meal: the bolus push leaves once the fixtures report the carbs stored (5 s after sending).
            Task { @MainActor in
                try? await Task.sleep(for: .seconds(8))
                NotificationCenter.default.post(name: .loopBolusPushSent, object: command.id.lowercased())
            }
        }
        return .sent(command)
    }
}

final class UIPreviewSimulatedCommands: @unchecked Sendable {
    private struct Entry {
        let id: String
        let draft: RemoteCommandDraft
        let scenario: String
        let at: Date
    }

    private let lock = NSLock()
    private var entries: [Entry] = []

    func add(_ draft: RemoteCommandDraft, scenario: String) -> RemoteCommand {
        let entry = Entry(id: UUID().uuidString.lowercased(), draft: draft, scenario: scenario, at: Date())
        lock.withLock { entries.append(entry) }
        return command(entry, now: entry.at)
    }

    /// Newest first, as the server lists them.
    func items(patientID: String) -> [RemoteCommand] {
        let now = Date()
        return lock.withLock { entries }.reversed().map { command($0, now: now) }
    }

    private func command(_ entry: Entry, now: Date) -> RemoteCommand {
        let elapsed = now.timeIntervalSince(entry.at)
        let (status, message): (String, String?) = switch elapsed {
        case ..<5: ("SENT", nil)
        case ..<14: ("TRIO_ACCEPTED", nil)
        default:
            switch entry.scenario {
            case "rejected":
                // As long as Trio's own messages get: the screen shows a short reason and keeps this under "Szczegóły".
                ("REJECTED", "Błąd: Bolus failed: the pump did not respond to the bolus command (communication timeout after 3 retries). The bolus was not delivered; check the pump connection in Trio and try again.")
            case "partial":
                ("PARTIAL", "Węglowodany zapisane w Trio, bolus odrzucony: przekroczyłby maksymalne IOB w Trio (5 j, teraz 3.4 j)")
            case "noreply" where elapsed >= 24:
                ("NO_REPLY", "Trio nie odpowiedziało na czas.")
            case "noreply":
                ("TRIO_ACCEPTED", nil)
            default:
                ("SUCCEEDED", nil)
            }
        }
        let iso = { (date: Date) in ISO8601DateFormatter().string(from: date) }
        let json: [String: Any?] = [
            "id": entry.id,
            "status": status,
            "status_message": message,
            "source": entry.draft.source.rawValue,
            "carbs_g": entry.draft.carbsG,
            "insulin_u": NSDecimalNumber(decimal: entry.draft.insulinU).doubleValue,
            "icr_g_per_u": 8,
            "follows_command_id": entry.draft.followsCommandID,
            "sent_by_me": true,
            "authorized_at": iso(entry.at),
            "send_deadline": iso(entry.at.addingTimeInterval(60)),
            "sent_at": iso(entry.at),
            "answered_at": elapsed >= 14 ? iso(entry.at.addingTimeInterval(14)) : nil,
            "warnings": [Any](),
        ]
        let data = try! JSONSerialization.data(withJSONObject: json.compactMapValues { $0 })
        return try! JSONDecoder().decode(RemoteCommand.self, from: data)
    }
}

extension UIPreviewFixtureHTTPClient {
    /// The new Meals tab: a Bolus tab bolus with two reminders, a chat meal, an older one.
    fileprivate func journalItems() -> [String] {
        [
            journalItem("meal-bolus", title: nil, minutesAgo: 10, carbs: 45, insulin: 4.5, source: "BOLUS_SCREEN", reminders: bolusReminders()),
            journalItem(Self.burgerMeal, title: "Burger wołowy z frytkami", minutesAgo: 50, carbs: 36, insulin: 3.6, source: "CHAT", reminders: burgerReminders()),
            journalItem("meal-pizza", title: "Pizza margherita, 2 kawałki", minutesAgo: 300, carbs: 60, insulin: 7.2, source: "CHAT", reminders: #"{"id":"r-rise","kind":"SECOND_DOSE","trigger":"GLUCOSE_RISING","due_at":"\#(iso(-255 * 60))","wait_until":"\#(iso(-195 * 60))","status":"EXPIRED","enabled":true,"fired_at":null}"#),
            journalItem("meal-pancakes", title: "Naleśniki z serem", minutesAgo: 26 * 60, carbs: 50, insulin: 5, source: "CHAT", reminders: ""),
            journalItem("meal-soup", title: "Pomidorowa z makaronem", minutesAgo: 4 * 24 * 60, carbs: 35, insulin: 3.5, source: "CHAT", reminders: ""),
            journalItem("meal-sandwich", title: "Kanapka z serem żółtym", minutesAgo: 4 * 24 * 60 + 180, carbs: 30, insulin: 3, source: "CHAT", reminders: ""),
            journalItem("meal-d5", title: "Owsianka z bananem", minutesAgo: 5 * 24 * 60 + 120, carbs: 40, insulin: 4, source: "CHAT", reminders: ""),
            journalItem("meal-d6", title: "Spaghetti bolognese", minutesAgo: 6 * 24 * 60 + 120, carbs: 40, insulin: 4, source: "CHAT", reminders: ""),
            journalItem("meal-d7", title: "Placki ziemniaczane", minutesAgo: 7 * 24 * 60 + 120, carbs: 40, insulin: 4, source: "CHAT", reminders: ""),
            journalItem("meal-d8", title: "Ryż z kurczakiem", minutesAgo: 8 * 24 * 60 + 120, carbs: 40, insulin: 4, source: "CHAT", reminders: ""),
            journalItem("meal-d9", title: "Pierogi ruskie", minutesAgo: 9 * 24 * 60 + 120, carbs: 40, insulin: 4, source: "CHAT", reminders: ""),
            journalItem("meal-d10", title: "Kanapki z szynką", minutesAgo: 10 * 24 * 60 + 120, carbs: 40, insulin: 4, source: "CHAT", reminders: ""),
        ]
    }

    fileprivate func bolusReminders() -> String {
        #"{"id":"r-second","kind":"SECOND_DOSE","trigger":"AFTER_MINUTES","due_at":"\#(iso(20 * 60))","wait_until":null,"status":"WAITING","enabled":true,"fired_at":null},{"id":"wbt","kind":"WBT","trigger":"AFTER_MINUTES","due_at":"\#(iso(140 * 60))","wait_until":null,"status":"WAITING","enabled":true,"fired_at":null}"#
    }

    /// The burger's split bolus: its second part came now (its card gives it), the WBT is still to come.
    fileprivate func burgerReminders() -> String {
        #"{"id":"\#(Self.burgerPlan)","kind":"PLANNED_PART","trigger":"AFTER_MINUTES","due_at":"\#(iso(-60))","wait_until":null,"status":"DUE_NOW","enabled":true,"fired_at":"\#(iso(-60))"},{"id":"wbt","kind":"WBT","trigger":"AFTER_MINUTES","due_at":"\#(iso(100 * 60))","wait_until":null,"status":"WAITING","enabled":true,"fired_at":null}"#
    }

    fileprivate func burgerOverview() -> String {
        let item = journalItem(Self.burgerMeal, title: "Burger wołowy z frytkami", minutesAgo: 50, carbs: 36, insulin: 3.6, source: "CHAT", reminders: burgerReminders())
        let values = [128, 130, 133, 140, 146, 150, 152, 149, 146, 143, 141]
        let readings = values.enumerated().map { index, value in #"{"observed_at":"\#(iso(-65 * 60 + Double(index) * 5 * 60))","glucose_mgdl":\#(value)}"# }.joined(separator: ",")
        let bolus = #"{"at":"\#(iso(-50 * 60))","insulin_u":3.6,"carbs_g":36,"kind":"MEAL","source":"GLUCOMIND","author_name":"Tomek"}"#
        let macros = #"{"carbs":{"grams":60,"origin":"CAREGIVER"},"protein":{"grams":32,"origin":"CAREGIVER"},"fat":{"grams":44,"origin":"CAREGIVER"}}"#
        let given = #"{"since":"\#(iso(-50 * 60))","total_u":0,"doses":[],"line":"Żaden z opiekunów nie podał jeszcze tej dawki."}"#
        return #"{"patient_id":"\#(Self.patientID)","overview":\#(item.dropLast()),"description":"Burger wołowy z frytkami","macros":\#(macros),"glucose":[\#(readings)],"boluses":[\#(bolus)],"given_since_start":\#(given)}}"#
    }

    fileprivate func journalItem(_ id: String, title: String?, minutesAgo: Double, carbs: Double, insulin: Double, source: String, reminders: String, extra: String = "") -> String {
        let titleJSON = title.map { "\"\($0)\"" } ?? "null"
        let conversation = source == "CHAT" ? "\"conv-long\"" : "null"
        return #"{"meal_id":"\#(id)","started_at":"\#(iso(-minutesAgo * 60))","title":\#(titleJSON),"carbs_g":\#(carbs),"insulin_total_u":\#(insulin),"source":"\#(source)","conversation_id":\#(conversation),"has_macros":\#(title != nil),"reminders":[\#(reminders)]\#(extra)}"#
    }

    fileprivate func clock(_ offsetSeconds: TimeInterval) -> String {
        let formatter = DateFormatter()
        formatter.dateFormat = "HH:mm"
        return formatter.string(from: Date().addingTimeInterval(offsetSeconds))
    }

    fileprivate func mealOverview(_ id: String) -> String {
        let isBolus = id == "meal-bolus"
        let start: Double = isBolus ? -10 : -300
        let values: [Int] = isBolus ? [150, 141, 134, 128, 131, 136, 141] : [118, 125, 140, 170, 195, 210, 212, 205, 196, 188, 182, 184, 190, 196]
        let readings = values.enumerated().map { index, value in #"{"observed_at":"\#(iso((start - 15) * 60 + Double(index) * 5 * 60))","glucose_mgdl":\#(value)}"# }.joined(separator: ",")
        let item = isBolus
            ? journalItem(id, title: nil, minutesAgo: 10, carbs: 45, insulin: 4.5, source: "BOLUS_SCREEN", reminders: bolusReminders())
            : journalItem(id, title: "Pizza margherita, 2 kawałki", minutesAgo: 300, carbs: 60, insulin: 7.2, source: "CHAT", reminders: "")
        let boluses = isBolus
            ? #"{"at":"\#(iso(-10 * 60))","insulin_u":4.5,"carbs_g":45,"kind":"MEAL","source":"GLUCOMIND","author_name":"Tomek"}"#
            : #"{"at":"\#(iso(-300 * 60))","insulin_u":6,"carbs_g":60,"kind":"MEAL","source":"GLUCOMIND","author_name":"Tomek"},{"at":"\#(iso(-255 * 60))","insulin_u":1.2,"carbs_g":12,"kind":"OTHER","source":"GLUCOMIND","author_name":"Ania"}"#
        let timeline = isBolus
            ? #"{"at":"\#(iso(-10 * 60))","type":"BOLUS","bolus":{"at":"\#(iso(-10 * 60))","insulin_u":4.5,"carbs_g":45,"kind":"MEAL","source":"GLUCOMIND","author_name":"Tomek"}},{"at":"\#(iso(20 * 60))","type":"REMINDER","reminder":{"id":"r-second","kind":"SECOND_DOSE","trigger":"AFTER_MINUTES","due_at":"\#(iso(20 * 60))","wait_until":null,"status":"WAITING","enabled":true,"fired_at":null}},{"at":"\#(iso(140 * 60))","type":"REMINDER","reminder":{"id":"wbt","kind":"WBT","trigger":"AFTER_MINUTES","due_at":"\#(iso(140 * 60))","wait_until":null,"status":"WAITING","enabled":true,"fired_at":null}}"#
            : #"{"at":"\#(iso(-300 * 60))","type":"BOLUS","bolus":{"at":"\#(iso(-300 * 60))","insulin_u":6,"carbs_g":60,"kind":"MEAL","source":"GLUCOMIND","author_name":"Tomek"}}"#
        let description = isBolus ? "null" : #""Pizza margherita, 2 kawałki""#
        let given = isBolus
            ? #"{"since":"\#(iso(-10 * 60))","total_u":0,"doses":[],"line":"Żaden z opiekunów nie podał jeszcze tej dawki."}"#
            : #"{"since":"\#(iso(-300 * 60))","total_u":1.2,"doses":[{"at":"\#(iso(-255 * 60))","insulin_u":1.2,"by":"Ania"}],"line":"⚠️ Od \#(clock(-300 * 60)) podano już 1,2 j (\#(clock(-255 * 60)), Ania)."}"#
        return #"{"patient_id":"\#(Self.patientID)","overview":\#(item.dropLast()),"description":\#(description),"macros":\#(isBolus ? #"{"carbs":{"grams":null,"origin":null},"protein":{"grams":null,"origin":null},"fat":{"grams":null,"origin":null}}"# : #"{"carbs":{"grams":60,"origin":"CAREGIVER"},"protein":{"grams":22,"origin":"CAREGIVER"},"fat":{"grams":26,"origin":"CAREGIVER"}}"#),"status":"CONFIRMED","trusted":true,"content_revision":1,"has_photo":false,"glucose":[\#(readings)],"boluses":[\#(boluses)],"timeline":[\#(timeline)],"given_since_start":\#(given)}}"#
    }
}

#endif
