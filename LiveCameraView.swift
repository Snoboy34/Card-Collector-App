import SwiftUI
import AVFoundation
import CoreImage
import Vision

public struct LiveCameraView: UIViewRepresentable {
    
    @EnvironmentObject private var calibrationEngine: CameraCalibration
    private let onFrameCaptured: (CGImage) -> Void
    
    public init(onFrameCaptured: @escaping (CGImage) -> Void = { _ in }) {
        self.onFrameCaptured = onFrameCaptured
    }
    
    public func makeUIView(context: Context) -> UIView {
        let captureContainerView = UIView(frame: .zero)
        captureContainerView.backgroundColor = .black
        
        let cameraSessionQueue = DispatchQueue(label: "com.cardgrader.camerasession.queue", qos: .userInteractive)
        
        cameraSessionQueue.async {
            let recordingSession = AVCaptureSession()
            recordingSession.sessionPreset = .photo
            
            guard let primaryBackCamera = AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: .back),
                  let hardwareInputNode = try? AVCaptureDeviceInput(device: primaryBackCamera) else {
                print("Failed to acquire connection to rear camera hardware.")
                return
            }
            
            if recordingSession.canAddInput(hardwareInputNode) {
                recordingSession.addInput(hardwareInputNode)
            }
            
            let frameBufferOutput = AVCaptureVideoDataOutput()
            frameBufferOutput.alwaysDiscardsLateVideoFrames = true
            frameBufferOutput.setSampleBufferDelegate(context.coordinator, queue: cameraSessionQueue)
            
            if recordingSession.canAddOutput(frameBufferOutput) {
                recordingSession.addOutput(frameBufferOutput)
                if let connection = frameBufferOutput.connection(with: .video) {
                    if connection.isVideoRotationAngleSupported(90.0) {
                        connection.videoRotationAngle = 90.0
                    }
                }
            }
            
            DispatchQueue.main.async {
                let liveVideoPreviewLayer = AVCaptureVideoPreviewLayer(session: recordingSession)
                liveVideoPreviewLayer.frame = captureContainerView.bounds
                liveVideoPreviewLayer.videoGravity = .resizeAspectFill
                captureContainerView.layer.addSublayer(liveVideoPreviewLayer)
                
                let maskOverlayShapeLayer = CAShapeLayer()
                maskOverlayShapeLayer.frame = captureContainerView.bounds
                maskOverlayShapeLayer.strokeColor = UIColor.systemGreen.cgColor
                maskOverlayShapeLayer.lineWidth = 3.0
                maskOverlayShapeLayer.fillColor = UIColor.systemGreen.withAlphaComponent(0.12).cgColor
                maskOverlayShapeLayer.lineJoin = .round
                captureContainerView.layer.addSublayer(maskOverlayShapeLayer)
                
                context.coordinator.previewLayerAnchor = liveVideoPreviewLayer
                context.coordinator.visualMaskOverlayLayer = maskOverlayShapeLayer
                context.coordinator.onFrameReceivedClosure = self.onFrameCaptured
                
                cameraSessionQueue.async {
                    recordingSession.startRunning()
                }
            }
        }
        
        return captureContainerView
    }
    
    public func updateUIView(_ uiView: UIView, context: Context) {
        DispatchQueue.main.async {
            if let targetLayer = context.coordinator.previewLayerAnchor,
               let targetMask = context.coordinator.visualMaskOverlayLayer {
                targetLayer.frame = uiView.bounds
                targetMask.frame = uiView.bounds
            }
        }
    }
    
    public func makeCoordinator() -> Coordinator {
        Coordinator()
    }
    
    // MARK: - Core Video Thread Frame Sample Buffer Interceptor Pipeline
    public class Coordinator: NSObject, AVCaptureVideoDataOutputSampleBufferDelegate {
        var previewLayerAnchor: AVCaptureVideoPreviewLayer?
        var visualMaskOverlayLayer: CAShapeLayer?
        var onFrameReceivedClosure: ((CGImage) -> Void)?
        
        private let sharedCIContext = CIContext(options: [.useSoftwareRenderer: false])
        
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
                    // Map normalization points smoothly over to your physical display pixels
                    let convertedTopLeft = visualPreview.layerPointConverted(fromCaptureDevicePoint: localizedCard.topLeft)
                    let convertedTopRight = visualPreview.layerPointConverted(fromCaptureDevicePoint: localizedCard.topRight)
                    let convertedBottomLeft = visualPreview.layerPointConverted(fromCaptureDevicePoint: localizedCard.bottomLeft)
                    let convertedBottomRight = visualPreview.layerPointConverted(fromCaptureDevicePoint: localizedCard.bottomRight)
                    
                    // Generate a vector line path connecting the four physical corners
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
    }
}
