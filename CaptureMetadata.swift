import Foundation
import AVFoundation
import ImageIO
import UIKit

/// Camera state read at the moment a still was taken. Recorded with the scan
/// (`captureMetadata` upload field); the server stores it and never grades it.
struct CameraFacts {
    var deviceType: String
    var position: String
    var photoWidth: Int?
    var photoHeight: Int?
    var codec: String
    var iso: Double?
    var exposureDurationS: Double?
    var lensPosition: Double?
    var lensAperture: Double?
    var zoomFactor: Double?
    var focusMode: String
    var exposureMode: String
    var whiteBalanceMode: String

    static func read(device: AVCaptureDevice?, photo: AVCapturePhoto, fileData: Data) -> CameraFacts {
        let dims = photo.resolvedSettings.photoDimensions
        let exposure = device.map { CMTimeGetSeconds($0.exposureDuration) }
        return CameraFacts(
            deviceType: device?.deviceType.rawValue ?? "unknown",
            position: device.map { positionName($0.position) } ?? "unknown",
            photoWidth: dims.width > 0 ? Int(dims.width) : nil,
            photoHeight: dims.height > 0 ? Int(dims.height) : nil,
            codec: codecName(fileData),
            iso: device.map { Double($0.iso) },
            exposureDurationS: exposure.flatMap { $0.isFinite ? $0 : nil },
            lensPosition: device.map { Double($0.lensPosition) },
            lensAperture: device.map { Double($0.lensAperture) },
            zoomFactor: device.map { Double($0.videoZoomFactor) },
            focusMode: device.map { focusModeName($0.focusMode) } ?? "unknown",
            exposureMode: device.map { exposureModeName($0.exposureMode) } ?? "unknown",
            whiteBalanceMode: device.map { whiteBalanceModeName($0.whiteBalanceMode) } ?? "unknown"
        )
    }

    /// From the file bytes, not the requested settings: JPEG starts FF D8 FF,
    /// HEIF/HEIC has `ftyp` at offset 4.
    static func codecName(_ data: Data) -> String {
        let bytes = [UInt8](data.prefix(12))
        if bytes.count >= 3, bytes[0] == 0xFF, bytes[1] == 0xD8, bytes[2] == 0xFF { return "jpeg" }
        if bytes.count >= 8, bytes[4] == 0x66, bytes[5] == 0x74, bytes[6] == 0x79, bytes[7] == 0x70 { return "heif" }
        return "unknown"
    }

    static func positionName(_ position: AVCaptureDevice.Position) -> String {
        switch position {
        case .back: return "back"
        case .front: return "front"
        case .unspecified: return "unspecified"
        @unknown default: return "unknown"
        }
    }

    static func focusModeName(_ mode: AVCaptureDevice.FocusMode) -> String {
        switch mode {
        case .locked: return "locked"
        case .autoFocus: return "auto"
        case .continuousAutoFocus: return "continuous"
        @unknown default: return "unknown"
        }
    }

    static func exposureModeName(_ mode: AVCaptureDevice.ExposureMode) -> String {
        switch mode {
        case .locked: return "locked"
        case .autoExpose: return "auto"
        case .continuousAutoExposure: return "continuous"
        case .custom: return "custom"
        @unknown default: return "unknown"
        }
    }

    static func whiteBalanceModeName(_ mode: AVCaptureDevice.WhiteBalanceMode) -> String {
        switch mode {
        case .locked: return "locked"
        case .autoWhiteBalance: return "auto"
        case .continuousAutoWhiteBalance: return "continuous"
        @unknown default: return "unknown"
        }
    }
}

/// Schema-1 JSON for the `captureMetadata` field. Groups stay one level deep
/// (scalars and short scalar arrays only) — the server drops anything deeper,
/// anything outside app/device/camera/capture, and anything over 8 KB.
enum CaptureMetadata {
    static let schema = 1

    static func json(
        camera: CameraFacts?,
        uploadJPEG: Data,
        mode: String,
        capturedAt: Date,
        sweepFrames: Int,
        quad: JudgeAPIClient.CardQuad?,
        extraCamera: [String: Any] = [:]
    ) -> String? {
        let object = payload(
            camera: camera,
            uploadJPEG: uploadJPEG,
            mode: mode,
            capturedAt: capturedAt,
            sweepFrames: sweepFrames,
            quad: quad,
            extraCamera: extraCamera
        )
        guard JSONSerialization.isValidJSONObject(object),
              let data = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]),
              data.count <= 8 * 1024 else { return nil }
        return String(data: data, encoding: .utf8)
    }

    static func payload(
        camera: CameraFacts?,
        uploadJPEG: Data,
        mode: String,
        capturedAt: Date,
        sweepFrames: Int,
        quad: JudgeAPIClient.CardQuad?,
        extraCamera: [String: Any] = [:]
    ) -> [String: Any] {
        let info = Bundle.main.infoDictionary ?? [:]
        var app: [String: Any] = [:]
        app["version"] = info["CFBundleShortVersionString"] as? String
        app["build"] = info["CFBundleVersion"] as? String
        app["bundleId"] = Bundle.main.bundleIdentifier

        let device: [String: Any] = [
            "model": hardwareModel(),
            "systemName": UIDevice.current.systemName,
            "systemVersion": UIDevice.current.systemVersion
        ]

        var cam: [String: Any] = [:]
        if let camera {
            cam["deviceType"] = camera.deviceType
            cam["position"] = camera.position
            cam["photoWidth"] = camera.photoWidth
            cam["photoHeight"] = camera.photoHeight
            cam["codec"] = camera.codec
            cam["iso"] = camera.iso.map(round3)
            cam["exposureDurationS"] = camera.exposureDurationS.map { ($0 * 1_000_000).rounded() / 1_000_000 }
            cam["lensPosition"] = camera.lensPosition.map(round3)
            cam["lensAperture"] = camera.lensAperture.map(round3)
            cam["zoomFactor"] = camera.zoomFactor.map(round3)
            cam["focusMode"] = camera.focusMode
            cam["exposureMode"] = camera.exposureMode
            cam["whiteBalanceMode"] = camera.whiteBalanceMode
        }
        for (key, value) in extraCamera { cam[key] = value }

        var capture: [String: Any] = [
            "mode": mode,
            "capturedAt": ISO8601DateFormatter().string(from: capturedAt),
            "uploadBytes": uploadJPEG.count,
            "uploadCodec": CameraFacts.codecName(uploadJPEG),
            "cropJpegQuality": Double(CardAlignmentCrop.jpegQuality),
            "sweepFrames": sweepFrames,
            "quadDetected": quad != nil
        ]
        if let size = pixelSize(uploadJPEG) {
            capture["uploadWidth"] = size.width
            capture["uploadHeight"] = size.height
        }
        if let quad { capture["quadConfidence"] = round3(quad.confidence) }

        var root: [String: Any] = ["schema": schema, "app": app, "device": device, "capture": capture]
        if !cam.isEmpty { root["camera"] = cam }
        return root
    }

    /// e.g. "iPhone15,2" — the marketing name is not available on device.
    static func hardwareModel() -> String {
        var info = utsname()
        uname(&info)
        let mirror = Mirror(reflecting: info.machine)
        let bytes = mirror.children.compactMap { $0.value as? Int8 }.prefix(while: { $0 != 0 }).map { UInt8(bitPattern: $0) }
        let text = String(decoding: bytes, as: UTF8.self)
        return text.isEmpty ? "unknown" : text
    }

    static func pixelSize(_ data: Data) -> (width: Int, height: Int)? {
        guard let source = CGImageSourceCreateWithData(data as CFData, nil),
              let props = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
              let w = props[kCGImagePropertyPixelWidth] as? Int,
              let h = props[kCGImagePropertyPixelHeight] as? Int else { return nil }
        let orientation = props[kCGImagePropertyOrientation] as? Int ?? 1
        return orientation >= 5 ? (h, w) : (w, h)
    }

    private static func round3(_ value: Double) -> Double {
        (value * 1000).rounded() / 1000
    }

    #if DEBUG
    static func runContractChecks() {
        precondition(CameraFacts.codecName(Data([0xFF, 0xD8, 0xFF, 0xE0])) == "jpeg")
        precondition(CameraFacts.codecName(Data([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63])) == "heif")
        precondition(CameraFacts.codecName(Data([0x89, 0x50])) == "unknown")

        let facts = CameraFacts(
            deviceType: "AVCaptureDeviceTypeBuiltInWideAngleCamera", position: "back",
            photoWidth: 4032, photoHeight: 3024, codec: "jpeg",
            iso: 64.0, exposureDurationS: 0.0166666, lensPosition: 0.8123, lensAperture: 1.78,
            zoomFactor: 1.0, focusMode: "continuous", exposureMode: "locked", whiteBalanceMode: "locked"
        )
        let body = payload(
            camera: facts, uploadJPEG: Data([0xFF, 0xD8, 0xFF]), mode: "native-sweep",
            capturedAt: Date(timeIntervalSince1970: 0), sweepFrames: 4, quad: nil,
            extraCamera: ["photoSizeSetting": "12mp"]
        )
        precondition(body["schema"] as? Int == 1)
        let cam = body["camera"] as? [String: Any]
        precondition(cam?["photoWidth"] as? Int == 4032)
        precondition(cam?["iso"] as? Double == 64.0)
        precondition(cam?["exposureDurationS"] as? Double == 0.016667)
        precondition(cam?["photoSizeSetting"] as? String == "12mp")
        let capture = body["capture"] as? [String: Any]
        precondition(capture?["mode"] as? String == "native-sweep")
        precondition(capture?["capturedAt"] as? String == "1970-01-01T00:00:00Z")
        precondition(capture?["quadDetected"] as? Bool == false)
        precondition(capture?["quadConfidence"] == nil)
        precondition(capture?["uploadWidth"] == nil)
        for (_, group) in body {
            guard let group = group as? [String: Any] else { continue }
            for (_, value) in group {
                precondition(!(value is [String: Any]), "captureMetadata groups must stay flat")
            }
        }
        let noCamera = payload(camera: nil, uploadJPEG: Data(), mode: "native-still",
                               capturedAt: Date(), sweepFrames: 0, quad: nil)
        precondition(noCamera["camera"] == nil)
        precondition(json(camera: facts, uploadJPEG: Data([0xFF, 0xD8, 0xFF]), mode: "native-still",
                          capturedAt: Date(), sweepFrames: 0, quad: nil) != nil)
    }
    #endif
}
