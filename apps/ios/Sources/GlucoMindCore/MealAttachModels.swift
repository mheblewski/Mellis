import Foundation
import SwiftUI

/// "Do posiłku: …" on the Bolus tab's given card (meal-attach.v1): the bigger meal, started less than 3 hours before
/// the dose saved as a meal, that the dose may join (the join is "Scal", meal-merge.v1).
public struct MealAttachTarget: Decodable, Equatable, Sendable {
    public let meal_id: String
    public let started_at: String
    /// The meal chat's AI name ("Pizza margherita"), shown only here; nil: the meal is named by its time.
    public let short_name: String?
    public let carbs_g: Double?
    public let insulin_total_u: Double?
    /// One of the two meals has a later bolus part still to come: the join keeps it (split KEEP).
    public let split: Bool

    public init(meal_id: String, started_at: String, short_name: String?, carbs_g: Double?, insulin_total_u: Double?, split: Bool) {
        self.meal_id = meal_id
        self.started_at = started_at
        self.short_name = short_name
        self.carbs_g = carbs_g
        self.insulin_total_u = insulin_total_u
        self.split = split
    }

    private var clock: String? { ServerDate.parse(started_at).map { MealJournalFormat.clock($0) } }

    /// "Do posiłku: Pizza margherita", or "Do posiłku o 12:45" for a meal without a name.
    public var buttonTitle: String {
        if let name = short_name?.trimmingCharacters(in: .whitespacesAndNewlines), !name.isEmpty { return "Do posiłku: \(name)" }
        return clock.map { "Do posiłku o \($0)" } ?? "Do wcześniejszego posiłku"
    }

    /// "Pizza margherita o 12:45", or "posiłek o 12:45": what the dose joined.
    public var joinedName: String {
        let time = clock
        if let name = short_name?.trimmingCharacters(in: .whitespacesAndNewlines), !name.isEmpty {
            return time.map { "\(name) o \($0)" } ?? name
        }
        return time.map { "posiłek o \($0)" } ?? "wcześniejszy posiłek"
    }
}

public struct MealAttachTargetResponse: Decodable, Equatable, Sendable {
    public let patient_id: String
    /// The dose's meal has a description or values (absent on older servers: not known).
    public var described: Bool? = nil
    /// Its name once described ("Posiłek utworzony: …"): the AI's short name, else the description.
    public var meal_name: String? = nil
    public let target: MealAttachTarget?
}

public protocol MealAttachAPI {
    func getMealAttachTarget(patientID: String, mealID: String) async throws -> MealAttachTargetResponse
    func mergeMeals(patientID: String, mealIDs: [String], resetConfirmed: Bool, split: MealMergeSplitChoice?) async throws -> MealMergeResponse
}

extension APIClient: MealAttachAPI {}

/// The given card's meal: whether it still needs "Opisz posiłek" (not described yet, not merged away) and its "Do
/// posiłku" state (both buttons go once it is described, joined or merged away): looked up once the dose's meal is known, offered when there is a bigger meal, then joined (after
/// the caregiver confirms). Read again after the meal's chat closes and when the meals change.
@MainActor
public final class BolusMealAttachModel: ObservableObject {
    public enum State: Equatable {
        case none
        case offered(MealAttachTarget)
        case attaching(MealAttachTarget)
        case attached(MealAttachTarget)
        case failed(MealAttachTarget, String)
    }

    @Published public private(set) var state: State = .none
    /// Every change of the card's buttons: one smooth step (a button fades, the card eases to its new height).
    public static let change: Animation = .snappy(duration: 0.35)
    /// Described in its chat (or by hand): "Opisz posiłek" is done.
    @Published public private(set) var mealDescribed = false
    /// Merged into another meal elsewhere ("Scal" in the Meals tab): nothing left to describe or join.
    @Published public private(set) var mealGone = false
    /// The described meal's name ("Posiłek utworzony: Lody waniliowe").
    @Published public private(set) var mealName: String?
    /// The dose's own meal (its page from "Posiłek utworzony").
    public var currentMealID: String? { mealID }
    private var mealID: String?
    /// The bolus this card is about: another one starts the card over (the last meal's "Posiłek utworzony" showed on
    /// the next bolus's card until its own meal was saved).
    private var commandID: String?

    public init() {}

    /// The card now shows this bolus: a different one clears everything about the last one.
    public func follow(commandID: String?) {
        guard commandID != self.commandID else { return }
        self.commandID = commandID
        reset()
    }

    /// The meal this dose became: whether it is described and its bigger earlier meal (a failed read changes nothing).
    /// `force` reads the same meal again (its chat closed, the meals changed).
    public func load(api: MealAttachAPI, patientID: String, mealID: String, force: Bool = false) async {
        // Joined here: done. The server then links the dose to the meal it joined (a new meal id), which is not a new
        // meal to describe ("Opisz posiłek" came back for a moment and "Dopisane do" was lost).
        if case .attached = state { return }
        if mealID == self.mealID, !force { return }
        if mealID != self.mealID {
            self.mealID = mealID
            state = .none
            mealDescribed = false
            mealGone = false
            mealName = nil
        }
        do {
            let response = try await api.getMealAttachTarget(patientID: patientID, mealID: mealID)
            guard self.mealID == mealID else { return }
            withAnimation(Self.change) {
                mealDescribed = response.described ?? mealDescribed
                mealName = response.meal_name ?? mealName
                switch state {
                case .attaching, .attached: break
                // Described, it is a meal of its own: nothing left to join either (owner 2026-11-03).
                default:
                    let next: State = mealDescribed ? .none : response.target.map { .offered($0) } ?? .none
                    if next != state { state = next }
                }
            }
        } catch APIClientError.notFound {
            // Joined here, the meal is gone as expected; joined elsewhere, both buttons go.
            guard self.mealID == mealID else { return }
            if case .attached = state { return }
            if case .attaching = state { return }
            withAnimation(Self.change) {
                mealGone = true
                state = .none
            }
        } catch {}
    }

    /// "Opisz posiłek" still has something to do.
    public var needsDescription: Bool {
        if mealDescribed || mealGone { return false }
        switch state {
        case .attaching, .attached: return false
        default: return true
        }
    }

    /// "Dopisz do posiłku" confirmed: the card shows the join at once (the dialog's closing must not bring "Opisz
    /// posiłek" back for a moment before the join starts).
    public func beginAttaching() {
        guard let target = offeredTarget else { return }
        withAnimation(Self.change) { state = .attaching(target) }
    }

    /// The dose's meal joins the earlier one.
    public func attach(api: MealAttachAPI, patientID: String) async {
        guard let mealID else { return }
        let target: MealAttachTarget
        switch state {
        case let .attaching(attaching): target = attaching
        case let .offered(offered), let .failed(offered, _):
            target = offered
            withAnimation(Self.change) { state = .attaching(offered) }
        case .none, .attached: return
        }
        do {
            _ = try await api.mergeMeals(patientID: patientID, mealIDs: [target.meal_id, mealID], resetConfirmed: false, split: target.split ? .keep : nil)
            guard self.mealID == mealID else { return }
            withAnimation(Self.change) { state = .attached(target) }
        } catch {
            guard self.mealID == mealID else { return }
            withAnimation(Self.change) { state = .failed(target, "Nie udało się dopisać do posiłku. Spróbuj jeszcze raz albo scal posiłki w zakładce Posiłki.") }
        }
    }

    /// A new dose (or none): the card it was about is gone.
    public func reset() {
        mealID = nil
        state = .none
        mealDescribed = false
        mealGone = false
        mealName = nil
    }

    /// The target the button offers (also after a failed try, to try again).
    public var offeredTarget: MealAttachTarget? {
        switch state {
        case let .offered(target), let .failed(target, _): target
        default: nil
        }
    }
}
