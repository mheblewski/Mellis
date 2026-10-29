import SwiftUI
#if canImport(UIKit)
import UIKit
#endif

/// "Mellis" as in the logo files: the word in the text colour, the amber glucose reading in place of the dot over the
/// "i". The size comes from the caller's `.font`; the dot follows it.
public enum BrandWordmark {
    public static func text() -> some View {
        Wordmark()
    }

    private struct Wordmark: View {
        var body: some View {
            // Color.primary, not .primary: inside a list header .primary would dim to the header's grey.
            HStack(spacing: 0) {
                Text("Mell")
                // A dotless "ı" with the reading drawn over it, so the dot is the logo's amber one, not the font's.
                Text("\u{0131}")
                    .overlay {
                        GeometryReader { proxy in
                            // Measured on the system font: the line is about 1.19 em tall with the baseline at 0.95 em,
                            // so a dot 0.17 em wide sits just above the x-height.
                            let dot = proxy.size.height * 0.143
                            Circle()
                                .fill(Brand.amber)
                                .frame(width: dot, height: dot)
                                .position(x: proxy.size.width / 2, y: proxy.size.height * 0.252)
                        }
                    }
                Text("s")
            }
            .foregroundStyle(Color.primary)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("Mellis")
        }
    }
}

/// An empty new conversation: the logo, "Mellis", a greeting and three starter cards, centred on the screen. The
/// logo and the name come in at once (a tap on the hummingbird makes it greet); the cards follow one after another when the glucose for the first one is known
/// (or after a short wait), so the first card never changes right after it appears.
struct NewConversationStartView: View {
    enum PhotoSource { case camera, library }

    let greetingName: String?
    let glucose: DashboardGlucose?
    /// The dashboard read for the first card has ended.
    let glucoseSettled: Bool
    /// Remote control is set up on this phone: the meal card also asks for the bolus.
    let bolusCards: Bool
    let canSend: Bool
    let canAddPhoto: Bool
    let onSend: (String) -> Void
    let onMealPhoto: (PhotoSource) -> Void

    @State private var headerRevealed = false
    @State private var cardsRevealed = false

    /// The longest the cards wait for the glucose before coming in with the time of day's first card.
    private static let glucoseWait: Duration = .milliseconds(600)

    var body: some View {
        // Every minute, so the first card and the greeting follow the time of day while the screen stays open.
        TimelineView(.everyMinute) { context in
            VStack(spacing: 0) {
                // Still, so the screen stays calm; a tap on it makes the hummingbird greet.
                HummingbirdMark(size: 76)
                    .modifier(Entrance(revealed: headerRevealed, delay: 0, offset: 6, scale: 0.86))
                BrandWordmark.text()
                    .font(.system(size: 32, weight: .bold))
                    .padding(.top, 16)
                    .accessibilityLabel("Mellis")
                    .modifier(Entrance(revealed: headerRevealed, delay: 0.07, offset: 10))
                Text(ConversationStarters.greeting(name: greetingName, now: context.date))
                    .font(.body)
                    .foregroundStyle(.secondary)
                    .padding(.top, 6)
                    .modifier(Entrance(revealed: headerRevealed, delay: 0.12, offset: 10))

                let starters = ConversationStarters.make(glucose: glucose, now: context.date, bolusCards: bolusCards)
                VStack(spacing: 12) {
                    ForEach(Array(starters.enumerated()), id: \.element.id) { index, starter in
                        card(starter)
                            .modifier(Entrance(revealed: cardsRevealed, delay: 0.05 + Double(index) * 0.07, offset: 16))
                    }
                }
                .padding(.top, 44)
                // Later changes (the glucose leaving the range, the evening) cross-fade the first card.
                .animation(.easeInOut(duration: 0.25), value: starters.first)
            }
            .padding(.horizontal, 6)
        }
        .onAppear { headerRevealed = true }
        .task {
            if !glucoseSettled {
                try? await Task.sleep(for: Self.glucoseWait)
            }
            cardsRevealed = true
        }
        .onChange(of: glucoseSettled) { _, settled in
            if settled { cardsRevealed = true }
        }
    }

    @ViewBuilder
    private func card(_ starter: ConversationStarter) -> some View {
        switch starter.action {
        case .send(let question):
            Button {
                onSend(question)
            } label: {
                StarterCardLabel(starter: starter)
            }
            .buttonStyle(.plain)
            .disabled(!canSend)
            .accessibilityHint(starter.isHot ? "Polecane pytanie. Wysyła to pytanie" : "Wysyła to pytanie")
        case .mealPhoto:
            Menu {
                #if os(iOS)
                if UIImagePickerController.isSourceTypeAvailable(.camera) {
                    Button {
                        onMealPhoto(.camera)
                    } label: {
                        Label("Aparat", systemImage: "camera")
                    }
                }
                #endif
                Button {
                    onMealPhoto(.library)
                } label: {
                    Label("Zdjęcia", systemImage: "photo")
                }
            } label: {
                StarterCardLabel(starter: starter)
            }
            .buttonStyle(.plain)
            .disabled(!canSend || !canAddPhoto)
            .accessibilityHint("Dodaje zdjęcie posiłku do wiadomości")
        }
    }
}

/// Fades in and rises a little (a spring), in its turn; with Reduce Motion it only fades.
private struct Entrance: ViewModifier {
    let revealed: Bool
    let delay: Double
    var offset: CGFloat = 12
    var scale: CGFloat = 1
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    func body(content: Content) -> some View {
        let moves = !revealed && !reduceMotion
        content
            .opacity(revealed ? 1 : 0)
            .offset(y: moves ? offset : 0)
            .scaleEffect(moves ? scale : 1)
            .animation(
                reduceMotion ? .easeOut(duration: 0.2) : .spring(response: 0.55, dampingFraction: 0.82).delay(delay),
                value: revealed
            )
    }
}

private struct StarterCardLabel: View {
    let starter: ConversationStarter
    @Environment(\.isEnabled) private var isEnabled

    var body: some View {
        let shape = RoundedRectangle(cornerRadius: 20, style: .continuous)
        HStack(spacing: 14) {
            Image(systemName: starter.systemImage)
                .font(.system(size: 17, weight: .medium))
                .foregroundStyle(Color.accentColor)
                .frame(width: 38, height: 38)
                .background(Color.accentColor.opacity(0.1), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 3) {
                Text(starter.title)
                    .font(.system(size: 16, weight: .semibold))
                    .foregroundStyle(.primary)
                subtitle
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
            .multilineTextAlignment(.leading)
            .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 0)
            Image(systemName: "chevron.right")
                .font(.footnote.weight(.semibold))
                .foregroundStyle(.tertiary)
                .accessibilityHidden(true)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 15)
        .background {
            shape.fill(Self.cardBackground)
            if starter.isHot {
                BrandGradientBorder(cornerRadius: 20)
            } else {
                shape.strokeBorder(Self.hairline, lineWidth: 0.5)
            }
        }
        .contentShape(shape)
        .opacity(isEnabled ? 1 : 0.5)
        .accessibilityElement(children: .combine)
    }

    private var subtitle: Text {
        guard let highlight = starter.highlight, starter.subtitle.hasPrefix(highlight) else {
            return Text(starter.subtitle)
        }
        return Text(highlight).foregroundStyle(Self.color(starter.highlightLevel)).fontWeight(.semibold)
            + Text(starter.subtitle.dropFirst(highlight.count))
    }

    /// The dashboard's yellow and red for glucose out of range.
    private static func color(_ level: DashboardLevel?) -> Color {
        switch level {
        case .alarm: return Color(red: 1.0, green: 0.231, blue: 0.188)
        case .warning: return Color(red: 0.878, green: 0.631, blue: 0.0)
        default: return .secondary
        }
    }

    #if canImport(UIKit)
    /// White on the white page in light mode, raised grey on black in dark mode.
    private static let cardBackground = Color(uiColor: .secondarySystemGroupedBackground)
    private static let hairline = Color(uiColor: .separator)
    #else
    private static let cardBackground = Color(nsColor: .controlBackgroundColor)
    private static let hairline = Color(nsColor: .separatorColor)
    #endif
}
