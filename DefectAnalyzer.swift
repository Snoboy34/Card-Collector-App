import Foundation
import CoreImage
import UIKit

public struct AutoDefectScanResult {
    public let surfaceScratchCount: Int
    public let edgeWhiteningSeverity: Int
    // NEW: corner-fraying severity. Previously there was no corner analysis anywhere in
    // this file — CardScannerView was setting autoCornerFraying from a fake
    // `imageFrame.width % 2` placeholder because there was nothing real to call. This
    // closes that gap with a real per-frame measurement.
    public let cornerFrayingSeverity: Int
    public let detectedFlawMarkers: [CGPoint]
}

public final class DefectAnalyzer {

    private let context = CIContext(options: [.useSoftwareRenderer: false])

    public init() {}

    /// Analyzes a cropped card image to automatically calculate scratch counts, edge wear
    /// friction zones, and corner fraying/whitening.
    public func analyzeCardSurface(from cgImage: CGImage) -> AutoDefectScanResult {
        let ciImage = CIImage(cgImage: cgImage)

        // Step 1: Isolate Surface Anomalies using a high-pass Laplacian filter
        let scratchCount = detectSurfaceScratches(in: ciImage)

        // Step 2: Sample outer border pixels to locate localized high-brightness whitening scuffs
        let edgeSeverity = detectEdgeWhitening(in: ciImage)

        // Step 3: NEW — sample the four corner regions specifically for fraying/whitening,
        // separate from the general edge-perimeter scan above. Corners wear differently
        // than straight edges (rounding, chipping) so they get their own localized check
        // rather than being folded into the edge-whitening number.
        let cornerSeverity = detectCornerFraying(in: ciImage)

        // Step 4: Generate dynamic mock coordinate pinpoints matching the found defect counts
        let visualMarkers = generateDefectCoordinates(scratchCount: scratchCount, edgeCount: edgeSeverity)

        return AutoDefectScanResult(
            surfaceScratchCount: scratchCount,
            edgeWhiteningSeverity: edgeSeverity,
            cornerFrayingSeverity: cornerSeverity,
            detectedFlawMarkers: visualMarkers
        )
    }

    private func detectSurfaceScratches(in inputImage: CIImage) -> Int {
        // Convert to grayscale to remove distracting artwork color variations
        guard let monochromeFilter = CIFilter(name: "CIPhotoEffectMono") else { return 0 }
        monochromeFilter.setValue(inputImage, forKey: kCIInputImageKey)

        // Apply an edge enhancement filter to highlight thin surface fissures and cracks
        guard let lineEnhancer = CIFilter(name: "CILineOverlay") else { return 0 }
        lineEnhancer.setValue(monochromeFilter.outputImage, forKey: kCIInputImageKey)
        lineEnhancer.setValue(0.08, forKey: "inputNRNoiseLevel")
        lineEnhancer.setValue(0.70, forKey: "inputEdgeIntensity")

        guard let processingOutput = lineEnhancer.outputImage,
              let intermediateCGImage = context.createCGImage(processingOutput, from: processingOutput.extent) else {
            return 0
        }

        // Fast pixel calculation pass: measure high-frequency white pixel clusters
        return calculateHighIntensityPixelClusters(from: intermediateCGImage, intensityThreshold: 240)
    }

    private func detectEdgeWhitening(in inputImage: CIImage) -> Int {
        // Crop a thin perimeter frame around the card edges to isolate cardboard scuffs
        let perimeterBounds = inputImage.extent.insetBy(dx: 15, dy: 15)
        let edgeOnlyImage = inputImage.cropped(to: inputImage.extent).clampedToExtent().cropped(to: perimeterBounds)

        guard let maxIntensityFilter = CIFilter(name: "CIAreaMinMax") else { return 0 }
        maxIntensityFilter.setValue(edgeOnlyImage, forKey: kCIInputImageKey)
        maxIntensityFilter.setValue(CIVector(cgRect: edgeOnlyImage.extent), forKey: kCIInputExtentKey)

        guard let outputImage = maxIntensityFilter.outputImage else { return 0 }

        var rawPixelData = [UInt8](repeating: 0, count: 4)
        context.render(outputImage, toBitmap: &rawPixelData, rowBytes: 4, bounds: CGRect(x: 0, y: 0, width: 1, height: 1), format: .RGBA8, colorSpace: nil)

        // High brightness readings on raw cardboard edges indicate exposed white paper layers
        let edgeBrightness = rawPixelData[0] // Read Red/Grayscale channel density

        switch edgeBrightness {
        case 220...255: return 4 // Severe edge flaking scuffs
        case 170...219: return 2 // Moderate whitening friction points
        case 100...169: return 1 // Microscopic corner dings
        default: return 0        // Clean, uniform edges
        }
    }

    /// NEW: samples a small square region at each of the four corners and measures peak
    /// brightness within each, the same way detectEdgeWhitening measures the full perimeter —
    /// exposed white paper/fraying at a corner reads as a localized brightness spike relative
    /// to the surrounding border color. Returns the WORST (max) of the four corner readings,
    /// since a single badly frayed corner should drive the score even if the other three are
    /// clean — averaging them would dilute a real, visible flaw.
    private func detectCornerFraying(in inputImage: CIImage) -> Int {
        let extent = inputImage.extent
        // Corner sample squares sized relative to the card image, same proportions used by
        // the edge-whitening inset (15pt) but as a small square footprint at each corner
        // rather than a thin strip around the whole perimeter.
        let cornerSize: CGFloat = max(20, min(extent.width, extent.height) * 0.08)

        let corners: [CGRect] = [
            CGRect(x: extent.minX, y: extent.maxY - cornerSize, width: cornerSize, height: cornerSize), // top-left
            CGRect(x: extent.maxX - cornerSize, y: extent.maxY - cornerSize, width: cornerSize, height: cornerSize), // top-right
            CGRect(x: extent.minX, y: extent.minY, width: cornerSize, height: cornerSize), // bottom-left
            CGRect(x: extent.maxX - cornerSize, y: extent.minY, width: cornerSize, height: cornerSize) // bottom-right
        ]

        var worstSeverity = 0
        for cornerRect in corners {
            let severity = brightnessSeverity(in: inputImage, region: cornerRect)
            worstSeverity = max(worstSeverity, severity)
        }
        return worstSeverity
    }

    /// Shared helper: measures max brightness within a region and maps it to the same
    /// 0-4 severity scale used by detectEdgeWhitening, so corner and edge scores stay
    /// directly comparable.
    private func brightnessSeverity(in inputImage: CIImage, region: CGRect) -> Int {
        let clampedRegion = region.intersection(inputImage.extent)
        guard !clampedRegion.isEmpty else { return 0 }
        let regionImage = inputImage.cropped(to: clampedRegion)

        guard let maxIntensityFilter = CIFilter(name: "CIAreaMinMax") else { return 0 }
        maxIntensityFilter.setValue(regionImage, forKey: kCIInputImageKey)
        maxIntensityFilter.setValue(CIVector(cgRect: clampedRegion), forKey: kCIInputExtentKey)

        guard let outputImage = maxIntensityFilter.outputImage else { return 0 }

        var rawPixelData = [UInt8](repeating: 0, count: 4)
        context.render(outputImage, toBitmap: &rawPixelData, rowBytes: 4, bounds: CGRect(x: 0, y: 0, width: 1, height: 1), format: .RGBA8, colorSpace: nil)

        let brightness = rawPixelData[0]

        switch brightness {
        case 220...255: return 4
        case 170...219: return 2
        case 100...169: return 1
        default: return 0
        }
    }

    private func calculateHighIntensityPixelClusters(from cgImage: CGImage, intensityThreshold: UInt8) -> Int {
        guard let pixelDataProvider = cgImage.dataProvider,
              let rawPixelData = pixelDataProvider.data else { return 0 }

        let rawBufferPointer = CFDataGetBytePtr(rawPixelData)
        let frameTotalBytes = CFDataGetLength(rawPixelData)

        var consecutiveAnomalies = 0
        var totalScratchFaultsCalculated = 0

        // Scan the stride byte-array to locate high-frequency scratch signatures
        for byteIndex in stride(from: 0, to: frameTotalBytes, by: 4) {
            let pixelLuminanceValue = rawBufferPointer?[byteIndex] ?? 0

            if pixelLuminanceValue >= intensityThreshold {
                consecutiveAnomalies += 1
                if consecutiveAnomalies == 6 { // Group adjacent matching fragments to prevent noise false-positives
                    totalScratchFaultsCalculated += 1
                    consecutiveAnomalies = 0
                }
            } else {
                consecutiveAnomalies = 0
            }
        }

        // Normalize values to map accurately against your 0-5 layout slider cap
        return min(5, totalScratchFaultsCalculated / 2)
    }

    private func generateDefectCoordinates(scratchCount: Int, edgeCount: Int) -> [CGPoint] {
        var markerPlots: [CGPoint] = []

        if scratchCount >= 1 { markerPlots.append(CGPoint(x: 60, y: 90)) }
        if scratchCount >= 3 { markerPlots.append(CGPoint(x: 120, y: 130)) }
        if edgeCount >= 1 { markerPlots.append(CGPoint(x: 10, y: 15)) }
        if edgeCount >= 2 { markerPlots.append(CGPoint(x: 160, y: 195)) }

        return markerPlots
    }
}
