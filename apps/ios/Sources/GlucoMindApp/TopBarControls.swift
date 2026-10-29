import Combine
import SwiftUI
import GlucoMindCore

/// The right side of the top bars, one bubble: the bell with the notification list and the gear opening the settings
/// screen. Every tab shows it; the notification list behind the bell is one for the patient (held by the container), so
/// the tabs do not read it each.
struct TopBarTrailingControls: View {
    /// Nil hides "Odśwież" (the meals list refreshes by pulling it down).
    let onRefresh: (() -> Void)?
    let onShowPatientSelection: () -> Void
    let onOpenNotification: (_ pushUserInfo: [AnyHashable: Any]) -> Void
    let onSignOut: () async -> Void
    private let apiClient: APIClient
    private let patientID: String

    @EnvironmentObject private var container: AppContainer

    init(
        apiClient: APIClient,
        patientID: String,
        onRefresh: (() -> Void)? = nil,
        onShowPatientSelection: @escaping () -> Void,
        onOpenNotification: @escaping (_ pushUserInfo: [AnyHashable: Any]) -> Void,
        onSignOut: @escaping () async -> Void
    ) {
        self.onRefresh = onRefresh
        self.onShowPatientSelection = onShowPatientSelection
        self.onOpenNotification = onOpenNotification
        self.onSignOut = onSignOut
        self.apiClient = apiClient
        self.patientID = patientID
    }

    var body: some View {
        TopBarTrailingControlsContent(
            notificationsViewModel: container.notificationHistory(apiClient: apiClient, patientID: patientID),
            onRefresh: onRefresh,
            onOpenNotification: onOpenNotification
        )
    }
}

private struct TopBarTrailingControlsContent: View {
    @ObservedObject var notificationsViewModel: NotificationHistoryViewModel
    let onRefresh: (() -> Void)?
    let onOpenNotification: (_ pushUserInfo: [AnyHashable: Any]) -> Void

    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.liveUpdates) private var liveUpdates
    @EnvironmentObject private var container: AppContainer
    @State private var isNotificationsPresented = false

    var body: some View {
        HStack(spacing: 4) {
            bell
            settingsButton
        }
        // Black icons also outside a toolbar (the dashboard's header), where buttons take the accent color.
        .tint(.primary)
        // Each tab's bell asks; the shared list is read once (in flight or fresh enough serves them all).
        .task {
            await notificationsViewModel.refreshIfStale()
        }
        .onChange(of: scenePhase) { _, newValue in
            guard newValue == .active else { return }
            Task { await notificationsViewModel.refreshIfStale() }
        }
        // A new notification for either caregiver appears in the list (and the bell's dot) right away.
        .task(id: liveUpdates.map(ObjectIdentifier.init)) {
            notificationsViewModel.bindLiveUpdates(liveUpdates)
        }
        .sheet(isPresented: $isNotificationsPresented) {
            NotificationHistoryView(
                viewModel: notificationsViewModel,
                onOpen: { item in
                    notificationsViewModel.markRead(item)
                    isNotificationsPresented = false
                    onOpenNotification(item.payload.pushUserInfo)
                },
                onClose: {
                    isNotificationsPresented = false
                }
            )
        }
        .closesForNotification(isPresented: isNotificationsPresented) { isNotificationsPresented = false }
    }

    private var bell: some View {
        Button {
            isNotificationsPresented = true
            Task { await notificationsViewModel.refresh() }
        } label: {
            Image(systemName: "bell")
                .topBarIcon()
                .overlay(alignment: .topTrailing) {
                    // An unread row in the list (also a push dismissed on the phone).
                    if notificationsViewModel.hasUnseen {
                        Circle()
                            .fill(Color.red)
                            .frame(width: 9, height: 9)
                            .offset(x: -5, y: 5)
                    }
                }
        }
        .accessibilityLabel("Powiadomienia")
        .accessibilityValue(notificationsViewModel.hasUnseen ? "Nowe powiadomienia" : "")
    }

    private var settingsButton: some View {
        Button {
            // Held by the container, not by this toolbar item: iOS rebuilds the toolbar when the app comes back from the
            // background, and the settings (with half-typed keys) must stay open.
            container.presentSettings(refresh: onRefresh)
            Task { await container.refreshCapabilities() }
        } label: {
            Image(systemName: "gearshape")
                .topBarIcon()
        }
        .accessibilityLabel("Ustawienia")
    }
}

extension Image {
    /// One size for every icon in the top bars' bubbles.
    func topBarIcon() -> some View {
        font(.system(size: 17, weight: .medium))
            .foregroundStyle(.primary)
            .frame(width: 34, height: 34)
            .contentShape(Rectangle())
    }
}
