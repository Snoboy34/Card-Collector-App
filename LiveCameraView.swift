import SwiftUI
import AVFoundation
import CoreImage
import Vision

/// Live viewfinder + session-once AE/WB lock + high-quality stills.
///
/// `AVCaptureVideoDataOutput` stays on for the preview / Vision overlay.
/// `AVCapturePhotoOutput` is a separate still path — one JPEG per tap, not a
/// video-frame grab. Exposure and white balance lock after `isAdjusting*`
/// settles at session start (empty mat), then stay locked for the session.
public struct LiveCameraView: UIViewRepresentable {

    public struct StillCapture {
        public let jpeg: Data
        public let previewSize: CGSize
    }

    @EnvironmentObject private var calibrationEngine: CameraCalibration
    private let onFrameCaptured: (CGImage) -> Void
    @Binding private var stillCaptureNonce: UInt64
    @Binding private var exposureLockStatus: String
    private let onStillCaptured: (Result<StillCapture, Error>) -> Void

    public init(
        stillCaptureNonce: Binding<UInt64>,
        exposureLockStatus: Binding<String>,
        onStillCaptured: @escaping (Result<StillCapture, Error>) -> Void,
        onFrameCaptured: @escaping (CGImage) -> Void = { _ in }
    ) {
        self._stillCaptureNonce = stillCaptureNonce
        self._exposureLockStatus = exposureLockStatus
        self.onStillCaptured = onStillCaptured
        self.onFrameCaptured = onFrameCaptured
    }

    public func makeUIView(context: Context) -> UIView {
        let captureContainerView = UIView(frame: .zero)
        captureContainerView.backgroundColor = .black
        context.coordinator.onFrameReceivedClosure = onFrameCaptured
        context.coordinator.onStillCaptured = onStillCaptured
        context.coordinator.onExposureLockStatus = { exposureLockStatus = $0 }
        context.coordinator.attachPreview(to: captureContainerView)
        context.coordinator.startSessionIfNeeded()
        return captureContainerView
    }

    public func updateUIView(_ uiView: UIView, context: Context) {
        context.coordinator.onFrameReceivedClosure = onFrameCaptured
        context.coordinator.onStillCaptured = onStillCaptured
        context.coordinator.onExposureLockStatus = { exposureLockStatus = $0 }
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
        var visualMaskOverlayLayer: CAShapeLayer?
        var onFrameReceivedClosure: ((CGImage) -> Void)?
        var onStillCaptured: ((Result<StillCapture, Error>) -> Void)?
        var onExposureLockStatus: ((String) -> Void)?
        var lastHandledCaptureNonce: UInt64 = 0

        private let sessionQueue = DispatchQueue(label: "com.cardgrader.camerasession.queue", qos: .userInteractive)
        private let sharedCIContext = CIContext(options: [.useSoftwareRenderer: false])
        private let recordingSession = AVCaptureSession()
        private var photoOutput: AVCapturePhotoOutput?
        private var captureDevice: AVCaptureDevice?
        private var didStartSession = false
        private var didLockExposure = false
        private var captureInFlight = false

        func attachPreview(to container: UIView) {
            let liveVideoPreviewLayer = AVCaptureVideoPreviewLayer(session: recordingSession)
            liveVideoPreviewLayer.videoGravity = .resizeAspectFill
            liveVideoPreviewLayer.frame = container.bounds
            container.layer.addSublayer(liveVideoPreviewLayer)

            let maskOverlayShapeLayer = CAShapeLayer()
            maskOverlayShapeLayer.frame = container.bounds
            maskOverlayShapeLayer.strokeColor = UIColor.systemGreen.cgColor
            maskOverlayShapeLayer.lineWidth = 3.0
            maskOverlayShapeLayer.fillColor = UIColor.systemGreen.withAlphaComponent(0.12).cgColor
            maskOverlayShapeLayer.lineJoin = .round
            container.layer.addSublayer(maskOverlayShapeLayer)

            previewLayerAnchor = liveVideoPreviewLayer
            visualMaskOverlayLayer = maskOverlayShapeLayer
        }

        func layoutPreview(in view: UIView) {
            previewLayerAnchor?.frame = view.bounds
            visualMaskOverlayLayer?.frame = view.bounds
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
            }

            recordingSession.commitConfiguration()
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
                let settings = AVCapturePhotoSettings()
                settings.flashMode = .off
                settings.photoQualityPrioritization = .quality
                photoOutput.capturePhoto(with: settings, delegate: self)
            }
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
            var previewSize = CGSize.zero
            if Thread.isMainThread {
                previewSize = previewLayerAnchor?.bounds.size ?? .zero
            } else {
                previewSize = DispatchQueue.main.sync { previewLayerAnchor?.bounds.size ?? .zero }
            }
            let payload = StillCapture(jpeg: jpeg, previewSize: previewSize)
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

            performLiveCardBoundaryTracing(on: isolatedCGImage)

            DispatchQueue.main.async {
                closureAnchor(isolatedCGImage)
            }
        }

        private func performLiveCardBoundaryTracing(on cgImage: CGImage) {
            let imageRequestHandler = VNImageRequestHandler(cgImage: cgImage, options: [:])
            let rectangleRequest = VNDetectRectanglesRequest { [weak self] request, error in
                guard let self = self,
                      error == nil,
                      let findings = request.results as? [VNRectangleObservation],
                      let localizedCard = findings.first,
                      let overlayLayer = self.visualMaskOverlayLayer,
                      let visualPreview = self.previewLayerAnchor else {
                    DispatchQueue.main.async {
                        self?.visualMaskOverlayLayer?.path = nil
                    }
                    return
                }

                DispatchQueue.main.async {
                    let convertedTopLeft = visualPreview.layerPointConverted(fromCaptureDevicePoint: localizedCard.topLeft)
                    let convertedTopRight = visualPreview.layerPointConverted(fromCaptureDevicePoint: localizedCard.topRight)
                    let convertedBottomLeft = visualPreview.layerPointConverted(fromCaptureDevicePoint: localizedCard.bottomLeft)
                    let convertedBottomRight = visualPreview.layerPointConverted(fromCaptureDevicePoint: localizedCard.bottomRight)

                    let adaptivePath = UIBezierPath()
                    adaptivePath.move(to: convertedTopLeft)
                    adaptivePath.addLine(to: convertedTopRight)
                    adaptivePath.addLine(to: convertedBottomRight)
                    adaptivePath.addLine(to: convertedBottomLeft)
                    adaptivePath.close()

                    overlayLayer.path = adaptivePath.cgPath
                }
            }

            rectangleRequest.minimumAspectRatio = 0.55
            rectangleRequest.maximumAspectRatio = 0.85
            rectangleRequest.minimumConfidence = 0.85

            try? imageRequestHandler.perform([rectangleRequest])
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
                }
            }
        }
    }
}
