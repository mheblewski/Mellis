import CryptoKit
import Foundation
import LocalAuthentication
import Security

// The P-256 keys of a paired phone (docs/device-auth-api.md, "Keys on the phone"), never exported:
// - the device key, created at pairing, signs the pairing and session challenges; usable after the first unlock, so the
//   widget and background refreshes can renew a session without Face ID. A phone without Face ID / Touch ID pairs too;
// - the bolus key, created only when the person confirms a remote bolus grant on this phone and registered then
//   (POST /v1/me/devices/bolus-key), signs every remote command and the remote bolus confirmation; Face ID is enforced
//   by the key itself (`.biometryCurrentSet`), so a command without Face ID cannot be signed at all.
// Real phones keep them in the Secure Enclave. Tests use software keys, and so do Debug builds in the simulator, which
// has no Secure Enclave (SimulatorSoftwareDeviceKeyStore, never compiled into a phone build).

public enum DeviceKeyRole: String, CaseIterable, Sendable {
    case device
    case bolus
}

public enum DeviceKeyError: Error, Equatable {
    /// Face ID was cancelled (or the system cancelled it): nothing was signed.
    case cancelled
    /// The key no longer exists or no longer works, e.g. the bolus key after Face ID was changed: a new bolus key is made
    /// when remote bolus is confirmed again on this phone.
    case keyUnavailable
    /// Face ID / Touch ID is not set up: a bolus key cannot be made.
    case biometryNotAvailable
    case failed(String)

    public var message: String {
        switch self {
        case .cancelled:
            return "Anulowano."
        case .keyUnavailable:
            return "Klucz do zdalnego bolusa na tym telefonie przestał działać (np. po zmianie Face ID). Ustaw go ponownie: Ustawienia → pacjent → Zdalny bolus → Ustaw na tym telefonie."
        case .biometryNotAvailable:
            return DeviceBiometrics.unavailableMessage
        case let .failed(detail):
            return "Nie udało się podpisać na tym telefonie (\(detail))."
        }
    }
}

public protocol DeviceSigningKey: Sendable {
    /// The public half as the server reads it: X9.63 uncompressed point (0x04 ‖ X ‖ Y, 65 bytes).
    var publicKeyX963: Data { get }
    /// DER ECDSA P-256 / SHA-256 signature of `message` (SecKeyCreateSignature with .ecdsaSignatureMessageX962SHA256).
    /// `prompt`: the question Face ID shows (the bolus key; the device key never asks).
    func sign(_ message: Data, prompt: String?) async throws -> Data
    /// Several messages under one Face ID (registering the bolus key and confirming remote bolus at once).
    func sign(_ messages: [Data], prompt: String?) async throws -> [Data]
    /// Opens an ECIES message encrypted to this key (`SecKeyCreateDecryptedData`, `DeviceKeyECIES.algorithm`): another
    /// owner's remote settings handed to this phone. The bolus key asks Face ID (`prompt`), the device key never asks.
    func decrypt(_ ciphertext: Data, prompt: String?) async throws -> Data
}

/// The ECIES of the remote settings hand-off (docs/device-auth-api.md §8): cofactor ECDH on P-256 with an
/// ephemeral key, X9.63 KDF with SHA-256, AES-GCM with a KDF-derived IV. The output is the ephemeral public key (65
/// bytes, X9.63) ‖ ciphertext ‖ 16-byte tag. The Secure Enclave decrypts with its own key; the sender needs only the
/// recipient's public key.
public enum DeviceKeyECIES {
    public static let algorithm: SecKeyAlgorithm = .eciesEncryptionCofactorVariableIVX963SHA256AESGCM

    /// Encrypts `plaintext` to a P-256 public key given as X9.63 (what the server lists for each phone).
    public static func encrypt(_ plaintext: Data, toPublicKeyX963 publicKey: Data) throws -> Data {
        let key = try secKey(publicKeyX963: publicKey)
        var error: Unmanaged<CFError>?
        guard SecKeyIsAlgorithmSupported(key, .encrypt, algorithm),
              let ciphertext = SecKeyCreateEncryptedData(key, algorithm, plaintext as CFData, &error) as Data? else {
            throw DeviceKeyError.failed(error.map { String(describing: $0.takeRetainedValue()) } ?? "encryption")
        }
        return ciphertext
    }

    /// Decrypts with a software private key (tests, the Debug simulator), the same algorithm the Secure Enclave runs.
    public static func decrypt(_ ciphertext: Data, privateKey: P256.Signing.PrivateKey) throws -> Data {
        // SecKey's private EC representation: 04 ‖ X ‖ Y ‖ D.
        let raw = privateKey.publicKey.x963Representation + privateKey.rawRepresentation
        let attributes: [String: Any] = [
            kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom,
            kSecAttrKeyClass as String: kSecAttrKeyClassPrivate,
            kSecAttrKeySizeInBits as String: 256,
        ]
        var error: Unmanaged<CFError>?
        guard let key = SecKeyCreateWithData(raw as CFData, attributes as CFDictionary, &error) else {
            throw DeviceKeyError.failed(error.map { String(describing: $0.takeRetainedValue()) } ?? "key")
        }
        return try decrypt(ciphertext, key: key)
    }

    static func decrypt(_ ciphertext: Data, key: SecKey) throws -> Data {
        var error: Unmanaged<CFError>?
        guard let plaintext = SecKeyCreateDecryptedData(key, algorithm, ciphertext as CFData, &error) as Data? else {
            throw DeviceKeyECIES.decryptionError(error?.takeRetainedValue())
        }
        return plaintext
    }

    static func secKey(publicKeyX963 publicKey: Data) throws -> SecKey {
        guard publicKey.count == 65, publicKey.first == 0x04, (try? P256.Signing.PublicKey(x963Representation: publicKey)) != nil else {
            throw DeviceKeyError.failed("public key")
        }
        let attributes: [String: Any] = [
            kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom,
            kSecAttrKeyClass as String: kSecAttrKeyClassPublic,
            kSecAttrKeySizeInBits as String: 256,
        ]
        var error: Unmanaged<CFError>?
        guard let key = SecKeyCreateWithData(publicKey as CFData, attributes as CFDictionary, &error) else {
            throw DeviceKeyError.failed(error.map { String(describing: $0.takeRetainedValue()) } ?? "public key")
        }
        return key
    }

    /// A message that does not open (another phone's, or changed on the way) is `.failed("decryption")`; Face ID
    /// errors map as for signatures.
    static func decryptionError(_ error: CFError?) -> DeviceKeyError {
        guard let error else { return .failed("decryption") }
        let nsError = error as Error as NSError
        if nsError.domain == LAError.errorDomain {
            switch LAError.Code(rawValue: nsError.code) {
            case .userCancel, .appCancel, .systemCancel, .userFallback: return .cancelled
            case .biometryNotEnrolled, .biometryNotAvailable: return .biometryNotAvailable
            default: break
            }
        }
        if nsError.code == Int(errSecUserCanceled) { return .cancelled }
        if nsError.code == Int(errSecAuthFailed) || nsError.code == Int(errSecItemNotFound) { return .keyUnavailable }
        return .failed("decryption")
    }
}

public extension DeviceSigningKey {
    var publicKeyBase64: String { publicKeyX963.base64EncodedString() }

    func sign(_ messages: [Data], prompt: String?) async throws -> [Data] {
        var signatures: [Data] = []
        for message in messages { signatures.append(try await sign(message, prompt: prompt)) }
        return signatures
    }
}

/// The keys of a paired phone: the device key always, the bolus key once remote bolus was confirmed on this phone.
public struct DeviceKeyPair: Sendable {
    public let device: DeviceSigningKey
    public let bolus: DeviceSigningKey?

    public init(device: DeviceSigningKey, bolus: DeviceSigningKey? = nil) {
        self.device = device
        self.bolus = bolus
    }
}

public protocol DeviceKeyStore: Sendable {
    /// A new device key for a pairing; every earlier key of this phone (the bolus key too) is deleted.
    func createKeys() throws -> DeviceKeyPair
    /// The keys of the current pairing; nil when this phone has none.
    func loadKeys() throws -> DeviceKeyPair?
    /// A new Face ID bound bolus key, replacing an earlier one. `biometryNotAvailable` without Face ID / Touch ID.
    func createBolusKey() throws -> DeviceSigningKey
    func deleteBolusKey()
    func deleteKeys()
}

/// Whether this phone can hold a bolus key: Face ID or Touch ID set up. Without it the phone pairs and works, but remote
/// bolus is not available on it.
public enum DeviceBiometrics {
    public static var isAvailable: Bool {
        #if DEBUG
        // Simulator walkthroughs of a phone without biometrics (DeviceModeDebugScenes.swift).
        if ProcessInfo.processInfo.environment["MELLIS_NO_BIOMETRICS"] == "1" { return false }
        #endif
        var error: NSError?
        return LAContext().canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &error)
    }

    public static let unavailableMessage = "Zdalny bolus wymaga Face ID albo Touch ID: każde polecenie potwierdza się biometrią, a klucz do bolusa działa tylko z nią. Ten telefon nie ma ich skonfigurowanych. Ustaw Face ID albo Touch ID w Ustawieniach iPhone’a albo podawaj bolus zdalnie z innego telefonu."
}

// MARK: - Software keys (tests, Debug simulator)

/// A software P-256 key: what the Secure Enclave does, for tests and the simulator. `confirm` stands in for the Face ID
/// the bolus key would enforce.
public struct SoftwareDeviceSigningKey: DeviceSigningKey {
    public let privateKey: P256.Signing.PrivateKey
    private let confirm: (@Sendable (String) async -> BiometricResult)?

    public init(privateKey: P256.Signing.PrivateKey = P256.Signing.PrivateKey(), confirm: (@Sendable (String) async -> BiometricResult)? = nil) {
        self.privateKey = privateKey
        self.confirm = confirm
    }

    public var publicKeyX963: Data { privateKey.publicKey.x963Representation }

    public func sign(_ message: Data, prompt: String?) async throws -> Data {
        if let confirm {
            switch await confirm(prompt ?? "Potwierdź") {
            case .confirmed: break
            case let .refused(message):
                // LocalAuthenticationGate says "Anulowano." for a cancel; anything else (no Face ID set up) is shown.
                throw message == "Anulowano." ? DeviceKeyError.cancelled : DeviceKeyError.failed(message)
            }
        }
        return try privateKey.signature(for: message).derRepresentation
    }

    public func decrypt(_ ciphertext: Data, prompt: String?) async throws -> Data {
        if let confirm {
            switch await confirm(prompt ?? "Potwierdź") {
            case .confirmed: break
            case let .refused(message):
                throw message == "Anulowano." ? DeviceKeyError.cancelled : DeviceKeyError.failed(message)
            }
        }
        return try DeviceKeyECIES.decrypt(ciphertext, privateKey: privateKey)
    }

    public func sign(_ messages: [Data], prompt: String?) async throws -> [Data] {
        guard let first = messages.first else { return [] }
        // One confirmation, like one Face ID on an LAContext reused for every signature.
        let head = try await sign(first, prompt: prompt)
        return try [head] + messages.dropFirst().map { try privateKey.signature(for: $0).derRepresentation }
    }
}

/// Keys in memory only (tests).
public final class InMemoryDeviceKeyStore: DeviceKeyStore, @unchecked Sendable {
    private let lock = NSLock()
    private var keys: DeviceKeyPair?
    public private(set) var createdCount = 0
    public private(set) var bolusKeysCreated = 0
    private let confirm: (@Sendable (String) async -> BiometricResult)?
    /// False: a phone without Face ID / Touch ID (createBolusKey refuses).
    public var biometricsAvailable: Bool

    public init(keys: DeviceKeyPair? = nil, confirm: (@Sendable (String) async -> BiometricResult)? = nil, biometricsAvailable: Bool = true) {
        self.keys = keys
        self.confirm = confirm
        self.biometricsAvailable = biometricsAvailable
    }

    public func createKeys() throws -> DeviceKeyPair {
        lock.lock(); defer { lock.unlock() }
        let created = DeviceKeyPair(device: SoftwareDeviceSigningKey())
        keys = created
        createdCount += 1
        return created
    }

    public func createBolusKey() throws -> DeviceSigningKey {
        lock.lock(); defer { lock.unlock() }
        guard biometricsAvailable else { throw DeviceKeyError.biometryNotAvailable }
        guard let device = keys?.device else { throw DeviceKeyError.keyUnavailable }
        let bolus = SoftwareDeviceSigningKey(confirm: confirm)
        keys = DeviceKeyPair(device: device, bolus: bolus)
        bolusKeysCreated += 1
        return bolus
    }

    public func deleteBolusKey() {
        lock.lock(); defer { lock.unlock() }
        if let device = keys?.device { keys = DeviceKeyPair(device: device) }
    }

    public func loadKeys() throws -> DeviceKeyPair? {
        lock.lock(); defer { lock.unlock() }
        return keys
    }

    public func deleteKeys() {
        lock.lock(); defer { lock.unlock() }
        keys = nil
    }
}

#if DEBUG && targetEnvironment(simulator)
/// SIMULATOR ONLY, DEBUG ONLY: the simulator has no Secure Enclave, so the two keys are software keys kept in the
/// Keychain (shared with the widget like the real ones). The bolus key asks Face ID through LocalAuthentication (the
/// simulator's Features → Face ID), standing in for what the Secure Enclave enforces. Never compiled into a phone build.
public final class SimulatorSoftwareDeviceKeyStore: DeviceKeyStore, @unchecked Sendable {
    private let accessGroup: String?

    public init(accessGroup: String?) {
        self.accessGroup = accessGroup.flatMap { $0.isEmpty ? nil : $0 }
    }

    public func createKeys() throws -> DeviceKeyPair {
        deleteKeys()
        let device = P256.Signing.PrivateKey()
        try item(.device).save(device.rawRepresentation)
        return DeviceKeyPair(device: SoftwareDeviceSigningKey(privateKey: device))
    }

    public func loadKeys() throws -> DeviceKeyPair? {
        guard let device = try item(.device).load() else { return nil }
        let bolus = try item(.bolus).load().map { try P256.Signing.PrivateKey(rawRepresentation: $0) }
        return DeviceKeyPair(device: SoftwareDeviceSigningKey(privateKey: try P256.Signing.PrivateKey(rawRepresentation: device)), bolus: bolus.map(Self.bolusKey))
    }

    public func createBolusKey() throws -> DeviceSigningKey {
        // The simulator's Features → Face ID → Enrolled decides, as a phone's enrolment would.
        guard DeviceBiometrics.isAvailable else { throw DeviceKeyError.biometryNotAvailable }
        let bolus = P256.Signing.PrivateKey()
        try? item(.bolus).delete()
        try item(.bolus).save(bolus.rawRepresentation)
        return Self.bolusKey(bolus)
    }

    public func deleteBolusKey() {
        try? item(.bolus).delete()
    }

    public func deleteKeys() {
        DeviceKeyRole.allCases.forEach { try? item($0).delete() }
    }

    private static func bolusKey(_ key: P256.Signing.PrivateKey) -> DeviceSigningKey {
        SoftwareDeviceSigningKey(privateKey: key, confirm: { reason in await LocalAuthenticationGate().confirm(reason: reason) })
    }

    private func item(_ role: DeviceKeyRole) -> KeychainDataItem {
        KeychainDataItem(service: "pl.mellis.simulator-software-keys", account: role.rawValue, accessGroup: accessGroup)
    }
}
#endif

// MARK: - Secure Enclave

/// The phone's Secure Enclave keys, found by their application tags in the Keychain group shared with the widget.
public final class SecureEnclaveDeviceKeyStore: DeviceKeyStore, @unchecked Sendable {
    private let accessGroup: String?

    public init(accessGroup: String?) {
        self.accessGroup = accessGroup.flatMap { $0.isEmpty ? nil : $0 }
    }

    public static var isAvailable: Bool {
        #if targetEnvironment(simulator)
        return false
        #else
        return SecureEnclave.isAvailable
        #endif
    }

    public func createKeys() throws -> DeviceKeyPair {
        deleteKeys()
        do {
            return DeviceKeyPair(device: try createKey(.device))
        } catch {
            deleteKeys()
            throw error
        }
    }

    public func loadKeys() throws -> DeviceKeyPair? {
        guard let device = try publicKey(.device) else { return nil }
        // A bolus key invalidated by a Face ID change reads as missing: a new one is made at the next confirmation.
        let bolus = (try? publicKey(.bolus)) ?? nil
        return DeviceKeyPair(
            device: SecureEnclaveSigningKey(role: .device, tag: Self.tag(.device), accessGroup: accessGroup, publicKeyX963: device),
            bolus: bolus.map { SecureEnclaveSigningKey(role: .bolus, tag: Self.tag(.bolus), accessGroup: accessGroup, publicKeyX963: $0) }
        )
    }

    public func createBolusKey() throws -> DeviceSigningKey {
        deleteBolusKey()
        return try createKey(.bolus)
    }

    public func deleteBolusKey() {
        delete(.bolus)
    }

    public func deleteKeys() {
        DeviceKeyRole.allCases.forEach(delete)
    }

    private func delete(_ role: DeviceKeyRole) {
        var query: [String: Any] = [
            kSecClass as String: kSecClassKey,
            kSecAttrApplicationTag as String: Self.tag(role),
        ]
        if let accessGroup { query[kSecAttrAccessGroup as String] = accessGroup }
        SecItemDelete(query as CFDictionary)
    }

    static func tag(_ role: DeviceKeyRole) -> Data {
        Data("pl.mellis.\(role.rawValue)-key".utf8)
    }

    private func createKey(_ role: DeviceKeyRole) throws -> SecureEnclaveSigningKey {
        // The device key works after the first unlock (widget, background refresh); the bolus key only with the
        // current Face ID / Touch ID enrolment (a new face invalidates it).
        let protection: CFString = role == .device ? kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly : kSecAttrAccessibleWhenPasscodeSetThisDeviceOnly
        let flags: SecAccessControlCreateFlags = role == .device ? [.privateKeyUsage] : [.privateKeyUsage, .biometryCurrentSet]
        var accessError: Unmanaged<CFError>?
        guard let access = SecAccessControlCreateWithFlags(nil, protection, flags, &accessError) else {
            throw DeviceKeyError.failed(accessError.map { String(describing: $0.takeRetainedValue()) } ?? "access control")
        }
        if role == .bolus, !DeviceBiometrics.isAvailable {
            throw DeviceKeyError.biometryNotAvailable
        }
        var attributes: [String: Any] = [
            kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom,
            kSecAttrKeySizeInBits as String: 256,
            kSecAttrTokenID as String: kSecAttrTokenIDSecureEnclave,
            kSecPrivateKeyAttrs as String: [
                kSecAttrIsPermanent as String: true,
                kSecAttrApplicationTag as String: Self.tag(role),
                kSecAttrAccessControl as String: access,
            ] as [String: Any],
        ]
        if let accessGroup { attributes[kSecAttrAccessGroup as String] = accessGroup }
        var createError: Unmanaged<CFError>?
        guard let privateKey = SecKeyCreateRandomKey(attributes as CFDictionary, &createError) else {
            throw DeviceKeyError.failed(createError.map { String(describing: $0.takeRetainedValue()) } ?? "key")
        }
        guard let publicKey = SecKeyCopyPublicKey(privateKey), let data = SecKeyCopyExternalRepresentation(publicKey, nil) as Data? else {
            throw DeviceKeyError.failed("public key")
        }
        return SecureEnclaveSigningKey(role: role, tag: Self.tag(role), accessGroup: accessGroup, publicKeyX963: data)
    }

    /// The public half, read without touching the private key (no Face ID).
    private func publicKey(_ role: DeviceKeyRole) throws -> Data? {
        guard let key = try SecureEnclaveSigningKey.privateKeyReference(tag: Self.tag(role), accessGroup: accessGroup, context: nil) else { return nil }
        guard let publicKey = SecKeyCopyPublicKey(key), let data = SecKeyCopyExternalRepresentation(publicKey, nil) as Data? else {
            throw DeviceKeyError.keyUnavailable
        }
        return data
    }
}

struct SecureEnclaveSigningKey: DeviceSigningKey {
    let role: DeviceKeyRole
    let tag: Data
    let accessGroup: String?
    let publicKeyX963: Data

    func sign(_ message: Data, prompt: String?) async throws -> Data {
        try await sign([message], prompt: prompt)[0]
    }

    /// One LAContext for every message: Face ID asks once (the first signature), the others reuse the evaluated context.
    func sign(_ messages: [Data], prompt: String?) async throws -> [Data] {
        let tag = tag
        let accessGroup = accessGroup
        let role = role
        // SecKeyCreateSignature blocks (Face ID runs inside it for the bolus key): off the caller's thread.
        return try await Task.detached(priority: .userInitiated) {
            let context = LAContext()
            if let prompt { context.localizedReason = prompt }
            // Face ID only: no fallback to the passcode (the key would refuse it anyway).
            context.localizedFallbackTitle = ""
            guard let key = try Self.privateKeyReference(tag: tag, accessGroup: accessGroup, context: role == .bolus ? context : nil) else {
                throw DeviceKeyError.keyUnavailable
            }
            return try messages.map { message in
                var error: Unmanaged<CFError>?
                guard let signature = SecKeyCreateSignature(key, .ecdsaSignatureMessageX962SHA256, message as CFData, &error) as Data? else {
                    throw Self.keyError(error?.takeRetainedValue())
                }
                return signature
            }
        }.value
    }

    /// The bolus key asks Face ID inside SecKeyCreateDecryptedData (its access control); the device key does not.
    func decrypt(_ ciphertext: Data, prompt: String?) async throws -> Data {
        let tag = tag
        let accessGroup = accessGroup
        let role = role
        return try await Task.detached(priority: .userInitiated) {
            let context = LAContext()
            if let prompt { context.localizedReason = prompt }
            context.localizedFallbackTitle = ""
            guard let key = try Self.privateKeyReference(tag: tag, accessGroup: accessGroup, context: role == .bolus ? context : nil) else {
                throw DeviceKeyError.keyUnavailable
            }
            return try DeviceKeyECIES.decrypt(ciphertext, key: key)
        }.value
    }

    static func privateKeyReference(tag: Data, accessGroup: String?, context: LAContext?) throws -> SecKey? {
        var query: [String: Any] = [
            kSecClass as String: kSecClassKey,
            kSecAttrApplicationTag as String: tag,
            kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom,
            kSecReturnRef as String: true,
        ]
        if let accessGroup { query[kSecAttrAccessGroup as String] = accessGroup }
        if let context { query[kSecUseAuthenticationContext as String] = context }
        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let item, CFGetTypeID(item) == SecKeyGetTypeID() else {
            throw DeviceKeyError.failed("Keychain \(status)")
        }
        return (item as! SecKey)
    }

    private static func keyError(_ error: CFError?) -> DeviceKeyError {
        guard let error else { return .failed("signature") }
        let nsError = error as Error as NSError
        if nsError.domain == LAError.errorDomain {
            switch LAError.Code(rawValue: nsError.code) {
            case .userCancel, .appCancel, .systemCancel, .userFallback: return .cancelled
            case .biometryNotEnrolled, .biometryNotAvailable: return .biometryNotAvailable
            case .biometryLockout: return .failed("Face ID zablokowany: odblokuj telefon kodem i spróbuj ponownie")
            default: break
            }
        }
        // errSecAuthFailed / errSecItemNotFound after the Face ID enrolment changed: the key is gone for good.
        if nsError.code == Int(errSecAuthFailed) || nsError.code == Int(errSecItemNotFound) { return .keyUnavailable }
        if nsError.code == Int(errSecUserCanceled) { return .cancelled }
        return .failed("\(nsError.domain) \(nsError.code)")
    }
}

/// The keys this build uses: the Secure Enclave on a phone; the simulator's stand-in in Debug simulator builds.
public enum DeviceKeyStores {
    public static func standard(accessGroup: String?) -> DeviceKeyStore {
        #if DEBUG && targetEnvironment(simulator)
        return SimulatorSoftwareDeviceKeyStore(accessGroup: accessGroup)
        #else
        return SecureEnclaveDeviceKeyStore(accessGroup: accessGroup)
        #endif
    }
}
