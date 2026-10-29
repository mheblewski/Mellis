import CoreImage
import CoreImage.CIFilterBuiltins
import Foundation

// "Udostępnianie" in device mode (docs/device-auth-api.md §4–6, user docs instalacja/parowanie.md): the people of
// a patient with their permissions and phones, invitations by QR code / link, this person's own phones, and the remote
// bolus grant each person confirms with Face ID on their own phone.

public extension Notification.Name {
    /// This phone confirmed a remote bolus grant (object: the patient id).
    static let remoteBolusConfirmedOnThisPhone = Notification.Name("MellisRemoteBolusConfirmedOnThisPhone")
}

/// Settings → Udostępnianie for the patient on screen.
@MainActor
public final class DeviceSharingViewModel: ObservableObject {
    @Published public private(set) var people: PatientPeopleResponse?
    @Published public private(set) var isLoading = false
    @Published public private(set) var isSaving = false
    @Published public var errorMessage: String?
    /// Set after a confirmed remote bolus grant (Face ID): shown once.
    @Published public private(set) var notice: String?

    public let patientID: String
    public let patientName: String
    public let api: DeviceSharingAPI
    private let signer: RemoteCommandSigning?

    public init(patientID: String, patientName: String, api: DeviceSharingAPI, signer: RemoteCommandSigning?) {
        self.patientID = patientID
        self.patientName = patientName
        self.api = api
        self.signer = signer
    }

    public var isOwner: Bool { people?.you_are_owner == true }

    public func load() async {
        isLoading = people == nil
        defer { isLoading = false }
        do {
            people = try await api.listPeople(patientID: patientID)
            errorMessage = nil
        } catch {
            if error.isRequestCancellation { return }
            errorMessage = DeviceAuthErrorText.message(for: error) ?? "Nie udało się wczytać listy osób."
        }
    }

    /// An owner's changes to a person's switches; only what changed is sent (a remote bolus switched on is a new grant
    /// the person confirms on their phone).
    @discardableResult
    public func update(_ person: PatientPerson, to permissions: SharingPermissions) async -> Bool {
        let changes = permissions.normalized.changes(from: person.editablePermissions)
        guard !changes.isEmpty else { return true }
        return await save { _ = try await self.api.updatePerson(patientID: self.patientID, userID: person.user_id, changes: changes) }
    }

    /// An owner removes someone, or the person leaves (themself).
    @discardableResult
    public func remove(_ person: PatientPerson) async -> Bool {
        await save { try await self.api.removePerson(patientID: self.patientID, userID: person.user_id) }
    }

    /// "Odłącz" on a person's phone (owners): it loses access at once.
    @discardableResult
    public func revoke(device: PairedDevice, of person: PatientPerson) async -> Bool {
        await save { try await self.api.revokeMemberDevice(patientID: self.patientID, userID: person.user_id, deviceID: device.device_id) }
    }

    @discardableResult
    public func revoke(_ invitation: OpenInvitation) async -> Bool {
        await save { try await self.api.revokeInvitation(patientID: self.patientID, invitationID: invitation.invitation_id) }
    }

    /// "Chcę podawać bolus zdalnie dla: Janek": the grantee's own confirmation, signed with this phone's bolus key
    /// (Face ID). Only then does the grant count on the server.
    @discardableResult
    public func confirmRemoteBolus() async -> Bool {
        guard let signer else {
            errorMessage = "Ten telefon nie może podpisać potwierdzenia."
            return false
        }
        isSaving = true
        defer { isSaving = false }
        do {
            let signed = try await signer.signRemoteBolusConfirm(patientID: patientID)
            _ = try await api.confirmRemoteBolus(patientID: patientID, authorization: signed.authorization)
            notice = "Zdalny bolus włączony na tym telefonie. Ustaw jeszcze Zdalne sterowanie w ustawieniach."
            errorMessage = nil
            // Settings an owner handed over may wait for this phone (now with its bolus key).
            NotificationCenter.default.post(name: .remoteBolusConfirmedOnThisPhone, object: patientID)
            await load()
            return true
        } catch let error as RemoteCommandSigningError {
            if error != .key(.cancelled) { errorMessage = error.message }
            return false
        } catch {
            errorMessage = DeviceAuthErrorText.message(for: error) ?? "Nie udało się potwierdzić zdalnego bolusa."
            return false
        }
    }

    public func dismissNotice() {
        notice = nil
    }

    private func save(_ work: @escaping () async throws -> Void) async -> Bool {
        isSaving = true
        defer { isSaving = false }
        do {
            try await work()
            errorMessage = nil
            await load()
            return true
        } catch {
            errorMessage = DeviceAuthErrorText.message(for: error) ?? "Nie udało się zapisać zmian."
            return false
        }
    }
}

/// "Zaproś osobę": first name and permissions; then the QR code of the invitation link and the share sheet.
@MainActor
public final class InvitePersonViewModel: ObservableObject {
    @Published public var firstName = ""
    @Published public var permissions = SharingPermissions.inviteDefaults
    @Published public private(set) var isSending = false
    @Published public private(set) var errorMessage: String?
    @Published public private(set) var created: InvitationCreateResponse?

    public let patientID: String
    public let patientName: String
    private let api: DeviceSharingAPI

    public init(api: DeviceSharingAPI, patientID: String, patientName: String) {
        self.api = api
        self.patientID = patientID
        self.patientName = patientName
    }

    public var trimmedName: String { firstName.trimmingCharacters(in: .whitespacesAndNewlines) }

    public var canSend: Bool {
        !isSending && !trimmedName.isEmpty && trimmedName.count <= 40 && !permissions.normalized.isEmpty
    }

    public func send() async {
        guard canSend else { return }
        isSending = true
        defer { isSending = false }
        do {
            created = try await api.createInvitation(patientID: patientID, firstName: trimmedName, permissions: permissions.normalized)
            errorMessage = nil
        } catch {
            errorMessage = DeviceAuthErrorText.message(for: error) ?? "Nie udało się utworzyć zaproszenia."
        }
    }

    /// What the share sheet sends: the link works like a key, so the message says it is for one person only.
    public var shareMessage: String? {
        guard let created else { return nil }
        return InvitationShareText.message(firstName: trimmedName, patientName: patientName, link: created.pairing.pairing_url)
    }
}

public enum InvitationShareText {
    public static func message(firstName: String, patientName: String, link: String) -> String {
        "\(firstName), zapraszam Cię do Mellisa (pacjent: \(patientName)). Otwórz ten link na telefonie z aplikacją Mellis albo zeskanuj kod QR na moim ekranie. Zaproszenie działa 7 dni i tylko raz:\n\(link)"
    }
}

/// "Ten telefon": this person's phones, "Połącz kolejny telefon" (a 10-minute code) and "Odłącz".
@MainActor
public final class ThisPhoneViewModel: ObservableObject {
    @Published public private(set) var devices: [PairedDevice] = []
    @Published public private(set) var isLoading = false
    @Published public private(set) var isSaving = false
    @Published public var errorMessage: String?
    @Published public private(set) var pairingCode: PairingCode?

    private let api: DeviceSharingAPI

    public init(api: DeviceSharingAPI) {
        self.api = api
    }

    public var thisDevice: PairedDevice? { devices.first(where: \.this_device) }
    public var otherDevices: [PairedDevice] { devices.filter { !$0.this_device } }

    public func load() async {
        isLoading = devices.isEmpty
        defer { isLoading = false }
        do {
            devices = try await api.listOwnDevices()
            errorMessage = nil
        } catch {
            if error.isRequestCancellation { return }
            errorMessage = DeviceAuthErrorText.message(for: error) ?? "Nie udało się wczytać listy telefonów."
        }
    }

    public func createPairingCode() async {
        isSaving = true
        defer { isSaving = false }
        do {
            pairingCode = try await api.createOwnPairingCode()
            errorMessage = nil
        } catch {
            errorMessage = DeviceAuthErrorText.message(for: error) ?? "Nie udało się utworzyć kodu."
        }
    }

    public func clearPairingCode() {
        pairingCode = nil
    }

    @discardableResult
    public func revoke(_ device: PairedDevice) async -> Bool {
        isSaving = true
        defer { isSaving = false }
        do {
            try await api.revokeOwnDevice(deviceID: device.device_id)
            await load()
            return true
        } catch {
            errorMessage = DeviceAuthErrorText.message(for: error) ?? "Nie udało się odłączyć telefonu."
            return false
        }
    }
}

/// "Dodaj pacjenta": name, year of birth and the patient's Nightscout (address + read-only token); the server tests the
/// Nightscout before anything is saved. "Dodaj też współwłaścicieli": the owners of the person's other patients,
/// pre-selected; they own the new patient too (everything but remote bolus, which each one gets and confirms apart).
@MainActor
public final class AddPatientViewModel: ObservableObject {
    @Published public var displayName = ""
    @Published public var birthYear: Int?
    @Published public var nightscoutURL = ""
    @Published public var token = ""
    @Published public private(set) var isSaving = false
    @Published public private(set) var errorMessage: String?
    @Published public private(set) var coOwnerCandidates: [CoOwnerCandidate] = []
    @Published public private(set) var selectedCoOwnerIDs: Set<String> = []
    /// The co-owner list could not be read: the patient is still added, by the caller alone.
    @Published public private(set) var coOwnersUnavailable = false

    private let api: DeviceSharingAPI
    private let currentYear: Int

    public init(api: DeviceSharingAPI, now: Date = Date()) {
        self.api = api
        currentYear = Calendar(identifier: .gregorian).component(.year, from: now)
    }

    public var years: [Int] { Array((1900...currentYear).reversed()) }

    /// Reads who could co-own the new patient; everyone found starts selected.
    public func loadCoOwners() async {
        do {
            let candidates = try await api.listCoOwnerCandidates()
            let fresh = Set(candidates.map(\.user_id)).subtracting(coOwnerCandidates.map(\.user_id))
            coOwnerCandidates = candidates
            selectedCoOwnerIDs = selectedCoOwnerIDs.intersection(candidates.map(\.user_id)).union(fresh)
            coOwnersUnavailable = false
        } catch {
            if error.isRequestCancellation { return }
            coOwnersUnavailable = true
        }
    }

    public func toggleCoOwner(_ userID: String) {
        if selectedCoOwnerIDs.contains(userID) { selectedCoOwnerIDs.remove(userID) } else { selectedCoOwnerIDs.insert(userID) }
    }

    public var canSave: Bool {
        !isSaving && !displayName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && birthYear != nil
            && !nightscoutURL.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !token.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    /// The new patient's id, or nil (the error is shown).
    public func save() async -> String? {
        guard canSave, let birthYear else { return nil }
        isSaving = true
        defer { isSaving = false }
        var address = nightscoutURL.trimmingCharacters(in: .whitespacesAndNewlines)
        if !address.contains("://") { address = "https://" + address }
        do {
            let created = try await api.createPatient(NewPatientBody(
                displayName: displayName.trimmingCharacters(in: .whitespacesAndNewlines),
                birthYear: birthYear,
                nightscoutURL: address,
                token: token.trimmingCharacters(in: .whitespacesAndNewlines),
                // In the list's order, so the request is the same every time.
                coOwnerUserIDs: coOwnerCandidates.map(\.user_id).filter(selectedCoOwnerIDs.contains)
            ))
            errorMessage = nil
            return created.patient.patient_id
        } catch {
            errorMessage = DeviceAuthErrorText.message(for: error) ?? "Nie udało się dodać pacjenta."
            return nil
        }
    }
}

/// A QR code image of a pairing link, sharp at any size (one module = one pixel, scaled without smoothing).
public enum QRCodeImage {
    public static func make(_ text: String) -> CGImage? {
        let filter = CIFilter.qrCodeGenerator()
        filter.message = Data(text.utf8)
        filter.correctionLevel = "M"
        guard let output = filter.outputImage else { return nil }
        return CIContext().createCGImage(output, from: output.extent)
    }
}
