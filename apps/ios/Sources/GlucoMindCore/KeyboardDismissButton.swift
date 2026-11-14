import SwiftUI
#if canImport(UIKit) && os(iOS)
import UIKit

/// One button for the whole app that hides the keyboard: a small glass capsule at the right, just above the keyboard,
/// in every screen and sheet. It rides up and down with the keyboard (the keyboard layout guide), so a swipe that pulls
/// the keyboard down takes it along. Number pads have no return key, so without it the only way out was a swipe or a
/// tap somewhere else.
/// Over a chat composer on top of the keyboard it floats above the composer, over its send button
/// (`keyboardDismissButtonClearance`). Not shown where the screen has its own (`hidesKeyboardDismissButton`): the meal
/// search's close button, the Bolus tab's button beside the slider.
@MainActor
public final class KeyboardDismissButton {
    public static let shared = KeyboardDismissButton()

    private var window: KeyboardButtonWindow?
    private var controller: KeyboardButtonController?
    /// Screens and inputs that hide the keyboard their own way right now.
    private var owners = Set<AnyHashable>()
    /// Bars that ride on the keyboard (the chat composers), as their own views: only the ones on screen and on top
    /// count. A composer under a sheet stays in the window and never disappears, so a height it once reported lifted
    /// the button over nothing ("Edytuj posiłek" over the meal page).
    private let bars = NSHashTable<UIView>.weakObjects()

    private init() {}

    func install(in scene: UIWindowScene) {
        guard window?.windowScene !== scene else { return }
        let overlay = KeyboardButtonWindow(windowScene: scene)
        // Above sheets and the app's own windows; the keyboard has its own window above all of them.
        overlay.windowLevel = .normal + 1
        overlay.backgroundColor = .clear
        let controller = KeyboardButtonController()
        controller.isSuppressed = { [weak self] in !(self?.owners.isEmpty ?? true) }
        controller.currentClearance = { [weak self] in self?.visibleBarHeight() ?? 0 }
        overlay.rootViewController = controller
        overlay.isHidden = false
        window = overlay
        self.controller = controller
    }

    /// `owner` hides the keyboard its own way while `active`; the button stays away until every owner lets go.
    public func setOwnButton(_ owner: AnyHashable, active: Bool) {
        let changed = active ? owners.insert(owner).inserted : owners.remove(owner) != nil
        if changed { controller?.updateVisibility(animated: true) }
    }

    fileprivate func addBar(_ bar: UIView) {
        bars.add(bar)
        barsChanged()
    }

    fileprivate func barsChanged() {
        controller?.refreshClearance()
    }

    /// The tallest bar the person can see: in a window, not hidden, and inside the top presented screen of its window
    /// (not under a sheet).
    private func visibleBarHeight() -> CGFloat {
        var height: CGFloat = 0
        for bar in bars.allObjects {
            guard let window = bar.window, !bar.isHiddenOrClear, var top = window.rootViewController else { continue }
            while let presented = top.presentedViewController, !presented.isBeingDismissed { top = presented }
            guard bar.isDescendant(of: top.view) else { continue }
            height = max(height, bar.bounds.height)
        }
        return height
    }
}

private extension UIView {
    var isHiddenOrClear: Bool {
        var view: UIView? = self
        while let current = view {
            if current.isHidden || current.alpha < 0.01 { return true }
            view = current.superview
        }
        return false
    }
}

/// Lets every touch through except the ones on the button, and never takes the keyboard from the app's window.
private final class KeyboardButtonWindow: UIWindow {
    override var canBecomeKey: Bool { false }

    override func hitTest(_ point: CGPoint, with event: UIEvent?) -> UIView? {
        let hit = super.hitTest(point, with: event)
        return hit is UIButton ? hit : nil
    }
}

private final class KeyboardButtonController: UIViewController {
    var isSuppressed: () -> Bool = { false }
    var currentClearance: () -> CGFloat = { 0 }

    func refreshClearance() {
        clearance = currentClearance()
    }

    private var clearance: CGFloat = 0 {
        didSet {
            guard clearance != oldValue, let bottom else { return }
            bottom.constant = -(Self.gap + clearance)
            // Moved at once while hidden: it appears in its place, not sliding to it.
            guard shown else { return }
            UIView.animate(withDuration: 0.3, delay: 0, usingSpringWithDamping: 0.9, initialSpringVelocity: 0, options: [.allowUserInteraction, .beginFromCurrentState]) {
                self.view.layoutIfNeeded()
            }
        }
    }

    private static let gap: CGFloat = 8
    private var bottom: NSLayoutConstraint?

    private let button = UIButton(type: .system)
    private var keyboardUp = false
    private var shown = false

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .clear

        button.configuration = Self.configuration()
        button.accessibilityLabel = "Schowaj klawiaturę"
        button.addTarget(self, action: #selector(hideKeyboard), for: .touchUpInside)
        button.translatesAutoresizingMaskIntoConstraints = false
        button.layer.shadowColor = UIColor.black.cgColor
        button.layer.shadowOpacity = 0.12
        button.layer.shadowRadius = 10
        button.layer.shadowOffset = CGSize(width: 0, height: 3)
        button.alpha = 0
        button.isHidden = true
        view.addSubview(button)

        view.keyboardLayoutGuide.followsUndockedKeyboard = true
        let bottom = button.bottomAnchor.constraint(equalTo: view.keyboardLayoutGuide.topAnchor, constant: -(Self.gap + clearance))
        self.bottom = bottom
        NSLayoutConstraint.activate([
            bottom,
            button.widthAnchor.constraint(equalToConstant: 60),
            button.heightAnchor.constraint(equalToConstant: 36),
            // Flush with the chat composer bubble's trailing edge (12 pt from the screen's), over its send button.
            button.trailingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.trailingAnchor, constant: -12),
        ])

        let center = NotificationCenter.default
        center.addObserver(self, selector: #selector(keyboardWillShow(_:)), name: UIResponder.keyboardWillShowNotification, object: nil)
        center.addObserver(self, selector: #selector(keyboardWillHide(_:)), name: UIResponder.keyboardWillHideNotification, object: nil)
    }

    private static func configuration() -> UIButton.Configuration {
        var config: UIButton.Configuration
        if #available(iOS 26.0, *) {
            config = .glass()
        } else {
            config = .plain()
            config.background.visualEffect = UIBlurEffect(style: .systemThickMaterial)
            config.background.strokeColor = UIColor.separator.withAlphaComponent(0.3)
            config.background.strokeWidth = 0.5
        }
        config.cornerStyle = .capsule
        config.image = UIImage(systemName: "keyboard.chevron.compact.down")
        config.preferredSymbolConfigurationForImage = UIImage.SymbolConfiguration(pointSize: 15, weight: .semibold)
        config.baseForegroundColor = .tintColor
        config.contentInsets = .zero
        return config
    }

    @objc private func keyboardWillShow(_ note: Notification) {
        // A hardware keyboard shows only its thin shortcut bar, an undocked one floats: nothing to hide on top of.
        let frame = (note.userInfo?[UIResponder.keyboardFrameEndUserInfoKey] as? CGRect) ?? .zero
        keyboardUp = frame.height > 120
        refreshClearance()
        updateVisibility(animated: true)
    }

    @objc private func keyboardWillHide(_ note: Notification) {
        keyboardUp = false
        updateVisibility(animated: true)
    }

    func updateVisibility(animated: Bool) {
        let show = keyboardUp && !isSuppressed()
        guard show != shown else { return }
        shown = show
        let changes = { [button] in
            button.alpha = show ? 1 : 0
            button.transform = show ? .identity : CGAffineTransform(scaleX: 0.6, y: 0.6)
        }
        guard animated, view.window != nil else {
            changes()
            button.isHidden = !show
            return
        }
        if show {
            button.isHidden = false
            button.transform = CGAffineTransform(scaleX: 0.6, y: 0.6)
            UIView.animate(withDuration: 0.45, delay: 0.05, usingSpringWithDamping: 0.7, initialSpringVelocity: 0.4, options: [.allowUserInteraction, .beginFromCurrentState], animations: changes)
        } else {
            UIView.animate(withDuration: 0.18, delay: 0, options: [.beginFromCurrentState], animations: changes) { [weak self] _ in
                guard let self, !self.shown else { return }
                self.button.isHidden = true
            }
        }
    }

    @objc private func hideKeyboard() {
        UIImpactFeedbackGenerator(style: .soft).impactOccurred()
        UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)
    }
}

/// Put once behind the app's root view: adds the button's window to the scene.
public struct KeyboardDismissButtonInstaller: UIViewRepresentable {
    public init() {}

    public func makeUIView(context: Context) -> InstallerView { InstallerView() }
    public func updateUIView(_ uiView: InstallerView, context: Context) {}

    public final class InstallerView: UIView {
        override public func didMoveToWindow() {
            super.didMoveToWindow()
            guard let scene = window?.windowScene else { return }
            KeyboardDismissButton.shared.install(in: scene)
        }
    }
}

private struct HidesKeyboardDismissButton: ViewModifier {
    let hides: Bool
    @State private var owner = UUID()

    func body(content: Content) -> some View {
        content
            .onChange(of: hides, initial: true) { _, hides in
                KeyboardDismissButton.shared.setOwnButton(owner, active: hides)
            }
            .onDisappear { KeyboardDismissButton.shared.setOwnButton(owner, active: false) }
            .onAppear { KeyboardDismissButton.shared.setOwnButton(owner, active: hides) }
    }
}

/// A view behind the bar, the bar's size: the button reads its height and whether it is on screen when the keyboard
/// comes up.
private struct KeyboardBarProbe: UIViewRepresentable {
    func makeUIView(context: Context) -> ProbeView { ProbeView() }
    func updateUIView(_ uiView: ProbeView, context: Context) {}

    final class ProbeView: UIView {
        override init(frame: CGRect) {
            super.init(frame: frame)
            isUserInteractionEnabled = false
            backgroundColor = .clear
        }

        required init?(coder: NSCoder) { nil }

        override func didMoveToWindow() {
            super.didMoveToWindow()
            if window != nil { KeyboardDismissButton.shared.addBar(self) } else { KeyboardDismissButton.shared.barsChanged() }
        }

        override func layoutSubviews() {
            super.layoutSubviews()
            KeyboardDismissButton.shared.barsChanged()
        }
    }
}

public extension View {
    /// This view is a bar on top of the keyboard (with its bottom padding): the app's floating button stays above it.
    func keyboardDismissButtonClearance() -> some View {
        background(KeyboardBarProbe())
    }

    /// The screen hides the keyboard its own way while `hides`: the app's floating button stays away.
    func hidesKeyboardDismissButton(_ hides: Bool) -> some View {
        modifier(HidesKeyboardDismissButton(hides: hides))
    }
}
#else
public extension View {
    func hidesKeyboardDismissButton(_ hides: Bool) -> some View { self }
    func keyboardDismissButtonClearance() -> some View { self }
}
#endif
