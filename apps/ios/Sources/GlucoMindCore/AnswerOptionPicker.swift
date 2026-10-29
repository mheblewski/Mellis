import SwiftUI

/// The options of an answer as cards (answer-options.v1): the chosen one unfolded with its timeline and button, the
/// others folded to their doses ("0 j teraz · ok. 2,9 j później") and forecast; "Własny plan" last opens the keyboard.
/// Once something of an option was sent, the others are dimmed and locked.
struct AnswerOptionList<Cards: View>: View {
    let presentation: AnswerOptionsPresentation
    let message: ConversationMessage
    let onSelect: (String) -> Void
    /// The unfolded option's cards (bolus and rescue), drawn without their own frame.
    @ViewBuilder let cards: (String) -> Cards

    var body: some View {
        VStack(spacing: 8) {
            ForEach(presentation.options) { option in
                optionCard(option)
            }
            if presentation.lockedKey == nil {
                ownPlanRow
            }
        }
        .sensoryFeedback(.selection, trigger: presentation.selectedKey)
    }

    private func optionCard(_ option: AnswerOption) -> some View {
        let selected = presentation.selectedKey == option.key
        let locked = presentation.lockedKey != nil && presentation.lockedKey != option.key
        return VStack(alignment: .leading, spacing: 0) {
            Button {
                if !selected { onSelect(option.key) }
            } label: {
                HStack(alignment: .center, spacing: 10) {
                    radio(selected)
                    VStack(alignment: .leading, spacing: 2) {
                        HStack(alignment: .firstTextBaseline, spacing: 6) {
                            Text("\(option.key). \(option.title)")
                                .font(.subheadline.weight(.semibold))
                                .foregroundStyle(.primary)
                                .fixedSize(horizontal: false, vertical: true)
                            if option.recommended {
                                Text("polecam")
                                    .font(.caption2.weight(.semibold))
                                    .padding(.horizontal, 6)
                                    .padding(.vertical, 2)
                                    .foregroundStyle(Color.accentColor)
                                    .background(Capsule().fill(Color.accentColor.opacity(0.16)))
                                    .fixedSize()
                            }
                        }
                        // What the cards do not show, in small print (orange for a ⚠️ risk).
                        if let note = option.note, !note.isEmpty {
                            Text(note)
                                .font(.caption)
                                .foregroundStyle(note.hasPrefix("⚠") ? Color.orange : Color.secondary)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                        // Folded: the doses in one line; unfolded, the timeline below shows them.
                        if !selected {
                            Text(locked ? "wybrano opcję \(presentation.lockedKey ?? "")" : presentation.summary(of: option.key, in: message))
                                .font(.footnote)
                                .foregroundStyle(.secondary)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                    }
                    Spacer(minLength: 4)
                    if let minimum = presentation.forecastMinimum(of: option.key, in: message) {
                        ForecastLabel(minimum: minimum)
                    }
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 10)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .disabled(locked)
            .accessibilityAddTraits(selected ? .isSelected : [])

            if selected {
                VStack(alignment: .leading, spacing: 14) {
                    cards(option.key)
                }
                .padding(.horizontal, 12)
                .padding(.bottom, 12)
                .transition(.opacity)
            }
        }
        .background(
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .fill(selected ? Color.accentColor.opacity(0.08) : Color.secondary.opacity(0.08))
        )
        .overlay(
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .strokeBorder(selected ? Color.accentColor : Color.clear, lineWidth: 1.5)
        )
        .opacity(locked ? 0.45 : 1)
        .accessibilityElement(children: .contain)
    }

    private var ownPlanRow: some View {
        let selected = presentation.isOwnPlan
        return Button {
            onSelect(AnswerOptionsPresentation.ownPlanKey)
        } label: {
            HStack(spacing: 10) {
                radio(selected)
                VStack(alignment: .leading, spacing: 2) {
                    Text("Własny plan")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(.primary)
                    Text("Napisz w czacie, co chcesz zrobić")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 10)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(
                RoundedRectangle(cornerRadius: 16, style: .continuous)
                    .fill(selected ? Color.accentColor.opacity(0.08) : Color.secondary.opacity(0.08))
            )
            .overlay(
                RoundedRectangle(cornerRadius: 16, style: .continuous)
                    .strokeBorder(selected ? Color.accentColor : Color.clear, lineWidth: 1.5)
            )
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(selected ? .isSelected : [])
    }

    private func radio(_ selected: Bool) -> some View {
        ZStack {
            Circle()
                .strokeBorder(selected ? Color.accentColor : Color.secondary.opacity(0.5), lineWidth: 2)
            Circle()
                .fill(Color.accentColor)
                .scaleEffect(selected ? 1 : 0.2)
                .opacity(selected ? 1 : 0)
            Image(systemName: "checkmark")
                .font(.system(size: 10, weight: .bold))
                .foregroundStyle(.white)
                .opacity(selected ? 1 : 0)
        }
        .frame(width: 20, height: 20)
    }
}
