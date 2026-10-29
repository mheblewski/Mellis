import SwiftUI
import GlucoMindCore

// Building blocks of Settings: a grouped inset list whose rows carry an SF Symbol on a soft tinted tile of the brand
// palette (BrandTint, by topic; owner decision 2026-10-29). Sizes follow Dynamic Type (@ScaledMetric); every colour has
// a light and a dark tone.

/// Where Settings can open a page (NavigationStack values; Debug scenes open one directly).
enum SettingsRoute: Hashable {
    case patient(String)
    case remoteBolus(String)
    case thisPhone
    case lockScreen
    case aiInstructions
    case about
    case privacy
    case addPatient
}

/// The one icon tile of Settings and its sub-pages: an SF Symbol in the family's deeper tone on its soft background.
struct SettingsIcon: View {
    let systemName: String
    let tint: BrandTint
    @ScaledMetric(relativeTo: .body) private var size: CGFloat = 29

    init(_ systemName: String, tint: BrandTint) {
        self.systemName = systemName
        self.tint = tint
    }

    var body: some View {
        Image(systemName: systemName)
            .font(.system(size: size * 0.52, weight: .semibold))
            .foregroundStyle(tint.glyph)
            .frame(width: size, height: size)
            .background(RoundedRectangle(cornerRadius: size * 0.26, style: .continuous).fill(tint.background))
            .accessibilityHidden(true)
    }
}

/// A settings row's label: the icon, the title and an optional line under it.
struct SettingsRowLabel: View {
    let title: String
    var subtitle: String? = nil
    let systemImage: String
    let tint: BrandTint

    var body: some View {
        HStack(spacing: 14) {
            SettingsIcon(systemImage, tint: tint)
            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    // Color.primary / Color.secondary, not .primary / .secondary: inside a Button the hierarchical
                    // styles take the button's tint (the subtitle came out teal).
                    .foregroundStyle(Color.primary)
                if let subtitle, !subtitle.isEmpty {
                    Text(subtitle)
                        .font(.footnote)
                        .foregroundStyle(Color.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
        .padding(.vertical, 1)
        .accessibilityElement(children: .combine)
    }
}

/// A value row ("Adres", "Ostatni odczyt") with an icon. `valueChip` shows the value as a small tinted chip instead
/// (an amber "Czeka na potwierdzenie").
struct SettingsValueRow: View {
    let title: String
    let value: String
    let systemImage: String
    let tint: BrandTint
    var valueColor: Color = .secondary
    var valueChip: BrandTint? = nil

    var body: some View {
        LabeledContent {
            if let valueChip {
                SharingBadge(text: value, prominent: false, tint: valueChip)
            } else {
                Text(value)
                    .foregroundStyle(valueColor)
                    .multilineTextAlignment(.trailing)
            }
        } label: {
            SettingsRowLabel(title: title, systemImage: systemImage, tint: tint)
        }
    }
}

/// A toggle with an icon and a detail line under its title.
struct SettingsToggleRow: View {
    let title: String
    let detail: String
    let systemImage: String
    let tint: BrandTint
    @Binding var isOn: Bool

    var body: some View {
        Toggle(isOn: $isOn) {
            SettingsRowLabel(title: title, subtitle: detail, systemImage: systemImage, tint: tint)
        }
        .tint(Brand.interactive)
    }
}

/// A round avatar with the first letter of a name, white on a solid colour: a patient's own colour (PatientColor,
/// from the id) or the brand's deep teal for the person at the top of Settings.
struct SettingsAvatar: View {
    let name: String
    let fill: Color
    var size: CGFloat = 44
    @ScaledMetric(relativeTo: .title) private var scale: CGFloat = 1

    init(name: String, fill: Color, size: CGFloat = 44) {
        self.name = name
        self.fill = fill
        self.size = size
    }

    /// A patient: their stable colour.
    init(patientID: String, name: String, size: CGFloat = 44) {
        self.init(name: name, fill: PatientColor.forPatient(id: patientID).fill, size: size)
    }

    var body: some View {
        Text(String(name.trimmingCharacters(in: .whitespaces).prefix(1)).uppercased())
            .font(.system(size: size * scale * 0.45, weight: .semibold, design: .rounded))
            .foregroundStyle(.white)
            .frame(width: size * scale, height: size * scale)
            .background(Circle().fill(fill))
            .accessibilityHidden(true)
    }
}

/// The tile family of each kind of row, by topic (the same everywhere).
enum SettingsColor {
    // The patient and their data.
    static let patient = BrandTint.teal
    static let add = BrandTint.teal
    static let join = BrandTint.teal
    static let profile = BrandTint.teal
    static let nightscout = BrandTint.teal
    static let people = BrandTint.teal
    // Bolus and the loop.
    static let remoteBolus = BrandTint.petrol
    static let loop = BrandTint.petrol
    // Notifications.
    static let notifications = BrandTint.amber
    static let lockScreen = BrandTint.amber
    // This phone and the app.
    static let phone = BrandTint.slate
    static let about = BrandTint.slate
    static let manual = BrandTint.slate
    // Voluntary support: the warm amber of the logo's dot.
    static let support = BrandTint.amber
    // AI.
    static let assistant = BrandTint.sage
    // Only for destructive actions and errors.
    static let destructive = BrandTint.red
    // Something not available here (no Face ID, not set up yet).
    static let unavailable = BrandTint.neutral
}

/// An error line inside a section.
struct SettingsErrorRow: View {
    let message: String

    var body: some View {
        Label {
            Text(message).foregroundStyle(Color.secondary)
        } icon: {
            Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(BrandTint.red.glyph)
        }
        .font(.footnote)
    }
}

extension View {
    /// The grouped inset list of iOS Settings (the macOS package build uses its own list style).
    func settingsListStyle() -> some View {
        #if os(iOS)
        listStyle(.insetGrouped)
        #else
        listStyle(.inset)
        #endif
    }
}
