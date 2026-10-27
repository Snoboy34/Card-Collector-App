import SwiftUI
import AVFoundation
import CoreImage

/// Live viewfinder + session-once AE/WB lock + high-quality stills.
///
/// `AVCaptureVideoDataOutput` stays on for the preview / still-path OCR hook.
/// The SwiftUI frame is a composition aid. Distance comes from the live
/// card quad. That quad is not drawn (a drawn quad flickered).
/// The hosting UIView does not take hits so ScrollView and tab bar stay tappable.
/// `AVCapturePhotoOutput` is a separate still path — one JPEG per tap.
/// The still is the wide camera at 1×, JPEG, quality priority, at the
/// largest still size that camera reports. The iPhone 13 Pro wide camera
/// reports 4032×3024. A larger still is used when this camera offers one.
public struct LiveCameraView: UIViewRepresentable {

    public struct StillCapture {
        public let jpeg: Data
        public let previewSize: CGSize
        let camera: CameraFacts
        let capturedAt: Date
    }

    public struct CaptureSessionFacts: Equatable {
        public var focusSettled: Bool = false
        public var sensorWidth: Int = 0
        public var sensorHeight: Int = 0
        public var cameraDeviceType: String = ""
    }

    @EnvironmentObject private var calibrationEngine: CameraCalibration
    private let onFrameCaptured: (CGImage) -> Void
    @Binding private var stillCaptureNonce: UInt64
    @Binding private var exposureLockStatus: String
    @Binding private var sessionFacts: CaptureSessionFacts
    private let onStillCaptured: (Result<StillCapture, Error>) -> Void

    public init(
        stillCaptureNonce: Binding<UInt64>,
        exposureLockStatus: Binding<String>,
        sessionFacts: Binding<CaptureSessionFacts>,
        onStillCaptured: @escaping (Result<StillCapture, Error>) -> Void,
        onFrameCaptured: @escaping (CGImage) -> Void = { _ in }
    ) {
        self._stillCaptureNonce = stillCaptureNonce
        self._exposureLockStatus = exposureLockStatus
        self._sessionFacts = sessionFacts
        self.onStillCaptured = onStillCaptured
        self.onFrameCaptured = onFrameCaptured
    }

    public func makeUIView(context: Context) -> UIView {
        let captureContainerView = UIView(frame: .zero)
        captureContainerView.backgroundColor = .black
        captureContainerView.clipsToBounds = true
        captureContainerView.isUserInteractionEnabled = false
        context.coordinator.onFrameReceivedClosure = onFrameCaptured
        context.coordinator.onStillCaptured = onStillCaptured
        context.coordinator.onExposureLockStatus = { exposureLockStatus = $0 }
        context.coordinator.onSessionFacts = { sessionFacts = $0 }
        context.coordinator.attachPreview(to: captureContainerView)
        context.coordinator.startSessionIfNeeded()
        return captureContainerView
    }

    public func updateUIView(_ uiView: UIView, context: Context) {
        context.coordinator.onFrameReceivedClosure = onFrameCaptured
        context.coordinator.onStillCaptured = onStillCaptured
        context.coordinator.onExposureLockStatus = { exposureLockStatus = $0 }
        context.coordinator.onSessionFacts = { sessionFacts = $0 }
        DispatchQueue.main.async {
            context.coordinator.layoutPreview(in: uiView)
        }
        if context.coordinator.lastHandledCaptureNonce != stillCaptureNonce {
            context.coordinator.lastHandledCaptureNonce = stillCaptureNonce
            if stillCaptureNonce > 0 {
                context.coordinator.captureStillPhoto()
            }
        }
    }

    public func makeCoordinator() -> Coordinator {
        Coordinator()
    }

    public class Coordinator: NSObject, AVCaptureVideoDataOutputSampleBufferDelegate, AVCapturePhotoCaptureDelegate {
        var previewLayerAnchor: AVCaptureVideoPreviewLayer?
        var onFrameReceivedClosure: ((CGImage) -> Void)?
        var onStillCaptured: ((Result<StillCapture, Error>) -> Void)?
        var onExposureLockStatus: ((String) -> Void)?
        var onSessionFacts: ((CaptureSessionFacts) -> Void)?
        var lastHandledCaptureNonce: UInt64 = 0

        private let sessionQueue = DispatchQueue(label: "com.cardgrader.camerasession.queue", qos: .userInteractive)
        private let sharedCIContext = CIContext(options: [.useSoftwareRenderer: false])
        private let recordingSession = AVCaptureSession()
        private var photoOutput: AVCapturePhotoOutput?
        private var captureDevice: AVCaptureDevice?
        private var requestedPhoto = StillPhotoSize.Pixels(width: 0, height: 0)
        private var didStartSession = false
        private var didLockExposure = false
        private var captureInFlight = false
        private var lastFrameEmit = Date.distantPast
        private let frameEmitInterval: TimeInterval = 0.3

        func attachPreview(to container: UIView) {
            let liveVideoPreviewLayer = AVCaptureVideoPreviewLayer(session: recordingSession)
            liveVideoPreviewLayer.videoGravity = .resizeAspectFill
            liveVideoPreviewLayer.frame = container.bounds
            container.layer.addSublayer(liveVideoPreviewLayer)

            // The 2.5×3.5 frame and crosshair are drawn in SwiftUI. A live
            // Vision quad is measured for distance and is not drawn.
            previewLayerAnchor = liveVideoPreviewLayer
        }

        func layoutPreview(in view: UIView) {
            previewLayerAnchor?.frame = view.bounds
        }

        func startSessionIfNeeded() {
            sessionQueue.async { [weak self] in
                self?.configureAndStartSession()
            }
        }

        private func configureAndStartSession() {
            guard !didStartSession else { return }
            recordingSession.beginConfiguration()
            recordingSession.sessionPreset = .photo

            // Physical wide camera. The still uses the largest size this
            // sensor offers. On the iPhone 13 Pro that size is 4032×3024.
            guard let primaryBackCamera = AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: .back),
                  let hardwareInputNode = try? AVCaptureDeviceInput(device: primaryBackCamera) else {
                print("Failed to acquire connection to rear camera hardware.")
                recordingSession.commitConfiguration()
                publishLockStatus("Rear camera unavailable")
                return
            }

            if recordingSession.canAddInput(hardwareInputNode) {
                recordingSession.addInput(hardwareInputNode)
            }
            captureDevice = primaryBackCamera

            let frameBufferOutput = AVCaptureVideoDataOutput()
            frameBufferOutput.alwaysDiscardsLateVideoFrames = true
            frameBufferOutput.setSampleBufferDelegate(self, queue: sessionQueue)
            if recordingSession.canAddOutput(frameBufferOutput) {
                recordingSession.addOutput(frameBufferOutput)
                applyPortraitRotation(frameBufferOutput.connection(with: .video))
            }

            let stillOutput = AVCapturePhotoOutput()
            if recordingSession.canAddOutput(stillOutput) {
                recordingSession.addOutput(stillOutput)
                stillOutput.maxPhotoQualityPrioritization = .quality
                applyPortraitRotation(stillOutput.connection(with: .video))
                photoOutput = stillOutput
                applyMaximumStillSize(to: stillOutput)
            }

            recordingSession.commitConfiguration()
            if let stillOutput = photoOutput {
                applyMaximumStillSize(to: stillOutput)
            }
            publishSessionFacts()
            beginContinuousAE(on: primaryBackCamera)
            publishLockStatus("Point at empty mat — AE settling…")
            recordingSession.startRunning()
            didStartSession = true
            scheduleExposureSettleCheck(on: primaryBackCamera, started: Date())
        }

        private func applyPortraitRotation(_ connection: AVCaptureConnection?) {
            guard let connection else { return }
            if connection.isVideoRotationAngleSupported(90.0) {
                connection.videoRotationAngle = 90.0
            }
        }

        private func beginContinuousAE(on device: AVCaptureDevice) {
            do {
                try device.lockForConfiguration()
                if device.isExposureModeSupported(.continuousAutoExposure) {
                    device.exposureMode = .continuousAutoExposure
                }
                if device.isWhiteBalanceModeSupported(.continuousAutoWhiteBalance) {
                    device.whiteBalanceMode = .continuousAutoWhiteBalance
                }
                if device.minAvailableVideoZoomFactor <= 1, device.maxAvailableVideoZoomFactor >= 1 {
                    device.videoZoomFactor = 1
                }
                device.isSubjectAreaChangeMonitoringEnabled = false
                device.unlockForConfiguration()
            } catch {
                publishLockStatus("Could not start AE: \(error.localizedDescription)")
            }
        }

        /// Session-once lock: wait until AE/WB stop hunting after open, then lock.
        /// Minimum wait covers devices that never flip `isAdjusting*` to true.
        /// Timeout still locks so a capture session is never stuck open.
        private func scheduleExposureSettleCheck(on device: AVCaptureDevice, started: Date) {
            sessionQueue.asyncAfter(deadline: .now() + 0.08) { [weak self] in
                guard let self, !self.didLockExposure else { return }
                let elapsed = Date().timeIntervalSince(started)
                let settled = !device.isAdjustingExposure && !device.isAdjustingWhiteBalance
                let minWait: TimeInterval = 0.45
                let timeout: TimeInterval = 2.5
                if (settled && elapsed >= minWait) || elapsed >= timeout {
                    self.lockAEAndWB(device)
                    return
                }
                self.scheduleExposureSettleCheck(on: device, started: started)
            }
        }

        private func lockAEAndWB(_ device: AVCaptureDevice) {
            guard !didLockExposure else { return }
            do {
                try device.lockForConfiguration()
                if device.isExposureModeSupported(.locked) {
                    device.exposureMode = .locked
                }
                if device.isWhiteBalanceModeSupported(.locked) {
                    device.whiteBalanceMode = .locked
                }
                device.unlockForConfiguration()
                didLockExposure = true
                publishLockStatus("AE/WB locked for this session")
            } catch {
                publishLockStatus("AE lock failed: \(error.localizedDescription)")
            }
        }

        func captureStillPhoto() {
            sessionQueue.async { [weak self] in
                guard let self else { return }
                guard let photoOutput = self.photoOutput, self.recordingSession.isRunning else {
                    self.failStill(CaptureError.cameraNotRunning)
                    return
                }
                guard self.didLockExposure else {
                    self.failStill(CaptureError.exposureNotLocked)
                    return
                }
                guard !self.captureInFlight else {
                    self.failStill(CaptureError.captureInFlight)
                    return
                }
                self.captureInFlight = true
                guard let settings = self.jpegStillSettings(on: photoOutput) else {
                    self.captureInFlight = false
                    self.failStill(CaptureError.jpegUnavailable)
                    return
                }
                photoOutput.capturePhoto(with: settings, delegate: self)
            }
        }

        /// JPEG at the device-maximum size, quality priority. Nil when this
        /// camera cannot deliver JPEG.
        private func jpegStillSettings(on output: AVCapturePhotoOutput) -> AVCapturePhotoSettings? {
            guard output.availablePhotoCodecTypes.contains(.jpeg) else { return nil }
            let settings = AVCapturePhotoSettings(format: [AVVideoCodecKey: AVVideoCodecType.jpeg])
            settings.flashMode = output.supportedFlashModes.contains(.off) ? .off : settings.flashMode
            settings.photoQualityPrioritization = output.maxPhotoQualityPrioritization == .quality
                ? .quality
                : output.maxPhotoQualityPrioritization
            if requestedPhoto.width > 0, requestedPhoto.height > 0 {
                settings.maxPhotoDimensions = CMVideoDimensions(
                    width: Int32(requestedPhoto.width),
                    height: Int32(requestedPhoto.height)
                )
            }
            return settings
        }

        /// Raise the output cap to the largest size this wide camera offers.
        /// The list comes from the camera. iPhone 13 Pro (`iPhone14,2`)
        /// reports 4032×3024 as that maximum.
        private func applyMaximumStillSize(to output: AVCapturePhotoOutput) {
            let sizes = output.supportedMaxPhotoDimensions.map {
                StillPhotoSize.Pixels(width: Int($0.width), height: Int($0.height))
            }
            guard let largest = StillPhotoSize.largest(sizes) else { return }
            output.maxPhotoDimensions = CMVideoDimensions(width: Int32(largest.width), height: Int32(largest.height))
            requestedPhoto = largest
            publishSessionFacts()
        }

        public func photoOutput(_ output: AVCapturePhotoOutput, didFinishProcessingPhoto photo: AVCapturePhoto, error: Error?) {
            captureInFlight = false
            if let error {
                failStill(error)
                return
            }
            guard let jpeg = photo.fileDataRepresentation() else {
                failStill(CaptureError.missingJPEG)
                return
            }
            guard CameraFacts.codecName(jpeg) == "jpeg" else {
                failStill(CaptureError.notJPEG)
                return
            }
            var previewSize = CGSize.zero
            if Thread.isMainThread {
                previewSize = previewLayerAnchor?.bounds.size ?? .zero
            } else {
                previewSize = DispatchQueue.main.sync { previewLayerAnchor?.bounds.size ?? .zero }
            }
            var camera = CameraFacts.read(device: captureDevice, photo: photo, fileData: jpeg)
            if requestedPhoto.width > 0 {
                camera.maxPhotoWidth = requestedPhoto.width
                camera.maxPhotoHeight = requestedPhoto.height
                camera.requestedWidth = requestedPhoto.width
                camera.requestedHeight = requestedPhoto.height
                camera.photoSizeSetting = "max"
            } else {
                camera.photoSizeSetting = "default"
            }
            let payload = StillCapture(
                jpeg: jpeg,
                previewSize: previewSize,
                camera: camera,
                capturedAt: Date()
            )
            DispatchQueue.main.async { [weak self] in
                self?.onStillCaptured?(.success(payload))
            }
        }

        public func captureOutput(_ output: AVCaptureOutput, didOutput sampleBuffer: CMSampleBuffer, from connection: AVCaptureConnection) {
            guard let imagePixelBuffer = CMSampleBufferGetImageBuffer(sampleBuffer),
                  let closureAnchor = onFrameReceivedClosure else { return }

            let sourceImage = CIImage(cvImageBuffer: imagePixelBuffer)
            let maximumViewportDimensions = sourceImage.extent
            guard let isolatedCGImage = sharedCIContext.createCGImage(sourceImage, from: maximumViewportDimensions) else { return }

            let now = Date()
            guard now.timeIntervalSince(lastFrameEmit) >= frameEmitInterval else { return }
            lastFrameEmit = now
            publishSessionFacts()
            DispatchQueue.main.async {
                closureAnchor(isolatedCGImage)
            }
        }

        private func publishSessionFacts() {
            let facts = CaptureSessionFacts(
                focusSettled: !(captureDevice?.isAdjustingFocus ?? true),
                sensorWidth: requestedPhoto.width,
                sensorHeight: requestedPhoto.height,
                cameraDeviceType: captureDevice?.deviceType.rawValue ?? ""
            )
            DispatchQueue.main.async { [weak self] in
                self?.onSessionFacts?(facts)
            }
        }

        private func failStill(_ error: Error) {
            DispatchQueue.main.async { [weak self] in
                self?.onStillCaptured?(.failure(error))
            }
        }

        private func publishLockStatus(_ text: String) {
            DispatchQueue.main.async { [weak self] in
                self?.onExposureLockStatus?(text)
            }
        }

        enum CaptureError: LocalizedError {
            case cameraNotRunning
            case exposureNotLocked
            case captureInFlight
            case missingJPEG
            case jpegUnavailable
            case notJPEG

            var errorDescription: String? {
                switch self {
                case .cameraNotRunning:
                    return "Camera is not running yet."
                case .exposureNotLocked:
                    return "Wait for AE/WB lock. Point at the empty mat first."
                case .captureInFlight:
                    return "A still is already being captured."
                case .missingJPEG:
                    return "PhotoOutput returned no JPEG bytes."
                case .jpegUnavailable:
                    return "This camera cannot deliver a JPEG still."
                case .notJPEG:
                    return "The still was not a JPEG. Nothing was uploaded."
                }
            }
        }
    }
}
