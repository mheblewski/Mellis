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
    /// False while a voice message is recorded: its words are written in, not typed.
    var isEditable = true
    /// Holding the field while the keyboard is down (talk instead of typing); nil: a hold does what it always does.
    var onHold: ((ComposerHoldPhase) -> Void)? = nil

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
                },
                isEditable: isEditable,
                onHold: onHold
            )
        }
        #else
        TextField(placeholder, text: $text, axis: .vertical)
            .lineLimit(1...maxLines)
        #endif
    }
}

/// A hold on the composer's field: it began, the finger was lifted, or the touch was taken away.
enum ComposerHoldPhase {
    case began
    case ended
    case cancelled
}

#if canImport(UIKit)
private struct ImagePastingTextView: UIViewRepresentable {
    let placeholder: String
    @Binding var text: String
    @Binding var isFocused: Bool
    let maxLines: Int
    let onPasteImages: (([UIImage]) -> Void)?
    let isEditable: Bool
    let onHold: ((ComposerHoldPhase) -> Void)?

    func makeUIView(context: Context) -> ComposerFieldView {
        let field = ComposerFieldView()
        let view = field.textView
        view.delegate = context.coordinator
        view.font = .preferredFont(forTextStyle: .body)
        view.adjustsFontForContentSizeCategory = true
        view.backgroundColor = .clear
        view.textContainerInset = .zero
        view.textContainer.lineFragmentPadding = 0
        field.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        view.text = text
        let hold = UILongPressGestureRecognizer(target: context.coordinator, action: #selector(Coordinator.handleHold(_:)))
        hold.minimumPressDuration = 0.3
        hold.delegate = context.coordinator
        let tap = UITapGestureRecognizer(target: context.coordinator, action: #selector(Coordinator.handleTap(_:)))
        tap.require(toFail: hold)
        field.touchCover.addGestureRecognizer(hold)
        field.touchCover.addGestureRecognizer(tap)
        context.coordinator.field = field
        field.updateTouchCover(holdEnabled: onHold != nil)
        return field
    }

    func updateUIView(_ field: ComposerFieldView, context: Context) {
        context.coordinator.parent = self
        let view = field.textView
        view.onPasteImages = onPasteImages
        view.accessibilityLabel = placeholder
        if view.text != text {
            view.text = text
            // The words heard while talking keep the newest line in sight.
            if !isEditable {
                view.scrollRangeToVisible(NSRange(location: (view.text as NSString).length, length: 0))
            }
        }
        // Not through `isEditable`: switching it rebuilds the field's text interactions; the delegate refuses typing
        // instead.
        if !isEditable, view.isFirstResponder {
            DispatchQueue.main.async { view.resignFirstResponder() }
        }
        field.updateTouchCover(holdEnabled: onHold != nil)
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
    func sizeThatFits(_ proposal: ProposedViewSize, uiView field: ComposerFieldView, context: Context) -> CGSize? {
        guard let width = proposal.width, width.isFinite, width > 0 else {
            return nil
        }
        let view = field.textView
        let font = view.font ?? .preferredFont(forTextStyle: .body)
        let contentHeight = view.sizeThatFits(CGSize(width: width, height: .greatestFiniteMagnitude)).height
        let maxHeight = (font.lineHeight * CGFloat(maxLines)).rounded(.up)
        return CGSize(width: width, height: min(max(contentHeight, font.lineHeight.rounded(.up)), maxHeight))
    }

    func makeCoordinator() -> Coordinator {
        Coordinator(parent: self)
    }

    final class Coordinator: NSObject, UITextViewDelegate, UIGestureRecognizerDelegate {
        var parent: ImagePastingTextView
        weak var field: ComposerFieldView?

        init(parent: ImagePastingTextView) {
            self.parent = parent
        }

        @objc func handleHold(_ recognizer: UILongPressGestureRecognizer) {
            switch recognizer.state {
            case .began:
                parent.onHold?(.began)
            case .ended:
                parent.onHold?(.ended)
            case .cancelled, .failed:
                parent.onHold?(.cancelled)
            default:
                break
            }
        }

        /// A tap on the covered field opens the keyboard with the cursor where the finger was, as the field itself would.
        @objc func handleTap(_ recognizer: UITapGestureRecognizer) {
            guard let textView = field?.textView, parent.isEditable else { return }
            let point = recognizer.location(in: textView)
            guard textView.becomeFirstResponder() else { return }
            if let position = textView.closestPosition(to: point) {
                textView.selectedTextRange = textView.textRange(from: position, to: position)
            }
        }

        /// No new recording while one is going (the field is read-only then).
        func gestureRecognizerShouldBegin(_ recognizer: UIGestureRecognizer) -> Bool {
            guard recognizer is UILongPressGestureRecognizer else { return true }
            return parent.onHold != nil && parent.isEditable
        }

        func textViewShouldBeginEditing(_ textView: UITextView) -> Bool {
            parent.isEditable
        }

        func textView(_ textView: UITextView, shouldChangeTextIn range: NSRange, replacementText text: String) -> Bool {
            parent.isEditable
        }

        func textViewDidChange(_ textView: UITextView) {
            parent.text = textView.text
        }

        func textViewDidBeginEditing(_ textView: UITextView) {
            field?.updateTouchCover(holdEnabled: parent.onHold != nil)
            if !parent.isFocused {
                parent.isFocused = true
            }
        }

        func textViewDidEndEditing(_ textView: UITextView) {
            field?.updateTouchCover(holdEnabled: parent.onHold != nil)
            if parent.isFocused {
                parent.isFocused = false
            }
        }
    }
}

/// The composer's text view with a clear cover over it while the keyboard is down. The cover takes the tap (keyboard,
/// cursor at the finger) and the hold (talk): on the text view itself the hold waited for the field's own gestures,
/// which give up only when the finger moves or lifts. With the keyboard up the cover is gone and the field works as
/// usual (cursor, selection, loupe).
final class ComposerFieldView: UIView {
    let textView = PastingTextView()
    let touchCover = UIView()

    override init(frame: CGRect) {
        super.init(frame: frame)
        addSubview(textView)
        touchCover.backgroundColor = .clear
        addSubview(touchCover)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        textView.frame = bounds
        touchCover.frame = bounds
    }

    func updateTouchCover(holdEnabled: Bool) {
        touchCover.isHidden = !holdEnabled || textView.isFirstResponder
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
