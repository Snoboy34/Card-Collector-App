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
