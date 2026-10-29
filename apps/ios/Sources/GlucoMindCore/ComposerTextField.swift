import SwiftUI
#if canImport(UIKit)
import UIKit
#endif

/// The chat composer's text: a multi-line field (as `TextField(axis: .vertical)`) that also takes photos pasted from
/// the clipboard ("Wklej" in the edit menu, ⌘V). SwiftUI's TextField pastes text only, and its paste destination needs
/// iOS 27.
struct ComposerTextField: View {
    let placeholder: String
    @Binding var text: String
    @Binding var isFocused: Bool
    let maxLines: Int
    /// Takes the pasted photos as JPEG. Nil while no photo can be added (the limit is reached, a message is being
    /// sent): paste is then text only.
    var onPastePhotos: (([Data]) -> Void)?

    var body: some View {
        #if canImport(UIKit)
        ZStack(alignment: .topLeading) {
            // The placeholder wraps as TextField's does, and its height holds the field open while it is empty.
            Text(placeholder)
                .font(.body)
                .foregroundStyle(Color(uiColor: .placeholderText))
                .opacity(text.isEmpty ? 1 : 0)
                .allowsHitTesting(false)
                .accessibilityHidden(true)
            ImagePastingTextView(
                placeholder: placeholder,
                text: $text,
                isFocused: $isFocused,
                maxLines: maxLines,
                onPasteImages: onPastePhotos.map { onPastePhotos in
                    { images in onPastePhotos(images.compactMap { MealPhotoEncoder.jpeg(from: $0) }) }
                }
            )
        }
        #else
        TextField(placeholder, text: $text, axis: .vertical)
            .lineLimit(1...maxLines)
        #endif
    }
}

#if canImport(UIKit)
private struct ImagePastingTextView: UIViewRepresentable {
    let placeholder: String
    @Binding var text: String
    @Binding var isFocused: Bool
    let maxLines: Int
    let onPasteImages: (([UIImage]) -> Void)?

    func makeUIView(context: Context) -> PastingTextView {
        let view = PastingTextView()
        view.delegate = context.coordinator
        view.font = .preferredFont(forTextStyle: .body)
        view.adjustsFontForContentSizeCategory = true
        view.backgroundColor = .clear
        view.textContainerInset = .zero
        view.textContainer.lineFragmentPadding = 0
        view.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        view.text = text
        return view
    }

    func updateUIView(_ view: PastingTextView, context: Context) {
        context.coordinator.parent = self
        view.onPasteImages = onPasteImages
        view.accessibilityLabel = placeholder
        if view.text != text {
            view.text = text
        }
        // Asynchronously: becoming or resigning first responder reports back through the delegate, which writes
        // the binding, and a write during the view update is dropped.
        if isFocused != view.isFirstResponder {
            DispatchQueue.main.async {
                if isFocused, !view.isFirstResponder, view.window != nil {
                    view.becomeFirstResponder()
                } else if !isFocused, view.isFirstResponder {
                    view.resignFirstResponder()
                }
            }
        }
    }

    /// As tall as the text, up to `maxLines`; longer text scrolls inside.
    func sizeThatFits(_ proposal: ProposedViewSize, uiView view: PastingTextView, context: Context) -> CGSize? {
        guard let width = proposal.width, width.isFinite, width > 0 else {
            return nil
        }
        let font = view.font ?? .preferredFont(forTextStyle: .body)
        let contentHeight = view.sizeThatFits(CGSize(width: width, height: .greatestFiniteMagnitude)).height
        let maxHeight = (font.lineHeight * CGFloat(maxLines)).rounded(.up)
        return CGSize(width: width, height: min(max(contentHeight, font.lineHeight.rounded(.up)), maxHeight))
    }

    func makeCoordinator() -> Coordinator {
        Coordinator(parent: self)
    }

    final class Coordinator: NSObject, UITextViewDelegate {
        var parent: ImagePastingTextView

        init(parent: ImagePastingTextView) {
            self.parent = parent
        }

        func textViewDidChange(_ textView: UITextView) {
            parent.text = textView.text
        }

        func textViewDidBeginEditing(_ textView: UITextView) {
            if !parent.isFocused {
                parent.isFocused = true
            }
        }

        func textViewDidEndEditing(_ textView: UITextView) {
            if parent.isFocused {
                parent.isFocused = false
            }
        }
    }
}

/// Offers "Wklej" when the clipboard holds images, and hands them over instead of pasting text.
final class PastingTextView: UITextView {
    var onPasteImages: (([UIImage]) -> Void)?

    override func canPerformAction(_ action: Selector, withSender sender: Any?) -> Bool {
        // `hasImages` reads only the item types, so it shows no paste permission alert.
        if action == #selector(paste(_:)), onPasteImages != nil, UIPasteboard.general.hasImages {
            return true
        }
        return super.canPerformAction(action, withSender: sender)
    }

    override func paste(_ sender: Any?) {
        guard let onPasteImages, UIPasteboard.general.hasImages, let images = UIPasteboard.general.images, !images.isEmpty else {
            super.paste(sender)
            return
        }
        onPasteImages(images)
    }
}
#endif
