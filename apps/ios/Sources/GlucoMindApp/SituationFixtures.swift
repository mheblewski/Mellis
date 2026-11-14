import Foundation

/// Every state of Teraz for the offline fixture simulator (GLUCOMIND_UI_FIXTURES_SITUATION=<state>). Texts as the server
/// writes them, docs/product/teraz-situation/states.md.
struct SituationFixture {
    var state: String
    var value: Int
    var tone = "NEUTRAL"
    var delta = 0
    var direction = "Flat"
    var ageMinutes = 1.0
    var second: (kind: String, label: String?, value: String, unit: String?, note: String?)? = nil
    var sentence: String
    var detail: String? = nil
    var action: (kind: String, grams: Int?, style: String?, label: String)? = nil
    var checkMinutes: Double? = nil
    /// The undo window: seconds left.
    var undoSeconds: Double? = nil
    /// v5: the bar's button (kind, entry id, label); nil with `sendsLink`: no button; without it: an older server.
    var link: (kind: String, entryID: String?, label: String)? = nil
    var sendsLink = false

    private static let glucagon = "Gdy Ania nie reaguje, ma drgawki albo nie może przełykać, nie podawaj niczego doustnie. Podaj glukagon i zadzwoń pod 112."
    /// From 70 up, next to the countdown; below 70 the countdown alone says it (texts review, 2026-11-09).
    private static let promise = "Jeśli glukoza spadnie poniżej 70 wcześniej, Mellis da znać od razu."
    private static let ketones = "Warto sprawdzić wkłucie i zmierzyć ketony. Przy ketonach od 0,6 mmol/l wymień wkłucie i podaj korektę penem według planu z poradni."

    private static func dose(_ grams: Int, _ label: String = "Podaj") -> (String, String?, String, String?, String?) {
        ("DOSE", label, "\(grams) g", "szybkich węgli", "około \(grams * 10) ml soku")
    }
    private static func given(_ grams: Int, _ style: String = "FILLED") -> (String, Int?, String?, String) {
        ("GIVEN", grams, style, "Podano \(grams) g")
    }
    private static func check(_ minutes: Int) -> (String, String?, String, String?, String?) {
        ("CHECK", "Kolejne sprawdzenie za", "\(minutes) min", nil, nil)
    }
    private static let noReading: (String, String?, String, String?, String?) = ("NO_READING", nil, "18 min", "bez odczytu", nil)

    static let table: [String: SituationFixture] = {
        let all: [SituationFixture] = [
.init(state: "1", value: 104, delta: 1, sentence: "Pięknie. Od 5 godzin glukoza jest w zakresie."),
.init(state: "1w", value: 108, delta: 0, sentence: "Świetnie. Od 4 godzin glukoza jest w zakresie."),
.init(state: "1m", value: 118, delta: 1, sentence: "Klasa. Od 6 godzin glukoza jest w zakresie."),
.init(state: "1b", value: 104, delta: 1, sentence: "Pięknie. Przez całą noc glukoza była w zakresie."),
.init(state: "1c", value: 104, delta: 1, sentence: "Świetnie. Od 11 godzin glukoza jest w zakresie."),
.init(state: "1d", value: 128, delta: 2, sentence: " "),
.init(state: "1d1", value: 128, delta: 2, sentence: " "),
.init(state: "2", value: 158, delta: 6, direction: "FortyFiveUp", sentence: "Ewa podała bolus 0,7 j na 5 g węgli 5 minut temu."),
.init(state: "2k", value: 214, tone: "AMBER", delta: 3, direction: "FortyFiveUp", sentence: "Bolus 1,2 j z 12:33 podano poza Mellis."),
.init(state: "3", value: 204, tone: "AMBER", delta: 6, direction: "FortyFiveUp", sentence: "W Trio nie ma węgli, które tłumaczyłyby ten wzrost."),
.init(state: "3a", value: 268, tone: "AMBER", delta: 7, direction: "FortyFiveUp", sentence: "Trio dodaje insulinę, a glukoza nie spada.", detail: "Warto sprawdzić wkłucie i zmierzyć ketony."),
.init(state: "3b", value: 284, tone: "AMBER", delta: 1, sentence: "Od 2 godzin glukoza jest powyżej 250.", detail: ketones),
.init(state: "3c", value: 212, tone: "AMBER", delta: -18, direction: "DoubleDown", sentence: " "),
.init(state: "3d", value: 284, tone: "AMBER", delta: 1, sentence: "Od 2 godzin glukoza jest powyżej 250, a Trio nie przysyła danych.", detail: "Warto sprawdzić wkłucie i telefon z Trio oraz zmierzyć ketony."),
.init(state: "4", value: 142, delta: -11, direction: "SingleDown", sentence: " "),
.init(state: "4b", value: 98, delta: -12, direction: "SingleDown", sentence: " "),
.init(state: "4i", value: 98, delta: -12, direction: "SingleDown", sentence: " "),
.init(state: "5", value: 84, delta: -4, direction: "FortyFiveDown", second: ("FORECAST_DOSE", "Możesz podać", "3 g", "szybkich węgli", nil), sentence: "Glukoza może wkrótce spaść poniżej 70.", action: given(3, "OUTLINE")),
.init(state: "5b", value: 132, delta: -6, direction: "FortyFiveDown", sentence: "Glukoza może wkrótce spaść poniżej 70.", detail: "Linia na wykresie tego jeszcze nie pokazuje."),
.init(state: "6", value: 68, tone: "RED", delta: -3, direction: "FortyFiveDown", second: dose(3), sentence: "Insulina jeszcze działa, więc spadek może potrwać.", action: given(3)),
.init(state: "6b", value: 66, tone: "RED", delta: 3, direction: "FortyFiveUp", second: ("SOFT_DOSE", "Jeśli nie podano węgli", "3 g", "szybkich węgli", nil), sentence: " ", action: given(3, "OUTLINE")),
.init(state: "6b70", value: 72, delta: 3, direction: "FortyFiveUp", sentence: "Na razie kolejna porcja węgli nie jest potrzebna."),
.init(state: "6c", value: 66, tone: "RED", delta: 4, direction: "FortyFiveUp", sentence: "Glukoza jest poniżej 70, ale powoli rośnie. Jeśli przestanie rosnąć, podaj węgle.", detail: "Trio prognozuje, że za 30 minut glukoza wyniesie około 84.", action: ("LOG_CARBS", nil, nil, "Zapisz węgle")),
.init(state: "6d", value: 64, tone: "RED", delta: -22, direction: "DoubleDown", second: dose(3), sentence: "Spadek był bardzo szybki. Warto sprawdzić odczyt glukometrem.", detail: "Jeśli nie da się zmierzyć, podaj węgle.", action: given(3, "OUTLINE")),
.init(state: "6ds", value: 64, tone: "RED", delta: -3, direction: "FortyFiveDown", second: dose(3), sentence: "Sensor działa od 5 godzin. Warto sprawdzić odczyt glukometrem.", detail: "Jeśli nie da się zmierzyć, podaj węgle.", action: given(3, "OUTLINE")),
.init(state: "6e", value: 66, tone: "RED", delta: -3, direction: "FortyFiveDown", second: dose(3), sentence: "Trio nie przysyła danych od 31 minut, więc nie wiadomo, czy baza jest wstrzymana.", action: given(3)),
.init(state: "6f", value: 64, tone: "RED", delta: -1, second: dose(3), sentence: "25 minut po 3 g węgli glukoza nadal jest poniżej 70.", action: given(3)),
.init(state: "6g", value: 66, tone: "RED", delta: -3, direction: "FortyFiveDown", sentence: "Podaj szybkie węgle.", detail: "Bez przeliczników insuliny Mellis nie proponuje ilości węgli.", action: ("LOG_CARBS", nil, nil, "Zapisz węgle")),
.init(state: "7", value: 48, tone: "ON_RED", delta: -6, direction: "SingleDown", second: dose(4, "Podaj od razu"), sentence: glucagon, action: given(4)),
.init(state: "7b", value: 48, tone: "ON_RED", delta: -6, direction: "SingleDown", sentence: "Podaj od razu szybkie węgle. \(glucagon)", detail: "Bez przeliczników insuliny Mellis nie proponuje ilości węgli.", action: ("LOG_CARBS", nil, nil, "Zapisz węgle")),
.init(state: "8", value: 68, tone: "RED", delta: -3, direction: "FortyFiveDown", second: check(15), sentence: "Podano 3 g węgli o 12:34.", checkMinutes: 15),
.init(state: "8u", value: 66, tone: "RED", delta: -1, second: ("GIVEN", "Podano", "3 g", "szybkich węgli", nil), sentence: "Węgle zostaną zapisane za 5 sekund.", undoSeconds: 300),
.init(state: "8ub", value: 66, tone: "RED", delta: -1, second: ("GIVEN", "Podano", "3 g", "szybkich węgli", nil), sentence: "Ewa podała węgle. Mellis zapisze je za 5 sekund.", undoSeconds: 300),
.init(state: "8b", value: 66, tone: "RED", delta: -1, second: check(11), sentence: "Ewa podała 3 g węgli o 12:34.", checkMinutes: 11),
.init(state: "8c", value: 66, tone: "RED", delta: -1, second: check(11), sentence: "W Trio zapisano 3 g węgli o 12:41.", checkMinutes: 11),
.init(state: "8w", value: 86, delta: -2, sentence: "Podano 3 g węgli o 12:34. Mellis da znać, jeśli glukoza spadnie poniżej 70."),
.init(state: "8d", value: 82, delta: 5, direction: "FortyFiveUp", sentence: " "),
.init(state: "8e", value: 66, tone: "RED", delta: 3, direction: "FortyFiveUp", second: check(10), sentence: "16 minut po 3 g węgli glukoza nadal jest poniżej 70.", checkMinutes: 10),
.init(state: "8e2", value: 64, tone: "RED", delta: -2, second: dose(3), sentence: "21 minut po 3 g węgli glukoza nadal jest poniżej 70.", action: given(3)),
.init(state: "8f", value: 72, delta: -4, direction: "FortyFiveDown", second: check(10), sentence: "Podano 3 g węgli o 12:34. \(promise)", checkMinutes: 10),
.init(state: "8g", value: 50, tone: "ON_RED", delta: -2, direction: "FortyFiveDown", second: check(10), sentence: glucagon, detail: "Podano 4 g węgli o 3:12.", action: ("LOG_CARBS", nil, nil, "Zapisz węgle"), checkMinutes: 10),
.init(state: "8i", value: 92, delta: 2, sentence: " "),
.init(state: "8j", value: 62, tone: "STALE", ageMinutes: 18, second: noReading, sentence: "Zmierz glukozę glukometrem.", detail: "Podano 3 g węgli o 3:12."),
.init(state: "8j70", value: 84, tone: "STALE", ageMinutes: 18, second: noReading, sentence: "Warto zmierzyć glukozę glukometrem.", detail: "Podano 3 g węgli o 3:12."),
.init(state: "9", value: 112, tone: "STALE", ageMinutes: 24, second: ("NO_READING", nil, "24 min", "bez odczytu", nil), sentence: "Warto sprawdzić sensor i telefon z Trio."),
.init(state: "9b", value: 62, tone: "STALE", ageMinutes: 18, second: noReading, sentence: "Zmierz glukozę glukometrem."),
.init(state: "9b70", value: 76, tone: "STALE", ageMinutes: 18, second: noReading, sentence: "Warto zmierzyć glukozę glukometrem."),
.init(state: "9c", value: 128, delta: 1, sentence: "Trio nie przysyła danych od 31 minut.", detail: "Warto sprawdzić telefon z Trio."),

.init(state: "3e", value: 246, tone: "AMBER", delta: 1, sentence: "Półtorej godziny po korekcie glukoza spadła tylko o 20.", detail: "Insulina może nie docierać. Warto sprawdzić wkłucie i zmierzyć ketony."),
.init(state: "3b4", value: 296, tone: "AMBER", delta: 1, sentence: "Od 4 godzin glukoza jest powyżej 250.", detail: ketones),
.init(state: "P", value: 164, delta: 2, sentence: "Pompa jest wstrzymana od 25 minut.", detail: "Jeśli wstrzymanie nie było celowe, warto włączyć pompę."),
.init(state: "P1", value: 164, delta: 2, sentence: "Pompa jest wstrzymana od godziny.", detail: "Bez insuliny od ponad godziny rośnie ryzyko ketonów."),
.init(state: "Ph", value: 262, tone: "AMBER", delta: 3, direction: "FortyFiveUp", sentence: "Pompa jest wstrzymana od 25 minut.", detail: "Warto włączyć pompę i zmierzyć ketony."),
.init(state: "2b", value: 224, tone: "AMBER", delta: 4, direction: "FortyFiveUp", sentence: "1,5 godziny po bolusie glukoza nadal rośnie.", detail: "Warto sprawdzić wkłucie albo czy węgli nie było więcej."),
.init(state: "2c", value: 138, delta: 5, direction: "FortyFiveUp", sentence: "W Trio zapisano 30 g węgli o 12:10, ale nie ma do nich bolusa.", detail: "Jeśli bolus podano penem, warto go zapisać w Trio."),
.init(state: "1f", value: 122, delta: -2, sentence: "W Trio nie ma węgli do bolusa z 12:10.", detail: "Jeśli ten bolus nie był do jedzenia, glukoza może spaść."),
.init(state: "3f", value: 214, tone: "AMBER", delta: 0, sentence: "Trio nie podaje bazy, bo przewiduje spadek."),
.init(state: "3i", value: 196, tone: "AMBER", delta: 0, sentence: " "),
.init(state: "1e", value: 172, delta: -4, direction: "FortyFiveDown", sentence: " "),
.init(state: "1o", value: 128, delta: 1, sentence: "W Trio działa nadpisanie: Sport, 80%."),
.init(state: "1s", value: 128, delta: 1, sentence: "Sensor działa od 3 godzin, więc odczyty mogą być mniej dokładne."),
.init(state: "1n", value: 134, delta: 1, sentence: "Zbiornik wystarczy na około 6 godzin. Warto wymienić go przed nocą."),
.init(state: "9d", value: 118, tone: "STALE", ageMinutes: 64, second: ("NO_READING", nil, "64 min", "bez odczytu", nil), sentence: "Bez odczytów Trio nie ma z czego liczyć.", detail: "Warto zmierzyć glukozę glukometrem."),
.init(state: "9n", value: 118, tone: "STALE", ageMinutes: 24, second: ("NO_READING", nil, "24 min", "bez odczytu", nil), sentence: "Sensor założono 20 minut temu, więc odczytów jeszcze nie ma.", detail: "Na razie warto mierzyć glukozę glukometrem."),
        ]
        let lunch = "66666666-6666-4666-8666-666666666661"
        // v5 (now-situation.v5): the planned meal and the bar's button. The fixture plan's lunch is 20 minutes away.
        let v5: [SituationFixture] = [
            .init(state: "m1", value: 128, delta: 1, sentence: "Obiad jest o 13:00.", detail: "Zupa ogórkowa i kotlet z kurczaka.", link: ("MEAL_PLAN_ENTRY", lunch, "Obiad"), sendsLink: true),
            .init(state: "m2", value: 164, delta: 4, direction: "FortyFiveUp", sentence: "Do posiłku z 12:10 nie ma wpisu węgli.", link: ("MEAL_PLAN_ENTRY", lunch, "Obiad"), sendsLink: true),
            .init(state: "m3", value: 284, tone: "AMBER", delta: 1, sentence: "Od 2 godzin glukoza jest powyżej 250.", detail: ketones, link: ("CONVERSATION", nil, "Rozmowa o tym"), sendsLink: true),
            .init(state: "m4", value: 128, delta: 1, sentence: " ", sendsLink: true),
        ]
        return Dictionary(uniqueKeysWithValues: (all + v5).map { ($0.state, $0) })
    }()

    /// After "Podano" in the fixtures: the undo window, then the check. `base` keeps the glucose of the state it was tapped in.
    static func afterGiven(grams: Int, secondsAgo: Double, base: SituationFixture) -> SituationFixture {
        var given = base
        given.action = nil
        given.detail = nil
        // GLUCOMIND_UI_FIXTURES_UNDO_SECONDS: a longer window, to reach "Cofnij" by hand in the simulator.
        let window = ProcessInfo.processInfo.environment["GLUCOMIND_UI_FIXTURES_UNDO_SECONDS"].flatMap(Double.init) ?? 5
        if secondsAgo < window {
            given.state = "8u"
            given.second = ("GIVEN", "Podano", "\(grams) g", "szybkich węgli", nil)
            given.sentence = "Węgle zostaną zapisane za 5 sekund."
            given.undoSeconds = window - secondsAgo
        } else {
            given.state = "8"
            given.tone = base.tone == "ON_RED" ? "RED" : base.tone
            given.second = check(15)
            given.sentence = "Podano \(grams) g węgli o 12:34."
            given.detail = base.value < 70 ? nil : promise
            given.checkMinutes = 15
        }
        return given
    }

    func glucoseJSON(iso: (Double) -> String) -> String {
        #"{"value":\#(value),"unit":"mg/dL","direction":"\#(direction)","observed_at":"\#(iso(-ageMinutes * 60))","delta":\#(delta)}"#
    }

    func responseField(iso: (Double) -> String) -> String {
        func quoted(_ text: String?) -> String { text.map { "\"\($0)\"" } ?? "null" }
        let secondJSON = second.map { #"{"kind":"\#($0.kind)","label":\#(quoted($0.label)),"value":"\#($0.value)","unit":\#(quoted($0.unit)),"note":\#(quoted($0.note))}"# } ?? "null"
        let undoJSON = undoSeconds.map { #"{"kind":"UNDO","grams":null,"style":null,"label":"Cofnij","other_amount_label":null,"event_id":"fixture-given","until":"\#(iso($0))"}"# }
        let actionJSON = undoJSON ?? action.map { action -> String in
            let grams = action.grams.map(String.init) ?? "null"
            let other = action.kind == "GIVEN" ? #""Inna ilość""# : "null"
            return #"{"kind":"\#(action.kind)","grams":\#(grams),"style":\#(quoted(action.style)),"label":"\#(action.label)","other_amount_label":\#(other)}"#
        } ?? "null"
        let checkJSON = checkMinutes.map { #"{"carbs_at":"\#(iso(-60))","carbs_g":5,"due_at":"\#(iso($0 * 60))"}"# } ?? "null"
        let linkJSON = !sendsLink ? "" : #","link":\#(link.map { #"{"kind":"\#($0.kind)","entry_id":\#(quoted($0.entryID)),"label":"\#($0.label)"}"# } ?? "null")"#
        let dayLinesJSON = ProcessInfo.processInfo.environment["GLUCOMIND_UI_FIXTURES_DAY_LINE"].flatMap { $0.isEmpty ? nil : $0 }.map { #","day_lines":["\#($0)"]"# } ?? ""
        return #","situation":{"policy_version":"now-situation.v6","state":"\#(state)","evaluated_at":"\#(iso(0))","glucose":{"value":\#(value),"at":"\#(iso(-ageMinutes * 60))","age_minutes":\#(Int(ageMinutes)),"tone":"\#(tone)"},"second":\#(secondJSON),"sentence":\#(quoted(sentence)),"detail":\#(quoted(detail)),"action":\#(actionJSON),"check":\#(checkJSON)\#(dayLinesJSON),"dose_policy_version":null\#(linkJSON)}"#
    }
}
