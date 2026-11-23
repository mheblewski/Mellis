#if os(iOS)
import AVFoundation
import SwiftUI
import UIKit

/// The camera inside the composer's bubble: a live picture above the text field, the shutter on it. Nothing opens over
/// the chat; the photo taken joins the ones above the field, as a photo from the library does. What the picture shows
/// is what goes with the message (the photo is cut to the visible frame).
struct ComposerCameraView: View {
    let onPhoto: (UIImage) -> Void
    let onClose: () -> Void

    @StateObject private var camera = ComposerCameraController()
    @State private var flash = false
    @State private var pinchBase: CGFloat = 1

    var body: some View {
        ZStack {
            switch camera.state {
            case .starting:
                Color.black
                ProgressView().tint(.white)
            case .running:
                ComposerCameraPreview(controller: camera)
                    .gesture(MagnificationGesture()
                        .onChanged { camera.zoom(pinchBase * $0) }
                        .onEnded { _ in pinchBase = camera.zoomFactor })
            case .denied:
                Color.black
                deniedNotice
            case .unavailable:
                Color.black
                Text("Ten telefon nie ma aparatu.")
                    .font(.subheadline)
                    .foregroundStyle(.white.opacity(0.8))
            }
            // The shot: a short white blink, as in the system camera.
            Color.white.opacity(flash ? 0.7 : 0).allowsHitTesting(false)
        }
        .overlay(alignment: .topLeading) { closeButton }
        .overlay(alignment: .bottom) {
            if camera.state == .running { shutter }
        }
        .frame(height: 300)
        .clipShape(RoundedRectangle(cornerRadius: 19, style: .continuous))
        .task { await camera.start() }
        .onDisappear { camera.stop() }
    }

    private var closeButton: some View {
        Button(action: onClose) {
            Image(systemName: "xmark")
                .font(.system(size: 14, weight: .semibold))
                .foregroundStyle(.white)
                .frame(width: 32, height: 32)
                .background(Circle().fill(.black.opacity(0.45)))
                .contentShape(Circle())
        }
        .buttonStyle(.plain)
        .padding(10)
        .accessibilityLabel("Zamknij aparat")
    }

    private var shutter: some View {
        Button {
            withAnimation(.easeOut(duration: 0.08)) { flash = true }
            withAnimation(.easeIn(duration: 0.25).delay(0.08)) { flash = false }
            camera.capture { image in
                if let image { onPhoto(image) }
            }
        } label: {
            ZStack {
                Circle().stroke(.white, lineWidth: 4).frame(width: 62, height: 62)
                Circle().fill(.white).frame(width: 50, height: 50)
                    .scaleEffect(camera.isCapturing ? 0.85 : 1)
            }
            .contentShape(Circle())
            .shadow(color: .black.opacity(0.25), radius: 6)
        }
        .buttonStyle(.plain)
        .disabled(camera.isCapturing)
        .padding(.bottom, 14)
        .accessibilityLabel("Zrób zdjęcie")
        .sensoryFeedback(.impact(weight: .light), trigger: camera.shotCount)
    }

    private var deniedNotice: some View {
        VStack(spacing: 12) {
            Text("Mellis nie ma dostępu do aparatu. Możesz go włączyć w Ustawieniach.")
                .font(.subheadline)
                .multilineTextAlignment(.center)
                .foregroundStyle(.white)
            Button("Otwórz Ustawienia") {
                if let url = URL(string: UIApplication.openSettingsURLString) {
                    UIApplication.shared.open(url)
                }
            }
            .buttonStyle(.borderedProminent)
        }
        .padding(.horizontal, 28)
    }
}

/// The capture session behind the composer's camera: the back camera, one photo at a time.
@MainActor
final class ComposerCameraController: NSObject, ObservableObject {
    enum State: Equatable { case starting, running, denied, unavailable }

    @Published private(set) var state: State = .starting
    @Published private(set) var isCapturing = false
    @Published private(set) var shotCount = 0
    private(set) var zoomFactor: CGFloat = 1

    nonisolated let session = AVCaptureSession()
    private let output = AVCapturePhotoOutput()
    private var device: AVCaptureDevice?
    private let queue = DispatchQueue(label: "pl.mellis.composer-camera")
    /// The bubble's live picture: its frame decides the part of the photo kept.
    weak var previewLayer: AVCaptureVideoPreviewLayer?
    private var pending: ((UIImage?) -> Void)?

    static var isSimulator: Bool {
        #if targetEnvironment(simulator)
        true
        #else
        false
        #endif
    }

    func start() async {
        if Self.isSimulator {
            state = .running
            return
        }
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized:
            break
        case .notDetermined:
            guard await AVCaptureDevice.requestAccess(for: .video) else {
                state = .denied
                return
            }
        default:
            state = .denied
            return
        }
        guard let device = AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: .back),
              let input = try? AVCaptureDeviceInput(device: device) else {
            state = .unavailable
            return
        }
        self.device = device
        let session = session
        let output = output
        await withCheckedContinuation { (done: CheckedContinuation<Void, Never>) in
            queue.async {
                session.beginConfiguration()
                session.sessionPreset = .photo
                if session.canAddInput(input) { session.addInput(input) }
                if session.canAddOutput(output) { session.addOutput(output) }
                session.commitConfiguration()
                session.startRunning()
                done.resume()
            }
        }
        state = .running
    }

    func stop() {
        let session = session
        queue.async { if session.isRunning { session.stopRunning() } }
    }

    func zoom(_ factor: CGFloat) {
        guard let device else { return }
        let clamped = min(max(factor, 1), min(device.activeFormat.videoMaxZoomFactor, 6))
        do {
            try device.lockForConfiguration()
            device.videoZoomFactor = clamped
            device.unlockForConfiguration()
            zoomFactor = clamped
        } catch {}
    }

    func capture(_ completion: @escaping (UIImage?) -> Void) {
        guard !isCapturing else { return }
        isCapturing = true
        shotCount += 1
        if Self.isSimulator {
            Task {
                try? await Task.sleep(for: .milliseconds(200))
                isCapturing = false
                completion(Self.simulatorPhoto())
            }
            return
        }
        pending = completion
        if let connection = output.connection(with: .video), let layerConnection = previewLayer?.connection {
            // The photo stands as the picture did (only its orientation tag changes, not its pixels).
            let angle = layerConnection.videoRotationAngle
            if connection.isVideoRotationAngleSupported(angle) { connection.videoRotationAngle = angle }
        }
        output.capturePhoto(with: AVCapturePhotoSettings(), delegate: self)
    }

    /// The visible part of the bubble, in the photo's normalized coordinates (landscape sensor space).
    private func visibleRect() -> CGRect? {
        guard let layer = previewLayer else { return nil }
        return layer.metadataOutputRectConverted(fromLayerRect: layer.bounds)
    }

    private func finish(_ image: UIImage?) {
        isCapturing = false
        pending?(image)
        pending = nil
    }

    /// Cuts the photo to what the bubble showed.
    static func crop(_ image: UIImage, toSensorRect rect: CGRect) -> UIImage {
        guard let cg = image.cgImage else { return image }
        let width = CGFloat(cg.width), height = CGFloat(cg.height)
        // The sensor rect is in the unrotated (landscape) buffer, which is the cgImage before its orientation.
        let crop = CGRect(x: rect.minX * width, y: rect.minY * height, width: rect.width * width, height: rect.height * height)
            .integral
            .intersection(CGRect(x: 0, y: 0, width: width, height: height))
        guard !crop.isEmpty, let cut = cg.cropping(to: crop) else { return image }
        return UIImage(cgImage: cut, scale: image.scale, orientation: image.imageOrientation)
    }

    /// A stand-in photo where there is no camera (simulator checks of the layout).
    private static func simulatorPhoto() -> UIImage {
        let size = CGSize(width: 1200, height: 1600)
        return UIGraphicsImageRenderer(size: size).image { context in
            UIColor(red: 0.93, green: 0.83, blue: 0.62, alpha: 1).setFill()
            context.fill(CGRect(origin: .zero, size: size))
            UIColor(red: 0.8, green: 0.35, blue: 0.25, alpha: 1).setFill()
            context.cgContext.fillEllipse(in: CGRect(x: 250, y: 450, width: 700, height: 700))
        }
    }
}

extension ComposerCameraController: AVCapturePhotoCaptureDelegate {
    nonisolated func photoOutput(_ output: AVCapturePhotoOutput, didFinishProcessingPhoto photo: AVCapturePhoto, error: Error?) {
        let data = photo.fileDataRepresentation()
        Task { @MainActor in
            guard let data, let image = UIImage(data: data) else {
                finish(nil)
                return
            }
            if let rect = visibleRect() {
                finish(Self.crop(image, toSensorRect: rect))
            } else {
                finish(image)
            }
        }
    }
}

/// The live picture of the composer's camera (a gradient stand-in in the simulator).
private struct ComposerCameraPreview: UIViewRepresentable {
    let controller: ComposerCameraController

    func makeUIView(context: Context) -> PreviewView {
        let view = PreviewView()
        if ComposerCameraController.isSimulator {
            view.backgroundColor = UIColor(red: 0.35, green: 0.3, blue: 0.25, alpha: 1)
        } else {
            view.previewLayer.session = controller.session
            view.previewLayer.videoGravity = .resizeAspectFill
            controller.previewLayer = view.previewLayer
        }
        return view
    }

    func updateUIView(_ uiView: PreviewView, context: Context) {}

    final class PreviewView: UIView {
        override class var layerClass: AnyClass { AVCaptureVideoPreviewLayer.self }
        var previewLayer: AVCaptureVideoPreviewLayer { layer as! AVCaptureVideoPreviewLayer }
    }
}
#endif
