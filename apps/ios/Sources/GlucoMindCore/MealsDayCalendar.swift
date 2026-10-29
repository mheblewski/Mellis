import SwiftUI

/// A day's dot in the week strip and the month grid.
public enum MealsDayMarker: Equatable {
    case none
    case entries
}

public extension Calendar {
    /// Polish weekday and month names whatever the phone's language (the app is Polish only), weeks from Monday.
    static var polish: Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.locale = Locale(identifier: "pl_PL")
        calendar.timeZone = .current
        calendar.firstWeekday = 2
        return calendar
    }
}

/// "Posiłki" as large as the system's large title, with the refresh spinner right next to it in a slot of its own, and
/// the month button that opens the month grid.
struct MealsTitle: View {
    let pull: PullModel
    let month: String
    @Binding var showsMonth: Bool
    /// Off while the search shows its results instead of the calendar.
    var showsMonthButton = true
    /// From a list section header's inset to the screen's margin (-16); 0 above a list.
    var edgeInset: CGFloat = -16

    var body: some View {
        HStack(spacing: 10) {
            Text("Posiłki")
                .font(.largeTitle.weight(.bold))
                // Color.primary, not .primary: in a section header .primary resolves to the header's grey.
                .foregroundStyle(Color.primary)
                .accessibilityAddTraits(.isHeader)
            PullRefreshSpinner(pull: pull)
            Spacer(minLength: 0)
            if showsMonthButton {
                monthButton
            }
        }
        .textCase(nil)
        // From the section's inset to the screen's margin, where the large title was.
        .padding(.leading, edgeInset)
        .padding(.trailing, edgeInset)
        .padding(.bottom, 6)
    }

    private var monthButton: some View {
            Button {
                withAnimation(.snappy) { showsMonth.toggle() }
            } label: {
                HStack(spacing: 4) {
                    Text(month.components(separatedBy: " ").first ?? month)
                    Image(systemName: showsMonth ? "chevron.up" : "chevron.down").font(.caption.weight(.bold))
                }
                .font(.subheadline.weight(.semibold))
                .padding(.horizontal, 12)
                .padding(.vertical, 6)
                .background(Capsule().fill(Color.secondary.opacity(0.15)))
                .foregroundStyle(Color.primary)
            }
            .buttonStyle(.plain)
            .accessibilityLabel(showsMonth ? "Zwiń kalendarz" : "Pokaż cały miesiąc")
    }
}

/// The selected day's week, Monday to Sunday, with the same dots as the month grid; arrows move by a week.
struct MealsWeekStrip: View {
    @ObservedObject var viewModel: MealJournalViewModel
    /// The chosen day's mark is one shape that slides from day to day.
    @Namespace private var selection
    /// Where the next week comes from: an earlier one from the left.
    @State private var comesFrom: Edge = .leading

    var body: some View {
        let week = viewModel.weekOfSelectedDay
        HStack(spacing: 0) {
            weekButton(-1, systemImage: "chevron.left", label: "Poprzedni tydzień")
            ZStack {
                HStack(spacing: 0) {
                    ForEach(week, id: \.self) { day in
                        dayCell(day)
                    }
                }
                .id(week.first)
                .transition(.asymmetric(insertion: .move(edge: comesFrom).combined(with: .opacity), removal: .move(edge: comesFrom == .leading ? .trailing : .leading).combined(with: .opacity)))
            }
            .clipped()
            weekButton(1, systemImage: "chevron.right", label: "Następny tydzień")
                .disabled(!viewModel.canShowNextWeek)
        }
        .animation(.snappy(duration: 0.3), value: viewModel.selectedDay)
        .animation(.snappy(duration: 0.3), value: week.first)
        .onChange(of: week.first) { old, new in
            guard let old, let new else { return }
            comesFrom = new < old ? .leading : .trailing
        }
    }

    private func weekButton(_ weeks: Int, systemImage: String, label: String) -> some View {
        Button {
            Task { await viewModel.showWeek(offset: weeks) }
        } label: {
            Image(systemName: systemImage)
                .font(.footnote.weight(.semibold))
                .frame(width: 26, height: 52)
                .contentShape(Rectangle())
        }
        .buttonStyle(.borderless)
        .accessibilityLabel(label)
    }

    private func dayCell(_ day: Date) -> some View {
        let isSelected = viewModel.calendar.isDate(day, inSameDayAs: viewModel.selectedDay)
        let isToday = viewModel.calendar.isDateInToday(day)
        let isFuture = viewModel.isFuture(day)
        let marker = viewModel.marker(for: day)
        return Button {
            Task { await viewModel.select(day) }
        } label: {
            VStack(spacing: 2) {
                Text(viewModel.shortWeekday(day))
                    .font(.caption2)
                    .foregroundStyle(isSelected ? Color.white.opacity(0.85) : Color.secondary)
                Text("\(viewModel.calendar.component(.day, from: day))")
                    .font(.body.weight(isToday || isSelected ? .semibold : .regular))
                    .foregroundStyle(isSelected ? Color.white : (isFuture ? Color.secondary.opacity(0.5) : (isToday ? Color.accentColor : Color.primary)))
                Circle()
                    .fill(marker == .entries ? Color.secondary.opacity(0.6) : Color.clear)
                    .frame(width: 5, height: 5)
            }
            .frame(maxWidth: .infinity, minHeight: 52)
            .background {
                if isSelected {
                    RoundedRectangle(cornerRadius: 12)
                        .fill(Color.accentColor)
                        .matchedGeometryEffect(id: "selected-day", in: selection)
                }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(isFuture)
        .accessibilityLabel(MealsCalendarText.accessibilityLabel(day, marker: marker))
    }
}

struct MealsMonthCalendar: View {
    @ObservedObject var viewModel: MealJournalViewModel
    @Namespace private var selection

    private let columns = Array(repeating: GridItem(.flexible(), spacing: 2), count: 7)

    var body: some View {
        VStack(spacing: 12) {
            HStack {
                Button {
                    Task { await viewModel.showMonth(offset: -1) }
                } label: {
                    Image(systemName: "chevron.left")
                        .font(.title3.weight(.semibold))
                        .frame(width: 44, height: 44)
                        .contentShape(Rectangle())
                }
                .accessibilityLabel("Poprzedni miesiąc")

                Spacer()
                Text(MealsCalendarText.monthTitle(viewModel.displayedMonth))
                    .font(.title3.weight(.semibold))
                Spacer()

                Button {
                    Task { await viewModel.showMonth(offset: 1) }
                } label: {
                    Image(systemName: "chevron.right")
                        .font(.title3.weight(.semibold))
                        .frame(width: 44, height: 44)
                        .contentShape(Rectangle())
                }
                .disabled(!viewModel.canShowNextMonth)
                .accessibilityLabel("Następny miesiąc")
            }
            .buttonStyle(.borderless)
            .frame(minHeight: 52)

            LazyVGrid(columns: columns, spacing: 4) {
                ForEach(Array(viewModel.weekdaySymbols.enumerated()), id: \.offset) { _, symbol in
                    Text(symbol)
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(.secondary)
                }
                ForEach(Array(viewModel.monthGrid.enumerated()), id: \.offset) { _, day in
                    if let day {
                        dayCell(day)
                    } else {
                        Color.clear.frame(height: 40)
                    }
                }
            }
        }
        .animation(.snappy(duration: 0.3), value: viewModel.selectedDay)
    }

    private func dayCell(_ day: Date) -> some View {
        let isSelected = viewModel.calendar.isDate(day, inSameDayAs: viewModel.selectedDay)
        let isToday = viewModel.calendar.isDateInToday(day)
        let isFuture = viewModel.isFuture(day)
        let marker = viewModel.marker(for: day)
        return Button {
            Task { await viewModel.select(day) }
        } label: {
            VStack(spacing: 3) {
                Text("\(viewModel.calendar.component(.day, from: day))")
                    .font(.callout.weight(isToday || isSelected ? .semibold : .regular))
                    .foregroundStyle(isSelected ? Color.white : (isFuture ? Color.secondary.opacity(0.5) : (isToday ? Color.accentColor : Color.primary)))
                    .frame(width: 30, height: 30)
                    .background {
                        if isSelected {
                            Circle()
                                .fill(Color.accentColor)
                                .matchedGeometryEffect(id: "selected-day", in: selection)
                        }
                    }
                Circle()
                    .fill(marker == .entries ? Color.secondary.opacity(0.6) : Color.clear)
                    .frame(width: 5, height: 5)
            }
            .frame(maxWidth: .infinity, minHeight: 40)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(isFuture)
        .accessibilityLabel(MealsCalendarText.accessibilityLabel(day, marker: marker))
    }
}

enum MealsCalendarText {
    static func monthTitle(_ month: Date) -> String {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "pl_PL")
        formatter.setLocalizedDateFormatFromTemplate("LLLLyyyy")
        let label = formatter.string(from: month)
        return label.prefix(1).uppercased() + label.dropFirst()
    }

    static func accessibilityLabel(_ day: Date, marker: MealsDayMarker) -> String {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "pl_PL")
        formatter.setLocalizedDateFormatFromTemplate("dMMMM")
        switch marker {
        case .entries: return "\(formatter.string(from: day)), są wpisy"
        case .none: return formatter.string(from: day)
        }
    }
}
