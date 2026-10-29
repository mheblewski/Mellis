import SwiftUI

/// The middle of the chat and meals top bars: whose data the screen shows.
public struct PatientNameBubble: View {
    let name: String

    public init(name: String) {
        self.name = name
    }

    public var body: some View {
        Text(name)
            .font(.subheadline.weight(.semibold))
            .foregroundStyle(.primary)
            .lineLimit(1)
            .padding(.horizontal, 16)
            .frame(height: 44)
            .topBarBubble()
            .accessibilityLabel("Pacjent: \(name)")
    }
}

public extension View {
    /// The glass capsule the system draws behind toolbar buttons, for what it does not draw one behind itself (the
    /// title slot).
    func topBarBubble() -> some View {
        glassBubble(in: Capsule())
    }

    /// The same glass in any shape (the chat's composer); a material on systems before iOS 26.
    func glassBubble(in shape: some Shape) -> some View {
        background {
            if #available(iOS 26.0, macOS 26.0, *) {
                shape.fill(.clear).glassEffect(.regular, in: shape)
            } else {
                shape.fill(.regularMaterial)
            }
        }
    }
}
