import SwiftUI
import GlucoMindCore

/// One step of a loop's remote control setup (Trio's or Loop's): a numbered dot (a check once done, "!" when something
/// is wrong), the title, a one-line summary while folded, and the step's content when open.
struct RemoteSetupStepCard<Content: View>: View {
    let number: Int
    let title: String
    let summary: String?
    let done: Bool
    let isOpen: Bool
    /// Something about this step needs the caregiver (another Trio / Loop in Nightscout).
    var problem = false
    /// Not the next step to do: shown dimmed while folded.
    var dimmed = false
    let onToggle: () -> Void
    @ViewBuilder let content: () -> Content

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Button(action: onToggle) {
                HStack(spacing: 10) {
                    dot
                    VStack(alignment: .leading, spacing: 2) {
                        Text(title).font(.body.weight(.semibold)).foregroundStyle(.primary)
                        if !isOpen, let summary {
                            Text(summary).font(.footnote).foregroundStyle(.secondary).lineLimit(2)
                        }
                    }
                    Spacer(minLength: 6)
                    Image(systemName: "chevron.down")
                        .font(.footnote.weight(.semibold))
                        .foregroundStyle(.tertiary)
                        .rotationEffect(.degrees(isOpen ? 180 : 0))
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)

            if isOpen {
                VStack(alignment: .leading, spacing: 10) {
                    content()
                }
                .padding(.top, 12)
            }
        }
        .padding(14)
        .background(RoundedRectangle(cornerRadius: 16, style: .continuous).fill(DashboardPalette.cardBackground))
        .overlay(
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .stroke(isOpen && !done ? Color.accentColor.opacity(0.5) : Color.clear, lineWidth: 1)
        )
        .opacity(!done && !isOpen && dimmed ? 0.6 : 1)
    }

    private var dot: some View {
        ZStack {
            Circle().fill(problem ? Color.orange.opacity(0.18) : done ? Color.green.opacity(0.18) : isOpen ? Color.accentColor.opacity(0.18) : Color.secondary.opacity(0.15))
            if problem {
                Image(systemName: "exclamationmark").font(.footnote.weight(.bold)).foregroundStyle(.orange)
            } else if done {
                Image(systemName: "checkmark").font(.footnote.weight(.bold)).foregroundStyle(.green)
            } else {
                Text("\(number)").font(.footnote.weight(.semibold)).foregroundStyle(isOpen ? Color.accentColor : .secondary)
            }
        }
        .frame(width: 28, height: 28)
    }
}
