import SwiftUI

/// A reminder the chat set (care-reminders.v1): a note pushed to both caregivers at a time or on a glucose condition.
public struct ConversationCareReminder: Codable, Equatable, Identifiable {
    public let id: String
    public let note: String
    /// AT_TIME, GLUCOSE_STOPPED_FALLING, GLUCOSE_RISING, GLUCOSE_ABOVE or GLUCOSE_BELOW
    public let trigger: String
    public let due_at: String
    public let threshold_mgdl: Int?
    public let wait_until: String?
    /// ACTIVE, FIRED, CANCELLED, EXPIRED (a threshold never crossed), MISSED (not sent in time) or GIVEN
    public let status: String
    public let fired_at: String?
    /// READY (the time or condition came) or FORCED (the waiting time ran out)
    public let fired_reason: String?
    public let cancelled_by_name: String?
    /// The server's Polish words for when ("czw., 14:00", "gdy glukoza zacznie rosnąć (najpóźniej czw., 15:00)").
    public let described: String

    public var isActive: Bool { status == "ACTIVE" }

    /// "Przyjdzie: …", "Przyszło 14:02", "Anulowane (Ewa)".
    public var statusLine: String {
        switch status {
        case "FIRED":
            let at = fired_at.flatMap(ServerDate.parse).map(LoopFormat.clock) ?? ""
            return fired_reason == "FORCED" ? "Przyszło \(at) (warunek się nie spełnił)" : "Przyszło \(at)"
        case "CANCELLED":
            return "Anulowane\(cancelled_by_name.map { " (\($0))" } ?? "")"
        case "EXPIRED":
            return "Wygasło: glukoza nie przekroczyła progu"
        case "MISSED":
            return "Przegapione: serwer nie wysłał go na czas"
        case "GIVEN":
            return "Dawkę podano przed przypomnieniem"
        default:
            return "Przyjdzie: \(described)"
        }
    }
}

public struct CareReminderCancelResponse: Decodable, Equatable {
    public let reminder: ConversationCareReminder
}

struct CareReminderCard: View {
    let reminder: ConversationCareReminder
    /// Nil while a cancel is running or when the reminder is no longer active.
    let onCancel: (() -> Void)?
    let error: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 8) {
                Image(systemName: reminder.isActive ? "bell.badge" : "bell")
                    .font(.body.weight(.semibold))
                    .foregroundStyle(reminder.isActive ? AnyShapeStyle(.tint) : AnyShapeStyle(.secondary))
                Text("Przypomnienie")
                    .font(.subheadline.weight(.semibold))
                Spacer(minLength: 6)
            }
            Text(reminder.note)
                .font(.body)
                .fixedSize(horizontal: false, vertical: true)
            Text(reminder.statusLine)
                .font(.footnote)
                .foregroundStyle(.secondary)
            if let error {
                Text(error).font(.footnote).foregroundStyle(.red)
            }
            if reminder.isActive, let onCancel {
                Button("Anuluj przypomnienie", role: .destructive, action: onCancel)
                    .font(.footnote.weight(.semibold))
                    .buttonStyle(.borderless)
                    .padding(.top, 2)
            }
        }
        .padding(.horizontal, 15)
        .padding(.vertical, 12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 18, style: .continuous).fill(Color.secondary.opacity(0.08)))
        .overlay(RoundedRectangle(cornerRadius: 18, style: .continuous).stroke(Color.secondary.opacity(0.18), lineWidth: 1))
    }
}
