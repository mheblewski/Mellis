import Foundation

/// GLUCOMIND_UI_FIXTURES_PATTERNS=1: "Wzorce" without a server (one family's history from 11 Nov, fictional dates).
final class UIPreviewPatternsFixture: @unchecked Sendable {
    static var isOn: Bool { ProcessInfo.processInfo.environment["GLUCOMIND_UI_FIXTURES_PATTERNS"] == "1" }

    private let lock = NSLock()
    private var dismissedPatterns: Set<String> = []
    /// Cards opened in this run: no longer "Nowy" (the server keeps it per caregiver).
    private var openedPatterns: Set<String> = []

    func capabilities(patientID: String) -> String {
        #"{"patient_id":"\#(patientID)","loop_system":{"kind":"TRIO","version":"0.5.1"},"remote_commands":{"enabled":false,"reason":"PATIENT_DISABLED"},"therapy_patterns":{"available":true},"prediction_line":{"available":true},"prediction_experiment":{"available":true,"enabled":true,"can_change":false}}"#
    }

    func route(path: String, method: String, body: Data?, patientID: String) -> (Int, String)? {
        // "Wzorce" (therapy-patterns.v1): the patterns one family's history shows on 11 Nov.
        if method == "GET", path.hasSuffix("/patterns") {
            let dismissed = lock.withLock { dismissedPatterns }
            let lowsAfter = #"{"key":"TIME_BELOW_GOAL","id":"TIME_BELOW_GOAL","title":"Czas poniżej 70 ponad cel","summary":"Glukoza była poniżej 70 przez 5,2% czasu (cel: poniżej 4%), poniżej 54 przez 1,1% (cel: poniżej 1%).","sentence":"Glukoza była poniżej 70 przez 5,2% czasu (cel: poniżej 4%), poniżej 54 przez 1,1% (cel: poniżej 1%).","lines":[],"details":["Dni ze spadkiem poniżej 70: 10 z 14 dni.","Najwięcej tego czasu między 18 a 21: 41%."],"question":"Czy przed spadkami był ruch albo zjedzone było mniej, niż zapisano?","visit":"spadki, najwięcej między 18 a 21: baza, ISF i przelicznik. Zmiany dawek omów z poradnią.","can_dismiss":false,"episode_count":10,"episodes":[{"date":"2026-11-11","time":"21:05","note":"najniżej 58 · 25 min poniżej 70"},{"date":"2026-11-10","time":"15:20","note":"najniżej 49 · 40 min poniżej 70"},{"date":"2026-11-08","time":"20:50","note":"najniżej 63 · 20 min poniżej 70"},{"date":"2026-11-06","time":"10:40","note":"najniżej 52 · 35 min poniżej 70"},{"date":"2026-11-04","time":"14:55","note":"najniżej 61 · 15 min poniżej 70"}],"first_seen":"2026-11-12","first_episode":"2026-10-30","last_seen":"2026-11-12","is_new":true,"dismissed_until":null}"#
            let meal = #"{"key":"MEAL_RISES_SAME_TIME.1800-2400","id":"MEAL_RISES_SAME_TIME","title":"Wzrosty po posiłkach wieczorem (18–24)","summary":"Po 6 z 16 posiłków wieczorem glukoza mocno wzrosła (o innych porach 11%). W tych godzinach były też spadki.","sentence":"Po 6 z 16 posiłków wieczorem glukoza mocno wzrosła (o innych porach 11%). W tych godzinach były też spadki.","lines":[],"details":["Mocno: o co najmniej 60, do ponad 250 albo ponad 180 dłużej niż 2 godziny. Liczone są posiłki zaczęte poniżej 180.","Spadki poniżej 70 w tych godzinach: 6 z 14 dni.","Te dni obejmują zmianę przelicznika z 6.11."],"question":"Co zwykle jest na talerzu o tej porze: szybkie węgle, dużo tłuszczu?","visit":"wzrosty i spadki wieczorem razem: przelicznik i ISF.","can_dismiss":true,"episode_count":6,"episodes":[{"date":"2026-11-10","time":"18:40","note":"22 g · bolus razem z jedzeniem · start 142 · najwyżej 298"},{"date":"2026-11-07","time":"19:05","note":"18 g · bolus 5 min przed · start 120 · najwyżej 255"},{"date":"2026-11-05","time":"20:10","note":"25 g · bolus 2 min po · start 160 · ponad 180 przez 2 h 20 min"},{"date":"2026-11-03","time":"18:35","note":"20 g · bolus razem z jedzeniem · start 131 · najwyżej 291"}],"first_seen":"2026-11-09","first_episode":"2026-10-31","last_seen":"2026-11-12","is_new":false,"dismissed_until":DISMISSED,"dismissed_label":LABEL}"#
            let dayLowsNow = #"{"key":"DAY_LOWS_WITHOUT_FOOD.9","id":"DAY_LOWS_WITHOUT_FOOD","title":"Spadki między 9 a 12 bez jedzenia","summary":"W 4 z 14 dni między 9:00 a 12:00 glukoza spadła poniżej 70, choć przez 3 godziny wcześniej nie było jedzenia ani bolusa.","sentence":"W 4 z 14 dni między 9:00 a 12:00 glukoza spadła poniżej 70, choć przez 3 godziny wcześniej nie było jedzenia ani bolusa.","lines":[],"details":[],"question":"Czy przed spadkiem był ruch: WF, spacer, zabawa?","visit":"baza i ISF tych godzin.","can_dismiss":false,"episode_count":4,"episodes":[{"date":"2026-11-12","time":"11:12","note":"najniżej 53 · 20 min poniżej 70","chart":{"trace":[[0,118],[5,119],[10,121],[15,122],[20,123],[25,124],[30,125],[35,125],[40,125],[45,125],[50,125],[55,124],[60,124],[65,123],[70,123],[75,123],[80,124],[85,125],[90,128],[95,131],[100,136],[105,141],[110,148],[115,155],[120,162],[125,170],[130,177],[135,184],[140,189],[145,193],[150,196],[155,196],[160,195],[165,192],[170,188],[175,182],[180,175],[185,168],[190,161],[195,154],[200,148],[205,143],[210,138],[215,134],[220,132],[225,130],[230,128],[235,127],[240,125],[245,124],[250,122],[255,119],[260,115],[265,110],[270,103],[275,96],[280,87],[285,79],[290,70],[295,62],[300,56],[305,51],[310,49],[315,50],[320,53],[325,59],[330,66],[335,74],[340,83],[345,92],[350,99],[355,106],[360,111],[365,115],[370,118],[375,119],[380,120],[385,120],[390,119],[395,118],[400,118],[405,117],[410,117],[415,117],[420,117]],"meal_minute":91,"meal_time":"7:31","nadir":53,"nadir_time":"11:12","low_minutes":20,"boluses":[[91,3]],"carbs":[[91,15]]}},{"date":"2026-11-09","time":"11:22","note":"najniżej 54 · 25 min poniżej 70","chart":{"trace":[[0,123],[5,124],[10,125],[15,125],[20,125],[25,125],[30,124],[35,123],[40,122],[45,121],[50,120],[55,119],[60,119],[65,118],[70,119],[75,120],[80,121],[85,123],[90,126],[95,130],[100,134],[105,139],[110,145],[115,151],[120,157],[125,163],[130,170],[135,176],[140,181],[145,185],[150,188],[155,190],[160,191],[165,190],[170,188],[175,185],[180,181],[185,176],[190,170],[195,165],[200,159],[205,154],[210,150],[215,145],[220,142],[225,138],[230,135],[235,132],[240,129],[245,127],[250,124],[255,121],[260,117],[265,113],[270,109],[275,104],[280,98],[285,91],[290,84],[295,77],[300,70],[305,64],[310,60],[315,57],[320,56],[325,57],[330,60],[335,65],[340,71],[345,78],[350,85],[355,92],[360,98],[365,103],[370,106],[375,109],[380,112],[385,113],[390,114],[395,115],[400,116],[405,117],[410,119],[415,120],[420,121]],"meal_minute":98,"meal_time":"7:38","nadir":54,"nadir_time":"11:22","low_minutes":25,"boluses":[[98,3.5]],"carbs":[[98,18]]}},{"date":"2026-11-07","time":"11:47","note":"najniżej 65 · 20 min poniżej 70","chart":{"trace":[[0,129],[5,128],[10,127],[15,126],[20,126],[25,126],[30,126],[35,127],[40,128],[45,129],[50,130],[55,131],[60,132],[65,133],[70,134],[75,134],[80,134],[85,134],[90,134],[95,134],[100,133],[105,133],[110,134],[115,135],[120,137],[125,140],[130,144],[135,148],[140,154],[145,161],[150,168],[155,176],[160,183],[165,190],[170,196],[175,201],[180,204],[185,206],[190,205],[195,203],[200,199],[205,194],[210,187],[215,180],[220,173],[225,165],[230,159],[235,152],[240,147],[245,143],[250,140],[255,138],[260,136],[265,135],[270,134],[275,133],[280,132],[285,130],[290,128],[295,124],[300,120],[305,114],[310,106],[315,98],[320,90],[325,82],[330,74],[335,68],[340,63],[345,61],[350,62],[355,65],[360,70],[365,77],[370,85],[375,93],[380,102],[385,109],[390,116],[395,121],[400,125],[405,127],[410,129],[415,129],[420,129]],"meal_minute":122,"meal_time":"8:02","nadir":65,"nadir_time":"11:47","low_minutes":20,"boluses":[[122,2.4]],"carbs":[[122,12]]}},{"date":"2026-11-04","time":"11:37","note":"najniżej 48 · 20 min poniżej 70","chart":{"trace":[[0,126],[5,126],[10,126],[15,127],[20,128],[25,129],[30,130],[35,131],[40,132],[45,133],[50,134],[55,134],[60,134],[65,134],[70,134],[75,133],[80,133],[85,132],[90,132],[95,133],[100,134],[105,136],[110,140],[115,144],[120,149],[125,155],[130,162],[135,169],[140,177],[145,184],[150,191],[155,197],[160,202],[165,204],[170,206],[175,205],[180,202],[185,198],[190,193],[195,186],[200,179],[205,172],[210,165],[215,158],[220,153],[225,148],[230,144],[235,141],[240,139],[245,137],[250,136],[255,135],[260,134],[265,133],[270,131],[275,129],[280,125],[285,120],[290,114],[295,106],[300,97],[305,88],[310,78],[315,68],[320,59],[325,52],[330,47],[335,45],[340,46],[345,50],[350,57],[355,66],[360,75],[365,85],[370,95],[375,104],[380,111],[385,117],[390,121],[395,124],[400,126],[405,126],[410,126],[415,126],[420,126]],"meal_minute":107,"meal_time":"7:47","nadir":48,"nadir_time":"11:37","low_minutes":20,"boluses":[[107,4]],"carbs":[[107,20]]}}],"first_seen":"2026-11-13","first_episode":"2026-11-04","last_seen":"2026-11-13","is_new":true,"dismissed_until":null,"chart":{"from_minute":360,"to_minute":780,"band_from_minute":540,"band_to_minute":720,"comparison":"W pozostałych 10 dniach między 9 a 12 glukoza spadła poniżej 70 raz (3.11), ale wtedy wcześniej było jedzenie albo bolus. Posiłek z bolusem przed 9:00 był we wszystkich 14 dniach."}}"#
            let dayLows = #"{"key":"DAY_LOWS_WITHOUT_FOOD.6","id":"DAY_LOWS_WITHOUT_FOOD","title":"Spadki między 6 a 9 bez jedzenia","summary":"W 4 z 14 dni między 6:00 a 9:00 glukoza spadła poniżej 70, choć przez 3 godziny wcześniej nie było jedzenia ani bolusa.","sentence":"W 4 z 14 dni między 6:00 a 9:00 glukoza spadła poniżej 70, choć przez 3 godziny wcześniej nie było jedzenia ani bolusa.","lines":[],"details":[],"question":null,"visit":"baza i ISF tych godzin.","can_dismiss":false,"episode_count":4,"episodes":[],"first_seen":"2026-10-24","first_episode":"2026-10-22","last_seen":"2026-11-03","is_new":false,"dismissed_until":null}"#
            let hide = dismissed.contains("MEAL_RISES_SAME_TIME.1800-2400")
            let mealJSON = meal.replacingOccurrences(of: "DISMISSED", with: hide ? #""2026-12-12T12:00:00.000Z""# : "null").replacingOccurrences(of: "LABEL", with: hide ? #""Ukryte przez: Ewa, 12.11""# : "null")
            let opened = lock.withLock { openedPatterns }
            // is_new as the server sends it: new until this caregiver opens the card.
            func card(_ json: String, new: Bool) -> String {
                let key = json.components(separatedBy: #""key":""#).dropFirst().first?.components(separatedBy: "\"").first ?? ""
                let flag = new && !opened.contains(key)
                return json.replacingOccurrences(of: #""is_new":true"#, with: #""is_new":\#(flag)"#).replacingOccurrences(of: #""is_new":false"#, with: #""is_new":\#(flag)"#)
            }
            let mealPlain = meal.replacingOccurrences(of: "DISMISSED", with: "null").replacingOccurrences(of: "LABEL", with: "null")
            let morningMeal = mealPlain.replacingOccurrences(of: "MEAL_RISES_SAME_TIME.1800-2400", with: "MEAL_RISES_SAME_TIME.0600-1100").replacingOccurrences(of: "wieczorem (18–24)", with: "rano (6–11)")
            let nightLows = lowsAfter.replacingOccurrences(of: "TIME_BELOW_GOAL", with: "NIGHT_LOWS").replacingOccurrences(of: "Czas poniżej 70 ponad cel", with: "Spadki poniżej 54 w nocy")
            // GLUCOMIND_UI_FIXTURES_PATTERNS_ROW: one state of the Teraz row (screenshots of every state); unset = the family's 11 Nov.
            let rowState = ProcessInfo.processInfo.environment["GLUCOMIND_UI_FIXTURES_PATTERNS_ROW"]
            var activeCards: [String]
            var changeShown = true
            switch rowState {
            case "new": activeCards = [card(mealPlain, new: true)]; changeShown = false
            case "new_change": activeCards = [card(mealPlain, new: true)]
            case "two_new": activeCards = [card(mealPlain, new: true), card(morningMeal, new: true)]; changeShown = false
            case "new_lows": activeCards = [card(dayLowsNow, new: true)]; changeShown = false
            case "new_fact": activeCards = [card(lowsAfter, new: true)]; changeShown = false
            case "seen": activeCards = [card(mealPlain, new: false)]; changeShown = false
            case "seen_change": activeCards = [card(mealPlain, new: false)]
            case "seen_lows": activeCards = [card(dayLowsNow, new: false), card(mealPlain, new: false)]; changeShown = false
            case "night54": activeCards = [card(nightLows, new: false)]; changeShown = false
            case "change", "change_ready": activeCards = []
            case "none": activeCards = []; changeShown = false
            default: activeCards = hide ? [card(dayLowsNow, new: true)] : [card(dayLowsNow, new: true), card(mealJSON, new: false)]
            }
            let active = activeCards.joined(separator: ",")
            let hidden = hide && rowState == nil ? mealJSON : ""
            let goneCards = rowState == nil ? dayLows : ""
            // GLUCOMIND_UI_FIXTURES_CHANGE_READY=1: the change after its 14 days (two sections, no verdict); else day 5, one line.
            let ready = ProcessInfo.processInfo.environment["GLUCOMIND_UI_FIXTURES_CHANGE_READY"] == "1" || rowState == "change_ready"
            let change = ready
                ? #"{"key":"CHANGE_CHECK.2026-11-06","title":"Zmiana z 6.11","ready":true,"line":null,"changes":[],"hours":"18:00–3:00, 9:30–18:00","day":14,"of":14,"before_days":14,"after_days":14,"rows":[],"sections":[{"title":"Przelicznik 18:00–24:00: 7,1 → 6,8","subtitle":"liczone w godzinach 18:00–3:00","before_days":14,"after_days":14,"before_label":"Przed 23.10–5.11","after_label":"Po 7.11–20.11","rows":[{"label":"Dni poniżej 54","before":"3 z 14","after":"2 z 14"},{"label":"Czas poniżej 70","before":"4,8%","after":"5,6%"}]},{"title":"Przelicznik 9:30–18:00: 7,7 → 8,3","subtitle":"liczone w godzinach 9:30–18:00","before_days":14,"after_days":14,"before_label":"Przed 23.10–5.11","after_label":"Po 7.11–20.11","rows":[{"label":"Dni poniżej 54","before":"4 z 14","after":"2 z 14"},{"label":"Czas poniżej 70","before":"4,1%","after":"3,0%"}]}],"context":[],"before_note":null,"note":"Bez oceny: w tych samych tygodniach zmienił się też sposób podawania bolusa (1,3 → 2,0 na posiłek), a tych zmian nie da się rozdzielić.","question":"Co jeszcze zmieniło się w tych tygodniach: posiłki, sposób podawania bolusa, ruch, choroba?"}"#
                : #"{"key":"CHANGE_CHECK.2026-11-06","title":"Zmiana z 6.11","ready":false,"line":"Przelicznik 9:30–18: 7,7 → 8,3 (mniej insuliny)\nPrzelicznik 18–24: 7,1 → 6,8 (więcej insuliny)\ndzień 5 z 14 · porównanie od 21.11","changes":[],"hours":null,"day":5,"of":14,"before_days":null,"after_days":null,"rows":[],"sections":[],"context":[],"before_note":null,"note":null,"question":null}"#
            return (200, #"{"patient_id":"\#(patientID)","version":"therapy-patterns.v1","computed_at":"2026-11-12T03:05:00.000Z","window":{"from":"2026-10-29","to":"2026-11-11"},"change_check":\#(changeShown ? change : "null"),"patterns":[\#(active)],"gone":[\#(goneCards)],"dismissed":[\#(hidden)]}"#)
        }
        // "Raport dla poradni": GLUCOMIND_UI_FIXTURES_REPORT_HTML=<path on this Mac> shows a real report kept outside the
        // repository (health data); without it, four empty pages.
        if method == "GET", path.hasSuffix("/patterns/report") {
            let html = ProcessInfo.processInfo.environment["GLUCOMIND_UI_FIXTURES_REPORT_HTML"].flatMap { try? String(contentsOfFile: $0, encoding: .utf8) }
                ?? "<!doctype html><html><head><meta name=\"viewport\" content=\"width=794\"><style>.page{width:210mm;height:297mm;padding:20mm;font-family:-apple-system}</style></head><body>" + (1...4).map { "<section class=\"page\"><h1>Strona \($0) z 4</h1></section>" }.joined() + "</body></html>"
            return (200, serialize(["patient_id": patientID, "version": "clinic-report.v1", "html": html]))
        }
        if method == "POST", path.contains("/patterns/"), path.hasSuffix("/opened") {
            let key = String(path.split(separator: "/").dropLast().last ?? "")
            lock.withLock { _ = openedPatterns.insert(key) }
            return (200, #"{"patient_id":"\#(patientID)","key":"\#(key)","opened_at":"2026-11-12T08:00:00.000Z"}"#)
        }
        if method == "POST", path.contains("/patterns/"), path.hasSuffix("/dismiss") {
            let key = String(path.split(separator: "/").dropLast().last ?? "")
            let wanted = body.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }?["dismissed"] as? Bool ?? true
            lock.withLock { if wanted { dismissedPatterns.insert(key) } else { dismissedPatterns.remove(key) } }
            return (200, #"{"patient_id":"\#(patientID)","key":"\#(key)","dismissed_until":null}"#)
        }
        return nil
    }

    private func serialize(_ object: Any) -> String {
        (try? JSONSerialization.data(withJSONObject: object)).map { String(decoding: $0, as: UTF8.self) } ?? "{}"
    }
}
