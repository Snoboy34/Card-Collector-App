import UIKit

/// Fixed 2.5×3.5 neon-window geometry, ported from `public/scan_level.js`
/// (`cardFrameRect`, `videoCoverCrop`, `alignmentCropInVideo`) on the Node stack.
///
/// The still JPEG is cropped to this window before `POST /api/grade` so the
/// bytes match the Safari alignment-crop contract (`alignmentCrop=true`).
/// Vision quads are not used here — foil/glare makes them less stable than
/// the fixed overlay the operator already fills.
enum CardAlignmentCrop {
    static let cardAspect: CGFloat = 2.5 / 3.5
    static let jpegQuality: CGFloat = 0.92

    struct PixelRect: Equatable {
        var x: CGFloat
        var y: CGFloat
        var w: CGFloat
        var h: CGFloat

        var cgRect: CGRect { CGRect(x: x, y: y, width: w, height: h) }
    }

    static func cardFrameRect(canvasWidth: CGFloat, canvasHeight: CGFloat) -> PixelRect {
        let pad = min(canvasWidth, canvasHeight) * 0.08
        var h = canvasHeight - pad * 2
        var w = h * cardAspect
        if w > canvasWidth - pad * 2 {
            w = canvasWidth - pad * 2
            h = w / cardAspect
        }
        return PixelRect(
            x: (canvasWidth - w) / 2,
            y: (canvasHeight - h) / 2,
            w: w,
            h: h
        )
    }

    static func videoCoverCrop(videoW: CGFloat, videoH: CGFloat, viewW: CGFloat, viewH: CGFloat) -> PixelRect {
        let srcAspect = videoW / videoH
        let viewAspect = viewW / viewH
        if srcAspect > viewAspect {
            let cropW = videoH * viewAspect
            return PixelRect(x: (videoW - cropW) / 2, y: 0, w: cropW, h: videoH)
        }
        let cropH = videoW / viewAspect
        return PixelRect(x: 0, y: (videoH - cropH) / 2, w: videoW, h: cropH)
    }

    static func alignmentCropInVideo(videoW: CGFloat, videoH: CGFloat, viewW: CGFloat, viewH: CGFloat) -> PixelRect? {
        guard videoW > 0, videoH > 0, viewW > 0, viewH > 0 else { return nil }
        let cover = videoCoverCrop(videoW: videoW, videoH: videoH, viewW: viewW, viewH: viewH)
        let frame = cardFrameRect(canvasWidth: viewW, canvasHeight: viewH)
        return PixelRect(
            x: cover.x + (frame.x / viewW) * cover.w,
            y: cover.y + (frame.y / viewH) * cover.h,
            w: (frame.w / viewW) * cover.w,
            h: (frame.h / viewH) * cover.h
        )
    }

    /// Crops a camera JPEG to the neon window as seen in `previewSize` (aspect-fill).
    static func cropJPEG(_ data: Data, previewSize: CGSize) throws -> Data {
        guard previewSize.width > 0, previewSize.height > 0 else {
            throw CropError.previewNotLaidOut
        }
        guard let source = UIImage(data: data) else {
            throw CropError.undecodableJPEG
        }
        let upright = uprightImage(source)
        let pixelSize = CGSize(
            width: upright.size.width * upright.scale,
            height: upright.size.height * upright.scale
        )
        guard let crop = alignmentCropInVideo(
            videoW: pixelSize.width,
            videoH: pixelSize.height,
            viewW: previewSize.width,
            viewH: previewSize.height
        ) else {
            throw CropError.invalidGeometry
        }
        guard let cgImage = upright.cgImage else {
            throw CropError.missingCGImage
        }
        let integral = clampedIntegralRect(crop.cgRect, in: CGSize(width: cgImage.width, height: cgImage.height))
        guard integral.width >= 8, integral.height >= 8, let cut = cgImage.cropping(to: integral) else {
            throw CropError.cropFailed
        }
        let cropped = UIImage(cgImage: cut, scale: 1, orientation: .up)
        guard let jpeg = cropped.jpegData(compressionQuality: jpegQuality) else {
            throw CropError.jpegEncodeFailed
        }
        return jpeg
    }

    enum CropError: LocalizedError {
        case previewNotLaidOut
        case undecodableJPEG
        case invalidGeometry
        case missingCGImage
        case cropFailed
        case jpegEncodeFailed

        var errorDescription: String? {
            switch self {
            case .previewNotLaidOut: return "Preview layer has no size yet — wait for the viewfinder."
            case .undecodableJPEG: return "PhotoOutput did not return a decodable JPEG."
            case .invalidGeometry: return "Could not map the 2.5×3.5 window onto the still."
            case .missingCGImage: return "Upright still has no CGImage."
            case .cropFailed: return "Neon-window crop failed."
            case .jpegEncodeFailed: return "Failed to re-encode the cropped JPEG."
            }
        }
    }

    static func uprightImage(_ image: UIImage) -> UIImage {
        if image.imageOrientation == .up { return image }
        let format = UIGraphicsImageRendererFormat.default()
        format.scale = image.scale
        format.opaque = true
        let renderer = UIGraphicsImageRenderer(size: image.size, format: format)
        return renderer.image { _ in
            image.draw(in: CGRect(origin: .zero, size: image.size))
        }
    }

    static func clampedIntegralRect(_ rect: CGRect, in size: CGSize) -> CGRect {
        let bounds = CGRect(origin: .zero, size: size)
        let intersection = rect.intersection(bounds).integral
        return intersection
    }
}
