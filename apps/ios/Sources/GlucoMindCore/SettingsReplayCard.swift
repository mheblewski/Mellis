import SwiftUI

/// A settings change replayed on Trio's logged decisions (settings-replay-card.v1), the same card in the chat and in
/// "Pod lupą" (mockups v3): window header, one verdict line, the setting with −/+, four rows, one confidence line and
/// details that open in place. The server counted and worded everything; this view only draws it. −/+ asks the server
/// for the same change with the next value and draws the new card in place.
public struct SettingsReplay: Codable, Equatable {
    public struct NowAfter: Codable, Equatable {
        public let now: Double
        public let after: Double
        public init(now: Double, after: Double) { self.now = now; self.after = after }
    }

    public struct Part: Codable, Equatable {
        public let text: String
        /// GAIN, COST, NONE.
        public let tone: String
        public init(text: String, tone: String) { self.text = text; self.tone = tone }
    }

    public struct Verdict: Codable, Equatable {
        public let lows: Part?
        public let rises: Part?
        public let text: String
        public init(lows: Part?, rises: Part?, text: String) { self.lows = lows; self.rises = rises; self.text = text }
    }

    public struct Row: Codable, Equatable {
        public let key: String
        public let label: String
        public let days: NowAfter
        public let minutes: NowAfter
        public let days_text: String
        public let minutes_text: String
        public let tone: String
        public init(key: String, label: String, days: NowAfter, minutes: NowAfter, days_text: String, minutes_text: String, tone: String) {
            self.key = key; self.label = label; self.days = days; self.minutes = minutes; self.days_text = days_text; self.minutes_text = minutes_text; self.tone = tone
        }
    }

    public struct Window: Codable, Equatable {
        public let from: String
        public let to: String
        public init(from: String, to: String) { self.from = from; self.to = to }
    }

    public let version: String
    /// BASAL, TARGET, ISF, ICR.
    public let setting: String
    public let from: String
    public let to: String
    public let now_value: Double
    public let value: Double
    public let step: Double
    public let min: Double
    public let max: Double
    public let setting_label: String
    public let now_label: String
    public let value_label: String
    public let window: Window
    public let window_label: String
    public let days: Int
    public let verdict: Verdict
    public let rows: [Row]
    public let confidence: String
    public let details: [String]
    public let lows_not_worse: Bool

    public init(version: String, setting: String, from: String, to: String, now_value: Double, value: Double, step: Double, min: Double, max: Double, setting_label: String, now_label: String, value_label: String, window: Window, window_label: String, days: Int, verdict: Verdict, rows: [Row], confidence: String, details: [String], lows_not_worse: Bool) {
        self.version = version; self.setting = setting; self.from = from; self.to = to; self.now_value = now_value; self.value = value
        self.step = step; self.min = min; self.max = max; self.setting_label = setting_label; self.now_label = now_label
        self.value_label = value_label; self.window = window; self.window_label = window_label; self.days = days
        self.verdict = verdict; self.rows = rows; self.confidence = confidence; self.details = details; self.lows_not_worse = lows_not_worse
    }

    /// The next value one step away, within the bounds and in the step's precision; nil at a bound.
    public func stepped(_ direction: Int) -> Double? {
        let next = ((value + Double(direction) * step) / step).rounded() * step
        let rounded = (next * 1000).rounded() / 1000
        guard rounded >= min - 1e-9, rounded <= max + 1e-9, abs(rounded - value) > 1e-9 else { return nil }
        return rounded
    }
}

public struct SettingsReplayResponse: Decodable, Equatable {
    public let status: String
    public let card: SettingsReplay?
}

extension APIClient {
    /// The same change with another value, counted again (settings-replay-card.v1).
    public func settingsReplay(patientID: String, setting: String, from: String, to: String, value: Double) async throws -> SettingsReplayResponse {
        var request = try await makeRequest(path: "/v1/patients/\(patientID)/settings-replay", method: "POST")
        request.timeoutInterval = 60
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        struct Body: Encodable { let setting: String; let from: String; let to: String; let value: Double }
        request.httpBody = try jsonEncoder.encode(Body(setting: setting, from: from, to: to, value: value))
        return try await decode(request, as: SettingsReplayResponse.self)
    }
}

/// Counting a card again for another value; provided where the app knows the patient and the server.
public struct SettingsReplayRecount {
    public let recount: (SettingsReplay, Double) async -> SettingsReplay?
    public init(recount: @escaping (SettingsReplay, Double) async -> SettingsReplay?) { self.recount = recount }

    public static func api(_ client: APIClient, patientID: String) -> SettingsReplayRecount {
        SettingsReplayRecount { card, value in
            let response = try? await client.settingsReplay(patientID: patientID, setting: card.setting, from: card.from, to: card.to, value: value)
            return response?.status == "OK" ? response?.card : nil
        }
    }
}

private struct SettingsReplayRecountKey: EnvironmentKey {
    static let defaultValue: SettingsReplayRecount? = nil
}

public extension EnvironmentValues {
    /// −/+ on a settings replay card; without it the card shows the value only.
    var settingsReplayRecount: SettingsReplayRecount? {
        get { self[SettingsReplayRecountKey.self] }
        set { self[SettingsReplayRecountKey.self] = newValue }
    }
}

public struct SettingsReplayCardView: View {
    @State private var card: SettingsReplay
    @State private var detailsShown: Bool
    @State private var counting = false
    @State private var failed = false
    @Environment(\.settingsReplayRecount) private var recount

    public init(card: SettingsReplay, detailsShown: Bool = false) {
        _card = State(initialValue: card)
        _detailsShown = State(initialValue: detailsShown)
    }

    init?(metricCard: ConversationMetricCard) {
        guard metricCard.kind == "SETTING_REPLAY", let replay = metricCard.replay else { return nil }
        self.init(card: replay)
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(card.window_label)
                .font(.footnote)
                .foregroundStyle(.secondary)
            verdict
            stepper
            rows
                .opacity(counting ? 0.45 : 1)
            Text(failed ? "Nie udało się przeliczyć tej wartości. Spróbuj jeszcze raz." : card.confidence)
                .font(.footnote)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            Divider()
            details
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 20, style: .continuous).fill(WhatIfColors.background))
        .animation(.easeOut(duration: 0.2), value: card)
    }

    private var verdict: some View {
        let lows = card.verdict.lows
        let rises = card.verdict.rises
        var text = Text("")
        if let lows {
            text = text + Text(lows.text).foregroundColor(SettingsReplayColors.tone(lows.tone))
            text = text + Text(rises == nil ? "." : ", ")
        }
        if let rises {
            let words = lows == nil ? rises.text.prefix(1).uppercased() + rises.text.dropFirst() : rises.text
            text = text + Text(words).foregroundColor(SettingsReplayColors.tone(rises.tone)) + Text(".")
        }
        if lows == nil && rises == nil { text = Text(card.verdict.text) }
        return text
            .font(.system(size: 17, weight: .semibold))
            .fixedSize(horizontal: false, vertical: true)
            .accessibilityLabel(card.verdict.text)
    }

    private var stepper: some View {
        HStack(alignment: .center, spacing: 8) {
            VStack(alignment: .leading, spacing: 2) {
                Text(card.setting_label).font(.subheadline.weight(.semibold))
                Text(card.now_label).font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 6)
            if recount != nil {
                stepButton(-1, symbol: "minus", label: "Mniej")
            }
            ZStack {
                Text(card.value_label).font(.body.weight(.bold)).monospacedDigit().opacity(counting ? 0 : 1)
                if counting { ProgressView().controlSize(.small) }
            }
            .frame(minWidth: 64)
            if recount != nil {
                stepButton(1, symbol: "plus", label: "Więcej")
            }
        }
    }

    private func stepButton(_ direction: Int, symbol: String, label: String) -> some View {
        let next = card.stepped(direction)
        return Button {
            guard let next, let recount else { return }
            counting = true
            failed = false
            Task {
                let updated = await recount.recount(card, next)
                counting = false
                if let updated { card = updated } else { failed = true }
            }
        } label: {
            Image(systemName: symbol)
                .font(.system(size: 17, weight: .semibold))
                .frame(width: 44, height: 44)
                .background(RoundedRectangle(cornerRadius: 10, style: .continuous).fill(WhatIfColors.tile))
        }
        .buttonStyle(.plain)
        .foregroundStyle(Brand.dynamic(light: 0x0E5A61, dark: 0x5EEAD4))
        .disabled(next == nil || counting)
        .opacity(next == nil ? 0.35 : 1)
        .accessibilityLabel("\(label): \(card.setting_label)")
    }

    private var rows: some View {
        VStack(spacing: 0) {
            ForEach(Array(card.rows.enumerated()), id: \.element.key) { index, row in
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text(row.label).font(.subheadline)
                    Spacer(minLength: 6)
                    (Text(row.days_text).font(.callout.weight(.bold)) + Text(" · \(row.minutes_text)").font(.footnote))
                        .monospacedDigit()
                        .foregroundColor(SettingsReplayColors.tone(row.tone, neutral: .primary))
                        .lineLimit(1)
                        .minimumScaleFactor(0.8)
                }
                .padding(.vertical, 8)
                .accessibilityElement(children: .combine)
                if index < card.rows.count - 1 { Divider() }
            }
        }
    }

    private var details: some View {
        VStack(alignment: .leading, spacing: 8) {
            Button {
                withAnimation(.easeOut(duration: 0.2)) { detailsShown.toggle() }
            } label: {
                HStack {
                    Text("Szczegóły").font(.subheadline.weight(.medium))
                    Spacer()
                    Image(systemName: "chevron.down").rotationEffect(.degrees(detailsShown ? 180 : 0))
                }
                .frame(minHeight: 36)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .foregroundStyle(Brand.dynamic(light: 0x0E5A61, dark: 0x5EEAD4))
            if detailsShown {
                ForEach(card.details, id: \.self) { line in
                    Text(line).font(.footnote).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                }
            }
        }
    }
}

enum SettingsReplayColors {
    static func tone(_ tone: String, neutral: Color = .primary) -> Color {
        switch tone {
        case "GAIN": return WhatIfColors.gain.text
        case "COST": return WhatIfColors.cost.text
        default: return neutral
        }
    }
}
