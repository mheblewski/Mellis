import SwiftUI
import GlucoMindCore

/// The bell's list: the pushes sent for the patient, so one dismissed on the phone by accident can still be opened. One
/// whose request was done (by either caregiver) is gone; a row stays new until it is opened or all are marked read.
struct NotificationHistoryView: View {
    @ObservedObject var viewModel: NotificationHistoryViewModel
    let onOpen: (NotificationHistoryItem) -> Void
    let onClose: () -> Void

    var body: some View {
        NavigationStack {
            content
                .navigationTitle("Powiadomienia")
                #if os(iOS)
                .navigationBarTitleDisplayMode(.inline)
                #endif
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) {
                        Button("Zamknij", action: onClose)
                    }
                }
                .refreshable {
                    await viewModel.refresh()
                }
        }
    }

    @ViewBuilder
    private var content: some View {
        if viewModel.items.isEmpty {
            if viewModel.isLoading {
                ProgressView("Wczytuję…")
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if let errorMessage = viewModel.errorMessage {
                ContentUnavailableView {
                    Label(errorMessage, systemImage: "exclamationmark.triangle")
                } description: {
                    Text("Sprawdź połączenie i spróbuj ponownie.")
                } actions: {
                    Button("Spróbuj ponownie") {
                        Task { await viewModel.refresh() }
                    }
                    .buttonStyle(.bordered)
                }
            } else {
                ContentUnavailableView(
                    "Brak powiadomień",
                    systemImage: "bell.slash",
                    description: Text("Tu zobaczysz powiadomienia z aplikacji Mellis, także te odrzucone na telefonie.")
                )
            }
        } else {
            List {
                if viewModel.hasUnseen {
                    HStack {
                        Spacer()
                        Button("Oznacz wszystkie jako przeczytane") {
                            withAnimation { viewModel.markAllRead() }
                        }
                        .font(.footnote.weight(.semibold))
                        .buttonStyle(.borderless)
                    }
                    .listRowSeparator(.hidden)
                }
                ForEach(viewModel.items) { item in
                    Button {
                        onOpen(item)
                    } label: {
                        NotificationHistoryRow(item: item, isNew: viewModel.isNew(item))
                    }
                    .tint(.primary)
                }
            }
            .listStyle(.plain)
        }
    }
}

private struct NotificationHistoryRow: View {
    let item: NotificationHistoryItem
    let isNew: Bool

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: symbol)
                .font(.body)
                .foregroundStyle(Color.accentColor)
                .frame(width: 32, height: 32)
                .background(Circle().fill(Color.accentColor.opacity(0.12)))

            VStack(alignment: .leading, spacing: 3) {
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Text(item.title)
                        .font(.subheadline.weight(isNew ? .semibold : .regular))
                        .foregroundStyle(.primary)
                        .lineLimit(2)
                    Spacer(minLength: 4)
                    if let sentAt = item.sentAt {
                        Text(HistoryDateText.label(for: sentAt))
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    if isNew {
                        Circle()
                            .fill(Color.accentColor)
                            .frame(width: 8, height: 8)
                            .accessibilityHidden(true)
                    }
                }
                Text(item.body)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .lineLimit(3)
                    .multilineTextAlignment(.leading)
            }
        }
        .padding(.vertical, 4)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
        .accessibilityValue(isNew ? "Nowe" : "")
    }

    private var symbol: String {
        switch item.type {
        case "meal_description":
            return "fork.knife"
        case "wbt_reminder":
            return "clock.badge.exclamationmark"
        case "planned_bolus":
            return "clock.arrow.circlepath"
        case "rescue_carbs":
            return "exclamationmark.triangle"
        case "care_reminder":
            return "bell"
        case "dose_given":
            return "checkmark.circle"
        default:
            return item.payload.questionId == "hypo_report" ? "arrow.down.heart" : "questionmark.bubble"
        }
    }
}
