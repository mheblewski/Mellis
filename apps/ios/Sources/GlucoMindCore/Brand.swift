import SwiftUI
#if canImport(UIKit)
import UIKit
#endif

/// The hummingbird identity's colours (docs/brand/final/README.md), each with a dark-mode tone. They dress the app's
/// chrome only: dose and glucose colours (insulin blue, SMB purple, WBT orange, hypo red, range green/yellow/red) keep
/// their Trio and Nightscout meaning.
public enum Brand {
    /// The logo's petrol; in dark mode a light teal, where petrol would vanish.
    public static let petrol = dynamic(light: 0x0E5A61, dark: 0x5EEAD4)
    /// The logo's wing.
    public static let teal = dynamic(light: 0x14B8A6, dark: 0x2DD4BF)
    /// Buttons, links and the user's bubbles; the same colour as the AccentColor asset (white text stays readable on it).
    public static let interactive = dynamic(light: 0x0F766E, dark: 0x0D9488)
    /// Rescue carbs (the "Podano" button, its drops and the given line): a deep, cool emerald that sits with the petrol,
    /// instead of the system's bright green; still green, so it still reads as "sugar given, all right".
    public static let rescue = dynamic(light: 0x12875B, dark: 0x1FA971)
    /// Glucose in range on the dashboard (the value, chart dots and band, the time-in-range ring): the rescue emerald a
    /// shade lighter, since it marks data, not a button; brighter in dark mode. Still plainly green next to yellow and red.
    public static let inRange = dynamic(light: 0x17A05D, dark: 0x2FC274)
    /// The launch screen's and splash's background in both themes; the same colour as the LaunchBackground asset the
    /// system shows before the app runs, so the hand-off has no flash.
    public static let splashBackground = rgb(0x346C73)
    /// The reading dot. Never a warning colour: a high glucose stays yellow.
    public static let amber = rgb(0xFFB547)

    /// The deep teal of the launch screen as a plain brand colour (the person's own avatar in Settings).
    public static let deepTeal = splashBackground

    public static func dynamic(light: UInt32, dark: UInt32) -> Color {
        #if canImport(UIKit)
        return Color(UIColor { traits in
            let (r, g, b) = components(traits.userInterfaceStyle == .dark ? dark : light)
            return UIColor(red: r, green: g, blue: b, alpha: 1)
        })
        #else
        return rgb(light)
        #endif
    }

    public static func rgb(_ hex: UInt32) -> Color {
        let (r, g, b) = components(hex)
        return Color(red: r, green: g, blue: b)
    }

    private static func components(_ hex: UInt32) -> (Double, Double, Double) {
        (Double((hex >> 16) & 0xFF) / 255, Double((hex >> 8) & 0xFF) / 255, Double(hex & 0xFF) / 255)
    }
}

/// The calm tinted tiles of Settings (owner decision 2026-10-29: no iOS-Settings "candy" squares). Each family has a
/// light, muted background and its glyph in a deeper tone of the same family; in dark mode a darker tinted background
/// and a lighter glyph. Assigned by topic, never at random:
/// teal = the patient and their data, petrol = bolus and the loop, amber = notifications, slate = this phone and the
/// app, sage = AI. Red only for destructive actions and errors; neutral for something not available.
/// Contrast (WCAG): every glyph on its tile is at least 4.6:1 in light and 6.9:1 in dark mode (neutral, the disabled
/// look, 2.8:1 / 4.3:1).
public enum BrandTint: String, CaseIterable, Sendable {
    case teal, petrol, amber, slate, sage, red, neutral

    /// The tile's soft background.
    public var background: Color {
        switch self {
        case .teal: return Brand.dynamic(light: 0xDDF4EF, dark: 0x133B37)
        case .petrol: return Brand.dynamic(light: 0xDCE6E8, dark: 0x1B3236)
        case .amber: return Brand.dynamic(light: 0xFBEFD8, dark: 0x3B2D14)
        case .slate: return Brand.dynamic(light: 0xE3E8EE, dark: 0x262D36)
        case .sage: return Brand.dynamic(light: 0xE2EBE3, dark: 0x243127)
        case .red: return Brand.dynamic(light: 0xFADEDB, dark: 0x3F1D1A)
        case .neutral: return Brand.dynamic(light: 0xE9E9EB, dark: 0x2C2C2E)
        }
    }

    /// The glyph on the tile, and the colour of text in this family (an amber chip, a patient's name).
    public var glyph: Color {
        switch self {
        // Brand.interactive's light tone.
        case .teal: return Brand.dynamic(light: 0x0F766E, dark: 0x5ED6C5)
        // The wordmark's ink (docs/brand/final: "Atrament").
        case .petrol: return Brand.dynamic(light: 0x0B3A3F, dark: 0x9FC6CB)
        case .amber: return Brand.dynamic(light: 0x94600F, dark: 0xF0C072)
        case .slate: return Brand.dynamic(light: 0x4B5B6D, dark: 0xAEBBCA)
        case .sage: return Brand.dynamic(light: 0x4E6A55, dark: 0xA8C4AE)
        case .red: return Brand.dynamic(light: 0xB42318, dark: 0xF4A49C)
        case .neutral: return Brand.dynamic(light: 0x8A8A8E, dark: 0x8E8E93)
        }
    }
}

/// A patient's own colour: a stable pick from the brand palette by patient id (the same on every screen and phone),
/// for the avatar in Settings and the name on the lock screen; later the patient switcher can use it too.
/// FNV-1a over the lowercased id, in the order teal, petrol, sage, slate, amber. Two patients can share a colour
/// (one in five): the colour is a hint, the name is always next to it.
public enum PatientColor: Int, CaseIterable, Sendable {
    case teal, petrol, sage, slate, amber

    public static func forPatient(id: String) -> PatientColor {
        var hash: UInt32 = 2_166_136_261
        for byte in id.lowercased().utf8 {
            hash ^= UInt32(byte)
            hash = hash &* 16_777_619
        }
        return PatientColor(rawValue: Int(hash % UInt32(allCases.count))) ?? .teal
    }

    public var tint: BrandTint {
        switch self {
        case .teal: return .teal
        case .petrol: return .petrol
        case .sage: return .sage
        case .slate: return .slate
        case .amber: return .amber
        }
    }

    /// The avatar's fill under a white initial (at least 3.9:1 against white in both modes).
    public var fill: Color {
        switch self {
        case .teal: return Brand.dynamic(light: 0x128379, dark: 0x1B8F84)
        case .petrol: return Brand.dynamic(light: 0x0E4F55, dark: 0x2D6A71)
        case .sage: return Brand.dynamic(light: 0x5B7A63, dark: 0x5F8068)
        case .slate: return Brand.dynamic(light: 0x55667A, dark: 0x5B6D82)
        case .amber: return Brand.dynamic(light: 0xA0670F, dark: 0xA86E14)
        }
    }

    /// The patient's name as text (lock screen, Dynamic Island): the family's glyph tone, readable in both modes.
    public var text: Color { tint.glyph }
}
