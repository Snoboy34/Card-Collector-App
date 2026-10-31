import CoreGraphics
import Foundation
import Vision

/// Live distance guide. The on-screen card quad is mapped into the still the
/// shutter will take, and px/mm is that card's height divided by 88.9 mm.
/// The band is guidance for the person holding the phone. The shutter opens
/// when the card is in frame, the phone is level, and the edge is sharp.
/// The server labels each scan from the px/mm it measures on the still.
enum DistanceGuide {
    static let cardHeightMm = 88.9
    /// Wider than the 0.31 mm transition measured on the sharp 11 cm still.
    /// The preview is a smaller image of that edge, and this only refuses a
    /// smeared border. Distance itself is the band below, not this number.
    static let maxSharpTransitionMm = 0.55
    static let wideCamera = "AVCaptureDeviceTypeBuiltInWideAngleCamera"
    /// Fraction of a filled frame the default band will approach. Filling the
    /// frame ran soft on the measured phone, so an unmeasured phone stops
    /// short of that. 70% of a 4032 px still is about 31.8 px/mm, which still
    /// reaches the 30 px/mm line.
    static let defaultBandFillFraction = 0.70
    /// Far end of the default band when the still can show it. Under 15 px/mm
    /// the server withholds the edge.
    static let defaultBandLabelFloor = 15.0

    enum BandSource: String, Equatable {
        case measured
        case `default`
        case open
    }

    struct ActiveBand: Equatable {
        var minPxPerMm: Double
        var maxPxPerMm: Double
        var source: BandSource

        func contains(_ pxPerMm: Double) -> Bool {
            if source == .open { return pxPerMm > 0 }
            return pxPerMm >= minPxPerMm && pxPerMm <= maxPxPerMm
        }

        static let open = ActiveBand(minPxPerMm: 0, maxPxPerMm: 0, source: .open)
    }

    struct DeviceBand: Equatable {
        var model: String
        var camera: String
        var minPxPerMm: Double
        var maxPxPerMm: Double

        func contains(_ pxPerMm: Double) -> Bool {
            pxPerMm >= minPxPerMm && pxPerMm <= maxPxPerMm
        }
    }

    /// Measured on a capture test. iPhone 13 Pro (`iPhone14,2`) wide camera:
    /// about 11 cm, 29–31 px/mm. 12 cm was 26.4 and sharp but short of 30.
    /// 10 cm was 32.2 and slightly soft. Nothing else is filled in here.
    static let measuredBands: [DeviceBand] = [
        DeviceBand(model: "iPhone14,2", camera: wideCamera, minPxPerMm: 29, maxPxPerMm: 31)
    ]

    static func band(model: String, camera: String) -> DeviceBand? {
        measuredBands.first { $0.model == model && $0.camera == camera }
    }

    static func round1(_ value: Double) -> Double {
        (value * 10).rounded() / 10
    }

    /// Band for a camera with no capture test, from the long side of the
    /// still that camera reported. Nil when that still is too small to
    /// describe a range; the caller then leaves the distance open.
    static func defaultBand(stillWidth: Int, stillHeight: Int) -> ActiveBand? {
        let longSide = max(stillWidth, stillHeight)
        guard longSide >= 200 else { return nil }
        let fill = Double(longSide) / cardHeightMm
        let maxPx = round1(fill * defaultBandFillFraction)
        let minPx = round1(min(defaultBandLabelFloor, maxPx * 0.50))
        guard maxPx > minPx else { return nil }
        return ActiveBand(minPxPerMm: minPx, maxPxPerMm: maxPx, source: .default)
    }

    /// Measured band when this device and camera have one. Otherwise the
    /// default from the reported still, or an open band when the still size
    /// has not arrived. An open band does not lock the shutter.
    static func activeBand(model: String, camera: String, stillWidth: Int, stillHeight: Int) -> ActiveBand {
        if let measured = band(model: model, camera: camera) {
            return ActiveBand(minPxPerMm: measured.minPxPerMm, maxPxPerMm: measured.maxPxPerMm, source: .measured)
        }
        return defaultBand(stillWidth: stillWidth, stillHeight: stillHeight) ?? .open
    }

    struct NormPoint: Equatable {
        var x: Double
        var y: Double

        init(_ x: Double, _ y: Double) {
            self.x = x
            self.y = y
        }

        init(_ point: CGPoint) {
            x = Double(point.x)
            y = Double(point.y)
        }
    }

    struct NormQuad: Equatable {
        var tl: NormPoint
        var tr: NormPoint
        var br: NormPoint
        var bl: NormPoint

        init(tl: NormPoint, tr: NormPoint, br: NormPoint, bl: NormPoint) {
            self.tl = tl
            self.tr = tr
            self.br = br
            self.bl = bl
        }

        init(_ observation: VNRectangleObservation) {
            tl = NormPoint(observation.topLeft)
            tr = NormPoint(observation.topRight)
            br = NormPoint(observation.bottomRight)
            bl = NormPoint(observation.bottomLeft)
        }
    }

    enum Prompt: Equatable {
        case findCard
        case moveCloser
        case tooClose
        case hold
        case holdFocusing
        case holdSoft
    }

    struct Reading: Equatable {
        var pxPerMm: Double?
        var prompt: Prompt
        var shutterAllowed: Bool
        var bandSource: BandSource

        static let idle = Reading(pxPerMm: nil, prompt: .findCard, shutterAllowed: false, bandSource: .open)

        var headline: String {
            switch prompt {
            case .findCard: return "Find the card"
            case .moveCloser: return "closer for best accuracy"
            case .tooClose: return "farther for best accuracy"
            case .hold, .holdFocusing: return "Hold"
            case .holdSoft: return "Edge soft"
            }
        }

        var detail: String? {
            switch prompt {
            case .holdFocusing: return "Focusing"
            case .holdSoft: return nil
            case .hold: return bandSource == .measured ? nil : "Default band"
            default: return nil
            }
        }

        var pxLabel: String {
            guard let pxPerMm, pxPerMm > 0 else { return "— px/mm" }
            return String(format: "%.1f px/mm", pxPerMm)
        }

        var statusLine: String {
            if let detail { return "\(pxLabel) · \(headline) · \(detail)" }
            return "\(pxLabel) · \(headline)"
        }
    }

    struct Smoother {
        private var pxWindow: [Double] = []
        private var sharpWindow: [Bool] = []
        private(set) var pxPerMm: Double?
        private(set) var edgeSharp: Bool = false

        mutating func reset() {
            pxWindow = []
            sharpWindow = []
            pxPerMm = nil
            edgeSharp = false
        }

        mutating func push(pxPerMm: Double?, edgeSharp: Bool?) {
            if let pxPerMm, pxPerMm > 0 {
                pxWindow.append(pxPerMm)
                if pxWindow.count > 3 { pxWindow.removeFirst() }
                self.pxPerMm = DistanceGuide.median(pxWindow)
            }
            if let edgeSharp {
                sharpWindow.append(edgeSharp)
                if sharpWindow.count > 3 { sharpWindow.removeFirst() }
                self.edgeSharp = sharpWindow.last ?? false
            }
        }
    }

    /// The band does not close the shutter. Focus, a sharp edge, and a level
    /// phone do. Outside the band the words ask for a closer or farther card.
    static func decide(pxPerMm: Double?, band: ActiveBand, focusSettled: Bool, edgeSharp: Bool, level: Bool) -> Reading {
        guard let pxPerMm, pxPerMm > 0 else {
            return Reading(pxPerMm: nil, prompt: .findCard, shutterAllowed: false, bandSource: band.source)
        }
        if !focusSettled {
            return Reading(pxPerMm: pxPerMm, prompt: .holdFocusing, shutterAllowed: false, bandSource: band.source)
        }
        if !edgeSharp {
            return Reading(pxPerMm: pxPerMm, prompt: .holdSoft, shutterAllowed: false, bandSource: band.source)
        }
        let prompt: Prompt
        if band.contains(pxPerMm) {
            prompt = .hold
        } else if pxPerMm < band.minPxPerMm {
            prompt = .moveCloser
        } else {
            prompt = .tooClose
        }
        return Reading(pxPerMm: pxPerMm, prompt: prompt, shutterAllowed: level, bandSource: band.source)
    }

    /// Card, level, a sharp edge, and the best band. An open band has no
    /// measured distance, so it never auto-captures. The manual shutter
    /// stays available outside the band.
    static func autoCaptureReady(cardFound: Bool, level: Bool, focusSettled: Bool, edgeSharp: Bool, pxPerMm: Double?, band: ActiveBand) -> Bool {
        guard cardFound, level, focusSettled, edgeSharp, let pxPerMm, pxPerMm > 0 else { return false }
        guard band.source == .measured || band.source == .default else { return false }
        return band.contains(pxPerMm)
    }

    /// Fires once after `holdSeconds` of `autoCaptureReady`. Any drop restarts
    /// the hold. A second fire waits until the card leaves the frame.
    struct AutoCapture: Equatable {
        private(set) var armedAt: Date?
        private(set) var fired = false
        static let holdSeconds: TimeInterval = 0.5

        mutating func reset() {
            armedAt = nil
            fired = false
        }

        mutating func noteCardLost() {
            armedAt = nil
            fired = false
        }

        /// A capture already started. The next automatic shot waits until the card leaves.
        mutating func noteCaptured() {
            armedAt = nil
            fired = true
        }

        /// Sweep, upload, or the report sheet. The hold starts over afterward.
        mutating func pause() {
            armedAt = nil
        }

        mutating func tick(ready: Bool, now: Date) -> Bool {
            if fired { return false }
            guard ready else {
                armedAt = nil
                return false
            }
            if armedAt == nil {
                armedAt = now
                return false
            }
            if let armedAt, now.timeIntervalSince(armedAt) + 1e-6 >= Self.holdSeconds {
                fired = true
                self.armedAt = nil
                return true
            }
            return false
        }
    }

    /// Why the shutter is closed. The box can be up while this is not "open".
    /// `block` is the finder's reason. Empty means a quad is on screen.
    /// Distance is guidance, not a close reason. The outer cut stays on the server.
    static func shutterDebug(block: String, freshFrames: Int, prompt: Prompt, level: Bool) -> String {
        if !block.isEmpty { return block }
        switch prompt {
        case .holdSoft:
            return "soft"
        case .holdFocusing:
            return "focusing"
        case .findCard:
            return "settling"
        case .hold, .moveCloser, .tooClose:
            if !level { return "level" }
            return freshFrames >= 3 ? "open" : "settling"
        }
    }

    /// Sensor pixels in the same orientation as the preview. A 4032×3024
    /// still shown in a portrait preview is 3024×4032 upright.
    static func uprightStillPixels(sensorWidth: Int, sensorHeight: Int, previewWidth: Int, previewHeight: Int) -> (width: Int, height: Int)? {
        guard sensorWidth > 0, sensorHeight > 0 else { return nil }
        guard previewWidth > 0, previewHeight > 0 else { return (sensorWidth, sensorHeight) }
        let sensorPortrait = sensorHeight > sensorWidth
        let previewPortrait = previewHeight > previewWidth
        if sensorPortrait == previewPortrait { return (sensorWidth, sensorHeight) }
        return (sensorHeight, sensorWidth)
    }

    static func pixelLength(_ a: NormPoint, _ b: NormPoint, width: Double, height: Double) -> Double {
        let dx = (a.x - b.x) * width
        let dy = (a.y - b.y) * height
        return (dx * dx + dy * dy).squareRoot()
    }

    /// Card height in preview pixels: the mean of the two long sides.
    /// Vision's aspect gate keeps the rectangle portrait, so those sides
    /// are the 88.9 mm edges.
    static func cardHeightPreviewPx(_ quad: NormQuad, width: Double, height: Double) -> Double? {
        guard width > 1, height > 1 else { return nil }
        let left = pixelLength(quad.tl, quad.bl, width: width, height: height)
        let right = pixelLength(quad.tr, quad.br, width: width, height: height)
        let card = (left + right) / 2
        return card > 1 ? card : nil
    }

    /// Preview card height scaled into the upright still, then divided by
    /// the face height. Aspect-fill shares one axis. A narrower preview, or
    /// a matching aspect, cropped the still's left and right, so the heights
    /// see the same field. A wider preview cropped the top and bottom, so
    /// the widths see the same field. The upright still's long side is the
    /// vertical axis: 4032 on a 4032×3024 sensor in a portrait preview.
    static func pxPerMm(cardHeightPreviewPx: Double, previewWidth: Double, previewHeight: Double, stillWidth: Double, stillHeight: Double, cardHeightMm: Double = DistanceGuide.cardHeightMm) -> Double? {
        guard cardHeightPreviewPx > 1, previewWidth > 1, previewHeight > 1, stillWidth > 1, stillHeight > 1 else {
            return nil
        }
        let previewAspect = previewWidth / previewHeight
        let stillAspect = stillWidth / stillHeight
        let scale: Double
        if previewAspect > stillAspect * 1.03 {
            scale = stillWidth / previewWidth
        } else {
            scale = stillHeight / previewHeight
        }
        return (cardHeightPreviewPx * scale) / cardHeightMm
    }

    static func median(_ values: [Double]) -> Double? {
        guard !values.isEmpty else { return nil }
        let sorted = values.sorted()
        let mid = sorted.count / 2
        if sorted.count % 2 == 1 { return sorted[mid] }
        return (sorted[mid - 1] + sorted[mid]) / 2
    }

    static func edgeIsSharp(transitionMm: Double) -> Bool {
        transitionMm > 0 && transitionMm <= maxSharpTransitionMm
    }

    /// Width of the 10%–90% step, in samples. Index 0 is outside the card.
    static func transitionWidthPx(_ samples: [Double]) -> Double? {
        guard samples.count >= 5 else { return nil }
        let headCount = max(1, samples.count / 5)
        guard let head = median(Array(samples.prefix(headCount))),
              let tail = median(Array(samples.suffix(headCount))) else { return nil }
        let span = abs(tail - head)
        guard span >= 12 else { return nil }
        let rising = tail > head
        let low = min(head, tail)
        let p10 = low + 0.10 * span
        let p90 = low + 0.90 * span
        var steep = 0
        var steepG = 0.0
        for index in 1..<samples.count {
            let gradient = abs(samples[index] - samples[index - 1])
            if gradient > steepG {
                steepG = gradient
                steep = index
            }
        }
        guard steepG >= 8 else { return nil }
        func cross(_ level: Double) -> Double? {
            var best: Double?
            var bestDist = Double.greatestFiniteMagnitude
            for index in 1..<samples.count {
                let a = samples[index - 1]
                let b = samples[index]
                let lo = min(a, b)
                let hi = max(a, b)
                guard level >= lo, level <= hi, a != b else { continue }
                let forward = rising ? (b > a) : (b < a)
                guard forward else { continue }
                let t = (level - a) / (b - a)
                guard t >= 0, t <= 1 else { continue }
                let x = Double(index - 1) + t
                let dist = abs(x - Double(steep))
                if dist < bestDist {
                    bestDist = dist
                    best = x
                }
            }
            return best
        }
        guard let c10 = cross(p10), let c90 = cross(p90) else { return nil }
        return abs(c90 - c10)
    }

    /// One edge of a grayscale buffer. `(ax, ay)` to `(bx, by)` is the edge
    /// in y-down pixels. `outward` is a unit vector pointing off the card.
    static func edgeTransitionMm(
        samples: [UInt8],
        width: Int,
        height: Int,
        ax: Double,
        ay: Double,
        bx: Double,
        by: Double,
        outwardX: Double,
        outwardY: Double,
        pxPerMm: Double
    ) -> Double? {
        guard width > 0, height > 0, samples.count == width * height, pxPerMm > 0 else { return nil }
        let reach = min(64, max(4, Int((pxPerMm * 1.5).rounded())))
        var stationMm: [Double] = []
        let stations = [0.20, 0.35, 0.50, 0.65, 0.80]
        for t in stations {
            let mx = ax + (bx - ax) * t
            let my = ay + (by - ay) * t
            var line: [Double] = []
            var intact = true
            for step in stride(from: reach, through: -reach, by: -1) {
                let x = Int((mx + outwardX * Double(step)).rounded())
                let y = Int((my + outwardY * Double(step)).rounded())
                guard x >= 0, y >= 0, x < width, y < height else {
                    intact = false
                    break
                }
                line.append(Double(samples[y * width + x]))
            }
            guard intact, let widthPx = transitionWidthPx(line) else { continue }
            stationMm.append(widthPx / pxPerMm)
        }
        guard stationMm.count >= 3 else { return nil }
        return median(stationMm)
    }

    static func outwardUnit(from ax: Double, _ ay: Double, to bx: Double, _ by: Double) -> (x: Double, y: Double)? {
        let dx = bx - ax
        let dy = by - ay
        let length = (dx * dx + dy * dy).squareRoot()
        guard length > 1 else { return nil }
        // Y-down clockwise (top-left, top-right, bottom-right, bottom-left):
        // (dy, -dx) points off the card.
        return (dy / length, -dx / length)
    }

    static func previewEdgeTransitionMm(image: CGImage, quad: NormQuad, previewPxPerMm: Double) -> Double? {
        guard previewPxPerMm > 0, let gray = grayscale(image) else { return nil }
        let w = Double(gray.width)
        let h = Double(gray.height)
        func pixel(_ point: NormPoint) -> (x: Double, y: Double) {
            (point.x * w, (1 - point.y) * h)
        }
        let corners = [pixel(quad.tl), pixel(quad.tr), pixel(quad.br), pixel(quad.bl)]
        var edges: [Double] = []
        for index in 0..<4 {
            let a = corners[index]
            let b = corners[(index + 1) % 4]
            guard let outward = outwardUnit(from: a.x, a.y, to: b.x, b.y) else { continue }
            guard let mm = edgeTransitionMm(
                samples: gray.samples,
                width: gray.width,
                height: gray.height,
                ax: a.x,
                ay: a.y,
                bx: b.x,
                by: b.y,
                outwardX: outward.x,
                outwardY: outward.y,
                pxPerMm: previewPxPerMm
            ) else { continue }
            edges.append(mm)
        }
        guard edges.count >= 3 else { return nil }
        return median(edges)
    }

    static func edgesAreSharp(image: CGImage, quad: NormQuad, previewPxPerMm: Double) -> Bool {
        guard let mm = previewEdgeTransitionMm(image: image, quad: quad, previewPxPerMm: previewPxPerMm) else {
            return false
        }
        return edgeIsSharp(transitionMm: mm)
    }

    static func grayscale(_ image: CGImage) -> (width: Int, height: Int, samples: [UInt8])? {
        let width = image.width
        let height = image.height
        guard width > 0, height > 0, width <= 5000, height <= 5000 else { return nil }
        var samples = [UInt8](repeating: 0, count: width * height)
        let wrote = samples.withUnsafeMutableBytes { raw -> Bool in
            guard let base = raw.baseAddress else { return false }
            guard let context = CGContext(
                data: base,
                width: width,
                height: height,
                bitsPerComponent: 8,
                bytesPerRow: width,
                space: CGColorSpaceCreateDeviceGray(),
                bitmapInfo: CGImageAlphaInfo.none.rawValue
            ) else { return false }
            context.interpolationQuality = .none
            context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
            return true
        }
        return wrote ? (width, height, samples) : nil
    }

    #if DEBUG
    static func runContractChecks(_ check: ContractCheck) {
        func expect(_ condition: @autoclosure () -> Bool, _ message: @autoclosure () -> String, file: StaticString = #filePath, line: UInt = #line) {
            check(condition(), message(), file, line)
        }
        let wide = activeBand(model: "iPhone14,2", camera: wideCamera, stillWidth: 4032, stillHeight: 3024)
        expect(wide.source == .measured && wide.minPxPerMm == 29 && wide.maxPxPerMm == 31, "iPhone 13 Pro wide band stays 29–31 px/mm")
        expect(band(model: "Pixel 8", camera: "back") == nil, "an unmeasured phone is absent from the measured table")
        expect(measuredBands.count == 1, "only the measured phone is in the band table")

        let hold = decide(pxPerMm: 30.0, band: wide, focusSettled: true, edgeSharp: true, level: true)
        expect(hold.prompt == .hold && hold.shutterAllowed && hold.statusLine == "30.0 px/mm · Hold", "30.0 px/mm inside the band holds")
        let lowEdge = decide(pxPerMm: 29.0, band: wide, focusSettled: true, edgeSharp: true, level: true)
        expect(lowEdge.shutterAllowed && lowEdge.prompt == .hold, "29 px/mm is inside the band")
        let highEdge = decide(pxPerMm: 31.0, band: wide, focusSettled: true, edgeSharp: true, level: true)
        expect(highEdge.shutterAllowed && highEdge.prompt == .hold, "31 px/mm is inside the band")
        let closer = decide(pxPerMm: 26.4, band: wide, focusSettled: true, edgeSharp: true, level: true)
        expect(closer.shutterAllowed && closer.prompt == .moveCloser && closer.statusLine == "26.4 px/mm · closer for best accuracy", "26.4 px/mm asks for a closer card and leaves the shutter open")
        let tooClose = decide(pxPerMm: 32.2, band: wide, focusSettled: true, edgeSharp: true, level: true)
        expect(tooClose.shutterAllowed && tooClose.prompt == .tooClose && tooClose.statusLine == "32.2 px/mm · farther for best accuracy", "32.2 px/mm asks for a farther card and leaves the shutter open")
        let tilted = decide(pxPerMm: 30.0, band: wide, focusSettled: true, edgeSharp: true, level: false)
        expect(!tilted.shutterAllowed && tilted.prompt == .hold, "tilt closes the shutter inside the band")
        let tiltedFar = decide(pxPerMm: 26.4, band: wide, focusSettled: true, edgeSharp: true, level: false)
        expect(!tiltedFar.shutterAllowed && tiltedFar.prompt == .moveCloser, "tilt closes the shutter while the distance words stay")
        let focusing = decide(pxPerMm: 30.0, band: wide, focusSettled: false, edgeSharp: true, level: true)
        expect(!focusing.shutterAllowed && focusing.prompt == .holdFocusing && focusing.statusLine.contains("Focusing"), "an unsettled focus keeps the shutter closed")
        let soft = decide(pxPerMm: 30.0, band: wide, focusSettled: true, edgeSharp: false, level: true)
        expect(!soft.shutterAllowed && soft.prompt == .holdSoft && soft.headline == "Edge soft" && !soft.statusLine.contains("Hold"), "a soft frame does not say Hold")
        let missing = decide(pxPerMm: nil, band: wide, focusSettled: true, edgeSharp: true, level: true)
        expect(!missing.shutterAllowed && missing.prompt == .findCard && missing.statusLine == "— px/mm · Find the card", "no card keeps the shutter closed")

        let fallback = activeBand(model: "Pixel 8", camera: "back", stillWidth: 4000, stillHeight: 3000)
        expect(fallback.source == .default && fallback.minPxPerMm == 15 && abs(fallback.maxPxPerMm - 31.5) < 0.05, "a 4000 px still defaults to 15–31.5 px/mm")
        let defaultHold = decide(pxPerMm: 30.0, band: fallback, focusSettled: true, edgeSharp: true, level: true)
        expect(defaultHold.shutterAllowed && defaultHold.statusLine == "30.0 px/mm · Hold · Default band", "an unmeasured phone can capture inside the default band")
        let defaultFar = decide(pxPerMm: 10.0, band: fallback, focusSettled: true, edgeSharp: true, level: true)
        expect(defaultFar.shutterAllowed && defaultFar.prompt == .moveCloser && defaultFar.statusLine.contains("closer for best accuracy"), "under 15 px/mm the words ask for a closer card and the shutter stays open")
        let defaultClose = decide(pxPerMm: 40.0, band: fallback, focusSettled: true, edgeSharp: true, level: true)
        expect(defaultClose.shutterAllowed && defaultClose.prompt == .tooClose, "past the default band the words ask for a farther card and the shutter stays open")
        let defaultSoft = decide(pxPerMm: 30.0, band: fallback, focusSettled: true, edgeSharp: false, level: true)
        expect(!defaultSoft.shutterAllowed && defaultSoft.prompt == .holdSoft, "the default band still waits for a sharp edge")
        let tiny = defaultBand(stillWidth: 800, stillHeight: 600)
        expect(tiny?.source == .default && (tiny?.maxPxPerMm ?? 99) < 15, "a small still keeps a band inside what it can show")
        let tinyHold = decide(pxPerMm: 5.0, band: tiny ?? .open, focusSettled: true, edgeSharp: true, level: true)
        expect(tinyHold.shutterAllowed, "a small still is not locked out")
        let open = activeBand(model: "Pixel 8", camera: "back", stillWidth: 0, stillHeight: 0)
        let openHold = decide(pxPerMm: 30.0, band: open, focusSettled: true, edgeSharp: true, level: true)
        expect(open.source == .open && openHold.shutterAllowed && openHold.statusLine == "30.0 px/mm · Hold · Default band", "a missing still size leaves the shutter open once focus, level, and the edge pass")
        let openSoft = decide(pxPerMm: 30.0, band: open, focusSettled: false, edgeSharp: true, level: true)
        expect(!openSoft.shutterAllowed, "an open band still waits for focus")

        expect(autoCaptureReady(cardFound: true, level: true, focusSettled: true, edgeSharp: true, pxPerMm: 30, band: wide), "the measured band arms auto-capture")
        expect(!autoCaptureReady(cardFound: true, level: true, focusSettled: true, edgeSharp: true, pxPerMm: 26.4, band: wide), "outside the measured band does not auto-capture")
        expect(!autoCaptureReady(cardFound: true, level: true, focusSettled: true, edgeSharp: true, pxPerMm: 32.2, band: wide), "too close does not auto-capture")
        expect(!autoCaptureReady(cardFound: true, level: false, focusSettled: true, edgeSharp: true, pxPerMm: 30, band: wide), "tilt does not auto-capture")
        expect(!autoCaptureReady(cardFound: true, level: true, focusSettled: false, edgeSharp: true, pxPerMm: 30, band: wide), "focus does not auto-capture")
        expect(!autoCaptureReady(cardFound: true, level: true, focusSettled: true, edgeSharp: false, pxPerMm: 30, band: wide), "a soft edge does not auto-capture")
        expect(!autoCaptureReady(cardFound: false, level: true, focusSettled: true, edgeSharp: true, pxPerMm: 30, band: wide), "no card does not auto-capture")
        expect(!autoCaptureReady(cardFound: true, level: true, focusSettled: true, edgeSharp: true, pxPerMm: 30, band: open), "an open band does not auto-capture")
        expect(autoCaptureReady(cardFound: true, level: true, focusSettled: true, edgeSharp: true, pxPerMm: 30, band: fallback), "a default band can auto-capture inside its range")
        expect(!autoCaptureReady(cardFound: true, level: true, focusSettled: true, edgeSharp: true, pxPerMm: 10, band: fallback), "outside the default band does not auto-capture")
        var clock = AutoCapture()
        let t0 = Date(timeIntervalSince1970: 1_000)
        expect(!clock.tick(ready: true, now: t0), "the first good frame arms the timer")
        expect(!clock.tick(ready: true, now: t0.addingTimeInterval(0.4)), "0.4 s does not fire")
        expect(clock.tick(ready: true, now: t0.addingTimeInterval(0.5)), "0.5 s of the best band fires once")
        expect(!clock.tick(ready: true, now: t0.addingTimeInterval(1.2)), "a second tick does not capture again")
        clock.noteCardLost()
        expect(!clock.tick(ready: true, now: t0.addingTimeInterval(2)), "after the card leaves, the hold starts over")
        expect(clock.tick(ready: true, now: t0.addingTimeInterval(2.5)), "a new hold captures again")
        var dropped = AutoCapture()
        expect(!dropped.tick(ready: true, now: t0), "a dropped hold arms")
        expect(!dropped.tick(ready: false, now: t0.addingTimeInterval(0.4)), "a dropped condition clears the timer")
        expect(!dropped.tick(ready: true, now: t0.addingTimeInterval(0.4)), "the hold starts again")
        expect(!dropped.tick(ready: true, now: t0.addingTimeInterval(0.8)), "0.4 s after a restart does not fire")
        expect(dropped.tick(ready: true, now: t0.addingTimeInterval(0.9)), "0.5 s after a restart fires")
        var taken = AutoCapture()
        expect(!taken.tick(ready: true, now: t0), "a manual capture arms nothing extra")
        taken.noteCaptured()
        expect(!taken.tick(ready: true, now: t0.addingTimeInterval(0.6)), "a capture already started does not fire again")
        var paused = AutoCapture()
        expect(!paused.tick(ready: true, now: t0), "a sweep pauses an armed hold")
        paused.pause()
        expect(!paused.tick(ready: true, now: t0.addingTimeInterval(0.6)), "the hold starts over after the pause")
        expect(paused.tick(ready: true, now: t0.addingTimeInterval(1.1)), "0.5 s after the pause fires")

        let upright = uprightStillPixels(sensorWidth: 4032, sensorHeight: 3024, previewWidth: 1440, previewHeight: 1920)
        expect(upright?.width == 3024 && upright?.height == 4032, "a portrait preview stands the 4032×3024 still upright")
        let previewCard = 2670.0 * (1920.0 / 4032.0)
        let px = pxPerMm(
            cardHeightPreviewPx: previewCard,
            previewWidth: 1440,
            previewHeight: 1920,
            stillWidth: Double(upright?.width ?? 0),
            stillHeight: Double(upright?.height ?? 0)
        )
        expect(px != nil && abs((px ?? 0) - (2670.0 / cardHeightMm)) < 0.05, "11 cm, 2670 px tall, reads about 30 px/mm")
        let face = CardFaceSize.sports
        let halfHeight = (1440.0 / 2) * (face.height / face.width)
        let half = pxPerMm(cardHeightPreviewPx: halfHeight, previewWidth: 1440, previewHeight: 1920, stillWidth: 3024, stillHeight: 4032, cardHeightMm: face.height)
        let halfExpected = ((1440.0 / 2) * (3024.0 / 1440.0)) / face.width
        expect(half != nil && abs((half ?? 0) - halfExpected) < 0.05 && (half ?? 0) < 29 && (half ?? 0) > 20, "half the preview width reads about 23.8 px/mm")
        let narrow = pxPerMm(cardHeightPreviewPx: previewCard, previewWidth: 1080, previewHeight: 1920, stillWidth: 3024, stillHeight: 4032)
        expect(narrow != nil && abs((narrow ?? 0) - (2670.0 / cardHeightMm)) < 0.05, "a 16:9 preview of the 11 cm card still reads about 30 px/mm")
        let widePreviewCard = 2670.0 * (1920.0 / 3024.0)
        let widePreview = pxPerMm(cardHeightPreviewPx: widePreviewCard, previewWidth: 1920, previewHeight: 1920, stillWidth: 3024, stillHeight: 4032)
        expect(widePreview != nil && abs((widePreview ?? 0) - (2670.0 / cardHeightMm)) < 0.05, "a wider preview scales on width and the 11 cm card still reads about 30 px/mm")
        expect(pxPerMm(cardHeightPreviewPx: previewCard, previewWidth: 1440, previewHeight: 1920, stillWidth: 0, stillHeight: 0) == nil, "a missing still size does not invent px/mm")

        let sharpStep = Array(repeating: 30.0, count: 16) + Array(repeating: 200.0, count: 16)
        let sharpPx = transitionWidthPx(sharpStep)
        expect(sharpPx != nil && (sharpPx ?? 0) < 1.2 && edgeIsSharp(transitionMm: (sharpPx ?? 9) / 14), "a one-pixel step is a sharp edge")
        var ramp = Array(repeating: 30.0, count: 8)
        for index in 0..<16 {
            ramp.append(30.0 + (170.0 * Double(index) / 15.0))
        }
        ramp += Array(repeating: 200.0, count: 8)
        let rampPx = transitionWidthPx(ramp)
        expect(rampPx != nil && (rampPx ?? 0) > 8 && !edgeIsSharp(transitionMm: (rampPx ?? 0) / 14), "a long ramp is a soft edge")
        expect(edgeIsSharp(transitionMm: 0.31) && !edgeIsSharp(transitionMm: 0.70), "0.31 mm is sharp and 0.70 mm is soft")

        let right = outwardUnit(from: 20, 5, to: 20, 35)
        expect(right != nil && abs((right?.x ?? 0) - 1) < 0.001 && abs(right?.y ?? 0) < 0.001, "the right edge points outward to the right")
        var buffer = [UInt8](repeating: 40, count: 48 * 48)
        for y in 0..<48 {
            for x in 24..<48 {
                buffer[y * 48 + x] = 210
            }
        }
        let measured = edgeTransitionMm(
            samples: buffer, width: 48, height: 48,
            ax: 24, ay: 8, bx: 24, by: 40,
            outwardX: 1, outwardY: 0, pxPerMm: 14
        )
        expect(measured != nil && edgeIsSharp(transitionMm: measured ?? 9), "a hard step on a buffer is sharp")

        var smoother = Smoother()
        smoother.push(pxPerMm: 26, edgeSharp: true)
        smoother.push(pxPerMm: 30, edgeSharp: true)
        smoother.push(pxPerMm: 30, edgeSharp: false)
        expect(smoother.pxPerMm == 30 && smoother.edgeSharp == false, "the latest edge check closes the shutter and the px/mm is the median")
        smoother.reset()
        expect(smoother.pxPerMm == nil && smoother.edgeSharp == false, "a lost card clears the guide")

        expect(shutterDebug(block: "no quad", freshFrames: 3, prompt: .hold, level: true) == "no quad", "no quad closes the shutter")
        expect(shutterDebug(block: "aspect fail", freshFrames: 3, prompt: .hold, level: true) == "aspect fail", "a bad aspect closes the shutter")
        expect(shutterDebug(block: "weak edge", freshFrames: 3, prompt: .hold, level: true) == "weak edge", "a weak edge closes the shutter")
        expect(shutterDebug(block: "small", freshFrames: 3, prompt: .holdSoft, level: true) == "small", "a small rectangle is reported ahead of the edge")
        expect(shutterDebug(block: "", freshFrames: 3, prompt: .holdSoft, level: true) == "soft", "a soft edge closes the shutter")
        expect(shutterDebug(block: "", freshFrames: 3, prompt: .tooClose, level: true) == "open", "too close does not close the shutter")
        expect(shutterDebug(block: "", freshFrames: 3, prompt: .moveCloser, level: true) == "open", "move closer does not close the shutter")
        expect(shutterDebug(block: "", freshFrames: 3, prompt: .hold, level: false) == "level", "tilt closes the shutter")
        expect(shutterDebug(block: "", freshFrames: 3, prompt: .moveCloser, level: false) == "level", "tilt closes the shutter ahead of the distance words")
        expect(shutterDebug(block: "", freshFrames: 3, prompt: .holdFocusing, level: true) == "focusing", "focus keeps the shutter closed")
        expect(shutterDebug(block: "", freshFrames: 1, prompt: .hold, level: true) == "settling", "one frame shows the box and does not open the shutter")
        expect(shutterDebug(block: "", freshFrames: 3, prompt: .hold, level: true) == "open", "three frames open the shutter")
        expect(shutterDebug(block: "", freshFrames: 2, prompt: .findCard, level: true) == "settling", "a quad with no px/mm is still settling")
    }
    #endif
}
