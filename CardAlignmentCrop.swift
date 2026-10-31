import UIKit

/// On-screen 2.5×3.5 frame, the same shape as `cardFrameRect` in
/// `public/scan_level.js`. It is a composition aid. The upload is the upright
/// full still. The server finds the cut.
enum CardAlignmentCrop {
    static let cardAspect: CGFloat = 2.5 / 3.5
    static let jpegQuality: CGFloat = 0.92
    /// Extra still pixels on each side of the quad, as a fraction of that
    /// side's card span. Background stays in the upload. The crop is not resized.
    static let quadMarginFraction: Double = 0.08

    struct QuadCrop {
        var jpeg: Data
        var quad: JudgeAPIClient.CardQuad?
    }

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

    /// Axis-aligned crop around the quad, expanded by `quadMarginFraction`
    /// and clamped to the still. Integer pixels, no scale.
    static func marginRect(corners: [(Double, Double)], imageWidth: Int, imageHeight: Int, marginFraction: Double = quadMarginFraction) -> CGRect? {
        guard imageWidth > 1, imageHeight > 1, corners.count == 4 else { return nil }
        let xs = corners.map(\.0)
        let ys = corners.map(\.1)
        guard let minX = xs.min(), let maxX = xs.max(), let minY = ys.min(), let maxY = ys.max() else { return nil }
        let spanX = maxX - minX
        let spanY = maxY - minY
        guard spanX > 8, spanY > 8 else { return nil }
        let padX = spanX * marginFraction
        let padY = spanY * marginFraction
        let raw = CGRect(
            x: minX - padX,
            y: minY - padY,
            width: spanX + padX * 2,
            height: spanY + padY * 2
        )
        let integral = clampedIntegralRect(raw, in: CGSize(width: imageWidth, height: imageHeight))
        guard integral.width >= 32, integral.height >= 32 else { return nil }
        return integral
    }

    static func shiftedQuad(_ quad: JudgeAPIClient.CardQuad, originX: Double, originY: Double, imageWidth: Int, imageHeight: Int) -> JudgeAPIClient.CardQuad? {
        func shift(_ point: [Double]) -> [Double]? {
            guard point.count == 2 else { return nil }
            return [point[0] - originX, point[1] - originY]
        }
        guard let tl = shift(quad.tl), let tr = shift(quad.tr), let br = shift(quad.br), let bl = shift(quad.bl) else {
            return nil
        }
        return JudgeAPIClient.CardQuad(
            tl: tl, tr: tr, br: br, bl: bl,
            imageWidth: imageWidth, imageHeight: imageHeight,
            confidence: quad.confidence
        )
    }

    /// Upright full still, with no crop. An already-upright JPEG is returned
    /// unchanged. The server measures the cut from these pixels.
    static func uprightJPEG(_ data: Data) throws -> Data {
        guard let source = UIImage(data: data) else { throw CropError.undecodableJPEG }
        if source.imageOrientation == .up { return data }
        let upright = uprightImage(source)
        guard let jpeg = upright.jpegData(compressionQuality: jpegQuality) else { throw CropError.jpegEncodeFailed }
        return jpeg
    }

    /// Quad plus margin from the full still, in the still's own pixels.
    /// No quad: the upright full still, so the server can detect the card.
    /// The capture path does not call this. The upload is `uprightJPEG`.
    static func cropToQuadMargin(_ data: Data, face: CardFaceSize.Millimetres = CardFaceSize.sports) throws -> QuadCrop {
        guard let source = UIImage(data: data) else { throw CropError.undecodableJPEG }
        let upright = uprightImage(source)
        guard let cgImage = upright.cgImage else { throw CropError.missingCGImage }
        guard let quad = CardStillQuad.detect(cgImage: cgImage, face: face) else {
            if source.imageOrientation == .up { return QuadCrop(jpeg: data, quad: nil) }
            guard let jpeg = upright.jpegData(compressionQuality: jpegQuality) else { throw CropError.jpegEncodeFailed }
            return QuadCrop(jpeg: jpeg, quad: nil)
        }
        let corners = [quad.tl, quad.tr, quad.br, quad.bl].compactMap { point -> (Double, Double)? in
            guard point.count == 2 else { return nil }
            return (point[0], point[1])
        }
        guard let rect = marginRect(corners: corners, imageWidth: cgImage.width, imageHeight: cgImage.height),
              let cut = cgImage.cropping(to: rect),
              let shifted = shiftedQuad(quad, originX: rect.origin.x, originY: rect.origin.y, imageWidth: cut.width, imageHeight: cut.height) else {
            guard let jpeg = upright.jpegData(compressionQuality: jpegQuality) else { throw CropError.jpegEncodeFailed }
            return QuadCrop(jpeg: jpeg, quad: nil)
        }
        let cropped = UIImage(cgImage: cut, scale: 1, orientation: .up)
        guard let jpeg = cropped.jpegData(compressionQuality: jpegQuality) else { throw CropError.jpegEncodeFailed }
        return QuadCrop(jpeg: jpeg, quad: shifted)
    }

    enum CropError: LocalizedError {
        case undecodableJPEG
        case missingCGImage
        case jpegEncodeFailed

        var errorDescription: String? {
            switch self {
            case .undecodableJPEG: return "PhotoOutput did not return a decodable JPEG."
            case .missingCGImage: return "Upright still has no CGImage."
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

    #if DEBUG
    static func runContractChecks(_ check: ContractCheck) {
        func expect(_ condition: @autoclosure () -> Bool, _ message: @autoclosure () -> String, file: StaticString = #filePath, line: UInt = #line) {
            check(condition(), message(), file, line)
        }
        // 11 cm on this phone: card about 1907×2670 inside a 3024×4032 still.
        let cardW = 1907.0
        let cardH = 2670.0
        let imageW = 3024
        let imageH = 4032
        let minX = (Double(imageW) - cardW) / 2
        let minY = (Double(imageH) - cardH) / 2
        let corners = [
            (minX, minY),
            (minX + cardW, minY),
            (minX + cardW, minY + cardH),
            (minX, minY + cardH)
        ]
        guard let rect = marginRect(corners: corners, imageWidth: imageW, imageHeight: imageH) else {
            expect(false, "the quad margin rect exists")
            return
        }
        expect(rect.width > 1748 && rect.height > 2448, "the quad margin is larger than the old 1748×2448 window")
        expect(rect.width < CGFloat(imageW) && rect.height < CGFloat(imageH), "the margin still leaves the still's own bounds")
        expect(rect.minX < minX && rect.minY < minY, "the crop keeps background above and left of the card")
        expect(rect.maxX > minX + cardW && rect.maxY > minY + cardH, "the crop keeps background below and right of the card")
        expect(!(rect.width == 1748 && rect.height == 2448), "the upload rect is not the neon window")
        let quad = JudgeAPIClient.CardQuad(
            tl: [minX, minY], tr: [minX + cardW, minY], br: [minX + cardW, minY + cardH], bl: [minX, minY + cardH],
            imageWidth: imageW, imageHeight: imageH, confidence: 0.9
        )
        let shifted = shiftedQuad(quad, originX: rect.origin.x, originY: rect.origin.y, imageWidth: Int(rect.width), imageHeight: Int(rect.height))
        expect(shifted?.imageWidth == Int(rect.width) && shifted?.imageHeight == Int(rect.height), "the quad's image size is the cropped still")
        expect((shifted?.tl.first ?? 0) > 1 && (shifted?.tl.dropFirst().first ?? 0) > 1, "the shifted quad sits inside the margin")
        expect(shiftedQuad(quad, originX: 0, originY: 0, imageWidth: 1, imageHeight: 1)?.tl == [minX, minY], "a zero origin leaves the quad where it was")
    }
    #endif
}
