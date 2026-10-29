import Foundation

/// One side of a meal change card ("było" / "będzie"), as the server decided it (conversation-meal-actions.v1).
public struct MealActionSide: Codable, Equatable {
    /// CONTENT (description, items, values), PURPOSE (what a loop entry was for), MEMBERSHIP (part of a meal or its
    /// own) or WBT_REMINDER.
    public let kind: String
    // CONTENT
    public var description: String? = nil
    public var items: [MealChatProposalItem]? = nil
    public var carbs_g: Double? = nil
    public var protein_g: Double? = nil
    public var fat_g: Double? = nil
    public var fat_protein_units: Double? = nil
    // PURPOSE / MEMBERSHIP: the name shown on the card ("dokładka do: Obiad").
    public var purpose: String? = nil
    public var label: String? = nil
    public var meal_id: String? = nil
    // WBT_REMINDER: nil before = there was no reminder.
    public var enabled: Bool? = nil

    public init(kind: String, description: String? = nil, items: [MealChatProposalItem]? = nil, carbs_g: Double? = nil, protein_g: Double? = nil, fat_g: Double? = nil, fat_protein_units: Double? = nil, purpose: String? = nil, label: String? = nil, meal_id: String? = nil, enabled: Bool? = nil) {
        self.kind = kind
        self.description = description
        self.items = items
        self.carbs_g = carbs_g
        self.protein_g = protein_g
        self.fat_g = fat_g
        self.fat_protein_units = fat_protein_units
        self.purpose = purpose
        self.label = label
        self.meal_id = meal_id
        self.enabled = enabled
    }

    public var isContent: Bool { kind == "CONTENT" }
}

public struct MealActionWarning: Codable, Equatable, Hashable {
    /// LOOP_CARBS_DIFFER, MEAL_WILL_BE_DELETED, ITEMS_DROPPED, MEAL_ENTRIES_SPLIT, MEAL_HIDDEN or NOT_UNDOABLE.
    public let code: String
    public let message: String

    public init(code: String, message: String) {
        self.code = code
        self.message = message
    }
}

/// A change of the meals module the AI prepared in a conversation. Nothing is saved until a caregiver taps "Zatwierdź".
public struct ConversationMealAction: Codable, Equatable, Identifiable {
    public let id: String
    public let user_message_id: String
    /// REPLACE_CONTENT, UPDATE_MACROS, UPDATE_DESCRIPTION, SET_PURPOSE, DETACH_ENTRY or SET_WBT_REMINDER.
    public let operation: String
    /// PROPOSED, APPLYING, APPLIED, REJECTED, SUPERSEDED, STALE or UNDONE.
    public let status: String
    public let title: String
    public let reason: String?
    public let before: MealActionSide
    public let after: MealActionSide
    public let warnings: [MealActionWarning]
    public let meal_id: String?
    public let can_apply: Bool
    public let can_edit: Bool
    public let can_undo: Bool
    public let decided_by: String?
    public let decided_at: String?
    public let created_at: String

    public init(id: String, user_message_id: String, operation: String, status: String, title: String, reason: String?, before: MealActionSide, after: MealActionSide, warnings: [MealActionWarning], meal_id: String?, can_apply: Bool, can_edit: Bool, can_undo: Bool, decided_by: String?, decided_at: String?, created_at: String) {
        self.id = id
        self.user_message_id = user_message_id
        self.operation = operation
        self.status = status
        self.title = title
        self.reason = reason
        self.before = before
        self.after = after
        self.warnings = warnings
        self.meal_id = meal_id
        self.can_apply = can_apply
        self.can_edit = can_edit
        self.can_undo = can_undo
        self.decided_by = decided_by
        self.decided_at = decided_at
        self.created_at = created_at
    }

    /// The warnings shown on the card; "no undo" is said by the missing button once the change is saved.
    public var visibleWarnings: [MealActionWarning] {
        status == "PROPOSED" ? warnings : warnings.filter { $0.code != "NOT_UNDOABLE" }
    }
}

/// The card's header: what kind of change, and the meal or entry it is about ("Obiad · 13:10").
public struct MealActionHeadline: Equatable {
    public let title: String
    public let chip: String?
    /// The loop entry's amounts ("18 g węglowodanów i 1,5 j. bolusa").
    public let detail: String?
}

/// One value of a content change: "W 18 → 46 g", or "W 46 g" when it stays.
public struct MealActionValueChange: Equatable, Identifiable {
    public let name: String
    public let before: Double?
    public let after: Double?
    public let unit: String

    public var id: String { name }
    public var changed: Bool { before != after }

    public var text: String {
        let suffix = unit.isEmpty ? "" : " \(unit)"
        guard changed else { return "\(name) \(MealActionPresentation.number(after))\(suffix)" }
        return "\(name) \(MealActionPresentation.number(before)) → \(MealActionPresentation.number(after))\(suffix)"
    }
}

public enum MealActionPresentation {
    /// "46", "1,2"; unknown as "?".
    public static func number(_ value: Double?) -> String {
        guard let value else { return "?" }
        let rounded = (value * 10).rounded() / 10
        return rounded.rounded() == rounded ? String(Int(rounded)) : String(format: "%.1f", rounded).replacingOccurrences(of: ".", with: ",")
    }

    /// "1 pozycja", "2 pozycje", "5 pozycji".
    public static func itemCount(_ count: Int) -> String {
        let lastTwo = count % 100
        let last = count % 10
        if count == 1 { return "1 pozycja" }
        if (2...4).contains(last) && !(12...14).contains(lastTwo) { return "\(count) pozycje" }
        return "\(count) pozycji"
    }
}

public extension ConversationMealAction {
    /// "Zmiana posiłku · Obiad (13:10)" → "Zmiana posiłku" + "Obiad · 13:10"; "Wpis z pętli o 13:10 (18 g …)" →
    /// "Wpis z pętli" + "13:10" + the amounts. Any other title is shown whole.
    var headline: MealActionHeadline {
        if let match = title.wholeMatch(of: #/(.+?) · (.+) \((\d{1,2}:\d{2})\)/#) {
            return MealActionHeadline(title: String(match.1), chip: "\(match.2) · \(match.3)", detail: nil)
        }
        if let match = title.wholeMatch(of: #/Wpis z pętli o (\d{1,2}:\d{2})(?: \((.+)\))?/#) {
            return MealActionHeadline(title: "Wpis z pętli", chip: String(match.1), detail: match.2.map(String.init))
        }
        return MealActionHeadline(title: title, chip: nil, detail: nil)
    }

    /// What it was and what it will be, in one line each: the descriptions of a content change, the labels otherwise.
    /// Nil before when there was nothing ("bez opisu") or nothing changes (a values-only change).
    var summaryLine: (before: String?, after: String) {
        guard before.isContent && after.isContent else {
            return (MealActionCard.label(before), MealActionCard.label(after))
        }
        let old = before.description.flatMap { $0.isEmpty ? nil : $0 }
        let new = after.description.flatMap { $0.isEmpty ? nil : $0 }
        guard let new else { return (old, "bez opisu") }
        return (old == new ? nil : old, new)
    }

    /// W / B / T / WBT of a content change (known on either side); empty when none of them changes.
    var valueChanges: [MealActionValueChange] {
        guard before.isContent && after.isContent else { return [] }
        let changes = [
            MealActionValueChange(name: "W", before: before.carbs_g, after: after.carbs_g, unit: "g"),
            MealActionValueChange(name: "B", before: before.protein_g, after: after.protein_g, unit: "g"),
            MealActionValueChange(name: "T", before: before.fat_g, after: after.fat_g, unit: "g"),
            MealActionValueChange(name: "WBT", before: before.fat_protein_units, after: after.fat_protein_units, unit: ""),
        ].filter { $0.before != nil || $0.after != nil }
        return changes.contains(where: \.changed) ? changes : []
    }

    /// "Skład: 2 pozycje · DiabCalc" over the new items; nil without items.
    var itemsSummary: String? {
        guard after.isContent, let items = after.items, !items.isEmpty else { return nil }
        let fromDatabase = items.filter { $0.source == "DIABCALC" }.count
        let source = fromDatabase == items.count ? "DiabCalc" : fromDatabase == 0 ? "szacunek" : "DiabCalc i szacunek"
        return "Skład: \(MealActionPresentation.itemCount(items.count)) · \(source)"
    }

    /// The one line a decided card collapses to; nil while it waits for a decision.
    var decidedLine: String? {
        let what = summaryLine.after
        switch status {
        case "APPLIED": return "Zapisano: \(what)"
        case "UNDONE": return "Cofnięto: \(what)"
        case "REJECTED": return "Odrzucono: \(what)"
        case "SUPERSEDED": return "Zastąpione nowszą propozycją"
        case "STALE": return "Nieaktualne: posiłek zmienił się w międzyczasie. Poproś o nową propozycję."
        default: return nil
        }
    }
}

public struct MealActionResponse: Decodable, Equatable {
    public let patient_id: String
    public let meal_action: ConversationMealAction
}

/// Values changed with "Popraw" before confirming a content change. Explicit nulls: a cleared value means "unknown".
public struct MealActionEdit: Encodable, Equatable {
    public let description: String?
    public let carbs_g: Double?
    public let protein_g: Double?
    public let fat_g: Double?

    public init(description: String?, carbs_g: Double?, protein_g: Double?, fat_g: Double?) {
        self.description = description
        self.carbs_g = carbs_g
        self.protein_g = protein_g
        self.fat_g = fat_g
    }

    private enum CodingKeys: String, CodingKey {
        case description, carbs_g, protein_g, fat_g
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(description, forKey: .description)
        try container.encode(carbs_g, forKey: .carbs_g)
        try container.encode(protein_g, forKey: .protein_g)
        try container.encode(fat_g, forKey: .fat_g)
    }
}

struct MealActionApplyRequest: Encodable {
    let edited: MealActionEdit?
}

public protocol MealActionsAPI {
    func applyMealAction(patientID: String, conversationID: String, actionID: String, edited: MealActionEdit?) async throws -> MealActionResponse
    func rejectMealAction(patientID: String, conversationID: String, actionID: String) async throws -> MealActionResponse
    func undoMealAction(patientID: String, conversationID: String, actionID: String) async throws -> MealActionResponse
}

extension APIClient: MealActionsAPI {}
