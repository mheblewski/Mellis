import Foundation
@testable import GlucoMindCore

/// What a tapped payload opens, as the app reads it (AppRoute.parse): the last conversation and meal route.
@MainActor
final class RouteRecorder {
    private(set) var route: ConversationRoute?
    private(set) var mealRoute: MealRoute?
    private(set) var routes: [AppRoute] = []

    func handle(_ userInfo: [AnyHashable: Any]) {
        guard let parsed = AppRoute.parse(pushPayload: userInfo) else { return }
        record(parsed)
    }

    func handle(universalLink url: URL) {
        guard let parsed = AppRoute.parse(universalLink: url) else { return }
        record(parsed)
    }

    private func record(_ parsed: AppRoute) {
        routes.append(parsed)
        switch parsed {
        case let .conversation(conversation): route = conversation
        case let .meal(meal): mealRoute = meal
        case .remoteCommands, .patient, .equipment: break
        }
    }
}
