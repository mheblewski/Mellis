import SwiftUI
import Charts
import GlucoMindCore

/// "Wzorce" (therapy-patterns.v1; docs/product/patterns-and-chat-replay-review.md): what repeats in the last 14
/// days, as facts with the things to look at, never a cause or a dose. A card opens the pattern: its days, "Omów z Mellis"
/// (the conversation of the pattern) and "Nie dotyczy nas". Every sentence is the server's; this view only draws it.
@MainActor
final class TherapyPatternsModel: ObservableObject {
    enum State: Equatable { case loading, loaded(TherapyPatternsView), failed, unavailable }

    @Published var state: State = .loading
    let apiClient: APIClient
    let patientID: String

    init(apiClient: APIClient, patientID: String) {
        self.apiClient = apiClient
        self.patientID = patientID
    }

    func load() async {
        do {
            state = .loaded(try await apiClient.therapyPatterns(patientID: patientID))
        } catch APIClientError.forbidden {
            // A server without Wzorce, or one that turned them off.
            state = .unavailable
        } catch {
            if case .loaded = state { return }
            state = .failed
        }
    }

    /// A new card was opened: the server stops calling it "Nowy" for this caregiver; the list and Teraz's row follow.
    func markOpened(_ pattern: TherapyPattern) async {
        guard pattern.is_new else { return }
        do {
            try await apiClient.markTherapyPatternOpened(patientID: patientID, key: pattern.key)
            await load()
        } catch {
            // An older server (no such call) or no network: the card stays "Nowy" until a later open.
        }
    }

    func setDismissed(_ pattern: TherapyPattern, _ dismissed: Bool) async -> Bool {
        do {
            try await apiClient.dismissTherapyPattern(patientID: patientID, key: pattern.key, dismissed: dismissed)
            await load()
            return true
        } catch {
            return false
        }
    }
}

struct TherapyPatternsScreen: View {
    @StateObject private var model: TherapyPatternsModel
    @State private var path: [TherapyPattern] = []
    private let initialKey: String?
    @State private var openedInitial = false
    @State private var showsReport = false
    @State private var changeConversation: String?
    @State private var openingChange = false
    @Environment(\.dismiss) private var dismiss

    init(apiClient: APIClient, patientID: String, initialKey: String? = nil) {
        _model = StateObject(wrappedValue: TherapyPatternsModel(apiClient: apiClient, patientID: patientID))
        self.initialKey = initialKey
    }

    var body: some View {
        Group {
            NavigationStack(path: $path) {
                ScrollView {
                    VStack(alignment: .leading, spacing: 14) {
                        switch model.state {
                        case .loaded(let view): content(view)
                        case .failed:
                            Text("Nie udało się wczytać. Spróbuj jeszcze raz za chwilę.")
                                .foregroundStyle(.secondary)
                                .padding(.top, 24)
                        case .unavailable:
                            Text("Serwer tego pacjenta nie pokazuje wzorców. Wzorce widzi właściciel pacjenta, który używa Trio.")
                                .foregroundStyle(.secondary)
                                .padding(.top, 24)
                        default:
                            VStack(spacing: 12) {
                                ProgressView()
                                Text("Szukam powtarzających się sytuacji w ostatnich 14 dniach…").font(.subheadline).foregroundStyle(.secondary)
                            }
                            .frame(maxWidth: .infinity)
                            .padding(.top, 48)
                        }
                    }
                    .padding(.horizontal, 16)
                    .padding(.bottom, 32)
                }
                .navigationTitle("Wzorce")
                #if os(iOS)
                .navigationBarTitleDisplayMode(.large)
                #endif
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) {
                        Button { dismiss() } label: { Image(systemName: "xmark") }
                            .accessibilityLabel("Zamknij")
                    }
                }
                .refreshable { await model.load() }
                .navigationDestination(for: TherapyPattern.self) { pattern in
                    TherapyPatternDetailView(model: model, pattern: pattern)
                }
                .navigationDestination(isPresented: Binding(get: { changeConversation != nil }, set: { if !$0 { changeConversation = nil } })) {
                    if let changeConversation {
                        PatternThreadScreen(apiClient: model.apiClient, patientID: model.patientID, conversationID: changeConversation, firstQuestion: "Co jeszcze zmieniło się w tych tygodniach?", title: "Rozmowa o zmianie")
                    }
                }
            }
            .task {
                await model.load()
                openInitialIfNeeded()
            }
        }
    }

    /// A push opens its pattern's card right away.
    private func openInitialIfNeeded() {
        guard !openedInitial, let initialKey, case .loaded(let view) = model.state else { return }
        openedInitial = true
        if let pattern = (view.patterns + view.gone + view.dismissed).first(where: { $0.key == initialKey }) { path = [pattern] }
    }

    @ViewBuilder
    private func content(_ view: TherapyPatternsView) -> some View {
        Text("Ostatnie 14 dni: \(PatternDates.short(view.window.from))–\(PatternDates.short(view.window.to))")
            .font(.subheadline)
            .foregroundStyle(.secondary)
        // Facts of the 14 days (a night under 54, time below the goal) are not patterns: their own section above
        // (owner 2026-11-13: "jest wymieniony jako wzorzec sytuacja która zdarzyła się tylko raz"). Then what repeats,
        // then the change: one line until its day 14.
        let facts = view.patterns.filter(\.isFact)
        let repeats = view.patterns.filter { !$0.isFact }
        if !facts.isEmpty {
            SectionTitle(text: "Do wiadomości")
            ForEach(facts) { pattern in
                NavigationLink(value: pattern) { PatternCard(pattern: pattern) }
                    .buttonStyle(.plain)
                    .accessibilityIdentifier("patterns.card.\(pattern.key)")
            }
        }
        SectionTitle(text: "Powtarza się")
        if repeats.isEmpty {
            VStack(alignment: .leading, spacing: 6) {
                Text("W ostatnich 14 dniach nic się nie powtarza. Mellis sprawdza to co noc.")
                    .font(.subheadline)
                    .foregroundStyle(.primary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .padding(16)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(RoundedRectangle(cornerRadius: 20, style: .continuous).fill(PatternColors.tile))
            .accessibilityElement(children: .combine)
        } else {
            ForEach(repeats) { pattern in
                NavigationLink(value: pattern) { PatternCard(pattern: pattern) }
                    .buttonStyle(.plain)
                    .accessibilityIdentifier("patterns.card.\(pattern.key)")
            }
        }
        if let change = view.change_check {
            if change.ready == false {
                ChangeLine(change: change)
            } else {
                ChangeCheckCard(change: change, isOpening: openingChange) {
                    Task {
                        openingChange = true
                        defer { openingChange = false }
                        changeConversation = try? await model.apiClient.openTherapyPatternThread(patientID: model.patientID, key: change.key).conversation_id
                    }
                }
            }
        }
        if !view.gone.isEmpty {
            // "Already not repeating" claimed more than the run knows: the pattern only fell under its threshold.
            SectionTitle(text: "Wcześniej wykryte")
            VStack(spacing: 0) {
                ForEach(Array(view.gone.enumerated()), id: \.element.id) { index, pattern in
                    NavigationLink(value: pattern) { GoneRow(pattern: pattern) }
                        .buttonStyle(.plain)
                    if index < view.gone.count - 1 { Divider() }
                }
            }
        }
        if !view.dismissed.isEmpty {
            DisclosureGroup("Ukryte: \(view.dismissed.count)") {
                ForEach(view.dismissed) { pattern in
                    VStack(alignment: .leading, spacing: 4) {
                        NavigationLink(value: pattern) { PatternCard(pattern: pattern, muted: true) }
                            .buttonStyle(.plain)
                        if let label = pattern.dismissed_label {
                            Text(label).font(.footnote).foregroundStyle(.secondary).padding(.leading, 4)
                        }
                    }
                    .padding(.top, 8)
                }
            }
            .font(.subheadline)
            .tint(.secondary)
        }
        Button {
            showsReport = true
        } label: {
            Label("Raport dla poradni", systemImage: "doc.text")
                .font(.body.weight(.semibold))
                .frame(maxWidth: .infinity, minHeight: 48)
        }
        .buttonStyle(.bordered)
        .tint(PatternColors.petrol)
        .padding(.top, 8)
        .accessibilityIdentifier("patterns.report")
        .sheet(isPresented: $showsReport) { ClinicReportScreen(apiClient: model.apiClient, patientID: model.patientID) }
        Text("Zmiany ustawień omawia się z poradnią. Mellis nie zmienia ustawień ani dawek.")
            .font(.caption)
            .foregroundStyle(.secondary)
            .fixedSize(horizontal: false, vertical: true)
            .padding(.top, 4)
    }
}

private struct SectionTitle: View {
    let text: String
    var body: some View {
        Text(text).font(.headline).padding(.top, 6).accessibilityAddTraits(.isHeader)
    }
}

private struct PatternCard: View {
    let pattern: TherapyPattern
    var muted = false

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: PatternStyle.icon(pattern.id))
                .font(.title3)
                .foregroundStyle(muted ? Color.secondary : PatternStyle.tint(pattern))
                .frame(width: 28)
            VStack(alignment: .leading, spacing: 6) {
                Text(pattern.title).font(.headline).foregroundStyle(muted ? .secondary : .primary)
                    .fixedSize(horizontal: false, vertical: true)
                if pattern.is_new && !muted && !pattern.isFact {
                    Text("Nowy")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(PatternColors.chipText)
                        .padding(.horizontal, 8)
                        .padding(.vertical, 3)
                        .background(Capsule().fill(PatternColors.chip))
                }
                Text(pattern.summary)
                    .font(.subheadline)
                    .foregroundStyle(muted ? .secondary : .primary)
                    .multilineTextAlignment(.leading)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            Image(systemName: "chevron.right").font(.footnote.weight(.semibold)).foregroundStyle(.tertiary).padding(.top, 4)
                .accessibilityHidden(true)
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 20, style: .continuous).strokeBorder(PatternColors.border, lineWidth: 1))
        .contentShape(Rectangle())
        // One VoiceOver stop per card: "Spadki po bolusie do posiłku, nowy, dotyczy spadków. W 9 z 14 dni…"
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(pattern.title)\(pattern.is_new && !muted && !pattern.isFact ? ", nowy" : "")\(pattern.isLows ? ", dotyczy spadków" : ""). \(PatternDates.spokenText(pattern.summary))")
        .accessibilityAddTraits(.isButton)
    }
}

/// The change until its day 14: one line, no numbers and no conversation yet (plan to 9/10, D1).
private struct ChangeLine: View {
    let change: ChangeCheck

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: "arrow.left.arrow.right").foregroundStyle(PatternColors.petrol).accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text(change.title).font(.subheadline.weight(.semibold))
                if let line = change.line { Text(line).font(.footnote).foregroundStyle(.primary) }
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 16, style: .continuous).fill(PatternColors.tile))
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(change.title). \(PatternDates.spokenText(change.line ?? "")).")
        .accessibilityIdentifier("patterns.change.line")
    }
}

/// "Przed i po zmianie": the same hours before and after a Trio change. Owner 2026-11-23 ("ściana tekstu taką samą
/// czcionką"): per section the setting small and its values large, the two smoothed mean lines on one chart, four shares
/// of time in tiles (red when worse, green when better), the safety line in its own red box, the note small.
private struct ChangeCheckCard: View {
    let change: ChangeCheck
    let isOpening: Bool
    let onTalk: () -> Void

    /// One section per direction of the change; an older server's single table as one section.
    private var sections: [ChangeCheck.Section] {
        if let sections = change.sections, !sections.isEmpty { return sections }
        return [ChangeCheck.Section(title: change.hours.map { "W godzinach \($0)" } ?? "", before_days: change.before_days ?? 0, after_days: change.after_days ?? 0, rows: change.rows)]
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(alignment: .center) {
                Label(change.title, systemImage: "arrow.left.arrow.right").font(.title3.weight(.semibold)).foregroundStyle(PatternColors.petrol)
                    .accessibilityAddTraits(.isHeader)
                Spacer(minLength: 8)
                if let day = change.day, let of = change.of {
                    Text(change.isRunning ? "dzień \(day) z \(of)" : "\(of) dni po zmianie")
                        .font(.caption.weight(.medium)).foregroundStyle(.secondary)
                        .padding(.horizontal, 9).padding(.vertical, 4)
                        .background(Capsule().fill(Color.primary.opacity(0.08)))
                }
            }
            ForEach(Array(sections.enumerated()), id: \.offset) { index, section in
                if index > 0 { Divider() }
                ChangeSectionView(section: section)
            }
            if let safety = change.safety {
                Label { Text(safety).font(.subheadline.weight(.semibold)).fixedSize(horizontal: false, vertical: true) } icon: {
                    Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(PatternColors.low)
                }
                .padding(12)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(RoundedRectangle(cornerRadius: 14, style: .continuous).fill(BrandTint.red.background))
                .accessibilityElement(children: .combine)
            }
            VStack(alignment: .leading, spacing: 4) {
                if let beforeNote = change.before_note { Text(beforeNote) }
                Text(change.note ?? ((change.after_days ?? 0) < 10
                     ? "Bez oceny: \(change.after_days ?? 0) dni po zmianie to za mało, a w tych tygodniach mogły się zmienić też posiłki i sposób podawania bolusa."
                     : "Bez oceny: w tych tygodniach mogły się zmienić też posiłki i sposób podawania bolusa."))
            }
            .font(.footnote)
            .foregroundStyle(.secondary)
            .fixedSize(horizontal: false, vertical: true)
            Button(action: onTalk) {
                HStack(spacing: 8) {
                    if isOpening { ProgressView().controlSize(.small).tint(.white) } else { Image(systemName: "bubble.left.and.text.bubble.right") }
                    Text("Omów z Mellis").fontWeight(.semibold)
                }
                .frame(maxWidth: .infinity, minHeight: 44)
            }
            .buttonStyle(.borderedProminent)
            .tint(PatternColors.button)
            .disabled(isOpening)
            .accessibilityIdentifier("patterns.change.talk")
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 20, style: .continuous).fill(PatternColors.tile))
    }
}

/// One direction of the change: "Przelicznik 18:00–24:00" small, "7,1 → 6,8" large with "więcej insuliny", the chart,
/// the tiles and the hours it was counted in. An older server's section (no `changes`) keeps its title and grid.
private struct ChangeSectionView: View {
    let section: ChangeCheck.Section
    @Environment(\.dynamicTypeSize) private var typeSize

    private var toned: Bool { section.rows.contains { $0.tone != nil } || section.chart != nil }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            if let changes = section.changes, !changes.isEmpty {
                ForEach(changes, id: \.self) { c in
                    VStack(alignment: .leading, spacing: 2) {
                        Text(c.label).font(.subheadline).foregroundStyle(.secondary)
                        ViewThatFits(in: .horizontal) {
                            HStack(alignment: .firstTextBaseline, spacing: 10) { values(c); chip }
                            VStack(alignment: .leading, spacing: 4) { values(c); chip }
                        }
                    }
                    .accessibilityElement(children: .ignore)
                    .accessibilityLabel("\(PatternDates.spokenText(c.label)): z \(c.before) na \(c.after)\(section.direction_label.map { ", \($0)" } ?? "")")
                    .accessibilityAddTraits(.isHeader)
                }
            } else {
                Text(section.title).font(.subheadline.weight(.semibold))
            }
            if let chart = section.chart {
                ChangeMeanChart(chart: chart, beforeLabel: section.before_label ?? "Przed", afterLabel: section.after_label ?? "Po")
            }
            if toned {
                LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 8, alignment: .top), count: typeSize.isAccessibilitySize ? 1 : 2), spacing: 8) {
                    ForEach(section.rows, id: \.self) { ChangeTile(row: $0) }
                }
            } else {
                BeforeAfterGrid(
                    beforeLabel: section.before_label ?? "Przed (\(section.before_days) dni)",
                    afterLabel: section.after_label ?? "Po (\(section.after_days) dni)",
                    rows: section.rows)
            }
            if let subtitle = section.subtitle {
                Text(subtitle.prefix(1).uppercased() + subtitle.dropFirst() + (subtitle.hasSuffix(".") ? "" : "."))
                    .font(.footnote).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    private func values(_ c: ChangeCheck.Change) -> some View {
        Text("\(c.before) → \(c.after)").font(.title.weight(.bold)).monospacedDigit()
    }

    @ViewBuilder private var chip: some View {
        if let label = section.direction_label {
            let more = section.direction == "MORE"
            Text(label)
                .font(.caption.weight(.semibold))
                .foregroundStyle(more ? PatternColors.chipText : Color.primary.opacity(0.8))
                .padding(.horizontal, 8).padding(.vertical, 3)
                .background(Capsule().fill(more ? PatternColors.chip : Color.primary.opacity(0.1)))
        }
    }
}

/// "Poniżej 54" / "0,4% → 1,4%": the after number red when worse, green when better, grey when it hardly moved.
private struct ChangeTile: View {
    let row: ChangeCheck.Row

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(row.label).font(.footnote).foregroundStyle(.secondary)
            HStack(alignment: .firstTextBaseline, spacing: 5) {
                Text(row.before)
                Text("→").foregroundStyle(.secondary).fontWeight(.regular)
                Text(row.after).foregroundStyle(row.isWorse ? PatternColors.low : row.isBetter ? PatternColors.better : Color.primary)
            }
            .font(.title3.weight(.bold))
            .monospacedDigit()
            .lineLimit(1)
            .minimumScaleFactor(0.7)
        }
        .padding(.horizontal, 11).padding(.vertical, 9)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 12, style: .continuous).fill(Color.primary.opacity(0.07)))
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(row.label): przed zmianą \(row.before), po zmianie \(row.after)\(row.isWorse ? ", gorzej" : row.isBetter ? ", lepiej" : "")")
    }
}

/// The two smoothed mean lines on one chart (owner 2026-11-23: no band around them, smooth, not sharp): before grey,
/// after teal, 70 and 180 as dashed lines over a faint red and orange field.
private struct ChangeMeanChart: View {
    let chart: ChangeCheck.SectionChart
    let beforeLabel: String
    let afterLabel: String

    private struct Point: Identifiable { let id: String; let minute: Int; let value: Int; let after: Bool }

    private var points: [Point] {
        chart.before.filter { $0.count == 2 }.map { Point(id: "b\($0[0])", minute: $0[0], value: $0[1], after: false) }
            + chart.after.filter { $0.count == 2 }.map { Point(id: "a\($0[0])", minute: $0[0], value: $0[1], after: true) }
    }
    private var low: Int { min(60, (points.map(\.value).min() ?? 60) - 10) }
    private var high: Int { max(200, (points.map(\.value).max() ?? 200) + 15) }
    /// The start, then every full 3 hours (18:00, 21:00, 24:00, 3:00; 9:30, 12:00, 15:00, 18:00).
    private var ticks: [Int] {
        [chart.from_minute] + stride(from: (chart.from_minute / 180 + 1) * 180, through: chart.to_minute, by: 180).filter { $0 - chart.from_minute >= 60 }
    }
    private func clock(_ m: Int) -> String {
        let x = m == 1440 ? 1440 : m % 1440
        return "\(x / 60):\(String(format: "%02d", x % 60))"
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 14) {
                legend(beforeLabel, color: .secondary)
                legend(afterLabel, color: PatternColors.petrol)
            }
            .font(.caption)
            Chart {
                RectangleMark(xStart: .value("od", chart.from_minute), xEnd: .value("do", chart.to_minute), yStart: .value("", low), yEnd: .value("", 70))
                    .foregroundStyle(PatternColors.low.opacity(0.12))
                RectangleMark(xStart: .value("od", chart.from_minute), xEnd: .value("do", chart.to_minute), yStart: .value("", 180), yEnd: .value("", high))
                    .foregroundStyle(Color.orange.opacity(0.07))
                RuleMark(y: .value("", 70))
                    .foregroundStyle(PatternColors.low.opacity(0.7))
                    .lineStyle(StrokeStyle(lineWidth: 1, dash: [3, 4]))
                    .annotation(position: .top, alignment: .trailing, spacing: 1) { Text("70").font(.caption2).foregroundStyle(PatternColors.low) }
                RuleMark(y: .value("", 180))
                    .foregroundStyle(Color.orange.opacity(0.6))
                    .lineStyle(StrokeStyle(lineWidth: 1, dash: [3, 4]))
                    .annotation(position: .top, alignment: .trailing, spacing: 1) { Text("180").font(.caption2).foregroundStyle(PatternColors.carbText) }
                ForEach(points) { p in
                    LineMark(x: .value("Godzina", p.minute), y: .value("Glukoza", p.value), series: .value("Okres", p.after ? "po" : "przed"))
                        .foregroundStyle(p.after ? PatternColors.petrol : Color.secondary)
                        .lineStyle(StrokeStyle(lineWidth: p.after ? 3 : 2.5, lineCap: .round, lineJoin: .round))
                        .interpolationMethod(.catmullRom)
                }
            }
            .chartXScale(domain: chart.from_minute...chart.to_minute)
            .chartYScale(domain: low...high)
            .chartYAxis(.hidden)
            .chartXAxis {
                // The first and last labels sit inside the chart (centred, the end label was dropped at the edge).
                AxisMarks(values: ticks) { value in
                    let m = value.as(Int.self) ?? 0
                    AxisValueLabel(anchor: m == chart.from_minute ? .topLeading : m == chart.to_minute ? .topTrailing : .top) { Text(clock(m)) }
                }
            }
            .frame(height: 150)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(spoken)
        }
    }

    private func legend(_ text: String, color: Color) -> some View {
        HStack(spacing: 5) {
            Capsule().fill(color).frame(width: 14, height: 3)
            Text(text).foregroundStyle(color == .secondary ? Color.secondary : color)
        }
        .accessibilityHidden(true)
    }

    /// "Średnia glukoza od 18:00 do 3:00. Przed zmianą najwyżej 195 o 23:00, po zmianie najwyżej 167 o 22:00."
    private var spoken: String {
        func peak(_ rows: [[Int]]) -> String {
            guard let top = rows.filter({ $0.count == 2 }).max(by: { $0[1] < $1[1] }) else { return "brak danych" }
            return "najwyżej \(top[1]) o \(clock(top[0]))"
        }
        return "Średnia glukoza od \(clock(chart.from_minute)) do \(clock(chart.to_minute)). Przed zmianą \(peak(chart.before)), po zmianie \(peak(chart.after))."
    }
}

/// "Przed / Po" rows; each row is one VoiceOver element ("Dni poniżej 54: przed zmianą 3 z 14, po zmianie 1 z 5"). "Po"
/// has the same weight as "Przed" (a bold "Po" read as a verdict). At accessibility text sizes each row stacks.
private struct BeforeAfterGrid: View {
    let beforeLabel: String
    let afterLabel: String
    let rows: [ChangeCheck.Row]
    @Environment(\.dynamicTypeSize) private var typeSize

    var body: some View {
        if typeSize.isAccessibilitySize {
            VStack(alignment: .leading, spacing: 10) {
                ForEach(rows, id: \.self) { row in
                    VStack(alignment: .leading, spacing: 2) {
                        Text(row.label).font(.subheadline.weight(.semibold))
                        Text("\(beforeLabel): \(row.before)").font(.subheadline)
                        Text("\(afterLabel): \(row.after)").font(.subheadline)
                    }
                    .accessibilityElement(children: .ignore)
                    .accessibilityLabel(spoken(row))
                }
            }
        } else {
            Grid(alignment: .trailing, horizontalSpacing: 12, verticalSpacing: 6) {
                GridRow {
                    Text("").gridColumnAlignment(.leading)
                    Text(beforeLabel).font(.footnote).foregroundStyle(.secondary)
                    Text(afterLabel).font(.footnote).foregroundStyle(.secondary)
                }
                .accessibilityHidden(true)
                ForEach(rows, id: \.self) { row in
                    GridRow {
                        Text(row.label).font(.subheadline).gridColumnAlignment(.leading)
                        Text(row.before).font(.subheadline).monospacedDigit()
                        Text(row.after).font(.subheadline).monospacedDigit()
                    }
                    .accessibilityElement(children: .ignore)
                    .accessibilityLabel(spoken(row))
                }
            }
        }
    }

    private func spoken(_ row: ChangeCheck.Row) -> String {
        "\(row.label): przed zmianą \(PatternDates.spokenText(row.before)), po zmianie \(PatternDates.spokenText(row.after))"
    }
}

/// A pattern seen in the last weeks, not now: its title, when it was seen and how often.
private struct GoneRow: View {
    let pattern: TherapyPattern

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: PatternStyle.icon(pattern.id)).foregroundStyle(.secondary).frame(width: 28).accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text(pattern.title).font(.subheadline).foregroundStyle(.primary)
                if let seen = GoneRow.seen(pattern) { Text(seen).font(.footnote).foregroundStyle(.secondary) }
            }
            Spacer(minLength: 8)
            Image(systemName: "chevron.right").font(.footnote.weight(.semibold)).foregroundStyle(.tertiary).accessibilityHidden(true)
        }
        .padding(.vertical, 12)
        .contentShape(Rectangle())
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(pattern.title). \(GoneRow.seen(pattern).map { PatternDates.spokenText($0) } ?? "Wcześniej wykryty.")")
        .accessibilityAddTraits(.isButton)
    }

    /// "wykryty 11.11 · 7 posiłków ze wzrostem", "wykryty 9.11, ostatnio 11.11 · 3 dni ze spadkiem".
    /// Dates are the nights the pattern was on the list (not a claim that it stopped); the count is
    /// what the analysis found (meals, days), never how many times the card was shown.
    static func seen(_ pattern: TherapyPattern) -> String? {
        guard let last = pattern.last_seen else { return nil }
        let lastText = PatternDates.short(last)
        let firstText = pattern.first_seen.map { PatternDates.short($0) }
        let dates = firstText.map { $0 == lastText ? $0 : "\($0), ostatnio \(lastText)" } ?? lastText
        let n = pattern.episode_count
        let count: String
        if n == 0 { count = "" }
        else if pattern.isLows { count = " · \(n) \(n == 1 ? "dzień" : "dni") ze spadkiem" }
        else if pattern.id == "MEAL_RISES_SAME_TIME" { count = " · \(n) \(plural(n, one: "posiłek", few: "posiłki", many: "posiłków")) ze wzrostem" }
        else { count = " · \(n) \(plural(n, one: "przypadek", few: "przypadki", many: "przypadków"))" }
        return "wykryty \(dates)\(count)"
    }

    private static func plural(_ n: Int, one: String, few: String, many: String) -> String {
        if n == 1 { return one }
        let tens = n % 100, units = n % 10
        return (2...4).contains(units) && !(12...14).contains(tens) ? few : many
    }
}

struct TherapyPatternDetailView: View {
    @ObservedObject var model: TherapyPatternsModel
    let pattern: TherapyPattern
    @State private var conversationID: String?
    @State private var isOpening = false
    @State private var isDismissing = false
    @State private var error: String?
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                HStack(spacing: 10) {
                    Image(systemName: PatternStyle.icon(pattern.id)).font(.title2).foregroundStyle(PatternStyle.tint(pattern)).accessibilityHidden(true)
                    Text(pattern.title).font(.title2.weight(.bold)).fixedSize(horizontal: false, vertical: true)
                        .accessibilityAddTraits(.isHeader)
                }
                if pattern.isSettings {
                    VStack(alignment: .leading, spacing: 10) {
                        ForEach(pattern.lines, id: \.self) { line in
                            HStack(alignment: .firstTextBaseline, spacing: 8) {
                                Text("•").foregroundStyle(.secondary)
                                Text(line).font(.body).fixedSize(horizontal: false, vertical: true)
                            }
                        }
                    }
                } else {
                    Text(pattern.sentence).font(.body).fixedSize(horizontal: false, vertical: true)
                    ForEach(pattern.details ?? [], id: \.self) { detail in
                        Text(detail).font(.subheadline).foregroundStyle(.primary).fixedSize(horizontal: false, vertical: true)
                    }
                    // Facts against the goal have no "first time" (a share over 14 days); patterns do.
                    if !pattern.isFact, let first = pattern.first_episode ?? pattern.first_seen {
                        Text("Pierwszy raz: \(PatternDates.short(first))").font(.footnote).foregroundStyle(.secondary)
                            .accessibilityLabel("Pierwszy raz: \(PatternDates.spoken(first))")
                    }
                }

                VStack(alignment: .leading, spacing: 8) {
                    if let question = pattern.question {
                        Text("Do sprawdzenia").font(.headline)
                        Text(question).font(.subheadline).fixedSize(horizontal: false, vertical: true)
                    }
                    (Text("Na wizytę: ").fontWeight(.semibold) + Text(pattern.visit))
                        .font(.subheadline)
                        .fixedSize(horizontal: false, vertical: true)
                        .padding(.top, pattern.question == nil ? 0 : 4)
                }

                Button {
                    Task { await openChat() }
                } label: {
                    HStack(spacing: 8) {
                        if isOpening { ProgressView().controlSize(.small).tint(.white) } else { Image(systemName: "bubble.left.and.text.bubble.right") }
                        Text("Omów z Mellis").fontWeight(.semibold)
                    }
                    .frame(maxWidth: .infinity, minHeight: 48)
                }
                .buttonStyle(.borderedProminent)
                .tint(PatternColors.button)
                .disabled(isOpening)
                .accessibilityIdentifier("patterns.talk")
                if let error { Text(error).font(.footnote).foregroundStyle(.secondary) }

                if let chart = pattern.chart, pattern.episodes.contains(where: { $0.chart != nil }) {
                    EpisodeCharts(chart: chart, episodes: pattern.episodes, more: pattern.episode_count - pattern.episodes.count)
                } else if !pattern.episodes.isEmpty {
                    VStack(alignment: .leading, spacing: 0) {
                        Text("Kiedy").font(.headline).padding(.bottom, 6)
                        ForEach(Array(pattern.episodes.enumerated()), id: \.offset) { index, episode in
                            VStack(alignment: .leading, spacing: 2) {
                                Text("\(PatternDates.weekdayShort(episode.date)), \(episode.time)").font(.subheadline.weight(.semibold)).monospacedDigit()
                                Text(episode.note).font(.subheadline).foregroundStyle(.primary).fixedSize(horizontal: false, vertical: true)
                            }
                            .accessibilityElement(children: .ignore)
                            .accessibilityLabel("\(PatternDates.spoken(episode.date)), \(episode.time). \(PatternDates.spokenText(episode.note))")
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(.vertical, 8)
                            if index < pattern.episodes.count - 1 { Divider() }
                        }
                        if pattern.episode_count > pattern.episodes.count {
                            Text("i jeszcze \(pattern.episode_count - pattern.episodes.count) wcześniej").font(.footnote).foregroundStyle(.secondary).padding(.top, 2)
                        }
                    }
                }

                if pattern.can_dismiss {
                    Button {
                        Task { await toggleDismissed() }
                    } label: {
                        HStack(spacing: 8) {
                            if isDismissing { ProgressView().controlSize(.small) }
                            Text(dismissLabel)
                        }
                        .frame(maxWidth: .infinity, minHeight: 44)
                    }
                    .buttonStyle(.bordered)
                    .tint(PatternColors.petrol)
                    .disabled(isDismissing)
                    if pattern.dismissed_until == nil {
                        Text(pattern.isSettings ? "Wróci, gdy któreś z tych ustawień się zmieni." : "Ukryje ten wzorzec i jego powiadomienia na 30 dni u obu opiekunów.")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 12)
        }
        #if os(iOS)
        .navigationBarTitleDisplayMode(.inline)
        #endif
        .navigationDestination(isPresented: Binding(get: { conversationID != nil }, set: { if !$0 { conversationID = nil } })) {
            if let conversationID {
                PatternThreadScreen(apiClient: model.apiClient, patientID: model.patientID, conversationID: conversationID,
                                    firstQuestion: PatternThreadScreen.firstQuestion(for: pattern), title: PatternThreadScreen.title(for: pattern))
            }
        }
        // Opened: no longer "Nowy" for this caregiver (owner 2026-11-14), here and on Teraz after Wzorce close.
        .task { await model.markOpened(pattern) }
    }

    private var dismissLabel: String {
        if pattern.dismissed_until != nil { return "Pokaż znowu na liście" }
        return pattern.isSettings ? "Omówione z poradnią" : "Nie dotyczy nas"
    }

    private func openChat() async {
        isOpening = true
        defer { isOpening = false }
        do {
            conversationID = try await model.apiClient.openTherapyPatternThread(patientID: model.patientID, key: pattern.key).conversation_id
            error = nil
        } catch {
            self.error = "Nie udało się otworzyć rozmowy. Spróbuj ponownie."
        }
    }

    private func toggleDismissed() async {
        isDismissing = true
        defer { isDismissing = false }
        let hiding = pattern.dismissed_until == nil
        if await model.setDismissed(pattern, hiding) {
            #if canImport(UIKit)
            UINotificationFeedbackGenerator().notificationOccurred(.success)
            let message = hiding
                ? (pattern.isSettings ? "Ukryto do zmiany ustawień u obu opiekunów" : "Ukryto na 30 dni u obu opiekunów")
                : "Wzorzec jest znowu na liście"
            // After the screen closes, or VoiceOver drops it while the focus moves (review 2026-11-12).
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) { UIAccessibility.post(notification: .announcement, argument: message) }
            #endif
            dismiss()
        } else {
            error = "Nie udało się zapisać. Spróbuj ponownie."
        }
    }
}

/// "Kiedy" as mini charts (docs/product/wzorce-chart-review.md, checked on real data 2026-11-13): each day from 3 h
/// before the pattern's hours to 1 h after, the hours shaded, the line red under 70, the lowest point a ring, the meal
/// with a bolus a neutral tick with its time (no "N h after": the lows were not tied to the bolus), and one sentence
/// counted from the data about the other days. One VoiceOver element per day.
private struct EpisodeCharts: View {
    let chart: TherapyPattern.PatternChart
    let episodes: [TherapyPattern.Episode]
    let more: Int

    private func hour(_ minute: Int) -> String { "\(minute / 60):\(String(format: "%02d", minute % 60))" }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Kiedy").font(.headline).accessibilityAddTraits(.isHeader)
            Text(chart.comparison).font(.subheadline).fixedSize(horizontal: false, vertical: true)
            Text("Wykres pokazuje glukozę od \(hour(chart.from_minute)) do \(hour(chart.to_minute)).").font(.footnote).foregroundStyle(.secondary)
            VStack(spacing: 0) {
                ForEach(Array(episodes.enumerated()), id: \.offset) { index, episode in
                    VStack(alignment: .leading, spacing: 4) {
                        HStack(alignment: .firstTextBaseline) {
                            Text(PatternDates.weekdayShort(episode.date)).font(.subheadline.weight(.semibold))
                            Spacer(minLength: 8)
                            if let c = episode.chart, let nadir = c.nadir, let at = c.nadir_time {
                                Text("najniżej \(nadir) o \(at)").font(.subheadline).foregroundStyle(.secondary).monospacedDigit()
                            }
                        }
                        if let c = episode.chart {
                            MiniGlucoseChart(chart: chart, day: c).frame(height: 96)
                            if let low = c.low_minutes { Text("\(low) min poniżej 70").font(.footnote).foregroundStyle(.secondary) }
                        } else {
                            Text(episode.note).font(.subheadline)
                        }
                    }
                    .padding(.vertical, 10)
                    .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                    .accessibilityElement(children: .ignore)
                    .accessibilityLabel(spoken(episode))
                    if index < episodes.count - 1 { Divider() }
                }
            }
            // Start, the pattern's start at its true place, end.
            GeometryReader { geo in
                let span = CGFloat(max(1, chart.to_minute - chart.from_minute))
                let bandX = geo.size.width * CGFloat(chart.band_from_minute - chart.from_minute) / span
                ZStack(alignment: .topLeading) {
                    Text(hour(chart.from_minute))
                    Text(hour(chart.band_from_minute)).fixedSize().position(x: bandX, y: 8)
                    Text(hour(chart.to_minute)).frame(maxWidth: .infinity, alignment: .trailing)
                }
            }
            .frame(height: 16)
            .font(.caption).foregroundStyle(.secondary).accessibilityHidden(true)
            Text("Pole w tle: \(chart.band_from_minute / 60)–\(chart.band_to_minute / 60), pora tego wzorca. Niebieski trójkąt: bolus. Pomarańczowa kropka: węgle.")
                .font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true).accessibilityHidden(true)
            if more > 0 { Text("i jeszcze \(more) wcześniej").font(.footnote).foregroundStyle(.secondary) }
        }
    }

    private func spoken(_ e: TherapyPattern.Episode) -> String {
        var parts = [PatternDates.spoken(e.date)]
        if let c = e.chart {
            let start = chart.from_minute
            let at = { (m: Double) in let t = start + Int(m.rounded()); return "\(t / 60):\(String(format: "%02d", t % 60))" }
            for b in c.boluses ?? [] where b.count == 2 { parts.append("Bolus \(DashboardFormat.dose(b[1])) j o \(at(b[0]))") }
            for g in c.carbs ?? [] where g.count == 2 { parts.append("Węgle \(Int(g[1].rounded())) g o \(at(g[0]))") }
            if let n = c.nadir, let at = c.nadir_time { parts.append("Najniżej \(n) o \(at)\(c.low_minutes.map { ", \($0) min poniżej 70" } ?? "")") }
        } else {
            parts.append(PatternDates.spokenText(e.note))
        }
        return parts.joined(separator: ". ") + "."
    }
}

/// One day's line: scale from the day's own readings (bottom ≤ 40, top = the day's highest + 10), so a real, flat
/// trace still shows its low and a reading of 35 never looks like 40.
private struct MiniGlucoseChart: View {
    let chart: TherapyPattern.PatternChart
    let day: TherapyPattern.EpisodeChart
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        Canvas { context, size in
            let span = Double(max(1, chart.to_minute - chart.from_minute))
            let values = day.trace.compactMap { $0.count == 2 ? Double($0[1]) : nil }
            let bottom = min(40, (values.min() ?? 40) - 5)
            let top = max(140, (values.max() ?? 140) + 10)
            let x = { (m: Double) in m / span * size.width }
            // room above for a bolus label, below for a grams label
            let y = { (g: Double) in size.height - 18 - (g - bottom) / (top - bottom) * (size.height - 46) }
            // the pattern's hours
            let bandX = x(Double(chart.band_from_minute - chart.from_minute))
            let bandW = x(Double(chart.band_to_minute - chart.band_from_minute))
            context.fill(Path(roundedRect: CGRect(x: bandX, y: 0, width: bandW, height: size.height), cornerRadius: 4), with: .color(PatternColors.petrol.opacity(0.10)))
            // 70
            let y70 = y(70)
            var line70 = Path(); line70.move(to: CGPoint(x: 0, y: y70)); line70.addLine(to: CGPoint(x: size.width, y: y70))
            context.stroke(line70, with: .color(PatternColors.low.opacity(0.55)), style: StrokeStyle(lineWidth: 1, dash: [3, 4]))
            context.draw(Text("70").font(.system(size: 10)).foregroundStyle(PatternColors.low), at: CGPoint(x: size.width - 2, y: y70 - 7), anchor: .trailing)
            // the line, split where readings are missing (> 15 min)
            var path = Path()
            var last: Double? = nil
            for point in day.trace where point.count == 2 {
                let p = CGPoint(x: x(Double(point[0])), y: y(Double(point[1])))
                if let l = last, Double(point[0]) - l <= 15 { path.addLine(to: p) } else { path.move(to: p) }
                last = Double(point[0])
            }
            context.stroke(path, with: .color(.primary), lineWidth: 2)
            var below = context
            below.clip(to: Path(CGRect(x: 0, y: y70, width: size.width, height: size.height - y70)))
            below.stroke(path, with: .color(PatternColors.low), lineWidth: 3)
            // lowest point: a ring
            if let lowest = day.trace.filter({ $0.count == 2 }).min(by: { $0[1] < $1[1] }) {
                let c = CGPoint(x: x(Double(lowest[0])), y: y(Double(lowest[1])))
                let ring = Path(ellipseIn: CGRect(x: c.x - 4, y: c.y - 4, width: 8, height: 8))
                context.fill(ring, with: .color(scheme == .dark ? .black : .white))
                context.stroke(ring, with: .color(PatternColors.low), lineWidth: 2)
            }
            // Boluses and carbs as on Teraz (owner 2026-11-13: a grey tick did not say it was a bolus, nor how much): a blue
            // triangle over the line with its units, an orange dot on the line with its grams below. Marks closer than
            // 12 pt are one mark with their sum.
            let glucoseAt = { (m: Double) -> Double in
                let pts = day.trace.filter { $0.count == 2 }
                guard let after = pts.firstIndex(where: { Double($0[0]) >= m }) else { return Double(pts.last?[1] ?? 100) }
                guard after > 0 else { return Double(pts[after][1]) }
                let a = pts[after - 1], b = pts[after]
                let f = (m - Double(a[0])) / max(1, Double(b[0] - a[0]))
                return Double(a[1]) + f * Double(b[1] - a[1])
            }
            func merged(_ rows: [[Double]]?) -> [(x: CGFloat, value: Double, m: Double)] {
                var out: [(x: CGFloat, value: Double, m: Double)] = []
                for r in (rows ?? []) where r.count == 2 {
                    let px = x(r[0])
                    if let last = out.last, px - last.x < 12 { out[out.count - 1].value += r[1] } else { out.append((px, r[1], r[0])) }
                }
                return out
            }
            let font = Font.system(size: 11, weight: .bold)
            for carb in merged(day.carbs) {
                let cy = y(glucoseAt(carb.m))
                let dot = CGRect(x: carb.x - 4, y: cy - 4, width: 8, height: 8)
                context.fill(Path(ellipseIn: dot.insetBy(dx: -1.5, dy: -1.5)), with: .color(scheme == .dark ? .black : .white))
                context.fill(Path(ellipseIn: dot), with: .color(.orange))
                context.draw(Text("\(Int(carb.value.rounded())) g").font(font).foregroundStyle(PatternColors.carbText),
                             at: CGPoint(x: min(max(carb.x, 14), size.width - 14), y: min(cy + 13, size.height - 1)), anchor: .center)
            }
            for bolus in merged(day.boluses) {
                let ly = y(glucoseAt(bolus.m))
                let tip = max(ly - 7, 22)
                var tri = Path()
                tri.move(to: CGPoint(x: bolus.x, y: tip))
                tri.addLine(to: CGPoint(x: bolus.x - 4.5, y: tip - 8))
                tri.addLine(to: CGPoint(x: bolus.x + 4.5, y: tip - 8))
                tri.closeSubpath()
                context.fill(tri, with: .color(DashboardPalette.insulin))
                context.draw(Text("\(DashboardFormat.dose(bolus.value)) j").font(font).foregroundStyle(DashboardPalette.insulin),
                             at: CGPoint(x: min(max(bolus.x, 14), size.width - 14), y: tip - 15), anchor: .center)
            }
        }
        .accessibilityHidden(true)
    }
}

/// The pattern's conversation: the same chat as in Rozmowy.
private struct PatternThreadScreen: View {
    @StateObject private var viewModel: ConversationViewModel
    private let conversationID: String
    private let firstQuestion: String
    private let title: String

    init(apiClient: APIClient, patientID: String, conversationID: String, firstQuestion: String = PatternThreadScreen.firstQuestion, title: String = "Rozmowa o wzorcu") {
        _viewModel = StateObject(wrappedValue: ConversationViewModel(apiClient: apiClient, patientID: patientID, conversationID: conversationID))
        self.conversationID = conversationID
        self.firstQuestion = firstQuestion
        self.title = title
    }

    var body: some View {
        ConversationView(viewModel: viewModel, conversationID: conversationID)
            .navigationTitle(title)
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .task { await askFirstQuestion() }
    }

    /// A new conversation starts with the question, so the answer comes without typing (the roles' review: an empty
    /// chat left nothing to start from). Only once: a conversation with any message is left as it is.
    private func askFirstQuestion() async {
        for _ in 0..<40 {
            if let conversation = viewModel.conversation, conversation.id == conversationID {
                if conversation.messages.isEmpty { await viewModel.submitSuggestedFollowUp(firstQuestion) }
                return
            }
            try? await Task.sleep(nanoseconds: 250_000_000)
        }
    }

    static let firstQuestion = "Co może tłumaczyć ten wzorzec?"

    /// A fact is not a pattern: its own first question and title.
    static func firstQuestion(for pattern: TherapyPattern) -> String {
        switch pattern.id {
        case "NIGHT_LOWS": return "Co mogło spowodować ten spadek?"
        case "TIME_BELOW_GOAL": return "Co może tłumaczyć ten czas poniżej 70?"
        default: return firstQuestion
        }
    }

    static func title(for pattern: TherapyPattern) -> String {
        switch pattern.id {
        case "NIGHT_LOWS": return "Rozmowa o nocy"
        case "TIME_BELOW_GOAL": return "Rozmowa o spadkach"
        default: return "Rozmowa o wzorcu"
        }
    }
}

private enum PatternStyle {
    static func icon(_ id: String) -> String {
        switch id {
        // Lows share one shape, not only the red (colour-blind and in the sun): an arrow down.
        case "NIGHT_LOWS", "TIME_BELOW_GOAL", "DAY_LOWS_WITHOUT_FOOD", "LOWS_AFTER_MEAL_BOLUS": return "arrow.down.circle"
        case "MEAL_RISES_SAME_TIME": return "fork.knife"
        case "RESCUE_REBOUND": return "arrow.up.forward"
        default: return "slider.horizontal.3"
        }
    }

    /// Lows in red, everything else in the brand colour.
    static func tint(_ pattern: TherapyPattern) -> Color { pattern.isLows ? PatternColors.low : PatternColors.petrol }
}

private enum PatternDates {
    private static let input: DateFormatter = {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.dateFormat = "yyyy-MM-dd"
        return f
    }()
    private static let shortFormat: DateFormatter = {
        let f = DateFormatter()
        f.locale = Locale(identifier: "pl_PL")
        f.dateFormat = "d.MM"
        return f
    }()
    private static let weekdayFormat: DateFormatter = {
        let f = DateFormatter()
        f.locale = Locale(identifier: "pl_PL")
        f.dateFormat = "EEE d.MM"
        return f
    }()

    private static let spokenFormat: DateFormatter = {
        let f = DateFormatter()
        f.locale = Locale(identifier: "pl_PL")
        f.dateFormat = "EEEE, d MMMM"
        return f
    }()

    static func short(_ iso: String) -> String { input.date(from: iso).map { shortFormat.string(from: $0) } ?? iso }
    /// "środa, 11 listopada" for VoiceOver.
    static func spoken(_ iso: String) -> String { input.date(from: iso).map { spokenFormat.string(from: $0) } ?? iso }

    private static let months = ["stycznia", "lutego", "marca", "kwietnia", "maja", "czerwca", "lipca", "sierpnia", "września", "października", "listopada", "grudnia"]

    /// Text for VoiceOver: "6.11" → "6 listopada", "18–24" → "od 18 do 24", "·" → ",", "→" → "na".
    static func spokenText(_ text: String) -> String {
        var out = text
        if let regex = try? NSRegularExpression(pattern: #"\b(\d{1,2})\.(\d{1,2})\b(?![.,]?\d)"#) {
            let ns = out as NSString
            for match in regex.matches(in: out, range: NSRange(location: 0, length: ns.length)).reversed() {
                let day = ns.substring(with: match.range(at: 1)); let month = Int(ns.substring(with: match.range(at: 2))) ?? 0
                guard (1...12).contains(month) else { continue }
                out = (out as NSString).replacingCharacters(in: match.range, with: "\(day) \(months[month - 1])")
            }
        }
        if let regex = try? NSRegularExpression(pattern: #"(\d{1,2}(?::\d{2})?)–(\d{1,2}(?::\d{2})?)"#) {
            out = regex.stringByReplacingMatches(in: out, range: NSRange(location: 0, length: (out as NSString).length), withTemplate: "od $1 do $2")
        }
        return out.replacingOccurrences(of: " · ", with: ", ").replacingOccurrences(of: "→", with: "na")
    }
    static func weekdayShort(_ iso: String) -> String { input.date(from: iso).map { weekdayFormat.string(from: $0) } ?? iso }
}

private enum PatternColors {
    /// Titles, icons and the progress bar: petrol in light mode, a light teal in dark mode (fixed petrol vanished there).
    static let petrol = Brand.petrol
    /// Filled buttons with white text.
    static let button = Brand.interactive
    /// The "Nowy" chip: the teal tile with its glyph colour (readable in both modes).
    static let chip = BrandTint.teal.background
    static let chipText = BrandTint.teal.glyph
    static let low = Brand.dynamic(light: 0xC4302B, dark: 0xFF7A70)
    /// A number on the change card that got better (owner 2026-11-23: worse red, better green).
    static let better = Brand.dynamic(light: 0x1E7B34, dark: 0x4CD964)
    /// The grams under a carb dot, as on the Teraz chart (the dot's orange is too faint as text).
    static let carbText = Brand.dynamic(light: 0xB35E00, dark: 0xF0A861)
    #if canImport(UIKit)
    static let tile = Color(uiColor: .secondarySystemBackground)
    static let border = Color(uiColor: .separator)
    #else
    static let tile = Color.secondary.opacity(0.12)
    static let border = Color.secondary.opacity(0.3)
    #endif
}
