import Combine
import Foundation
import SwiftUI

/// The prediction experiment for this caregiver and patient (Ustawienia → Funkcje eksperymentalne).
public struct PredictionExperimentAccess: Codable, Equatable, Sendable {
    /// The server offers it (its kill switch is not off).
    public let available: Bool
    /// An owner turned it on for the patient.
    public let enabled: Bool
    /// This caregiver may turn it on or off (owners).
    public let can_change: Bool
    /// The two ways of warning about a low, side by side (low-comparison.v1); nil until the server has worked one out.
    public var low_comparison: LowWarningComparison? = nil

    public init(available: Bool, enabled: Bool, can_change: Bool, low_comparison: LowWarningComparison? = nil) {
        self.available = available
        self.enabled = enabled
        self.can_change = can_change
        self.low_comparison = low_comparison
    }

    public static let unavailable = PredictionExperimentAccess(available: false, enabled: false, can_change: false)

    public var isOn: Bool { available && enabled }
}

/// The forecast line on the charts (the loop's curve, its cloud and the plan markers): served to every reader unless the
/// server turned it off. Not part of the experiment.
public struct PredictionLineAccess: Codable, Equatable, Sendable {
    public let available: Bool

    public init(available: Bool) {
        self.available = available
    }
}

/// Ustawienia → "Linia prognozy": this phone's own switch, on until someone turns it off.
public enum PredictionLinePreference {
    public static let key = "predictionLineShown"
    public static let defaultShown = true
}

/// The low-risk model's warnings against the rescue rules' on the same readings (server: low-risk-comparison.ts).
public struct LowWarningComparison: Codable, Equatable, Sendable {
    public struct Side: Codable, Equatable, Sendable {
        public let lows_warned: Int
        public let alerts_per_day: Double
        public let alerts_without_low_per_day: Double

        public init(lows_warned: Int, alerts_per_day: Double, alerts_without_low_per_day: Double) {
            self.lows_warned = lows_warned
            self.alerts_per_day = alerts_per_day
            self.alerts_without_low_per_day = alerts_without_low_per_day
        }
    }

    public let days: Double
    public let lows: Int
    public let model: Side
    public let rules: Side
    /// "MODEL" or "RULES": which of the two sends the alerts now.
    public let live_source: String
    public let ready: Bool

    public init(days: Double, lows: Int, model: Side, rules: Side, live_source: String, ready: Bool) {
        self.days = days
        self.lows = lows
        self.model = model
        self.rules = rules
        self.live_source = live_source
        self.ready = ready
    }
}

/// The comparison's words under the experiment's switch. The owner asked for the result to be passed on to him.
public enum LowWarningComparisonText {
    public static let title = "Ostrzeganie przed spadkiem: porównanie"
    public static let passOn = "Przekaż ten wynik Mateuszowi."
    public static let copy = "Skopiuj wynik"
    public static let copied = "Skopiowano"

    private static func number(_ value: Double) -> String {
        String(format: "%.1f", value).replacingOccurrences(of: ".", with: ",")
    }

    private static func counts(_ comparison: LowWarningComparison) -> String {
        "Dni z danymi: \(Int(comparison.days.rounded(.down))). Spadki poniżej 70: \(comparison.lows)."
    }

    /// Before there is enough data: what is being done and how far it is.
    public static func collecting(_ comparison: LowWarningComparison) -> [String] {
        [
            "Mellis porównuje dwa sposoby ostrzegania przed spadkiem glukozy poniżej 70: dotychczasowe reguły i nowy model.",
            counts(comparison),
            "Wynik pojawi się tutaj, gdy danych będzie dość. Zwykle trwa to od 2 do 4 tygodni.",
        ]
    }

    public static func result(_ comparison: LowWarningComparison) -> [String] {
        [
            counts(comparison),
            "Nowy model ostrzegł przed \(comparison.model.lows_warned) z nich, dotychczasowe reguły przed \(comparison.rules.lows_warned).",
            "Alerty dziennie: nowy model \(number(comparison.model.alerts_per_day)), dotychczasowe reguły \(number(comparison.rules.alerts_per_day)).",
            "Alerty, po których przez godzinę nie było spadku: nowy model \(number(comparison.model.alerts_without_low_per_day)) dziennie, dotychczasowe reguły \(number(comparison.rules.alerts_without_low_per_day)) dziennie.",
            comparison.live_source == "MODEL" ? "Alerty wysyła teraz nowy model." : "Alerty wysyłają teraz dotychczasowe reguły.",
            "Liczby są przybliżone: gdy po alercie ktoś poda węglowodany, spadku może nie być.",
        ]
    }

    /// What "Skopiuj wynik" puts on the clipboard.
    public static func share(_ comparison: LowWarningComparison) -> String {
        ([title] + result(comparison)).joined(separator: "\n")
    }
}

/// GET /v1/patients/{id}/prediction: only what the chart draws.
public struct PredictionResponse: Decodable, Equatable, Sendable {
    public struct Point: Decodable, Equatable, Sendable {
        public let at: String
        public let value: Int
        public let low: Int
        public let high: Int
    }

    public struct Line: Decodable, Equatable, Sendable {
        public let points: [Point]
        public let hidden_reason: String?
    }

    public struct Reading: Decodable, Equatable, Sendable {
        public let at: String
        public let value: Double
    }

    public struct Loop: Decodable, Equatable, Sendable {
        public let glucose: Reading?
    }

    public struct PlanEvent: Decodable, Equatable, Sendable {
        public let kind: String
        public let at: String
        public let title: String?
        public let state: String
    }

    public struct LateRise: Decodable, Equatable, Sendable {
        public let from: String
        public let to: String
        public let insulin_planned: Bool
        public let insulin_given: Bool
    }

    public struct Prediction: Decodable, Equatable, Sendable {
        public let loop: Loop
        public let line: Line?
        /// Absent from servers before the plan.
        public var plan: [PlanEvent]? = nil
        public var late_rise: [LateRise]? = nil
    }

    public let patient_id: String
    public let prediction: Prediction
}

/// The line as the chart draws it: from the newest reading on, or why it is hidden.
public struct ChartPredictionLine: Equatable, Sendable {
    public struct Point: Equatable, Sendable {
        public let t: TimeInterval
        public let value: Double
        public let low: Double
        public let high: Double

        public init(t: TimeInterval, value: Double, low: Double, high: Double) {
            self.t = t
            self.value = value
            self.low = low
            self.high = high
        }
    }

    /// Something planned on the chart. Facts, not a forecast: the line does not include them.
    public struct Marker: Equatable, Sendable, Identifiable {
        public let t: TimeInterval
        public let kind: String
        public let label: String
        /// Done early or skipped: drawn faint.
        public let settled: Bool

        public var id: String { "\(kind):\(t)" }

        public init(t: TimeInterval, kind: String, label: String, settled: Bool) {
            self.t = t
            self.kind = kind
            self.label = label
            self.settled = settled
        }

        public var isFood: Bool { kind == "PLANNED_MEAL" || kind == "LATER_CARBS" }
    }

    /// A time window after a meal when fat and protein may raise glucose. No number: how much is not known.
    public struct Zone: Equatable, Sendable {
        public let from: TimeInterval
        public let to: TimeInterval

        public init(from: TimeInterval, to: TimeInterval) {
            self.from = from
            self.to = to
        }
    }

    public let originT: TimeInterval
    public let originValue: Double
    public let points: [Point]
    /// A short reason when the line is hidden.
    public let hiddenText: String?
    public let markers: [Marker]
    public let zones: [Zone]

    public init(originT: TimeInterval, originValue: Double, points: [Point], hiddenText: String?, markers: [Marker] = [], zones: [Zone] = []) {
        self.originT = originT
        self.originValue = originValue
        self.points = points
        self.hiddenText = hiddenText
        self.markers = markers
        self.zones = zones
    }

    public init?(_ response: PredictionResponse) {
        let markers = (response.prediction.plan ?? []).compactMap { event -> Marker? in
            guard let date = ServerDate.parse(event.at) else { return nil }
            return Marker(t: date.timeIntervalSince1970, kind: event.kind, label: PredictionExperimentText.marker(kind: event.kind, title: event.title, state: event.state), settled: event.state != "PLANNED")
        }
        let zones = (response.prediction.late_rise ?? []).compactMap { rise -> Zone? in
            guard let from = ServerDate.parse(rise.from), let to = ServerDate.parse(rise.to) else { return nil }
            return Zone(from: from.timeIntervalSince1970, to: to.timeIntervalSince1970)
        }
        let line = response.prediction.line
        if let reason = line?.hidden_reason {
            self.init(originT: 0, originValue: 0, points: [], hiddenText: PredictionExperimentText.hidden(reason), markers: markers, zones: zones)
            return
        }
        let points = (line?.points ?? []).compactMap { point -> Point? in
            guard let date = ServerDate.parse(point.at) else { return nil }
            return Point(t: date.timeIntervalSince1970, value: Double(point.value), low: Double(point.low), high: Double(point.high))
        }
        if let glucose = response.prediction.loop.glucose, let origin = ServerDate.parse(glucose.at), !points.isEmpty {
            self.init(originT: origin.timeIntervalSince1970, originValue: glucose.value, points: points, hiddenText: nil, markers: markers, zones: zones)
            return
        }
        // No line to draw, and nothing else either: nothing is shown.
        guard !markers.isEmpty || !zones.isEmpty else { return nil }
        self.init(originT: 0, originValue: 0, points: [], hiddenText: nil, markers: markers, zones: zones)
    }

    /// The newest reading the line starts from is too old to draw it from.
    public func isStale(now: TimeInterval) -> Bool {
        hiddenText == nil && !points.isEmpty && now - originT > 20 * 60
    }

    /// The plan stays when the line has gone old.
    public func withoutLine() -> ChartPredictionLine {
        ChartPredictionLine(originT: 0, originValue: 0, points: [], hiddenText: nil, markers: markers, zones: zones)
    }

    /// This line at `progress` of the way from an older one (0 the old one, 1 this one), point for point at the same
    /// share of each line's length, also when the two have a different number of points.
    public func morphed(from old: ChartPredictionLine, progress: Double) -> ChartPredictionLine {
        guard !points.isEmpty, !old.points.isEmpty, progress < 1 else { return self }
        let share = max(progress, 0)
        let mix = { (from: Double, to: Double) in from + (to - from) * share }
        let moved = points.indices.map { index -> Point in
            let place = points.count > 1 ? Double(index) / Double(points.count - 1) * Double(old.points.count - 1) : 0
            let below = Int(place)
            let above = min(below + 1, old.points.count - 1)
            let between = place - Double(below)
            let at = { (key: KeyPath<Point, Double>) in old.points[below][keyPath: key] + (old.points[above][keyPath: key] - old.points[below][keyPath: key]) * between }
            return Point(t: mix(at(\.t), points[index].t), value: mix(at(\.value), points[index].value), low: mix(at(\.low), points[index].low), high: mix(at(\.high), points[index].high))
        }
        return ChartPredictionLine(originT: mix(old.originT, originT), originValue: mix(old.originValue, originValue), points: moved, hiddenText: hiddenText, markers: markers, zones: zones)
    }
}

public protocol PredictionLineAPI: Sendable {
    func getPrediction(patientID: String) async throws -> PredictionResponse
}

/// The line on Teraz: read while the experiment is on and the screen is open. A failed read draws no line.
@MainActor
public final class PredictionLineModel: ObservableObject {
    @Published public private(set) var line: ChartPredictionLine?
    /// The last read that got an answer, so a patient's page beside the one on screen does not read too often.
    public private(set) var loadedAt: Date?
    private let api: PredictionLineAPI
    private let patientID: String

    public init(api: PredictionLineAPI, patientID: String) {
        self.api = api
        self.patientID = patientID
    }

    public func load() async {
        do {
            let response = try await api.getPrediction(patientID: patientID)
            guard !Task.isCancelled else { return }
            line = ChartPredictionLine(response)
            loadedAt = .now
        } catch is CancellationError {
            return
        } catch {
            if !Task.isCancelled { line = nil }
        }
    }

    public func clear() {
        line = nil
        loadedAt = nil
    }
}

public struct PredictionExperimentResponse: Decodable, Equatable, Sendable {
    public let patient_id: String
    public let enabled: Bool
}

public enum PredictionExperimentText {
    public static let settingsSection = "Funkcje eksperymentalne"
    public static let featureName = "Prognoza glukozy"
    public static let detail = "Nowy model ostrzegania przed spadkiem liczy się w tle obok obecnych reguł. Po 2–4 tygodniach pokaże tu, jak oba wypadają na danych pacjenta."
    public static let footer = "Prognoza nie wpływa na dawki ani na to, kiedy przychodzą alerty. Można ją wyłączyć w każdej chwili."
    public static let lineLabel = "prognoza"
    public static let nowLabel = "teraz"
    public static let legend = "Szara linia po prawej to prognoza pętli, ta sama co na ekranie Bolus przed nową dawką. Chmura wokół niej pokazuje typowy błąd prognozy i z czasem się poszerza. Pętla uwzględnia insulinę i węgle, ale po około godzinie często się myli. \(planNote)"

    public static let lateRise = "Możliwy późny wzrost"
    public static let planNote = "Znaczniki to plan, który może się zmienić. Prognoza ich nie uwzględnia. Pole „Możliwy późny wzrost” to czas, gdy po posiłku z tłuszczem i białkiem glukoza może wzrosnąć. O ile, tego nie wiemy."

    public static func marker(kind: String, title: String?, state: String) -> String {
        let name: String
        switch kind {
        case "BOLUS_PART": name = "Druga część"
        case "WBT_INSULIN": name = "Insulina WBT"
        case "PLANNED_MEAL": name = title ?? "Posiłek"
        case "PLANNED_MOVEMENT": name = title.map { "Ruch: \($0)" } ?? "Ruch"
        case "LATER_CARBS": name = "Węglowodany"
        case "REMINDER": name = "Przypomnienie"
        default: name = "Plan"
        }
        switch state {
        case "DONE_EARLY": return "\(name) · już podano"
        case "SKIPPED": return "\(name) · pominięto"
        default: return name
        }
    }

    // MARK: The Bolus screen while the experiment is on

    public static let doseLineHeadline = "Po tej dawce cukier może spaść niżej"
    public static let doseLineCaution = "Linia przerywana zakłada, że pętla nic więcej nie zmieni, i bywa zbyt optymistyczna."
    public static let bolusChartNote = "Po około godzinie ta prognoza często rozmija się z rzeczywistością. Chmura to mniej więcej połowa przypadków: w drugiej połowie cukier wypada poza nią, także przy dawkach. Wykres służy do porównania dawek, a nie do odczytu cukru. Brak ostrzeżenia nie znaczy, że niskiego cukru nie będzie.\n\nBez nowej dawki linia jest taka sama jak na ekranie Teraz. Z dawką widać rachunek tylko dla niej, bez dalszych zmian pętli.\n\n\(planNote)"

    /// The red marker without a number that looks more certain than it is.
    public static func lowMarker(_ point: BolusForecastChart.Point) -> String {
        "< 70 · \(RemoteCommandFormat.time(point.date))"
    }

    /// The server's text with the line's number taken out; the rest (how far above the proposals, recent insulin) stays.
    public static func withoutLineNumber(_ message: String) -> String {
        var text = message
        for pattern in [#"Po tej dawce ok\. [0-9]+ mg/dL: "#, #" ?[Zz] tą dawką prognoza schodzi do ok\. [0-9]+ mg/dL \(linia przerywana; zakłada, że pętla nic więcej nie zmieni\)\.\s?"#] {
            text = text.replacingOccurrences(of: pattern, with: "", options: .regularExpression)
        }
        return "\(doseLineCaution) \(text.trimmingCharacters(in: .whitespaces))"
    }

    public static func hidden(_ reason: String) -> String {
        switch reason {
        case "LOW_RANGE": return "Bez prognozy: cukier poniżej 100"
        case "HIGH_RANGE": return "Bez prognozy: cukier powyżej 250"
        case "FALLING_FAST": return "Bez prognozy: cukier szybko spada"
        case "LOW_EXPECTED": return "Bez prognozy: pętla przewiduje niski cukier"
        case "ALERT_ACTIVE": return "Bez prognozy: trwa alert"
        case "LOOP_SILENT": return "Bez prognozy: pętla się nie zgłasza"
        case "NO_FRESH_READING": return "Bez prognozy: brak świeżego odczytu"
        default: return "Bez prognozy"
        }
    }
}

extension APIClient {
    /// On or off at any time; owners only.
    public func setPredictionExperiment(patientID: String, enabled: Bool) async throws -> PredictionExperimentResponse {
        var request = try await makeRequest(path: "/v1/patients/\(patientID)/prediction/opt-in", method: "POST")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        struct Body: Encodable { let enabled: Bool }
        request.httpBody = try jsonEncoder.encode(Body(enabled: enabled))
        return try await decode(request, as: PredictionExperimentResponse.self)
    }

    public func getPrediction(patientID: String) async throws -> PredictionResponse {
        let request = try await makeRequest(path: "/v1/patients/\(patientID)/prediction", method: "GET")
        return try await decode(request, as: PredictionResponse.self)
    }
}

extension APIClient: PredictionLineAPI {}

/// Ustawienia → "Linia prognozy" (outside the experimental features).
public enum PredictionLineText {
    public static let title = "Linia prognozy"
    public static let detail = "Szara linia prognozy pętli z chmurą i znaczniki planu na wykresach Teraz i Bolus."
}

private struct PredictionLineOnKey: EnvironmentKey {
    static let defaultValue = false
}

extension EnvironmentValues {
    /// The forecast line shows for the patient on screen: the server serves it and this phone's switch is on.
    public var predictionLineOn: Bool {
        get { self[PredictionLineOnKey.self] }
        set { self[PredictionLineOnKey.self] = newValue }
    }
}
