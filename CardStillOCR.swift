import Foundation
import UIKit
import Vision

/// Full-frame text recognition on a locked-exposure still JPEG (neon-cropped).
/// This is not the live `/`-only scanner in `CenteringAnalyzer`.
enum CardStillOCR {
    static func recognizeLines(from jpeg: Data) throws -> [String] {
        guard let source = UIImage(data: jpeg) else { return [] }
        let upright = CardAlignmentCrop.uprightImage(source)
        guard let cgImage = upright.cgImage else { return [] }

        let request = VNRecognizeTextRequest()
        request.recognitionLevel = .accurate
        request.usesLanguageCorrection = false
        request.recognitionLanguages = ["en-US"]

        let handler = VNImageRequestHandler(cgImage: cgImage, options: [:])
        try handler.perform([request])

        let observations = (request.results as? [VNRecognizedTextObservation]) ?? []
        let sorted = observations.sorted { $0.boundingBox.origin.y > $1.boundingBox.origin.y }
        var lines: [String] = []
        for observation in sorted {
            guard let text = observation.topCandidates(1).first?.string else { continue }
            let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
            if !trimmed.isEmpty {
                lines.append(trimmed)
            }
        }
        return lines
    }
}

/// Vision rectangle on the same upright still that is uploaded, so the quad
/// is in that JPEG's pixel coordinates (top-left origin). Nil when Vision
/// finds no card; the server then runs its own detector or returns 422.
enum CardStillQuad {
    static func detect(in jpeg: Data) -> JudgeAPIClient.CardQuad? {
        guard let source = UIImage(data: jpeg) else { return nil }
        let upright = CardAlignmentCrop.uprightImage(source)
        guard let cgImage = upright.cgImage else { return nil }

        let request = VNDetectRectanglesRequest()
        request.minimumAspectRatio = 0.55
        request.maximumAspectRatio = 0.85
        request.minimumConfidence = 0.8
        request.minimumSize = 0.3
        request.maximumObservations = 1

        let handler = VNImageRequestHandler(cgImage: cgImage, options: [:])
        do {
            try handler.perform([request])
        } catch {
            return nil
        }
        guard let rect = (request.results as? [VNRectangleObservation])?.first else { return nil }

        let width = Double(cgImage.width)
        let height = Double(cgImage.height)
        func pixel(_ point: CGPoint) -> [Double] {
            [Double(point.x) * width, (1.0 - Double(point.y)) * height]
        }
        return JudgeAPIClient.CardQuad(
            tl: pixel(rect.topLeft),
            tr: pixel(rect.topRight),
            br: pixel(rect.bottomRight),
            bl: pixel(rect.bottomLeft),
            imageWidth: cgImage.width,
            imageHeight: cgImage.height,
            confidence: Double(rect.confidence)
        )
    }
}
