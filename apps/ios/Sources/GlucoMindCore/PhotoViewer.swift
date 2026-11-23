import SwiftUI
#if canImport(UIKit)
import UIKit
#endif

#if os(iOS)
extension View {
    /// A tap opens the photo on the whole screen: the thumbnail grows into it (iOS 18 zoom), two fingers or a double tap
    /// enlarge it, a swipe down puts it back.
    func opensPhotoViewer(_ data: Data?) -> some View {
        modifier(PhotoViewerOpener(data: data))
    }
}

private struct PhotoViewerOpener: ViewModifier {
    let data: Data?
    @Namespace private var namespace
    @State private var isOpen = false

    func body(content: Content) -> some View {
        content
            .modifier(ZoomTransitionSource(id: "photo", namespace: namespace))
            .contentShape(Rectangle())
            .onTapGesture {
                if data != nil { isOpen = true }
            }
            .accessibilityAddTraits(data != nil ? .isButton : [])
            .accessibilityHint(data != nil ? "Powiększa zdjęcie" : "")
            .fullScreenCover(isPresented: $isOpen) {
                if let data {
                    PhotoViewer(data: data)
                        .modifier(ZoomTransitionDestination(id: "photo", namespace: namespace))
                }
            }
    }
}

private struct ZoomTransitionSource: ViewModifier {
    let id: String
    let namespace: Namespace.ID

    func body(content: Content) -> some View {
        if #available(iOS 18.0, *) {
            content.matchedTransitionSource(id: id, in: namespace)
        } else {
            content
        }
    }
}

private struct ZoomTransitionDestination: ViewModifier {
    let id: String
    let namespace: Namespace.ID

    func body(content: Content) -> some View {
        if #available(iOS 18.0, *) {
            content.navigationTransition(.zoom(sourceID: id, in: namespace))
        } else {
            content
        }
    }
}

/// One photo on a black screen: pinch or double tap to enlarge, ✕ or a swipe down to close, share at the top.
struct PhotoViewer: View {
    let data: Data
    @Environment(\.dismiss) private var dismiss
    @State private var isZoomed = false
    @State private var dragOffset: CGFloat = 0
    @State private var showsChrome = true

    var body: some View {
        ZStack {
            Color.black
                .opacity(1 - min(abs(dragOffset) / 400, 0.6))
                .ignoresSafeArea()
            if let image = UIImage(data: data) {
                ZoomableImage(image: image, isZoomed: $isZoomed, onSingleTap: {
                    withAnimation(.easeOut(duration: 0.2)) { showsChrome.toggle() }
                })
                .ignoresSafeArea()
                .offset(y: dragOffset)
                .scaleEffect(1 - min(abs(dragOffset) / 2000, 0.15))
                .simultaneousGesture(dismissDrag, including: Self.usesOwnDismissDrag ? .all : .subviews)
            }
        }
        .overlay(alignment: .top) {
            if showsChrome { topBar.transition(.opacity) }
        }
        .statusBarHidden(!showsChrome)
        .preferredColorScheme(.dark)
    }

    /// iOS 18 closes the zoomed-in screen itself with a swipe down, moving the whole screen back into the thumbnail; a
    /// second drag of our own moved only the photo and then closed it again. Ours stays for iOS 17 only.
    private static var usesOwnDismissDrag: Bool {
        if #available(iOS 18.0, *) { return false }
        return true
    }

    /// iOS 17: drawn only while the photo is not enlarged (an enlarged photo moves under the finger instead).
    private var dismissDrag: some Gesture {
        DragGesture(minimumDistance: 12)
            .onChanged { value in
                guard !isZoomed, abs(value.translation.height) > abs(value.translation.width) else { return }
                dragOffset = value.translation.height
            }
            .onEnded { value in
                guard !isZoomed else { return }
                if abs(value.translation.height) > 120 || abs(value.predictedEndTranslation.height) > 300 {
                    dismiss()
                } else {
                    withAnimation(.spring(duration: 0.3)) { dragOffset = 0 }
                }
            }
    }

    private var topBar: some View {
        HStack {
            Button { dismiss() } label: {
                Image(systemName: "xmark")
                    .font(.system(size: 16, weight: .semibold))
                    .foregroundStyle(.white)
                    .frame(width: 40, height: 40)
                    .glassBubble(in: Circle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Zamknij zdjęcie")
            Spacer()
            if let image = UIImage(data: data) {
                ShareLink(item: Image(uiImage: image), preview: SharePreview("Zdjęcie", image: Image(uiImage: image))) {
                    Image(systemName: "square.and.arrow.up")
                        .font(.system(size: 16, weight: .semibold))
                        .foregroundStyle(.white)
                        .frame(width: 40, height: 40)
                        .glassBubble(in: Circle())
                }
                .accessibilityLabel("Udostępnij zdjęcie")
            }
        }
        .padding(.horizontal, 16)
        .padding(.top, 8)
        .opacity(1 - min(abs(dragOffset) / 150, 1))
    }
}

/// The photo in a scroll view that zooms: fits the screen at first, up to 5× with two fingers, a double tap enlarges
/// at the tapped spot or goes back.
private struct ZoomableImage: UIViewRepresentable {
    let image: UIImage
    @Binding var isZoomed: Bool
    let onSingleTap: () -> Void

    func makeUIView(context: Context) -> CenteringScrollView {
        let scrollView = CenteringScrollView()
        scrollView.delegate = context.coordinator
        scrollView.minimumZoomScale = 1
        scrollView.maximumZoomScale = 5
        scrollView.showsVerticalScrollIndicator = false
        scrollView.showsHorizontalScrollIndicator = false
        scrollView.contentInsetAdjustmentBehavior = .never
        scrollView.backgroundColor = .clear
        scrollView.imageView.image = image
        scrollView.imageView.contentMode = .scaleAspectFit

        let doubleTap = UITapGestureRecognizer(target: context.coordinator, action: #selector(Coordinator.doubleTapped(_:)))
        doubleTap.numberOfTapsRequired = 2
        scrollView.addGestureRecognizer(doubleTap)
        let singleTap = UITapGestureRecognizer(target: context.coordinator, action: #selector(Coordinator.singleTapped))
        singleTap.require(toFail: doubleTap)
        scrollView.addGestureRecognizer(singleTap)
        return scrollView
    }

    func updateUIView(_ uiView: CenteringScrollView, context: Context) {
        context.coordinator.parent = self
    }

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    final class Coordinator: NSObject, UIScrollViewDelegate {
        var parent: ZoomableImage

        init(_ parent: ZoomableImage) { self.parent = parent }

        func viewForZooming(in scrollView: UIScrollView) -> UIView? {
            (scrollView as? CenteringScrollView)?.imageView
        }

        func scrollViewDidZoom(_ scrollView: UIScrollView) {
            (scrollView as? CenteringScrollView)?.centerImage()
            let zoomed = scrollView.zoomScale > 1.01
            if zoomed != parent.isZoomed { parent.isZoomed = zoomed }
        }

        @objc func doubleTapped(_ recognizer: UITapGestureRecognizer) {
            guard let scrollView = recognizer.view as? CenteringScrollView else { return }
            if scrollView.zoomScale > 1.01 {
                scrollView.setZoomScale(1, animated: true)
            } else {
                let point = recognizer.location(in: scrollView.imageView)
                let scale: CGFloat = 2.5
                let size = CGSize(width: scrollView.bounds.width / scale, height: scrollView.bounds.height / scale)
                scrollView.zoom(to: CGRect(x: point.x - size.width / 2, y: point.y - size.height / 2, width: size.width, height: size.height), animated: true)
            }
        }

        @objc func singleTapped() { parent.onSingleTap() }
    }

    final class CenteringScrollView: UIScrollView {
        let imageView = UIImageView()
        private var laidOutSize: CGSize = .zero

        override init(frame: CGRect) {
            super.init(frame: frame)
            addSubview(imageView)
        }

        required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

        override func layoutSubviews() {
            super.layoutSubviews()
            // The photo fits the screen at 1×; laid out again only when the screen size changes.
            guard bounds.size != laidOutSize, let image = imageView.image, image.size.width > 0, image.size.height > 0 else { return }
            laidOutSize = bounds.size
            zoomScale = 1
            let fit = min(bounds.width / image.size.width, bounds.height / image.size.height)
            imageView.frame = CGRect(origin: .zero, size: CGSize(width: image.size.width * fit, height: image.size.height * fit))
            contentSize = imageView.frame.size
            centerImage()
        }

        func centerImage() {
            let horizontal = max(0, (bounds.width - contentSize.width) / 2)
            let vertical = max(0, (bounds.height - contentSize.height) / 2)
            contentInset = UIEdgeInsets(top: vertical, left: horizontal, bottom: vertical, right: horizontal)
        }
    }
}
#endif
