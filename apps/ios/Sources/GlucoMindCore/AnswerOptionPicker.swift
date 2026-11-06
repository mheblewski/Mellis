import SwiftUI

/// The options of an answer as cards (answer-options.v1): the chosen one unfolded with its timeline and button, the
/// others folded to their doses ("0 j teraz · ok. 2,9 j później") and forecast; "Własny plan" last opens the keyboard.
/// Once something of an option was sent, the others are dimmed and locked.
/// An option's cards, always laid out and measured: unfolding changes the height itself, in the same animation that moves
/// the headers below, so the body and the headers move as one.
private struct UnfoldingBody<Content: View>: View {
    let isOpen: Bool
    @ViewBuilder let content: Content
    @State private var height: CGFloat?

    var body: some View {
        content
            .fixedSize(horizontal: false, vertical: true)
            .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { height = $0 }
            .frame(height: isOpen ? height : 0, alignment: .top)
            .frame(maxWidth: .infinity, alignment: .leading)
            .clipped()
            .opacity(isOpen ? 1 : 0)
            .allowsHitTesting(isOpen)
            .accessibilityHidden(!isOpen)
    }
}

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
                    VStack(alignment: .leading, spacing: 0) {
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
                                .padding(.top, 2)
                        }
                        // Folded: the doses in one line; unfolded, the timeline below shows them.
                        UnfoldingBody(isOpen: !selected) {
                            Text(locked ? "wybrano opcję \(presentation.lockedKey ?? "")" : presentation.summary(of: option.key, in: message))
                                .font(.footnote)
                                .foregroundStyle(.secondary)
                                .fixedSize(horizontal: false, vertical: true)
                                .padding(.top, 2)
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
            // The header moves as one with the card's frame, not each text on its own.
            .geometryGroup()

            UnfoldingBody(isOpen: selected) {
                VStack(alignment: .leading, spacing: 14) {
                    cards(option.key)
                }
                .padding(.horizontal, 12)
                .padding(.bottom, 12)
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
        .geometryGroup()
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

/// The complete cards taking the loader's place in one fade, with no empty moment between them.
struct LoaderToCards: View {
    let cards: AnyView
    @State private var isShown = false

    var body: some View {
        ZStack(alignment: .top) {
            cards.opacity(isShown ? 1 : 0)
            if !isShown {
                AnswerCardsLoader()
                    .transition(.opacity)
            }
        }
        .onAppear {
            withAnimation(.easeInOut(duration: 0.3)) { isShown = true }
        }
    }
}

/// Where the answer's cards will stand (cards-after-text.v1): the outline of a card with a soft light passing over it, so
/// the cards come in complete and ready, not part by part. Reduce Motion: the outline alone.
struct AnswerCardsLoader: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private static let sweep: TimeInterval = 1.5

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(spacing: 8) {
                ProgressView()
                    .controlSize(.small)
                Text("Przygotowuję kartę")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(.secondary)
            }
            shimmering(outline)
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .fill(Color.secondary.opacity(0.08))
        )
        .padding(.top, 4)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Przygotowuję kartę")
    }

    /// The card's parts: the steps of its timeline and its button.
    private var outline: some View {
        VStack(alignment: .leading, spacing: 14) {
            step(width: 150)
            step(width: 110)
            step(width: 190)
            Capsule()
                .frame(height: 46)
                .padding(.top, 2)
        }
        .foregroundStyle(Color.secondary.opacity(0.16))
    }

    private func step(width: CGFloat) -> some View {
        HStack(spacing: 12) {
            Circle()
                .frame(width: 16, height: 16)
            Capsule()
                .frame(width: width, height: 12)
        }
    }

    @ViewBuilder
    private func shimmering(_ content: some View) -> some View {
        if reduceMotion {
            content
        } else {
            content.overlay {
                TimelineView(.animation) { context in
                    GeometryReader { geometry in
                        let progress = context.date.timeIntervalSinceReferenceDate
                            .truncatingRemainder(dividingBy: Self.sweep) / Self.sweep
                        let band = geometry.size.width * 0.7
                        LinearGradient(
                            colors: [.clear, Color.primary.opacity(0.16), .clear],
                            startPoint: .leading,
                            endPoint: .trailing
                        )
                        .frame(width: band)
                        .offset(x: -band + (geometry.size.width + band) * progress)
                    }
                }
                .mask(content.foregroundStyle(Color.black))
            }
        }
    }
}
