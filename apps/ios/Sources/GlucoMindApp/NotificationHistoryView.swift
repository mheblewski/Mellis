import SwiftUI
import GlucoMindCore

/// The bell's list: the pushes sent for the patient, so one dismissed on the phone by accident can still be opened. One
/// whose request was done (by either caregiver) is gone; a row stays new until it is opened or all are marked read.
/// "Usuń" takes a row off this phone's list only, with 10 s to take it back.
struct NotificationHistoryView: View {
    @ObservedObject var viewModel: NotificationHistoryViewModel
    let onOpen: (NotificationHistoryItem) -> Void
    let onClose: () -> Void
    @State private var removed: NotificationHistoryItem?

    var body: some View {
        NavigationStack {
            content
                .safeAreaInset(edge: .bottom, spacing: 0) {
                    if let removed { undoBar(removed) }
                }
                .task(id: removed?.id) {
                    guard removed != nil else { return }
                    try? await Task.sleep(nanoseconds: 10_000_000_000)
                    guard !Task.isCancelled else { return }
                    withAnimation { removed = nil }
                }
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
        if viewModel.visibleItems.isEmpty {
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
                ForEach(viewModel.visibleItems) { item in
                    Button {
                        onOpen(item)
                    } label: {
                        NotificationHistoryRow(item: item, isNew: viewModel.isNew(item))
                    }
                    .tint(.primary)
                    .swipeActions(edge: .trailing, allowsFullSwipe: true) {
                        if viewModel.canHide(item) {
                            Button("Usuń", role: .destructive) {
                                withAnimation {
                                    viewModel.hide(item)
                                    removed = item
                                }
                            }
                        }
                    }
                }
            }
            .listStyle(.plain)
        }
    }
}

extension NotificationHistoryView {
    fileprivate func undoBar(_ item: NotificationHistoryItem) -> some View {
        HStack(spacing: 8) {
            Text("Usunięto z Twojej listy.")
                .font(.subheadline)
            Spacer(minLength: 4)
            Button("Cofnij") {
                withAnimation {
                    viewModel.unhide(item)
                    removed = nil
                }
            }
            .font(.subheadline.weight(.bold))
            .frame(minHeight: 44)
        }
        .padding(.leading, 16)
        .padding(.trailing, 12)
        .glassBubble(in: RoundedRectangle(cornerRadius: 18, style: .continuous))
        .padding(.horizontal, 16)
        .padding(.bottom, 8)
        .transition(.move(edge: .bottom).combined(with: .opacity))
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
        case "reservoir_low":
            return "drop"
        case "battery_low":
            return "battery.25percent"
        case "site_change":
            return "bandage"
        default:
            return item.payload.questionId == "hypo_report" ? "arrow.down.heart" : "questionmark.bubble"
        }
    }
}
