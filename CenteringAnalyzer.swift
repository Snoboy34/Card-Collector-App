import Foundation
import CoreGraphics
import Vision
import UIKit

public struct CenteringResult {
    public let leftRightRatio: (left: Double, right: Double)
    public let topBottomRatio: (top: Double, bottom: Double)
    public let passesPSA10: Bool
    public let passesBGS10: Bool
}

// NEW: per-edge diagnostic snapshot. This is the "see the raw measurements" instrumentation
// requested to debug the L/R inconsistency — since Swift Playgrounds has no Xcode console,
// this is designed to be read directly from the UI (via `lastDiagnostics` /
// `diagnosticsSummaryText` below) rather than printed to a log you can't see on-device.
public struct EdgeDiagnostic {
    public let edge: String
    /// The final sub-pixel border position this edge resolved to (median across sample
    /// lines), or nil if not enough sample lines detected a border to produce a reading.
    public let borderPosition: Double?
    /// Average of the local brightness range (max-min within the ~60px local window) across
    /// the sample lines that succeeded for this edge. Low values mean a low-contrast/flat
    /// border-to-art transition; high values mean a sharp one.
    public let averageLocalContrastRange: Int
    /// Average of the adaptive divergence threshold actually used, derived from the local
    /// contrast range above (floored at 12, capped at 50).
    public let averageAdaptiveThreshold: Int
    /// Average baseline brightness (the border's own color) across successful sample lines.
    public let averageBaseline: Int
    /// One entry per sample line attempted for this edge (7 by default), in scan order.
    /// nil means that specific sample line failed to find a sustained divergence at all.
    /// Seeing which specific lines failed/succeeded, and how much they disagree with each
    /// other, is the key signal for telling apart "glare confusing detection on some lines"
    /// vs. "the card was genuinely repositioned."
    public let sampleLineResults: [Double?]
}

public struct CenteringDiagnostics {
    public let left: EdgeDiagnostic
    public let right: EdgeDiagnostic
    public let top: EdgeDiagnostic
    public let bottom: EdgeDiagnostic
    public let timestamp: Date
}

public class CenteringAnalyzer {
    
    public init() {}
    
    // MARK: - Multi-Frame Averaging State
    // Rolling buffer of recent single-frame centering readings. Averaging (median) across
    // several frames is what actually kills frame-to-frame swing — a single frame is noisy
    // (lighting flicker, sensor noise, micro-shake); several frames held over ~1-2 seconds
    // converge on the card's true centering.
    private var recentSamples: [CenteringResult] = []
    private let maxSampleBufferSize = 8
    private let minimumSamplesForStableReading = 4
    // If a new single-frame reading differs from the current running median by more than
    // this many percentage points, treat it as the card having moved/been repositioned
    // (not just noise) and start the buffer over rather than blending it in.
    private let outlierRejectionThreshold = 20.0
    
    // NEW: tracks the raw detected card corners from the previous frame. FIXED: averaging
    // alone only proves several frames' MEASURED PERCENTAGES agree with each other — it does
    // NOT prove the card had actually stopped moving. If the card is still being slid into
    // place, several consecutive frames can happen to agree while genuinely capturing the
    // card at different real positions on different scans, which looked exactly like what
    // was reported: "didn't seem the card was even lined up before it captured and moved
    // on." This tracks the card's actual detected corner positions frame-to-frame and only
    // lets a sample into the buffer if the card was physically stationary — a much stronger,
    // more honest signal that the user has actually finished positioning it.
    private var lastObservedCorners: (topLeft: CGPoint, topRight: CGPoint, bottomLeft: CGPoint, bottomRight: CGPoint)?
    // Normalized-coordinate (0...1) tolerance for corner movement between frames. Vision's
    // rectangle corners are in normalized image coordinates, so this is roughly "the card
    // outline moved by more than ~1.5% of the frame's width/height since the last frame."
    private let positionStabilityThreshold: CGFloat = 0.015
    
    // FIXED (crash/lockup root cause): the buffer above is written to from the camera's
    // background Vision-processing thread (via analyzeCenteringAveraged, called from
    // processLiveCameraFrame's Task) AND cleared from the main thread (resetSampleBuffer,
    // called on commit/reset). Two threads mutating the same array with no coordination is
    // a data race — this is almost certainly what caused the intermittent crashes/lockups
    // after saving to Vault. All access to recentSamples now goes through this serial queue
    // so reads and writes can never overlap, regardless of which thread calls in.
    private let bufferAccessQueue = DispatchQueue(label: "com.thejudge.centeringanalyzer.bufferqueue")
    
    // NEW: separate serial queue guarding the diagnostics snapshot, so reading diagnostics
    // from the UI thread never contends with the buffer lock above.
    private let diagnosticsAccessQueue = DispatchQueue(label: "com.thejudge.centeringanalyzer.diagnosticsqueue")
    private var _lastDiagnostics: CenteringDiagnostics?
    
    /// The most recent per-edge diagnostic snapshot, safe to read from the UI thread at any
    /// time (e.g. to drive a small debug overlay/Text view in the scanner screen). Updated
    /// on every call to `analyzeCenteringReal`, including frames that ultimately fail — so
    /// you can see WHY a frame failed, not just that it did.
    public var lastDiagnostics: CenteringDiagnostics? {
        diagnosticsAccessQueue.sync { _lastDiagnostics }
    }
    
    private func setLastDiagnostics(_ diagnostics: CenteringDiagnostics) {
        diagnosticsAccessQueue.sync { _lastDiagnostics = diagnostics }
    }
    
    /// Human-readable multi-line dump of the last diagnostics snapshot, meant to be dropped
    /// straight into a Text() view in the scanner UI. This is the on-device substitute for
    /// print-statement debugging, since Swift Playgrounds builds run via TestFlight with no
    /// attached Xcode console.
    public var diagnosticsSummaryText: String {
        guard let d = lastDiagnostics else { return "No diagnostics captured yet." }
        func line(_ diag: EdgeDiagnostic) -> String {
            let posText = diag.borderPosition.map { String(format: "%.2f", $0) } ?? "FAILED"
            let samplesText = diag.sampleLineResults
                .map { $0.map { String(format: "%.1f", $0) } ?? "x" }
                .joined(separator: ", ")
            return "\(diag.edge.uppercased()): pos=\(posText)  baseline=\(diag.averageBaseline)  localRange=\(diag.averageLocalContrastRange)  threshold=\(diag.averageAdaptiveThreshold)  lines=[\(samplesText)]"
        }
        return [line(d.left), line(d.right), line(d.top), line(d.bottom)].joined(separator: "\n")
    }
    
    /// Call this whenever card detection is lost, the scan phase resets, or a new card
    /// is presented — clears the rolling buffer so old samples don't bleed into a new scan.
    public func resetSampleBuffer() {
        bufferAccessQueue.sync {
            recentSamples.removeAll()
            lastObservedCorners = nil
        }
    }
    
    /// True once enough consistent samples have accumulated that the averaged reading
    /// can be trusted (used to gate the "Lock & Advance" button / auto-advance on the
    /// front-centering phase).
    public var isStableReading: Bool {
        bufferAccessQueue.sync {
            recentSamples.count >= minimumSamplesForStableReading
        }
    }
    
    /// How many consistent samples are currently buffered (0...maxSampleBufferSize).
    /// Useful for showing "Hold steady... 3/4" style progress in the UI.
    public var currentSampleCount: Int {
        bufferAccessQueue.sync {
            recentSamples.count
        }
    }
    
    public func detectCardRectangle(in image: CGImage, completion: @escaping (VNRectangleObservation?) -> Void) {
        let requestHandler = VNImageRequestHandler(cgImage: image, options: [:])
        
        let rectangleRequest = VNDetectRectanglesRequest { request, error in
            guard error == nil,
                  let results = request.results as? [VNRectangleObservation],
                  let primaryCard = results.first else {
                completion(nil)
                return
            }
            completion(primaryCard)
        }
        
        rectangleRequest.minimumAspectRatio = 0.55
        rectangleRequest.maximumAspectRatio = 0.85
        rectangleRequest.minimumConfidence = 0.85
        
        try? requestHandler.perform([rectangleRequest])
    }
    
    public func extractCardIdentifierText(from image: CGImage, cardBoundingBox: VNRectangleObservation, completion: @escaping (String?) -> Void) {
        let requestHandler = VNImageRequestHandler(cgImage: image, options: [:])
        
        let textRequest = VNRecognizeTextRequest { request, error in
            guard error == nil, let textObservations = request.results as? [VNRecognizedTextObservation] else {
                completion(nil)
                return
            }
            
            for observation in textObservations {
                guard let candidateText = observation.topCandidates(1).first?.string else { continue }
                let normalizedText = candidateText.replacingOccurrences(of: " ", with: "")
                if normalizedText.contains("/") {
                    completion(normalizedText)
                    return
                }
            }
            completion(nil)
        }
        
        textRequest.recognitionLevel = .accurate
        textRequest.usesLanguageCorrection = false
        textRequest.regionOfInterest = CGRect(x: 0.0, y: 0.0, width: 1.0, height: 0.15)
        
        try? requestHandler.perform([textRequest])
    }
    
    /// OLD (fake) centering function — kept for reference, no longer used
    public func analyzeCentering(from observation: VNRectangleObservation) -> CenteringResult {
        let absoluteLeftBoundary: Double = Double(observation.topLeft.x)
        let absoluteRightBoundary: Double = 1.0 - Double(observation.topRight.x)
        let absoluteTopBoundary: Double = 1.0 - Double(observation.topLeft.y)
        let absoluteBottomBoundary: Double = Double(observation.bottomLeft.y)
        
        let simulatedArtFrameOffsetLeft: Double = absoluteLeftBoundary + 0.045
        let simulatedArtFrameOffsetRight: Double = absoluteRightBoundary + 0.048
        let simulatedArtFrameOffsetTop: Double = absoluteTopBoundary + 0.051
        let simulatedArtFrameOffsetBottom: Double = absoluteBottomBoundary + 0.050
        
        let leftBorderWidth: Double = simulatedArtFrameOffsetLeft - absoluteLeftBoundary
        let rightBorderWidth: Double = simulatedArtFrameOffsetRight - absoluteRightBoundary
        let totalHorizontalBordersCombined: Double = leftBorderWidth + rightBorderWidth
        
        let leftPercentage: Double = totalHorizontalBordersCombined > 0.0 ? (leftBorderWidth / totalHorizontalBordersCombined) * 100.0 : 50.0
        let rightPercentage: Double = totalHorizontalBordersCombined > 0.0 ? (rightBorderWidth / totalHorizontalBordersCombined) * 100.0 : 50.0
        
        let topBorderWidth: Double = simulatedArtFrameOffsetTop - absoluteTopBoundary
        let bottomBorderWidth: Double = simulatedArtFrameOffsetBottom - absoluteBottomBoundary
        let totalVerticalBordersCombined: Double = topBorderWidth + bottomBorderWidth
        
        let topPercentage: Double = totalVerticalBordersCombined > 0.0 ? (topBorderWidth / totalVerticalBordersCombined) * 100.0 : 50.0
        let bottomPercentage: Double = totalVerticalBordersCombined > 0.0 ? (bottomBorderWidth / totalVerticalBordersCombined) * 100.0 : 50.0
        
        let passesPSA10: Bool = leftPercentage >= 40.0 && leftPercentage <= 60.0 && topPercentage >= 40.0 && topPercentage <= 60.0
        let passesBGS10: Bool = leftPercentage >= 48.0 && leftPercentage <= 52.0 && topPercentage >= 48.0 && topPercentage <= 52.0
        
        return CenteringResult(
            leftRightRatio: (leftPercentage, rightPercentage),
            topBottomRatio: (topPercentage, bottomPercentage),
            passesPSA10: passesPSA10,
            passesBGS10: passesBGS10
        )
    }
    
    /// Internal per-sample-line scan result, now carrying diagnostic detail alongside the
    /// sub-pixel position so findBorderWidth can aggregate it into an EdgeDiagnostic.
    private struct LineScanResult {
        let position: Double
        let baseline: Int
        let localRange: Int
        let adaptiveThreshold: Int
    }
    
    /// NEW (real, improved) SINGLE-FRAME centering function — looks for a SUSTAINED shift in
    /// brightness, not just the single sharpest pixel-to-pixel jump. This avoids getting fooled
    /// by a logo, text, or color block near the edge, which can look like a sharper "border"
    /// than the real, more gradual transition into the card's artwork.
    ///
    /// FIXED: added an orientation lock. Vision reports topLeft/topRight/bottomLeft/bottomRight
    /// in the CAMERA IMAGE's coordinate space, not the card's. If the card (or phone) is held
    /// sideways relative to the card's natural portrait shape, "left border" and "top border"
    /// stop meaning the same physical edges from scan to scan. After perspective correction,
    /// if the corrected image comes out wider than it is tall, we rotate it 90° so every
    /// downstream measurement is always relative to the card's portrait orientation.
    ///
    /// NOTE: for a stable, trustworthy reading (not just a single frame), call
    /// `analyzeCenteringAveraged` instead — it wraps this function with multi-frame median
    /// averaging and outlier rejection.
    ///
    /// FIXED: now returns nil instead of a fallback CenteringResult when the frame can't be
    /// reliably measured (perspective correction failed, image couldn't be rendered, or a
    /// border edge couldn't be detected). Previously these failure cases returned a fake
    /// 50/50 "centered" result, which is indistinguishable from a real measurement to any
    /// caller — nil makes "this frame failed" explicit so it can be skipped instead of
    /// corrupting an average.
    ///
    /// NEW: on every call (success or failure), captures a CenteringDiagnostics snapshot
    /// into `lastDiagnostics` — the raw per-edge sample-line positions, local contrast range,
    /// and adaptive threshold actually used. This is the on-device visibility needed to tell
    /// apart a glare/finish issue from a physical-repositioning issue on the L/R axis.
    public func analyzeCenteringReal(from observation: VNRectangleObservation, in cgImage: CGImage) -> CenteringResult? {
        let ciImage = CIImage(cgImage: cgImage)
        let extent = ciImage.extent
        let topLeft = CGPoint(x: observation.topLeft.x * extent.width, y: observation.topLeft.y * extent.height)
        let topRight = CGPoint(x: observation.topRight.x * extent.width, y: observation.topRight.y * extent.height)
        let bottomLeft = CGPoint(x: observation.bottomLeft.x * extent.width, y: observation.bottomLeft.y * extent.height)
        let bottomRight = CGPoint(x: observation.bottomRight.x * extent.width, y: observation.bottomRight.y * extent.height)
        
        guard let perspectiveFilter = CIFilter(name: "CIPerspectiveCorrection") else { return nil }
        perspectiveFilter.setValue(ciImage, forKey: kCIInputImageKey)
        perspectiveFilter.setValue(CIVector(cgPoint: topLeft), forKey: "inputTopLeft")
        perspectiveFilter.setValue(CIVector(cgPoint: topRight), forKey: "inputTopRight")
        perspectiveFilter.setValue(CIVector(cgPoint: bottomLeft), forKey: "inputBottomLeft")
        perspectiveFilter.setValue(CIVector(cgPoint: bottomRight), forKey: "inputBottomRight")
        
        guard let correctedImage = perspectiveFilter.outputImage else { return nil }
        
        // NEW: orientation lock. A standard trading card is taller than it is wide. If the
        // perspective-corrected result is wider than it is tall, the card was captured
        // sideways — rotate it 90° (always the same direction, for consistency) so "left/
        // right" and "top/bottom" refer to the same physical edges every time regardless of
        // how the phone was held.
        var orientedImage = correctedImage
        let correctedExtent = correctedImage.extent
        if correctedExtent.width > correctedExtent.height {
            let rotated = correctedImage.transformed(by: CGAffineTransform(rotationAngle: -CGFloat.pi / 2))
            orientedImage = rotated.transformed(by: CGAffineTransform(
                translationX: -rotated.extent.origin.x,
                y: -rotated.extent.origin.y
            ))
        }
        
        let context = CIContext()
        guard let correctedCGImage = context.createCGImage(orientedImage, from: orientedImage.extent),
              let pixelData = correctedCGImage.dataProvider?.data,
              let buffer = CFDataGetBytePtr(pixelData) else {
            return nil
        }
        
        let width = correctedCGImage.width
        let height = correctedCGImage.height
        let bytesPerPixel = correctedCGImage.bitsPerPixel / 8
        let bytesPerRow = correctedCGImage.bytesPerRow
        let dataLength = CFDataGetLength(pixelData)
        
        func brightness(x: Int, y: Int) -> Int {
            let offset = y * bytesPerRow + x * bytesPerPixel
            guard offset + 2 < dataLength, offset >= 0 else { return 0 }
            let r = Int(buffer[offset])
            let g = Int(buffer[offset + 1])
            let b = Int(buffer[offset + 2])
            return (r + g + b) / 3
        }
        
        // Finds where brightness SUSTAINABLY diverges from the border's own baseline color,
        // rather than reacting to a single sharp spike.
        //
        // ADAPTIVE (replaces the old fixed divergenceThreshold = 30). A flat constant treats a
        // subtle, low-contrast border-to-art transition (dim ambient light, dark border into
        // dark art) exactly the same as a sharp, high-contrast one (bright light, white border
        // into vivid art) — that mismatch is the dominant driver of the lighting-sensitive
        // run-to-run spread seen in testing: under strong/glare-y lighting the line's real
        // contrast range is large and a threshold of 30 fires too early (on a shadow or
        // reflection near the edge); under flat, dim lighting the range is small and 30 may
        // never fire at all, so the edge fails to detect (or detects very late).
        //
        // Fix: derive the threshold from a LOCAL window of this specific line's own brightness
        // range — near where a real border transition should be — instead of a constant. Using
        // only a local window (not the full half-frame scan) matters: the art on the far side of
        // the border can have its own large brightness swings that have nothing to do with how
        // sharp the border-to-art transition itself is, and would otherwise throw off the
        // estimate. Floor/ceiling keep the result sane at the extremes — a near-flat window
        // (very low local range) won't collapse toward ~0 and start firing on sensor noise, and
        // a very high-contrast window won't demand an unreasonably large jump to register.
        //
        // SUB-PIXEL REFINEMENT: also returns a fractional (Double) position instead of a whole
        // pixel index. On an integer pixel grid, the true physical edge almost never lands
        // exactly on a sample point — rounding to the nearest whole pixel is what produced the
        // coincidental exact ties (e.g. two scans both reading 50.0%/50.0%) seen in testing on
        // axes that are genuinely close to centered but happened to round to the same integer
        // boundary rather than actually being identical. Linearly interpolating between the last
        // pre-crossing sample and the first post-crossing one estimates where the true edge sits
        // between them.
        func scanLineForBorder(edge: String, lineOffset: Int) -> LineScanResult? {
            let scanLength: Int
            switch edge {
            case "left", "right": scanLength = width / 2
            default: scanLength = height / 2
            }
            guard scanLength > 12 else { return nil }
            
            func pixelAt(_ i: Int) -> Int {
                switch edge {
                case "left": return brightness(x: i, y: lineOffset)
                case "right": return brightness(x: width - 1 - i, y: lineOffset)
                case "top": return brightness(x: lineOffset, y: i)
                default: return brightness(x: lineOffset, y: height - 1 - i)
                }
            }
            
            // Precompute the whole brightness profile for this line once. It gets reused for
            // the baseline, the local contrast range, and the threshold-crossing scan below —
            // cheaper than repeatedly calling pixelAt() for each purpose, and it's what makes
            // computing a proper local range practical.
            var profile = [Int](repeating: 0, count: scanLength)
            for i in 0..<scanLength { profile[i] = pixelAt(i) }
            
            // Baseline = average brightness of the first few pixels (the border itself,
            // right at the card's cut edge)
            let baselineSampleCount = 4
            let baseline = profile[0..<baselineSampleCount].reduce(0, +) / baselineSampleCount
            
            let localWindowSize = min(scanLength, 60)
            let localWindow = profile[0..<localWindowSize]
            let localRange = (localWindow.max() ?? baseline) - (localWindow.min() ?? baseline)
            let adaptiveDivergenceThreshold = max(12, min(50, Int(Double(localRange) * 0.2)))
            
            let sustainedRunRequired = 5
            
            var i = baselineSampleCount
            while i < scanLength - sustainedRunRequired {
                let signedDiff = profile[i] - baseline
                if abs(signedDiff) > adaptiveDivergenceThreshold {
                    // Confirm this isn't just a one-pixel blip: check the next several
                    // pixels also diverge from baseline before accepting this as the border
                    var sustained = true
                    for offset in 1...sustainedRunRequired {
                        if abs(profile[i + offset] - baseline) <= adaptiveDivergenceThreshold {
                            sustained = false
                            break
                        }
                    }
                    if sustained {
                        let target = signedDiff > 0
                        ? Double(baseline + adaptiveDivergenceThreshold)
                        : Double(baseline - adaptiveDivergenceThreshold)
                        let previous = Double(profile[i - 1])
                        let current = Double(profile[i])
                        let stepDelta = current - previous
                        let fraction = stepDelta == 0 ? 0.0 : (target - previous) / stepDelta
                        let clampedFraction = max(0.0, min(1.0, fraction))
                        return LineScanResult(
                            position: Double(i - 1) + clampedFraction,
                            baseline: baseline,
                            localRange: localRange,
                            adaptiveThreshold: adaptiveDivergenceThreshold
                        )
                    }
                }
                i += 1
            }
            return nil
        }
        
        // FIXED: previously returned a fixed default of 12 when no sustained divergence was
        // found on any sample line for this edge — which silently produced a fake "perfectly
        // centered" 50/50 reading whenever BOTH left and right failed to detect (12/(12+12)
        // = 50.0%). That's a detection failure disguised as data, not a real measurement.
        // Returning nil instead lets the caller treat this as "couldn't measure this frame"
        // and skip it, rather than quietly injecting a misleading centered value.
        //
        // NEW: also builds and returns the EdgeDiagnostic for this edge, so every sample
        // line's individual result (or failure) is visible, not just the final median width.
        func findBorderWidth(edge: String) -> (width: Double?, diagnostic: EdgeDiagnostic)? {
            let sampleCount = 7
            let dimension = (edge == "left" || edge == "right") ? height : width
            let margin = dimension / 4
            var lineResults: [LineScanResult?] = []
            
            for sample in 0..<sampleCount {
                let position = margin + (sample * (dimension - 2 * margin) / (sampleCount - 1))
                lineResults.append(scanLineForBorder(edge: edge, lineOffset: position))
            }
            
            let successfulResults = lineResults.compactMap { $0 }
            let positions = successfulResults.map { $0.position }.sorted()
            
            let medianWidth: Double?
            if positions.isEmpty {
                medianWidth = nil
            } else {
                // Proper median now that samples are continuous Doubles (not whole pixels):
                // for an even sample count, average the two middle values instead of
                // picking one arbitrarily.
                let mid = positions.count / 2
                medianWidth = positions.count % 2 == 0
                    ? (positions[mid - 1] + positions[mid]) / 2.0
                    : positions[mid]
            }
            
            let avgBaseline = successfulResults.isEmpty ? 0 : successfulResults.map { $0.baseline }.reduce(0, +) / successfulResults.count
            let avgLocalRange = successfulResults.isEmpty ? 0 : successfulResults.map { $0.localRange }.reduce(0, +) / successfulResults.count
            let avgThreshold = successfulResults.isEmpty ? 0 : successfulResults.map { $0.adaptiveThreshold }.reduce(0, +) / successfulResults.count
            
            let diagnostic = EdgeDiagnostic(
                edge: edge,
                borderPosition: medianWidth,
                averageLocalContrastRange: avgLocalRange,
                averageAdaptiveThreshold: avgThreshold,
                averageBaseline: avgBaseline,
                sampleLineResults: lineResults.map { $0?.position }
            )
            
            return (medianWidth, diagnostic)
        }
        
        let leftResult = findBorderWidth(edge: "left")
        let rightResult = findBorderWidth(edge: "right")
        let topResult = findBorderWidth(edge: "top")
        let bottomResult = findBorderWidth(edge: "bottom")
        
        // Capture diagnostics regardless of whether the overall frame succeeds or fails, so
        // a failed frame's per-edge detail is still visible on-device.
        if let leftResult, let rightResult, let topResult, let bottomResult {
            setLastDiagnostics(CenteringDiagnostics(
                left: leftResult.diagnostic,
                right: rightResult.diagnostic,
                top: topResult.diagnostic,
                bottom: bottomResult.diagnostic,
                timestamp: Date()
            ))
        }
        
        // FIXED: if ANY edge failed to detect a border, this frame can't produce a trustworthy
        // centering reading at all — bail out entirely (return nil) rather than computing a
        // percentage from a mix of real and fabricated widths.
        guard let leftBorder = leftResult?.width,
              let rightBorder = rightResult?.width,
              let topBorder = topResult?.width,
              let bottomBorder = bottomResult?.width else {
            return nil
        }
        
        let totalH = leftBorder + rightBorder
        let totalV = topBorder + bottomBorder
        let leftPct = totalH > 0 ? (leftBorder / totalH) * 100 : 50
        let rightPct = 100 - leftPct
        let topPct = totalV > 0 ? (topBorder / totalV) * 100 : 50
        let bottomPct = 100 - topPct
        
        let passesPSA10 = leftPct >= 40 && leftPct <= 60 && topPct >= 40 && topPct <= 60
        let passesBGS10 = leftPct >= 48 && leftPct <= 52 && topPct >= 48 && topPct <= 52
        
        return CenteringResult(
            leftRightRatio: (leftPct, rightPct),
            topBottomRatio: (topPct, bottomPct),
            passesPSA10: passesPSA10,
            passesBGS10: passesBGS10
        )
    }
    
    /// Multi-frame averaged centering. Call this once per live camera frame instead of calling
    /// `analyzeCenteringReal` directly. Internally it runs the single-frame scan, then folds
    /// the result into a rolling buffer and returns the MEDIAN of recent samples — which is
    /// dramatically more stable than any single frame, because random per-frame noise
    /// (lighting flicker, sensor noise, hand micro-shake) mostly cancels out across samples,
    /// while the card's real, unchanging centering stays put.
    ///
    /// If a new frame's reading is wildly different from the current running median, that's
    /// treated as a sign the card was moved/repositioned (not just noise) — the buffer resets
    /// so stale readings from before the move don't get blended into the new position.
    ///
    /// FIXED: all buffer reads/writes now happen inside bufferAccessQueue.sync, so this is
    /// safe to call from a background thread (as processLiveCameraFrame does) at the same
    /// time resetSampleBuffer() is called from the main thread.
    public func analyzeCenteringAveraged(from observation: VNRectangleObservation, in cgImage: CGImage) -> CenteringResult? {
        // The pixel-level scan itself doesn't touch shared state, so it can run outside the
        // lock — only the buffer read/mutate/return needs to be serialized.
        let singleFrameResult = analyzeCenteringReal(from: observation, in: cgImage)
        
        return bufferAccessQueue.sync {
            // NEW: check whether the card's actual detected outline moved since the last
            // frame. If it moved more than the tolerance, the user is still positioning the
            // card — treat this like a repositioning event and restart the buffer, same as
            // the outlier-rejection case below, rather than letting an in-motion frame count
            // toward "stable." Position tracking updates regardless of whether this frame's
            // pixel-level measurement succeeded — a failed measurement isn't evidence the
            // card moved.
            let cardIsStationary = isPositionStable(observation)
            lastObservedCorners = (observation.topLeft, observation.topRight, observation.bottomLeft, observation.bottomRight)
            
            // FIXED: analyzeCenteringReal now returns nil when this frame couldn't be
            // reliably measured (e.g. a border edge had no detectable divergence under the
            // current lighting). Previously a fake 50/50 fallback got silently folded into
            // the average; now a failed frame is skipped entirely — it doesn't touch the
            // buffer at all, and we just return whatever the buffer already had.
            guard let singleFrameResult = singleFrameResult else {
                return medianResult(from: recentSamples)
            }
            
            if !cardIsStationary {
                recentSamples.removeAll()
                recentSamples.append(singleFrameResult)
                return singleFrameResult
            }
            
            if let currentMedian = medianResult(from: recentSamples),
               !isSampleConsistent(singleFrameResult, with: currentMedian) {
                recentSamples.removeAll()
            }
            
            recentSamples.append(singleFrameResult)
            if recentSamples.count > maxSampleBufferSize {
                recentSamples.removeFirst()
            }
            
            return medianResult(from: recentSamples) ?? singleFrameResult
        }
    }
    
    /// Compares this frame's detected card corners against the previous frame's. Returns
    /// false (not stable) if this is the first frame seen (nothing to compare against yet)
    /// or if any corner moved more than positionStabilityThreshold.
    private func isPositionStable(_ observation: VNRectangleObservation) -> Bool {
        guard let last = lastObservedCorners else { return false }
        func distance(_ a: CGPoint, _ b: CGPoint) -> CGFloat {
            hypot(a.x - b.x, a.y - b.y)
        }
        let maxMovement = max(
            distance(observation.topLeft, last.topLeft),
            distance(observation.topRight, last.topRight),
            distance(observation.bottomLeft, last.bottomLeft),
            distance(observation.bottomRight, last.bottomRight)
        )
        return maxMovement < positionStabilityThreshold
    }
    
    private func isSampleConsistent(_ sample: CenteringResult, with median: CenteringResult) -> Bool {
        let leftDelta = abs(sample.leftRightRatio.left - median.leftRightRatio.left)
        let topDelta = abs(sample.topBottomRatio.top - median.topBottomRatio.top)
        return leftDelta < outlierRejectionThreshold && topDelta < outlierRejectionThreshold
    }
    
    private func medianResult(from samples: [CenteringResult]) -> CenteringResult? {
        guard !samples.isEmpty else { return nil }
        let lefts = samples.map { $0.leftRightRatio.left }.sorted()
        let tops = samples.map { $0.topBottomRatio.top }.sorted()
        let medianLeft = lefts[lefts.count / 2]
        let medianTop = tops[tops.count / 2]
        let medianRight = 100 - medianLeft
        let medianBottom = 100 - medianTop
        
        let passesPSA10 = medianLeft >= 40 && medianLeft <= 60 && medianTop >= 40 && medianTop <= 60
        let passesBGS10 = medianLeft >= 48 && medianLeft <= 52 && medianTop >= 48 && medianTop <= 52
        
        return CenteringResult(
            leftRightRatio: (medianLeft, medianRight),
            topBottomRatio: (medianTop, medianBottom),
            passesPSA10: passesPSA10,
            passesBGS10: passesBGS10
        )
    }
}
