import Combine
import Foundation

/// What the confirmation shows (W4): the exact values, the data behind them and the warnings to acknowledge.
public struct RemoteBolusConfirmation: Equatable, Identifiable {
    /// Kept when the caregiver changes the values in the confirmation, so the sheet stays open.
    public let id: UUID
    public let draftBase: RemoteBolusDraftBase
    public let preview: RemoteCommandPreview
    /// When this phone got the preview: older than RemoteBolusViewModel.previewMaxAge, it is read again before sending.
    public let checkedAt: Date
    /// Why the slide did not send (the data were read again): shown above the slider.
    public let notice: String?
    /// The data are being read again: the slider waits.
    public let isRechecking: Bool

    public init(id: UUID = UUID(), draftBase: RemoteBolusDraftBase, preview: RemoteCommandPreview, checkedAt: Date = Date(), notice: String? = nil, isRechecking: Bool = false) {
        self.id = id
        self.draftBase = draftBase
        self.preview = preview
        self.checkedAt = checkedAt
        self.notice = notice
        self.isRechecking = isRechecking
    }

    /// [Podaj] only without blocks, and not while the data are read again.
    public var canConfirm: Bool { preview.blocks.isEmpty && !isRechecking }

    public var carbsG: Int { draftBase.carbsG }
    public var insulinU: Decimal { draftBase.insulinU }

    public static func == (lhs: RemoteBolusConfirmation, rhs: RemoteBolusConfirmation) -> Bool {
        lhs.id == rhs.id && lhs.draftBase == rhs.draftBase && lhs.preview == rhs.preview && lhs.notice == rhs.notice && lhs.isRechecking == rhs.isRechecking
    }

    public var draft: RemoteCommandDraft {
        var draft = RemoteCommandDraft(
            source: draftBase.source,
            carbsG: draftBase.carbsG,
            insulinU: draftBase.insulinU,
            conversationID: draftBase.conversationID,
            proposalID: draftBase.proposalID,
            meal: draftBase.meal,
            followsCommandID: draftBase.followsCommandID,
            acknowledgedWarnings: preview.warnings.map(\.acknowledgementKey),
            confirmedAt: ServerDate.parse(preview.context.now),
            pumpBolusStep: preview.pumpBolusStep,
            wbtMealID: draftBase.wbtMealID,
            plannedBolusID: draftBase.plannedBolusID
        )
        draft.rescueAlertID = draftBase.rescueAlertID
        draft.rescueProposalID = draftBase.rescueProposalID
        return draft
    }
}

/// The values a confirmation is for, wherever they came from (the Bolus tab, a chat card, a new meal).
public struct RemoteBolusDraftBase: Equatable {
    public let source: RemoteCommandSource
    public let carbsG: Int
    public let insulinU: Decimal
    public let conversationID: String?
    public let proposalID: String?
    public let meal: RemoteCommandMeal?
    /// A retry of the command Trio refused (the bolus alone when its carbs were stored).
    public let followsCommandID: String?
    /// The WBT window's meal: the carbs-equivalent and bolus are its WBT.
    public let wbtMealID: String?
    /// The planned second part of a split meal bolus: its carbs and bolus join that meal.
    public let plannedBolusID: String?
    /// The chat card's own warnings (a forecast low for its amounts, fast carbs advised …), shown in the confirmation
    /// next to the live checks; they were made for `cardCarbsG` / `cardInsulinU`.
    public var cardWarnings: [RemoteCommandNotice] = []
    public var cardCarbsG: Int? = nil
    public var cardInsulinU: Decimal? = nil
    /// Rescue carbs (source .rescueCarbs): the alert or the chat card they answer.
    public var rescueAlertID: String? = nil
    public var rescueProposalID: String? = nil
    /// Until when the chat card behind this draft may be given (nil: no card, or one that never expires).
    public var proposalExpiresAt: Date? = nil

    /// The card behind this draft is past its validity: the server would refuse it (PROPOSAL_EXPIRED).
    public func proposalExpired(at now: Date) -> Bool {
        proposalExpiresAt.map { $0 <= now } ?? false
    }

    /// Rescue carbs to Trio: whole grams, no insulin, no meal.
    public static func rescueCarbs(grams: Int, conversationID: String?, alertID: String?, proposalID: String?) -> RemoteBolusDraftBase {
        var base = RemoteBolusDraftBase(source: .rescueCarbs, carbsG: grams, insulinU: 0, conversationID: conversationID)
        base.rescueAlertID = alertID
        base.rescueProposalID = proposalID
        return base
    }

    public var isRescue: Bool { source == .rescueCarbs }

    public init(source: RemoteCommandSource, carbsG: Int, insulinU: Decimal, conversationID: String? = nil, proposalID: String? = nil, meal: RemoteCommandMeal? = nil, followsCommandID: String? = nil, wbtMealID: String? = nil, plannedBolusID: String? = nil, cardWarnings: [RemoteCommandNotice] = []) {
        self.cardWarnings = cardWarnings
        if !cardWarnings.isEmpty {
            self.cardCarbsG = carbsG
            self.cardInsulinU = insulinU
        }
        self.followsCommandID = followsCommandID
        self.wbtMealID = wbtMealID
        self.plannedBolusID = plannedBolusID
        self.source = source
        self.carbsG = carbsG
        self.insulinU = insulinU
        self.conversationID = conversationID
        self.proposalID = proposalID
        self.meal = meal
    }

    /// The same command with other amounts.
    public func with(carbsG: Int, insulinU: Decimal) -> RemoteBolusDraftBase {
        var draft = RemoteBolusDraftBase(source: source, carbsG: carbsG, insulinU: insulinU, conversationID: conversationID, proposalID: proposalID, meal: meal, followsCommandID: followsCommandID, wbtMealID: wbtMealID, plannedBolusID: plannedBolusID)
        draft.cardWarnings = cardWarnings
        draft.cardCarbsG = cardCarbsG
        draft.cardInsulinU = cardInsulinU
        draft.rescueAlertID = rescueAlertID
        draft.rescueProposalID = rescueProposalID
        draft.proposalExpiresAt = proposalExpiresAt
        return draft
    }

    /// The card's warnings still describe these amounts (the caregiver did not change them).
    public func cardWarningsMatch(carbsG: Int, insulinU: Decimal) -> Bool {
        cardCarbsG == carbsG && cardInsulinU == insulinU
    }
}

public enum RemoteBolusSendState: Equatable {
    case idle
    case checking
    case sending
    case sent(RemoteCommand)
    case failed(String)
}

/// Amounts typed in the confirmation, rounded down to the bolus step as they are checked.
public struct RemoteBolusAmounts: Equatable {
    public let carbsG: Int
    public let insulinU: Decimal
}

/// The phone's own limits and pump step for a patient's loop (TrioRemoteSettings, LoopRemoteSettings).
public protocol RemoteCommandLimits {
    var bolusIncrement: Decimal { get }
    func limitProblem(carbsG: Int, insulinU: Decimal) -> String?
}

extension TrioRemoteSettings: RemoteCommandLimits {}
extension LoopRemoteSettings: RemoteCommandLimits {}

/// Confirmation and sending, shared by every place a dose can be given from.
@MainActor
public final class RemoteBolusFlow: ObservableObject {
    @Published public var confirmation: RemoteBolusConfirmation? {
        didSet {
            // Another confirmation (or none): what was typed in the previous one does not apply.
            if confirmation?.id != oldValue?.id { typedAmounts = nil; checkError = nil }
        }
    }
    @Published public private(set) var state: RemoteBolusSendState = .idle
    /// The amounts last typed in the open confirmation (nil: none typed). Until their check is back the confirmation is
    /// still for other values and cannot be sent.
    @Published public private(set) var typedAmounts: RemoteBolusAmounts?
    /// Why the check of the typed amounts failed: shown in the sheet, which cannot send until a check succeeds.
    @Published public private(set) var checkError: String?

    /// The confirmation is for what was typed last and its check succeeded: only then the slider may send it.
    public var confirmationIsCurrent: Bool {
        guard let confirmation, checkError == nil else { return false }
        guard let typedAmounts else { return true }
        return typedAmounts == RemoteBolusAmounts(carbsG: confirmation.carbsG, insulinU: confirmation.insulinU)
    }

    /// The patient every command of this flow is for: named on the confirmation, in Face ID and the notifications.
    public let patientID: String
    @Published public var patientName: String?
    private let api: RemoteCommandsAPI
    /// This phone's settings for the patient's loop (Trio's or Loop's), read when needed: the loop may change.
    private let limits: () -> RemoteCommandLimits?
    private let makeSender: () -> RemoteCommandSending
    private let now: () -> Date
    /// This phone's DIY acknowledgement (DIYAcknowledgement, scope .remoteBolus); nil: none asked (tests, previews).
    private let acknowledgement: DIYAcknowledgementStoring?
    /// The acknowledgement was accepted on this phone: until then the confirmation asks for it and nothing is sent.
    @Published public private(set) var bolusAcknowledged: Bool

    public init(patientID: String, patientName: String? = nil, api: RemoteCommandsAPI, limits: @escaping () -> RemoteCommandLimits?, acknowledgement: DIYAcknowledgementStoring? = nil, makeSender: @escaping () -> RemoteCommandSending, now: @escaping () -> Date = Date.init) {
        self.patientName = patientName
        self.patientID = patientID
        self.api = api
        self.limits = limits
        self.makeSender = makeSender
        self.now = now
        self.acknowledgement = acknowledgement
        self.bolusAcknowledged = acknowledgement?.isAccepted(.remoteBolus) ?? true
    }

    /// "Rozumiem i akceptuję" in the confirmation: remembered on this phone, for every patient.
    public func acceptBolusAcknowledgement() {
        acknowledgement?.acceptIfNeeded(.remoteBolus, at: now())
        bolusAcknowledged = true
    }

    /// Read again (another screen of this phone may have accepted it meanwhile).
    public func refreshBolusAcknowledgement() {
        let accepted = acknowledgement?.isAccepted(.remoteBolus) ?? true
        if accepted != bolusAcknowledged { bolusAcknowledged = accepted }
    }

    /// Trio's settings only (tests, previews).
    public convenience init(patientID: String, patientName: String? = nil, api: RemoteCommandsAPI, settingsStore: TrioRemoteSettingsStore, acknowledgement: DIYAcknowledgementStoring? = nil, makeSender: @escaping () -> RemoteCommandSending, now: @escaping () -> Date = Date.init) {
        self.init(patientID: patientID, patientName: patientName, api: api, limits: { (try? settingsStore.load(patientID: patientID)) ?? nil }, acknowledgement: acknowledgement, makeSender: makeSender, now: now)
    }

    /// A card's dose refused as expired (by this phone or the server): the chat reads the card's state again.
    public let proposalExpired = PassthroughSubject<String, Never>()

    /// Device mode: fetches the signing challenge as soon as a confirmation opens (the bolus key signs it at [Podaj]).
    public var prepareSigning: (() async -> Void)?

    static let expiredNotice = "Karta jest nieaktualna: glukoza i IOB mogły się zmienić. Przelicz dawkę na aktualnych danych."

    /// The pump's step from the last check (Trio reports it to Nightscout); it wins over this phone's setting.
    public private(set) var pumpBolusStep: Decimal?

    public var bolusStep: Decimal {
        pumpBolusStep ?? limits()?.bolusIncrement ?? Decimal(string: "0.05")!
    }

    /// The phone's own limits for these amounts (settings of this patient); nil when they fit or nothing is set.
    public func limitProblem(carbsG: Int, insulinU: Decimal) -> String? {
        limits()?.limitProblem(carbsG: carbsG, insulinU: insulinU)
    }

    /// Remembers the pump's step a check reported.
    public func adopt(_ preview: RemoteCommandPreview) {
        if let step = preview.pumpBolusStep { pumpBolusStep = step }
    }

    /// Checks the exact values with fresh data and opens the confirmation; blocks are shown there and keep [Podaj] off.
    public func prepare(_ base: RemoteBolusDraftBase) async {
        // A card past its validity (the chat not refreshed since) never opens a confirmation.
        if base.proposalExpired(at: now()) {
            expire(base)
            return
        }
        state = .checking
        do {
            var (rounded, preview) = try await check(base)
            // The check may report a coarser pump step than assumed: rounded down again and checked again.
            let again = RemoteCommandFormat.roundDown(rounded.insulinU, step: bolusStep)
            if again != rounded.insulinU {
                (rounded, preview) = try await check(rounded)
            }
            state = .idle
            confirmation = RemoteBolusConfirmation(draftBase: rounded, preview: preview, checkedAt: now())
            if let prepareSigning { Task { await prepareSigning() } }
        } catch {
            state = .failed(error.remoteCommandRefusal ?? "Nie udało się sprawdzić danych pacjenta.")
        }
    }

    /// A chat card's dose may be finer than the pump step: rounded down, never up, then checked.
    private func check(_ base: RemoteBolusDraftBase) async throws -> (RemoteBolusDraftBase, RemoteCommandPreview) {
        let rounded = base.with(carbsG: base.carbsG, insulinU: RemoteCommandFormat.roundDown(base.insulinU, step: bolusStep))
        let preview = try await api.previewRemoteCommand(patientID: patientID, carbsG: rounded.carbsG, insulinU: rounded.insulinU, bolusStep: bolusStep, mealInMinutes: nil, proposalID: rounded.proposalID, source: rounded.source, plannedBolusID: rounded.plannedBolusID)
        adopt(preview)
        return (rounded, preview)
    }

    /// The caregiver changed the values in the confirmation: checked again, the sheet stays. Until the check is back
    /// (and when it fails) the confirmation is not current, so the old values are never sent under the new ones.
    public func update(carbsG: Int, insulinU: Decimal) async {
        guard let current = confirmation else { return }
        // A typed dose is rounded down to the pump step (never up).
        let insulinU = RemoteCommandFormat.roundDown(insulinU, step: bolusStep)
        let requested = RemoteBolusAmounts(carbsG: carbsG, insulinU: insulinU)
        typedAmounts = requested
        checkError = nil
        let base = current.draftBase.with(carbsG: carbsG, insulinU: insulinU)
        do {
            let preview = try await api.previewRemoteCommand(patientID: patientID, carbsG: carbsG, insulinU: insulinU, bolusStep: bolusStep, mealInMinutes: nil, proposalID: base.proposalID, source: base.source, plannedBolusID: base.plannedBolusID)
            adopt(preview)
            // A newer check (other amounts typed meanwhile) or another confirmation wins over this answer.
            guard confirmation?.id == current.id, typedAmounts == requested else { return }
            confirmation = RemoteBolusConfirmation(id: current.id, draftBase: base, preview: preview, checkedAt: now())
        } catch {
            // A check replaced by the next keystroke says nothing; the confirmation stays not current meanwhile.
            guard !Task.isCancelled, confirmation?.id == current.id, typedAmounts == requested else { return }
            checkError = error.remoteCommandRefusal ?? "Nie udało się sprawdzić dawki. Sprawdź połączenie i spróbuj ponownie."
        }
    }

    /// "Sprawdź ponownie" after a failed check: the amounts typed last, checked again.
    public func recheck() async {
        guard let typedAmounts else { return }
        await update(carbsG: typedAmounts.carbsG, insulinU: typedAmounts.insulinU)
    }

    /// Sends without a confirmation sheet (the Bolus tab is the confirmation itself).
    public func send(_ draft: RemoteCommandDraft) async {
        refreshBolusAcknowledgement()
        guard bolusAcknowledged else {
            state = .failed(DIYAcknowledgement.requiredMessage)
            return
        }
        state = .sending
        switch await makeSender().send(draft) {
        case let .sent(command):
            state = .sent(command)
        case let .proposalExpired(message):
            state = .failed(message)
            if let id = draft.proposalID { proposalExpired.send(id) }
        case let .notSent(message), let .sendFailed(message):
            state = .failed(message)
        }
    }

    public func cancel() {
        confirmation = nil
        state = .idle
    }

    /// [Podaj] in the confirmation: Face ID, the server, the push. Data older than the Bolus tab allows (the sheet open a
    /// while) are read again first and the caregiver slides again: the server notices only changed warnings.
    /// Insulin while glucose is below 70 or a low is near (INSULIN_WHILE_LOW): the slide asks once more, separately,
    /// before Face ID (dose-calculator.v1).
    public var confirmationNeedsLowGlucoseStep: Bool {
        confirmation.map(confirmationNeedsLowGlucoseStepFor) ?? false
    }

    private func confirmationNeedsLowGlucoseStepFor(_ confirmation: RemoteBolusConfirmation) -> Bool {
        confirmation.insulinU > 0 && confirmation.preview.warnings.contains(where: \.needsSeparateConfirmation)
    }

    public func confirm(lowGlucoseConfirmed: Bool = false) async {
        guard let confirmation, confirmation.canConfirm, confirmationIsCurrent else { return }
        refreshBolusAcknowledgement()
        guard bolusAcknowledged else { return }
        if confirmationNeedsLowGlucoseStep && !lowGlucoseConfirmed { return }
        if confirmation.draftBase.proposalExpired(at: now()) {
            self.confirmation = nil
            expire(confirmation.draftBase)
            return
        }
        if now().timeIntervalSince(confirmation.checkedAt) > RemoteBolusViewModel.previewMaxAge {
            await refreshStaleData(confirmation)
            return
        }
        self.confirmation = nil
        state = .sending
        var draft = confirmation.draft
        draft.lowGlucoseConfirmed = lowGlucoseConfirmed && confirmationNeedsLowGlucoseStepFor(confirmation)
        switch await makeSender().send(draft) {
        case let .sent(command):
            state = .sent(command)
        case let .proposalExpired(message):
            state = .failed(message)
            if let id = confirmation.draftBase.proposalID { proposalExpired.send(id) }
        case let .notSent(message), let .sendFailed(message):
            state = .failed(message)
        }
    }

    public func reset() {
        state = .idle
    }

    /// Nothing is sent for an expired card; the chat reads it again (it then shows "Przelicz na aktualnych danych").
    private func expire(_ base: RemoteBolusDraftBase) {
        state = .failed(Self.expiredNotice)
        if let id = base.proposalID { proposalExpired.send(id) }
    }

    static let recheckingNotice = "Odświeżam dane pacjenta…"
    static let recheckedNotice = "Dane pacjenta zostały odświeżone. Sprawdź i przesuń ponownie."
    static let recheckFailedNotice = "Nie udało się odświeżyć danych pacjenta. Przesuń ponownie, żeby spróbować jeszcze raz."

    /// The same values checked again with fresh data; the sheet stays and nothing is sent.
    private func refreshStaleData(_ current: RemoteBolusConfirmation) async {
        confirmation = RemoteBolusConfirmation(id: current.id, draftBase: current.draftBase, preview: current.preview, checkedAt: current.checkedAt, notice: Self.recheckingNotice, isRechecking: true)
        do {
            let (rounded, preview) = try await check(current.draftBase)
            guard confirmation?.id == current.id else { return }
            confirmation = RemoteBolusConfirmation(id: current.id, draftBase: rounded, preview: preview, checkedAt: now(), notice: Self.recheckedNotice)
        } catch {
            guard confirmation?.id == current.id else { return }
            confirmation = RemoteBolusConfirmation(id: current.id, draftBase: current.draftBase, preview: current.preview, checkedAt: current.checkedAt, notice: error.remoteCommandRefusal ?? Self.recheckFailedNotice)
        }
    }
}

/// What became of the command sent from the Bolus tab, followed until Trio's final answer. The form keeps the typed
/// amounts until then: cleared when the bolus was given, kept when Trio refused or did not answer, and only the carbs
/// cleared when Trio stored them but refused the bolus.
public enum RemoteBolusOutcome: Equatable {
    /// Sent and waiting for Trio: the form is locked.
    case waiting(RemoteCommand)
    case given(RemoteCommand)
    case refused(RemoteCommand, TrioReplyText)
    /// The carbs are in Trio, the bolus was refused: only the insulin stays on the form.
    case carbsOnly(RemoteCommand, TrioReplyText)
    /// Trio did not answer in time: the dose may or may not have been given.
    case noReply(RemoteCommand)

    public var command: RemoteCommand {
        switch self {
        case let .waiting(command), let .given(command), let .refused(command, _), let .carbsOnly(command, _), let .noReply(command): return command
        }
    }

    public var isWaiting: Bool {
        if case .waiting = self { return true }
        return false
    }

    /// The step reached while waiting: 0 sending, 1 sent (Trio has not answered), 2 Trio accepted and doses.
    public var step: Int {
        switch command.status {
        case "AUTHORIZED": return 0
        case "SENT": return 1
        default: return 2
        }
    }
}

/// A retry of a command Trio refused, set from the history: the bolus alone when Trio kept the carbs.
public struct RemoteBolusRetryTarget: Equatable {
    public let followsCommandID: String
    public let proposalID: String?
    public let conversationID: String?
    /// PARTIAL: the carbs are in Trio already, only insulin may be sent.
    public let carbsKept: Bool
}

/// The Bolus tab (W3, layout chosen 2026-10-19): carbs → insulin by ICR (editable on a keypad), the patient's data, and
/// a slider that sends at once (it is the confirmation itself); the history of commands next to it.
@MainActor
public final class RemoteBolusViewModel: ObservableObject {
    @Published public var carbsText = "" {
        didSet {
            guard carbsText != oldValue else { return }
            if !isSettingInsulin { dismissFinishedOutcome() }
            // An empty form starts over: the next carbs fill the dose from the ICR again.
            if carbsText.trimmingCharacters(in: .whitespaces).isEmpty && insulinText.isEmpty && !isSettingInsulin { insulinEdited = false }
            schedulePreview()
        }
    }
    /// Any change the caregiver makes to the dose is theirs, an emptied field too (no dose, or one about to be typed):
    /// the ICR dose comes back only with "przelicz z ICR".
    @Published public var insulinText = "" {
        didSet { if insulinText != oldValue && !isSettingInsulin { insulinEdited = true; dismissFinishedOutcome(); schedulePreview() } }
    }
    @Published public private(set) var insulinEdited = false
    /// "Posiłek za 15 min": the carbs are eaten 15 min from now: the dose comes from the ICR of that time, Trio dates the
    /// carbs then (`scheduled_time`, the bolus starts now) and the chart has them then instead of the usual 10 min after
    /// the bolus (bolus-forecast.v3).
    @Published public var mealLater = false {
        didSet { if mealLater != oldValue { schedulePreview() } }
    }
    public static let mealLaterMinutes = 15
    /// "Przypomnij": what to remind about after this bolus (Bolus tab sends only; cleared with the form). A reminder
    /// needs a meal: setting one ticks "Zapisz jako posiłek", clearing them all puts the box back as it was before.
    @Published public var reminderPlan = BolusReminderPlan() {
        didSet {
            switch (oldValue.isEmpty, reminderPlan.isEmpty) {
            case (true, false):
                saveAsMealBeforeReminders = saveAsMeal
                saveAsMeal = true
            case (false, true):
                saveAsMeal = saveAsMealBeforeReminders ?? saveAsMeal
                saveAsMealBeforeReminders = nil
            default: break
            }
        }
    }
    /// "Zapisz jako posiłek": the dose becomes a meal of the Meals journal (Bolus tab, with carbs). Ticked and fixed
    /// while a reminder is set.
    @Published public var saveAsMeal = false
    private var saveAsMealBeforeReminders: Bool?
    /// The box follows the reminders while any is set (they belong to the meal).
    public var saveAsMealLocked: Bool { !reminderPlan.isEmpty }
    @Published public private(set) var preview: RemoteCommandPreview?
    @Published public private(set) var previewError: String?
    @Published public private(set) var recentCommands: [RemoteCommand] = []
    @Published public private(set) var retry: RemoteBolusRetryTarget?
    /// The command sent from this tab and what became of it (nil before a send, and once the caregiver moves on).
    @Published public private(set) var outcome: RemoteBolusOutcome?
    /// How often the history is read while a command waits for Trio (live updates may be late or off).
    nonisolated public static let outcomePollInterval: TimeInterval = 2
    private var outcomeTask: Task<Void, Never>?
    /// Trio's final answer while it is shown on the steps (the last one resolves) before the card and the form change:
    /// the answer and the card would otherwise arrive in the same instant, and the last step would never be seen.
    @Published public private(set) var settling: RemoteCommand?
    /// How long the resolved steps stay (0 applies the answer at once).
    public var outcomeHold: TimeInterval = 0.9
    private var settleTask: Task<Void, Never>?
    /// Why the slide did not send (data changed meanwhile): shown above the slider.
    @Published public private(set) var slideNotice: String?
    /// The slide asked for insulin while glucose is below 70 or a low is near: the separate confirmation is open.
    @Published public var pendingLowGlucoseConfirmation = false

    public let flow: RemoteBolusFlow
    private let patientID: String
    private let api: RemoteCommandsAPI
    private let now: () -> Date
    private var previewTask: Task<Void, Never>?
    private var isSettingInsulin = false
    /// The form is being filled from a refused command: not the caregiver's typing.
    private var isApplyingRetry = false
    private var liveSubscription: AnyCancellable?
    private var flowSubscription: AnyCancellable?
    private var previewedAt: Date?
    /// The meal time the last check was for ("+15 min" or not): it changes the ICR and the carbs' date in Trio.
    private var previewedMealLater = false
    private var previewMealTimeMatches: Bool { previewedMealLater == (mealLater && (carbsG ?? 0) > 0) }
    /// Each check's number: only the newest one's answer is shown (an older one may arrive later).
    private var previewGeneration = 0

    /// The data behind the slider may be this old when it is slid; older data are read again first.
    nonisolated public static let previewMaxAge: TimeInterval = 120

    /// The last 3 hours of glucose for the chart on top (the dashboard's readings).
    @Published public private(set) var readings: [DashboardReading] = []
    /// The readings were asked for once (the chart shows its loader until then).
    @Published public private(set) var readingsLoaded = false
    private let glucoseHistory: (() async -> [DashboardReading])?
    /// Meals whose bolus push already left this phone for Loop (lowercased ids): the server knows only that Loop
    /// stored the carbs until Loop answers the bolus.
    @Published public private(set) var loopBolusSent: Set<String> = []
    private var loopBolusSubscription: AnyCancellable?

    public init(patientID: String, api: RemoteCommandsAPI, flow: RemoteBolusFlow, now: @escaping () -> Date = Date.init, glucoseHistory: (() async -> [DashboardReading])? = nil) {
        self.patientID = patientID
        self.api = api
        self.flow = flow
        self.now = now
        self.glucoseHistory = glucoseHistory
        flowSubscription = flow.objectWillChange.sink { [weak self] _ in self?.objectWillChange.send() }
        loopBolusSubscription = NotificationCenter.default.publisher(for: .loopBolusPushSent)
            .compactMap { $0.object as? String }
            .receive(on: DispatchQueue.main)
            .sink { [weak self] id in self?.loopBolusSent.insert(id) }
    }

    public func loopBolusWasSent(_ command: RemoteCommand) -> Bool { loopBolusSent.contains(command.id.lowercased()) }

    public var carbsG: Int? {
        let trimmed = carbsText.trimmingCharacters(in: .whitespaces)
        if trimmed.isEmpty { return 0 }
        return Int(trimmed)
    }

    public var insulinU: Decimal? {
        let normalized = insulinText.trimmingCharacters(in: .whitespaces).replacingOccurrences(of: ",", with: ".")
        if normalized.isEmpty { return 0 }
        return Decimal(string: normalized, locale: Locale(identifier: "en_US_POSIX"))
    }

    /// The slider is on: amounts given and checked (the check matches what is on screen), nothing blocking, nothing in
    /// progress. It follows the keypad as the caregiver types.
    public var canGive: Bool {
        guard let carbs = carbsG, let insulin = insulinU, let preview else { return false }
        let checked = preview.carbs_g == carbs && Decimal(preview.insulin_u) == insulin && previewMealTimeMatches
        return (carbs > 0 || insulin > 0) && checked && preview.blocks.isEmpty && limitProblem == nil && flow.state != .sending && flow.state != .checking && !isLocked && flow.bolusAcknowledged
    }

    /// Over this phone's limits: said as it is typed and the slider stays off (nothing is sent to be refused later).
    public var limitProblem: String? {
        guard let carbs = carbsG, let insulin = insulinU else { return nil }
        return flow.limitProblem(carbsG: carbs, insulinU: insulin)
    }

    /// Blocks worth showing: on an empty form "type an amount" is obvious from the inactive slider (a dose off the pump
    /// step still says so).
    public var visibleBlocks: [RemoteCommandNotice] {
        guard previewMatchesScreen else { return [] }
        let empty = (carbsG ?? 0) == 0 && (insulinU ?? 0) == 0
        let waiting = waitingUntil != nil
        return (preview?.blocks ?? []).filter { !(empty && $0.code == "INVALID_AMOUNTS") && !(waiting && $0.code == "COMMAND_IN_FLIGHT") }
    }

    /// Until when a command of this patient (from any phone) may still get Trio's answer: the slider waits, with a
    /// countdown instead of a refusal after sliding. Nil when nothing waits.
    public var waitingUntil: Date? {
        guard let waiting = recentCommands.first(where: { $0.isWaitingForTrio }),
              let start = ServerDate.parse(waiting.sent_at ?? waiting.authorized_at) else { return nil }
        let until = start.addingTimeInterval(RemoteCommandSender.lockTimeout)
        return until > now() ? until : nil
    }

    /// The warnings of the check of the amounts on screen (none while a newer check is on its way).
    public var visibleWarnings: [RemoteCommandNotice] {
        previewMatchesScreen ? (preview?.warnings ?? []) : []
    }

    /// The last check was for the amounts on screen. While typing, the previous check (e.g. of the empty form: "Podaj
    /// węglowodany…") would flash under the new amounts until the new one arrives.
    public var previewMatchesScreen: Bool {
        guard let preview, let carbs = carbsG, let insulin = insulinU else { return false }
        return preview.carbs_g == carbs && Decimal(preview.insulin_u) == insulin
    }

    /// The chart is behind the form: the amounts or the meal time changed and the new forecast is on its way (or the
    /// first one is). Not while the amounts cannot be read or the check failed.
    public var chartIsUpdating: Bool {
        guard previewError == nil, let carbs = carbsG, insulinU != nil else { return false }
        guard let preview else { return true }
        if !previewMatchesScreen { return true }
        let shown = preview.forecast?.meal_in_minutes ?? Self.usualMealInMinutes
        return shown != (mealLater && carbs > 0 ? Self.mealLaterMinutes : Self.usualMealInMinutes)
    }
    /// Nothing to draw yet: the tab was just opened and the first check or the readings are on their way.
    public var chartIsLoading: Bool {
        (preview == nil && previewError == nil) || !readingsLoaded
    }

    /// The server's usual meal time on the chart (bolus-forecast.v3: 10 min after the bolus).
    static let usualMealInMinutes = 10

    /// The line under the amounts: where the dose comes from.
    public var icrHint: String? {
        guard previewMatchesScreen, let preview, let icr = preview.icr_g_per_u, let carbs = carbsG, carbs > 0, let fromICR = preview.icr_insulin_u else { return nil }
        // "+15 min": the ICR of the meal's time, said with that time.
        let at = preview.context.carbs_at.flatMap(ServerDate.parse).map { " o \(BolusReminderPlan.clock($0, calendar: .current))" } ?? ""
        return insulinEdited
            ? "Zmieniono ręcznie · z ICR \(RemoteCommandFormat.units(icr))\(at): \(RemoteCommandFormat.units(fromICR)) j"
            : "Z ICR \(RemoteCommandFormat.units(icr))\(at) · stuknij liczbę, żeby zmienić"
    }

    /// Opening the tab: the check, the history and the chart's readings at once (one after another kept the chart
    /// empty for a while).
    public func load() async {
        async let preview: Void = refreshPreview()
        async let recent: Void = refreshRecent()
        async let readings: Void = refreshReadings()
        _ = await (preview, recent, readings)
    }

    public func refreshReadings() async {
        defer { if !readingsLoaded { readingsLoaded = true } }
        guard let glucoseHistory else { return }
        let since = now().addingTimeInterval(-3 * 3600)
        let fetched = await glucoseHistory()
        // A read cut short (the tab was left) or failed comes back empty: the readings on screen stay.
        guard !Task.isCancelled, !fetched.isEmpty || readings.isEmpty else { return }
        let recent = fetched.filter { (ServerDate.parse($0.at) ?? .distantPast) >= since }
        if recent != readings { readings = recent }
    }

    /// "30 g ÷ ICR 8 = 3,8 j": where the dose from the carbs comes from (nil without carbs or ICR).
    public var icrLine: String? {
        guard previewMatchesScreen, let preview, let icr = preview.icr_g_per_u, let carbs = carbsG, carbs > 0, let fromICR = preview.icr_insulin_u else { return nil }
        return "\(carbs) g ÷ ICR \(RemoteCommandFormat.units(icr)) = \(RemoteCommandFormat.units(fromICR)) j"
    }

    public func refreshRecent() async {
        if let items = try? await api.listRemoteCommands(patientID: patientID, limit: 50) {
            recentCommands = items
            applyOutcome()
        }
    }

    /// New commands (also the other caregiver's) and their answers change the history and the checks.
    public func bindLiveUpdates(_ live: LiveUpdates?) {
        liveSubscription = live?.changes
            .filter { $0.concerns(kind: "remote_command") }
            .debounce(for: .milliseconds(300), scheduler: RunLoop.main)
            .sink { [weak self] _ in
                Task {
                    await self?.refreshRecent()
                    await self?.refreshPreview()
                }
            }
    }

    /// Back to the dose the form starts from: the calculator's default (dose-calculator.v1), else carbs / ICR.
    public func useICRDose() {
        insulinEdited = false
        setInsulin(preview.flatMap(Self.defaultDose))
        schedulePreview()
    }

    /// The dose an empty form starts from: the calculator's default, or carbs / ICR from an older server.
    nonisolated static func defaultDose(_ preview: RemoteCommandPreview) -> Double? {
        preview.dose_calculation?.default_u ?? preview.icr_insulin_u
    }

    /// The dose "Przywróć" puts back (nil without carbs or a calculation).
    public var defaultDose: Double? {
        guard let preview, (carbsG ?? 0) > 0 else { return nil }
        return Self.defaultDose(preview)
    }

    /// Where the dose on the form can come from, the corner ± switch's two modes (only one at a time, lower wins):
    /// - the calculator lowered the default: `.icr` offers carbs / ICR (switch on: the calculator's dose is on the form),
    ///   `.calculator` brings the calculator's dose back (switch off);
    /// - an opt-in higher dose exists (dose-calculator.v2): `.higher` puts it on the form (switch off: the default is on),
    ///   `.withoutHigher` goes back to the default (switch on: the higher dose is on).
    public enum DoseSource: Equatable, Sendable {
        case icr
        case calculator
        case higher
        case withoutHigher
    }

    /// carbs / ICR (rounded to the pump step) when the calculator's default is below it; nil when not lowered.
    nonisolated static func loweredICRDose(_ preview: RemoteCommandPreview) -> Double? {
        guard let calculation = preview.dose_calculation, let icr = preview.icr_insulin_u ?? calculation.icr_dose_u,
              icr > calculation.default_u + 1e-9 else { return nil }
        return icr
    }

    /// The opt-in higher dose (half a correction on top of the default; at 0 g the correction alone), when offered and
    /// the default is not lowered (the lower mode wins).
    nonisolated static func higherDose(_ preview: RemoteCommandPreview) -> Double? {
        guard loweredICRDose(preview) == nil, let calculation = preview.dose_calculation, calculation.offersHigher else { return nil }
        return calculation.higher_u
    }

    /// The insulin field's corner ± switch: the source a tap puts on the form, nil when it is not shown. Lowered: shown
    /// only with carbs, on while the calculator's lower default is on the form (it offers carbs / ICR), off for carbs /
    /// ICR or a typed dose (it offers the calculator's default back, the way "Przywróć" used to). Higher (also at 0 g):
    /// off while the default (or a typed dose) is on the form, on while the higher dose is. Read from the last check of
    /// these carbs (not only one for the exact dose), so it does not blink while the new dose is checked.
    public var doseSourceOffer: DoseSource? {
        guard retry == nil, !isLocked, let carbs = carbsG, let preview, preview.carbs_g == carbs,
              let calculation = preview.dose_calculation else { return nil }
        if carbs > 0, Self.loweredICRDose(preview) != nil {
            return Self.sameUnits(insulinU, calculation.default_u) ? .icr : .calculator
        }
        if let higher = Self.higherDose(preview) {
            return Self.sameUnits(insulinU, higher) ? .withoutHigher : .higher
        }
        return nil
    }

    /// The corner switch's state: on (filled) while the calculator's lower dose, or the opt-in higher dose, is on the
    /// form; nil: not shown.
    public var calculatorSwitchOn: Bool? {
        doseSourceOffer.map { $0 == .icr || $0 == .withoutHigher }
    }

    /// The switch is in its opt-in higher mode (dose-calculator.v2).
    public var doseSwitchAddsCorrection: Bool {
        doseSourceOffer == .higher || doseSourceOffer == .withoutHigher
    }

    /// Carbs / ICR is the dose on screen while the calculator would give less.
    public var icrDoseChosen: Bool {
        guard previewMatchesScreen, let preview, (carbsG ?? 0) > 0, let icr = Self.loweredICRDose(preview) else { return false }
        return Self.sameUnits(insulinU, icr)
    }

    /// The opt-in higher dose is the dose on screen.
    public var higherDoseChosen: Bool {
        guard previewMatchesScreen, let preview, let higher = Self.higherDose(preview) else { return false }
        return Self.sameUnits(insulinU, higher)
    }

    /// The corner button's tap: carbs / ICR or the higher dose (a dose of the caregiver's, checked and warned about like
    /// a typed one), or back to the calculator's default (at 0 g: an empty dose).
    public func useDoseSource(_ source: DoseSource) {
        switch source {
        case .calculator:
            useICRDose()
        case .icr:
            guard let preview, let icr = Self.loweredICRDose(preview) else { return }
            setInsulin(icr)
            insulinEdited = true
            dismissFinishedOutcome()
            schedulePreview()
        case .higher:
            guard let preview, let higher = Self.higherDose(preview) else { return }
            setInsulin(higher)
            insulinEdited = true
            dismissFinishedOutcome()
            schedulePreview()
        case .withoutHigher:
            if (carbsG ?? 0) > 0 {
                useICRDose()
            } else {
                insulinEdited = false
                setInsulin(nil)
                dismissFinishedOutcome()
                schedulePreview()
            }
        }
    }

    nonisolated private static func sameUnits(_ value: Decimal?, _ units: Double) -> Bool {
        guard let value else { return false }
        return abs(NSDecimalNumber(decimal: value).doubleValue - units) < 1e-6
    }

    /// The calculator's line under the dose: why it is what it is (dose-calculator.v1). Nil while the check is not for the
    /// screen, without a calculation, and for an empty form. With carbs / ICR chosen over a lower default: how much more
    /// than the calculator and why it gave less ("Z przelicznika: 1,6 j więcej niż kalkulator (aktywna insulina)").
    public var calculatorLine: String? {
        // dose-calculator.v2: the higher dose on the form says what it adds; offered, the line says it can be added.
        if let line = higherLine { return line }
        guard previewMatchesScreen, let calculation = preview?.dose_calculation, !calculation.summary.isEmpty else { return nil }
        guard (carbsG ?? 0) > 0 || (insulinU ?? 0) > 0 else { return nil }
        if icrDoseChosen, let preview, let icr = Self.loweredICRDose(preview) {
            let more = ((icr - calculation.default_u) * 100).rounded() / 100
            let why = calculation.reason_code.flatMap(Self.loweredReasonWords).map { " (\($0))" } ?? ""
            return "Z przelicznika: \(RemoteCommandFormat.units(more))\u{00A0}j więcej niż kalkulator\(why)"
        }
        return calculation.line
    }

    /// The server's reason for a lower default, in the words of its line (dose-calculator.ts LOWERED_REASON_WORDS).
    nonisolated static func loweredReasonWords(_ code: String) -> String? {
        switch code {
        case "ACTIVE_INSULIN": return "aktywna insulina"
        case "FALLING": return "glukoza spada"
        case "BELOW_TARGET": return "glukoza poniżej celu"
        case "LOW_CARBS_FIRST": return "niska glukoza — najpierw węglowodany"
        case "LOOP_FORECAST_LOW": return "prognoza poniżej celu"
        default: return nil
        }
    }

    /// The whole explanation and the formula behind the line's info button (nil when the line says it all).
    public var calculatorDetails: String? {
        guard calculatorLine != nil else { return nil }
        if higherLine != nil, let calculation = preview?.dose_calculation {
            // Offered over a meal's default: what the default itself is, then the correction's reasoning.
            let offeredOverMeal = !higherDoseChosen && (carbsG ?? 0) > 0
            let base = offeredOverMeal ? (calculation.details ?? calculation.line) : nil
            return [base, calculation.higherDetails].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: "\n\n")
        }
        return preview?.dose_calculation?.details
    }

    /// The line while the switch is in its higher mode, short enough for one line of the Insulina tile (the glucose,
    /// trend, IOB and formula are behind the info button): on, what the correction adds ("+0,3 j korekty (połowa)" at
    /// 0 g, "+0,3 j korekty do przelicznika (połowa)" over a meal); off with the default (an empty dose at 0 g) on the
    /// form, that it can be added ("Korekta do wyboru: +0,3 j (±)"). Nil otherwise (a dose typed over keeps the
    /// calculator's own line).
    private var higherLine: String? {
        guard previewMatchesScreen, let calculation = preview?.dose_calculation, let extra = calculation.higherExtraU,
              let offer = doseSourceOffer, offer == .higher || offer == .withoutHigher else { return nil }
        let units = "+\(RemoteCommandFormat.units(extra))\u{00A0}j"
        let carbs = carbsG ?? 0
        if higherDoseChosen {
            return carbs > 0 ? "\(units) korekty do przelicznika (połowa)" : "\(units) korekty (połowa)"
        }
        let onDefault = carbs > 0 ? Self.sameUnits(insulinU, calculation.default_u) : (insulinU ?? 0) == 0
        guard onDefault else { return nil }
        return "Korekta do wyboru: \(units) (±)"
    }

    /// The default is below carbs / ICR: the line is shown as a warning colour.
    public var calculatorLowersDose: Bool {
        previewMatchesScreen && (preview?.dose_calculation?.lowersDose ?? false) && (carbsG ?? 0) > 0
    }

    /// "Podaj ponownie" in the history: the form takes the refused dose (insulin alone when Trio kept the carbs).
    public func prepareRetry(of command: RemoteCommand) {
        guard command.status == "PARTIAL" || command.status == "REJECTED" else { return }
        let carbsKept = command.status == "PARTIAL"
        retry = RemoteBolusRetryTarget(followsCommandID: command.id, proposalID: command.proposal_id, conversationID: command.conversation_id, carbsKept: carbsKept)
        isApplyingRetry = true
        defer { isApplyingRetry = false }
        isSettingInsulin = true
        carbsText = carbsKept ? "" : String(command.carbs_g)
        insulinText = RemoteCommandFormat.units(command.insulin_u)
        isSettingInsulin = false
        insulinEdited = true
        slideNotice = nil
        schedulePreview()
    }

    public func cancelRetry() {
        retry = nil
        outcome = nil
        clearForm()
    }

    /// The slide: sends what is on screen, with the warnings on screen acknowledged. When the data behind the screen are
    /// old or do not match the amounts (typed after the last check), they are read again and the caregiver slides again.
    public func slideToGive(lowGlucoseConfirmed: Bool = false) async {
        slideNotice = nil
        guard let carbs = carbsG, let insulin = insulinU, let preview else { return }
        let current = preview.carbs_g == carbs && Decimal(preview.insulin_u) == insulin && previewMealTimeMatches
        let fresh = previewedAt.map { now().timeIntervalSince($0) <= Self.previewMaxAge } ?? false
        guard current, fresh, preview.blocks.isEmpty else {
            await refreshPreview()
            slideNotice = "Dane pacjenta się zmieniły. Sprawdź i przesuń ponownie."
            return
        }
        // Insulin while carbs should come first: a separate, explicit confirmation before anything is sent.
        if preview.warnings.contains(where: \.needsSeparateConfirmation) && !lowGlucoseConfirmed {
            pendingLowGlucoseConfirmation = true
            return
        }
        pendingLowGlucoseConfirmation = false
        let draft = RemoteCommandDraft(
            source: retry?.proposalID != nil ? .chatCard : .bolusScreen,
            carbsG: carbs,
            insulinU: insulin,
            conversationID: retry?.conversationID,
            proposalID: retry?.proposalID,
            meal: nil,
            followsCommandID: retry?.followsCommandID,
            acknowledgedWarnings: preview.warnings.map(\.acknowledgementKey),
            confirmedAt: ServerDate.parse(preview.context.now),
            pumpBolusStep: preview.pumpBolusStep
        )
        var withReminders = draft
        withReminders.lowGlucoseConfirmed = lowGlucoseConfirmed && insulin > 0 && preview.warnings.contains(where: \.needsSeparateConfirmation)
        if draft.source == .bolusScreen, carbs > 0 {
            withReminders.reminders = reminderPlan.reminders
            withReminders.createMeal = saveAsMeal || !reminderPlan.isEmpty
            if mealLater { withReminders.mealInMinutes = Self.mealLaterMinutes }
        }
        outcome = nil
        await flow.send(withReminders)
        if case let .sent(command) = flow.state {
            // Sent, not given: the amounts stay (locked) until Trio's final answer.
            follow(command)
        }
        await refreshRecent()
    }

    /// The form is locked while this tab's command waits for Trio (and while it is being sent).
    public var isLocked: Bool {
        flow.state == .sending || (outcome?.isWaiting ?? false)
    }

    /// Follows a sent command until Trio's final answer: the history is read every couple of seconds (live updates
    /// read it too) and each read applies what it says.
    public func follow(_ command: RemoteCommand) {
        outcome = .waiting(command)
        outcomeTask?.cancel()
        outcomeTask = Task { [weak self] in
            let deadline = Date().addingTimeInterval(RemoteCommandSender.lockTimeout + 30)
            while !Task.isCancelled, Date() < deadline {
                try? await Task.sleep(nanoseconds: UInt64(Self.outcomePollInterval * 1_000_000_000))
                guard let self, !Task.isCancelled else { return }
                await self.refreshRecent()
                if self.outcome?.isWaiting != true { return }
            }
        }
    }

    /// What the newest history says about the followed command.
    func applyOutcome() {
        guard settling == nil, case let .waiting(followed)? = outcome, let command = recentCommands.first(where: { $0.id == followed.id }) else { return }
        guard command.isSettled || command.status == "NO_REPLY" else {
            outcome = .waiting(command)
            return
        }
        outcomeTask?.cancel()
        guard outcomeHold > 0 else { return finish(command) }
        // The steps show the answer first (still locked); the card and the form follow a moment later.
        outcome = .waiting(command)
        settling = command
        let hold = outcomeHold
        settleTask?.cancel()
        settleTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(hold * 1_000_000_000))
            guard let self, !Task.isCancelled else { return }
            self.settling = nil
            self.finish(command)
        }
    }

    /// Trio's final answer on the form: the card, and the amounts cleared or kept.
    private func finish(_ command: RemoteCommand) {
        switch command.status {
        case "SUCCEEDED":
            outcome = .given(command)
            retry = nil
            clearForm()
        case "PARTIAL":
            // The carbs are in Trio: only the insulin stays, and the next slide sends it alone.
            prepareRetry(of: command)
            outcome = .carbsOnly(command, TrioReplyText(statusMessage: command.status_message))
        case "REJECTED", "SEND_FAILED", "EXPIRED":
            prepareRetry(of: command)
            outcome = .refused(command, TrioReplyText(statusMessage: command.status_message))
        case "NO_REPLY":
            outcome = .noReply(command)
        default:
            outcome = .waiting(command)
        }
    }

    /// A finished outcome's card goes once the caregiver types something new.
    private func dismissFinishedOutcome() {
        guard let outcome, !outcome.isWaiting, !isApplyingRetry else { return }
        self.outcome = nil
    }

    /// After a sent command the form starts over; the command's state stays visible.
    public func clearForm() {
        isSettingInsulin = true
        carbsText = ""
        insulinText = ""
        isSettingInsulin = false
        insulinEdited = false
        mealLater = false
        reminderPlan = BolusReminderPlan()
        saveAsMeal = false
        saveAsMealBeforeReminders = nil
        schedulePreview()
    }

    /// Glucose has risen for the last 10 min (three readings, each higher): "gdy zacznie rosnąć" would fire at once.
    public var glucoseRisingNow: Bool {
        BolusReminderPlan.isRising(readings, now: now())
    }

    private func schedulePreview() {
        previewTask?.cancel()
        previewTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 250_000_000)
            guard !Task.isCancelled else { return }
            await self?.refreshPreview()
        }
    }

    public func refreshPreview() async {
        previewGeneration += 1
        let generation = previewGeneration
        guard let carbs = carbsG, let insulin = insulinU else {
            previewError = "Wpisz liczby."
            return
        }
        let later = mealLater && carbs > 0
        do {
            let result = try await api.previewRemoteCommand(patientID: patientID, carbsG: carbs, insulinU: insulinEdited ? insulin : nil, bolusStep: flow.bolusStep, mealInMinutes: later ? Self.mealLaterMinutes : nil, proposalID: retry?.proposalID, source: retry?.proposalID != nil ? .chatCard : .bolusScreen)
            // A newer check was asked for meanwhile (typing, live updates): its answer wins, this one is dropped.
            guard generation == previewGeneration else { return }
            flow.adopt(result)
            previewedMealLater = later
            preview = result
            previewedAt = now()
            previewError = nil
            if !insulinEdited {
                // The calculator's default (never above carbs / ICR); an older server: carbs / ICR.
                setInsulin(carbs > 0 ? Self.defaultDose(result) : nil)
            }
        } catch {
            // A check cancelled by a newer one (typing) or cut short by leaving the tab is not a failure: the last check
            // stays on screen.
            guard generation == previewGeneration, !Task.isCancelled, !error.isRequestCancellation else { return }
            previewError = error.remoteCommandRefusal ?? "Nie udało się wczytać danych pacjenta."
        }
    }

    private func setInsulin(_ value: Double?) {
        isSettingInsulin = true
        insulinText = value.map { RemoteCommandFormat.units($0) } ?? ""
        isSettingInsulin = false
    }
}


/// "Przypomnij" in the Bolus tab: the WBT and/or a second dose, when glucose starts rising or after a set time. Nothing
/// here computes a dose: at the reminder the caregiver decides.
public struct BolusReminderPlan: Equatable, Sendable {
    public enum SecondDose: Equatable, Sendable {
        case whenRising
        case after(minutes: Int)
    }

    public var wbt = false
    public var secondDose: SecondDose?

    /// The ready-made delays of "Druga dawka za zadany czas"; "Inny" takes 5-240 min.
    public static let presetMinutes = [15, 30, 60]
    public static let customMinutesRange = 5...240
    /// The WBT reminder comes 2,5 h after the bolus.
    public static let wbtMinutes = 150

    public init(wbt: Bool = false, secondDose: SecondDose? = nil) {
        self.wbt = wbt
        self.secondDose = secondDose
    }

    public var isEmpty: Bool { !wbt && secondDose == nil }
    public var count: Int { (wbt ? 1 : 0) + (secondDose == nil ? 0 : 1) }

    public var reminders: [BolusReminder] {
        var list: [BolusReminder] = []
        switch secondDose {
        case .whenRising?: list.append(.secondDoseWhenRising)
        case let .after(minutes)?: list.append(.secondDoseAfter(minutes: minutes))
        case nil: break
        }
        if wbt { list.append(.wbt) }
        return list
    }

    /// "18:35 · WBT 20:35", "Gdy rośnie · WBT 20:35": the chip once something is set.
    public func chipText(from start: Date, calendar: Calendar = .current) -> String {
        var parts: [String] = []
        switch secondDose {
        case .whenRising?: parts.append("Gdy rośnie")
        case let .after(minutes)?: parts.append(Self.clock(start.addingTimeInterval(TimeInterval(minutes * 60)), calendar: calendar))
        case nil: break
        }
        if wbt { parts.append("WBT \(Self.clock(start.addingTimeInterval(TimeInterval(Self.wbtMinutes * 60)), calendar: calendar))") }
        return parts.joined(separator: " · ")
    }

    /// Rising: the last three readings span at least 10 min, each higher than the one before, at least 3 mg/dL in all
    /// (the server's rule for "gdy zacznie rosnąć"). Readings older than 20 min say nothing about now.
    public static func isRising(_ readings: [DashboardReading], now: Date) -> Bool {
        let dated = readings.compactMap { reading in ServerDate.parse(reading.at).map { (at: $0, value: reading.value) } }
            .filter { now.timeIntervalSince($0.at) <= 20 * 60 }
            .sorted { $0.at < $1.at }
        guard dated.count >= 3 else { return false }
        let last = Array(dated.suffix(3))
        guard last[2].at.timeIntervalSince(last[0].at) >= 10 * 60 - 30 else { return false }
        return last[0].value < last[1].value && last[1].value < last[2].value && last[2].value - last[0].value >= 3
    }

    public static func clock(_ date: Date, calendar: Calendar) -> String {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "pl_PL")
        formatter.timeZone = calendar.timeZone
        formatter.dateFormat = "HH:mm"
        return formatter.string(from: date)
    }
}
