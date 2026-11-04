import Foundation

/// The dashboard's basal capsule beside IOB and COB (docs/product/dashboard-basal-review.md): the rate the loop set now,
/// the plan only when it differs ("0 j/h z 0,2"), and full sentences in the bubble a tap opens. No warning colours; the
/// capsule turns to "—" when the loop's data are old, so an old rate is never shown as now.
public struct DashboardBasalCapsule: Equatable {
    /// "Baza", or "Pompa wstrzymana" (then without a value).
    public let title: String
    /// "0 j/h"; nil while suspended; "—" when unknown or old.
    public let value: String?
    /// "z 0,2" when the rate differs from the plan.
    public let plan: String?
    /// Old or unknown data: the capsule is greyed.
    public let dimmed: Bool
    /// The bubble's sentences, in order.
    public let details: [String]
    public let accessibilityLabel: String

    /// Older than this, the loop's rate is not taken as now (as the loop tile's yellow).
    static let staleMinutes = 15

    public static func make(_ dashboard: DashboardResponse, now: Date) -> DashboardBasalCapsule? {
        let loopMinutes = dashboard.loop.flatMap { DashboardDate.parse($0.observed_at) }.map { DashboardFormat.wholeMinutes(since: $0, now: now) }
        if let basal = dashboard.insulin?.basal_now {
            return make(basal, loopMinutes: loopMinutes, now: now)
        }
        // An older server: the delivered rate only, without a plan.
        guard let rate = DashboardGlance.loop(dashboard, now: now)?.basalRate else { return nil }
        return make(DashboardBasalNow(rate: rate, source: "TEMP", since: nil, plan_rate: nil, profile_rate: nil), loopMinutes: loopMinutes, now: now, serverKnowsPlan: false)
    }

    /// `serverKnowsPlan` false: an older server that sends no plan at all (then no "Brak planu" sentence).
    public static func make(_ basal: DashboardBasalNow, loopMinutes: Int?, now: Date, serverKnowsPlan: Bool = true) -> DashboardBasalCapsule {
        let since = basal.since.flatMap(DashboardDate.parse)
        let lasting = since.map { duration(minutes: DashboardFormat.wholeMinutes(since: $0, now: now)) }

        if basal.source == "SUSPENDED" {
            let sentence = lasting.map { "Pompa jest wstrzymana od \($0). Insulina nie jest podawana." } ?? "Pompa jest wstrzymana. Insulina nie jest podawana."
            return DashboardBasalCapsule(title: "Pompa wstrzymana", value: nil, plan: nil, dimmed: false, details: [sentence],
                                         accessibilityLabel: "Pompa wstrzymana")
        }
        if let loopMinutes, loopMinutes > staleMinutes {
            return DashboardBasalCapsule(title: "Baza", value: "—", plan: nil, dimmed: true,
                                         details: ["Brak świeżych danych z pętli od \(duration(minutes: loopMinutes))."],
                                         accessibilityLabel: "Baza: brak świeżych danych")
        }
        guard let rate = basal.rate else {
            return DashboardBasalCapsule(title: "Baza", value: "—", plan: nil, dimmed: true,
                                         details: ["Nie wiadomo, jaką bazę ustawiła pętla."], accessibilityLabel: "Baza: brak danych")
        }

        let rateText = DashboardFormat.dose(rate)
        var details: [String] = []
        var plan: String?
        if let planRate = basal.plan_rate {
            if abs(planRate - rate) < 0.005 {
                details.append("Baza \(rateText) j/h, zgodnie z planem.")
            } else {
                plan = "z \(DashboardFormat.dose(planRate))"
                details.append("Pętla ustawiła bazę na \(rateText) j/h. W planie jest \(DashboardFormat.dose(planRate)) j/h.")
                if let lasting { details.append("Tak jest od \(lasting).") }
            }
        } else {
            details.append("Pętla ustawiła bazę na \(rateText) j/h.")
            if let lasting { details.append("Tak jest od \(lasting).") }
            if serverKnowsPlan { details.append("Brak planu bazy w profilu.") }
        }
        if let override = basal.override, let profileRate = basal.profile_rate {
            let name = override.name.map { "\($0), " } ?? ""
            details.append("Plan uwzględnia nadpisanie: \(name)\(override.percentage)% (w profilu \(DashboardFormat.dose(profileRate)) j/h).")
        }
        if basal.smb_last_hour_units >= 0.01 {
            details.append("Mikrobolusy w ostatniej godzinie: \(DashboardFormat.dose(basal.smb_last_hour_units)) j.")
        }
        if plan != nil {
            details.append("Pętla sama zmienia bazę według prognozy glikemii.")
        }
        let spoken = plan != nil
            ? "Baza: teraz \(rateText) jednostki na godzinę, w planie \(DashboardFormat.dose(basal.plan_rate ?? 0))"
            : "Baza: \(rateText) jednostki na godzinę"
        return DashboardBasalCapsule(title: "Baza", value: "\(rateText) j/h", plan: plan, dimmed: false, details: details, accessibilityLabel: spoken)
    }

    /// "chwili" under 5 min, "25 min", "1 godz. 10 min", "3 godz." (after "od").
    static func duration(minutes: Int) -> String {
        if minutes < 5 { return "chwili" }
        if minutes < 60 { return "\(minutes) min" }
        let hours = minutes / 60
        let rest = minutes % 60
        return rest == 0 ? "\(hours) godz." : "\(hours) godz. \(rest) min"
    }
}
