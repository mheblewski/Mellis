import SwiftUI
import Charts

// MARK: - Header

struct HypoEpisodeHeader: View {
    let hypo: ConversationHypo
    /// stale-alerts.v1: an ended hypo over 30 min old is history ("Nieaktualne · 2 godz. temu").
    var stale: AlertStaleness.Stale? = nil

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Image(systemName: "arrow.down.heart.fill")
                    .foregroundStyle(stale == nil ? Color.red : Color.secondary)
                Text("Hipo o \(HypoFormat.time(hypo.started_at))")
                    .font(.title3.weight(.bold))
                Spacer(minLength: 0)
                Text(HypoFormat.day(hypo.started_at))
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
            if let stale {
                StaleAlertBadge(stale: stale)
            }

            HStack(spacing: 8) {
                if let minimum = hypo.minimum_glucose {
                    StatPill(title: "najniżej", value: "\(minimum) mg/dL")
                }
                if hypo.ended_at == nil || hypo.state.uppercased() == "OPEN" {
                    StatPill(title: "trwa", value: "nadal")
                } else if let duration = hypo.duration_minutes {
                    StatPill(title: "trwało", value: "\(duration) min")
                }
            }

            if hypo.glucose_readings.count >= 2 {
                HypoGlucoseChart(hypo: hypo)
                    .frame(height: 140)
            }
        }
        .padding(14)
        .background(
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .fill(Color.red.opacity(0.06))
        )
    }
}

private struct StatPill: View {
    let title: String
    let value: String

    var body: some View {
        HStack(spacing: 4) {
            Text(title)
                .foregroundStyle(.secondary)
            Text(value)
                .fontWeight(.semibold)
        }
        .font(.footnote)
        .padding(.horizontal, 10)
        .padding(.vertical, 5)
        .background(Capsule().fill(Color.secondary.opacity(0.1)))
    }
}

/// CGM around the hypo with the 70 mg/dL line and the episode shaded.
struct HypoGlucoseChart: View {
    let hypo: ConversationHypo

    private var points: [(date: Date, value: Int)] {
        hypo.glucose_readings.compactMap { reading in
            HypoFormat.date(reading.observed_at).map { ($0, reading.glucose_mgdl) }
        }
    }

    var body: some View {
        let points = self.points
        let start = HypoFormat.date(hypo.started_at)
        let end = hypo.ended_at.flatMap(HypoFormat.date) ?? points.last?.date
        let maxValue = max(180, (points.map(\.value).max() ?? 180) + 20)

        Chart {
            if let start, let end, end > start {
                RectangleMark(xStart: .value("Początek", start), xEnd: .value("Koniec", end))
                    .foregroundStyle(Color.red.opacity(0.1))
            }
            RuleMark(y: .value("Próg", 70))
                .foregroundStyle(Color.red.opacity(0.6))
                .lineStyle(StrokeStyle(lineWidth: 1, dash: [4, 3]))
            ForEach(points, id: \.date) { point in
                LineMark(x: .value("Czas", point.date), y: .value("mg/dL", point.value))
                    .interpolationMethod(.monotone)
                    .foregroundStyle(Color.accentColor)
            }
        }
        .chartYScale(domain: 40...maxValue)
        .chartXAxis {
            AxisMarks(values: .stride(by: .hour)) { _ in
                AxisGridLine()
                AxisValueLabel(format: .dateTime.hour().minute())
            }
        }
        .accessibilityLabel("Wykres glukozy wokół hipo")
    }
}

// MARK: - Chat intro

/// Starts the chat about the hypo below its header: a few one-tap questions, or the composer below.
struct HypoChatIntro: View {
    let canSend: Bool
    var title = "Porozmawiaj o tym hipo"
    var detail = "Mellis przeanalizuje dane z pętli wokół tego spadku."
    var questions = Self.questions
    let onQuestion: (String) -> Void

    static let questions = [
        "Dlaczego był ten spadek?",
        "Czy dosłodzenie było odpowiednie?",
        "Co zrobić, żeby to się nie powtórzyło?",
    ]

    /// A meal's WBT conversation starts here (wbt-chat.v1).
    static func wbt(canSend: Bool, onQuestion: @escaping (String) -> Void) -> HypoChatIntro {
        HypoChatIntro(
            canSend: canSend,
            title: "Porozmawiaj o dawce WBT",
            detail: "Mellis zna posiłek, proponowaną dawkę, wcześniejsze WBT i aktualną glukozę. Może zaproponować inną dawkę do podania.",
            questions: ["Dlaczego taka dawka?", "Czy dać mniej?", "Czy podać teraz, czy poczekać?"],
            onQuestion: onQuestion
        )
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Label(title, systemImage: "bubble.left.and.text.bubble.right")
                .font(.headline)
            Text(detail)
                .font(.subheadline)
                .foregroundStyle(.secondary)

            VStack(alignment: .leading, spacing: 8) {
                ForEach(questions, id: \.self) { question in
                    Button {
                        onQuestion(question)
                    } label: {
                        HStack {
                            Text(question)
                                .multilineTextAlignment(.leading)
                            Spacer(minLength: 0)
                            Image(systemName: "arrow.up.right")
                                .font(.footnote)
                        }
                        .padding(.horizontal, 12)
                        .padding(.vertical, 10)
                        .background(
                            RoundedRectangle(cornerRadius: 12, style: .continuous)
                                .stroke(Color.accentColor.opacity(0.4), lineWidth: 1)
                        )
                    }
                    .buttonStyle(.plain)
                    .foregroundStyle(Color.accentColor)
                    .disabled(!canSend)
                }
            }
        }
        .frame(maxWidth: 680, alignment: .leading)
        .padding(.top, 8)
    }
}

// MARK: - Shared

enum HypoFormat {
    private static let timeZone = TimeZone(identifier: "Europe/Warsaw") ?? .current

    static func date(_ iso: String) -> Date? {
        ServerDate.parse(iso)
    }

    static func time(_ iso: String) -> String {
        guard let date = date(iso) else { return "—" }
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "pl_PL")
        formatter.timeZone = timeZone
        formatter.dateFormat = "HH:mm"
        return formatter.string(from: date)
    }

    static func day(_ iso: String) -> String {
        guard let date = date(iso) else { return "" }
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = timeZone
        if calendar.isDateInToday(date) { return "dzisiaj" }
        if calendar.isDateInYesterday(date) { return "wczoraj" }
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "pl_PL")
        formatter.timeZone = timeZone
        formatter.dateFormat = "d MMMM"
        return formatter.string(from: date)
    }

    static func grams(_ value: Double) -> String {
        value.rounded() == value ? String(Int(value)) : String(format: "%.1f", value).replacingOccurrences(of: ".", with: ",")
    }
}
