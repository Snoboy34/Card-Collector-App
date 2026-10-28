import Foundation
import UIKit
import Vision

/// Full-frame text recognition on the locked-exposure still that is uploaded.
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

        let observations = request.results ?? []
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

/// Outer cut on the upright still, in that JPEG's pixel coordinates
/// (top-left origin). Nil when the cut is missing or a second edge makes it
/// low-confidence; the upload is then the full still and the server detects.
enum CardStillQuad {
    static func detect(in jpeg: Data) -> JudgeAPIClient.CardQuad? {
        guard let source = UIImage(data: jpeg) else { return nil }
        let upright = CardAlignmentCrop.uprightImage(source)
        guard let cgImage = upright.cgImage else { return nil }
        return detect(cgImage: cgImage)
    }

    /// Outer cut only. A low-confidence cut returns nil so the upload stays
    /// the full still instead of cropping inside the card.
    static func detect(cgImage: CGImage, face: CardFaceSize.Millimetres = CardFaceSize.sports) -> JudgeAPIClient.CardQuad? {
        guard let found = OuterCut.find(in: cgImage, face: face), found.confident else { return nil }
        return found.cardQuad()
    }
}
