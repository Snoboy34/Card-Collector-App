import CoreGraphics
import Foundation
import Vision

/// Live card box. Vision finds and follows one rectangle. Mat texture is
/// rejected by size, confidence, and a real brightness step on every side.
/// The phone does not decide the outer cut. That stays on the server, from
/// the full still.
enum CardVisionTrack {
    static let minimumConfidence: Float = 0.85
    static let trackMinimumConfidence: Float = 0.50
    static let minimumAspect: Float = 0.55
    static let maximumAspect: Float = 0.85
    /// Shorter side of the rectangle, as a fraction of the image's shorter side.
    /// Vision's own default is 0.2. A card at 14 cm is still well above this.
    /// A patch of mat texture is not.
    static let minimumSize: Float = 0.25
    static let quadratureTolerance: Float = 20
    static let maximumObservations = 8
    /// Share of the frame. A framed card from 14 cm to 9 cm is about 0.24–0.58.
    static let minimumAreaFraction = 0.12
    /// Gray levels across each side, outside to inside. Pink-mat texture is
    /// a few levels. The white card edge on that mat is several times this.
    static let minimumEdgeContrast = 32.0
    /// Area ratio below which an overlapping rectangle is a different, smaller
    /// one (the inner frame). Moving the phone back a few millimetres stays
    /// above this. A shrink past it has to show up again on the next frame,
    /// and only if no larger rectangle is still found.
    static let shrinkRatio = 0.92
    static let overlapKeep = 0.35
    /// How far one frame may pull the shown box. Position and size move together.
    static let blend = 0.40

    struct Quad: Equatable {
        struct Point: Equatable {
            var x: Double
            var y: Double
        }

        var tl: Point
        var tr: Point
        var br: Point
        var bl: Point
        var confidence: Double

        var center: Point {
            Point(
                x: (tl.x + tr.x + br.x + bl.x) / 4,
                y: (tl.y + tr.y + br.y + bl.y) / 4
            )
        }

        var bounds: (minX: Double, minY: Double, maxX: Double, maxY: Double) {
            let xs = [tl.x, tr.x, br.x, bl.x]
            let ys = [tl.y, tr.y, br.y, bl.y]
            return (xs.min() ?? 0, ys.min() ?? 0, xs.max() ?? 0, ys.max() ?? 0)
        }

        /// Share of the frame. Normalized x and y are already fractions of the image.
        var area: Double {
            let box = bounds
            return max(0, box.maxX - box.minX) * max(0, box.maxY - box.minY)
        }

        func aspect(imageWidth: Double, imageHeight: Double) -> Double {
            func length(_ a: Point, _ b: Point) -> Double {
                let dx = (a.x - b.x) * imageWidth
                let dy = (a.y - b.y) * imageHeight
                return hypot(dx, dy)
            }
            let width = (length(tl, tr) + length(bl, br)) / 2
            let height = (length(tl, bl) + length(tr, br)) / 2
            guard height > 1 else { return 0 }
            return width / height
        }

        func iou(_ other: Quad) -> Double {
            let a = bounds
            let b = other.bounds
            let overlapW = min(a.maxX, b.maxX) - max(a.minX, b.minX)
            let overlapH = min(a.maxY, b.maxY) - max(a.minY, b.minY)
            let inter = max(0, overlapW) * max(0, overlapH)
            let union = area + other.area - inter
            guard union > 1e-6 else { return 0 }
            return inter / union
        }
    }

    enum Choice: Equatable {
        case adopt(Quad)
        case stay
        case none
    }

    /// Largest card-shaped quad. A smaller one that still overlaps the
    /// current quad does not replace it.
    static func choose(current: Quad?, candidates: [Quad]) -> Choice {
        let ranked = candidates.sorted { $0.area > $1.area }
        guard let current else {
            if let best = ranked.first { return .adopt(best) }
            return .none
        }
        let overlapping = ranked.filter { $0.iou(current) >= overlapKeep }
        if let keep = overlapping.first(where: { $0.area + 1e-6 >= current.area * shrinkRatio }) {
            return .adopt(keep)
        }
        if !overlapping.isEmpty { return .stay }
        if let best = ranked.first { return .adopt(best) }
        return .none
    }

    /// `tracked` is the rectangle Vision is already following. Detections are
    /// other rectangles from this frame. A modest size change of the tracked
    /// rectangle is the phone moving. A much smaller one has to repeat for a
    /// second frame, and a larger overlapping detection still wins. A smaller
    /// detection never replaces the tracked card on its own.
    static func followTracked(holds: Int, current: Quad?, tracked: Quad?, detected: [Quad]) -> Choice {
        guard let current else {
            var pool = detected
            if let tracked { pool.append(tracked) }
            return choose(current: nil, candidates: pool)
        }
        var pool = detected
        if let tracked { pool.append(tracked) }
        let overlapping = pool.filter { $0.iou(current) >= overlapKeep }
        if let best = overlapping.filter({ $0.area + 1e-6 >= current.area * shrinkRatio }).max(by: { $0.area < $1.area }) {
            return .adopt(best)
        }
        if holds >= 1, let tracked {
            return .adopt(tracked)
        }
        if pool.isEmpty { return .none }
        return .stay
    }

    /// Nil when this quad may be shown. Otherwise the debug word.
    static func rejectReason(quad: Quad, contrast: Double, imageWidth: Double, imageHeight: Double) -> String? {
        if quad.area + 1e-9 < minimumAreaFraction { return "small" }
        let aspect = quad.aspect(imageWidth: imageWidth, imageHeight: imageHeight)
        if aspect < Double(minimumAspect) || aspect > Double(maximumAspect) { return "aspect fail" }
        if contrast < minimumEdgeContrast { return "weak edge" }
        return nil
    }

    static func failureLabel(quads: [Quad], contrasts: [Double], imageWidth: Double, imageHeight: Double) -> String {
        guard quads.count == contrasts.count, !quads.isEmpty else { return "no quad" }
        let index = quads.indices.max { quads[$0].area < quads[$1].area } ?? 0
        return rejectReason(
            quad: quads[index], contrast: contrasts[index],
            imageWidth: imageWidth, imageHeight: imageHeight
        ) ?? "no quad"
    }

    /// Minimum side contrast, in gray levels. `samples` is top-left row-major.
    /// The quad is Vision's bottom-left normalized rectangle.
    static func edgeContrast(samples: [UInt8], width: Int, height: Int, quad: Quad) -> Double {
        guard width > 4, height > 4, samples.count == width * height else { return 0 }
        func pixel(_ point: Quad.Point) -> (x: Double, y: Double) {
            (point.x * Double(width - 1), (1 - point.y) * Double(height - 1))
        }
        let corners = [pixel(quad.tl), pixel(quad.tr), pixel(quad.br), pixel(quad.bl)]
        let center = (
            x: corners.map(\.x).reduce(0, +) / 4,
            y: corners.map(\.y).reduce(0, +) / 4
        )
        var sideContrast: [Double] = []
        for index in 0..<4 {
            let a = corners[index]
            let b = corners[(index + 1) % 4]
            let midX = (a.x + b.x) / 2
            let midY = (a.y + b.y) / 2
            var nx = midX - center.x
            var ny = midY - center.y
            let norm = hypot(nx, ny)
            guard norm > 1 else {
                sideContrast.append(0)
                continue
            }
            nx /= norm
            ny /= norm
            var steps: [Double] = []
            for step in 0..<7 {
                let t = 0.30 + (0.40 * Double(step) / 6)
                let x = a.x + (b.x - a.x) * t
                let y = a.y + (b.y - a.y) * t
                let outside = sample(samples, width: width, height: height, x: x + nx * 5, y: y + ny * 5)
                let inside = sample(samples, width: width, height: height, x: x - nx * 5, y: y - ny * 5)
                if let outside, let inside {
                    steps.append(abs(inside - outside))
                }
            }
            sideContrast.append(median(steps) ?? 0)
        }
        return sideContrast.min() ?? 0
    }

    struct Lock {
        private(set) var shown: Quad?
        private(set) var freshFrames = 0

        mutating func reset() {
            shown = nil
            freshFrames = 0
        }

        mutating func adopt(_ measured: Quad) -> Quad {
            guard let shown else {
                self.shown = measured
                freshFrames = 1
                return measured
            }
            let next = Quad(
                tl: mix(shown.tl, measured.tl),
                tr: mix(shown.tr, measured.tr),
                br: mix(shown.br, measured.br),
                bl: mix(shown.bl, measured.bl),
                confidence: measured.confidence
            )
            self.shown = next
            freshFrames += 1
            return next
        }

        mutating func miss() {
            shown = nil
            freshFrames = 0
        }

        private func mix(_ current: Quad.Point, _ measured: Quad.Point) -> Quad.Point {
            Quad.Point(
                x: current.x * (1 - blend) + measured.x * blend,
                y: current.y * (1 - blend) + measured.y * blend
            )
        }
    }

    struct Outcome {
        var quad: Quad?
        var label: String
        var freshFrames: Int
    }

    /// One live frame. Detection acquires. Rectangle tracking follows.
    /// The shown box is the smoothed quad, which is not fed back into Vision,
    /// so a smoothed corner cannot drag the tracker.
    final class Session {
        private let sequence = VNSequenceRequestHandler()
        private var tracked: VNRectangleObservation?
        private var lock = Lock()
        private var shrinkHolds = 0
        private let gate = NSLock()

        func reset() {
            gate.lock()
            tracked = nil
            lock.reset()
            shrinkHolds = 0
            gate.unlock()
        }

        func step(_ image: CGImage) -> Outcome {
            gate.lock()
            defer { gate.unlock() }
            let width = image.width
            let height = image.height
            guard let gray = DistanceGuide.grayscale(image), gray.width == width, gray.height == height else {
                lock.miss()
                tracked = nil
                shrinkHolds = 0
                return Outcome(quad: nil, label: "no quad", freshFrames: 0)
            }
            var trackedPass: (Quad, VNRectangleObservation)?
            if let tracked {
                let request = VNTrackRectangleRequest(rectangleObservation: tracked)
                request.trackingLevel = .accurate
                if (try? sequence.perform([request], on: image, orientation: .up)) != nil,
                   let observation = request.results?.first as? VNRectangleObservation,
                   observation.confidence >= CardVisionTrack.trackMinimumConfidence {
                    let quad = Self.quad(from: observation)
                    let contrast = CardVisionTrack.edgeContrast(samples: gray.samples, width: width, height: height, quad: quad)
                    if CardVisionTrack.rejectReason(quad: quad, contrast: contrast, imageWidth: Double(width), imageHeight: Double(height)) == nil {
                        trackedPass = (quad, observation)
                    }
                }
            }
            if let trackedPass, let shown = lock.shown,
               trackedPass.0.iou(shown) >= CardVisionTrack.overlapKeep,
               trackedPass.0.area + 1e-6 >= shown.area * CardVisionTrack.shrinkRatio {
                shrinkHolds = 0
                self.tracked = trackedPass.1
                let next = lock.adopt(trackedPass.0)
                return Outcome(quad: next, label: "", freshFrames: lock.freshFrames)
            }
            let request = VNDetectRectanglesRequest()
            request.minimumAspectRatio = CardVisionTrack.minimumAspect
            request.maximumAspectRatio = CardVisionTrack.maximumAspect
            request.minimumConfidence = CardVisionTrack.minimumConfidence
            request.minimumSize = CardVisionTrack.minimumSize
            request.quadratureTolerance = CardVisionTrack.quadratureTolerance
            request.maximumObservations = CardVisionTrack.maximumObservations
            let handler = VNImageRequestHandler(cgImage: image, orientation: .up, options: [:])
            try? handler.perform([request])
            let observations = (request.results as? [VNRectangleObservation]) ?? []
            var quads: [Quad] = []
            var contrasts: [Double] = []
            var paired: [(Quad, VNRectangleObservation)] = []
            for observation in observations {
                let quad = Self.quad(from: observation)
                let contrast = CardVisionTrack.edgeContrast(samples: gray.samples, width: width, height: height, quad: quad)
                quads.append(quad)
                contrasts.append(contrast)
                if CardVisionTrack.rejectReason(quad: quad, contrast: contrast, imageWidth: Double(width), imageHeight: Double(height)) == nil {
                    paired.append((quad, observation))
                }
            }
            if let trackedPass, !paired.contains(where: { $0.0 == trackedPass.0 }) {
                paired.append(trackedPass)
            }
            switch CardVisionTrack.followTracked(
                holds: shrinkHolds,
                current: lock.shown,
                tracked: trackedPass?.0,
                detected: paired.map(\.0)
            ) {
            case .adopt(let chosen):
                shrinkHolds = 0
                tracked = paired.first { $0.0 == chosen }?.1 ?? trackedPass?.1
                let next = lock.adopt(chosen)
                return Outcome(quad: next, label: "", freshFrames: lock.freshFrames)
            case .stay:
                shrinkHolds += 1
                return held(on: gray.samples, width: width, height: height, passing: paired)
            case .none:
                break
            }
            let label = CardVisionTrack.failureLabel(
                quads: quads, contrasts: contrasts,
                imageWidth: Double(width), imageHeight: Double(height)
            )
            lock.miss()
            tracked = nil
            shrinkHolds = 0
            return Outcome(quad: nil, label: label, freshFrames: 0)
        }

        /// The current box is still the one we want. Drop it only when its
        /// own edge has fallen to mat texture, and then only for a real card.
        private func held(on samples: [UInt8], width: Int, height: Int, passing: [(Quad, VNRectangleObservation)]) -> Outcome {
            guard let shown = lock.shown else {
                lock.miss()
                tracked = nil
                return Outcome(quad: nil, label: "no quad", freshFrames: 0)
            }
            let contrast = CardVisionTrack.edgeContrast(samples: samples, width: width, height: height, quad: shown)
            if CardVisionTrack.rejectReason(quad: shown, contrast: contrast, imageWidth: Double(width), imageHeight: Double(height)) == nil {
                return Outcome(quad: shown, label: "", freshFrames: lock.freshFrames)
            }
            if let best = passing.max(by: { $0.0.area < $1.0.area }) {
                shrinkHolds = 0
                tracked = best.1
                let adopted = lock.adopt(best.0)
                return Outcome(quad: adopted, label: "", freshFrames: lock.freshFrames)
            }
            lock.miss()
            tracked = nil
            shrinkHolds = 0
            return Outcome(quad: nil, label: "weak edge", freshFrames: 0)
        }

        private static func quad(from observation: VNRectangleObservation) -> Quad {
            func point(_ value: CGPoint) -> Quad.Point { Quad.Point(x: Double(value.x), y: Double(value.y)) }
            return Quad(
                tl: point(observation.topLeft),
                tr: point(observation.topRight),
                br: point(observation.bottomRight),
                bl: point(observation.bottomLeft),
                confidence: Double(observation.confidence)
            )
        }
    }

    private static func sample(_ samples: [UInt8], width: Int, height: Int, x: Double, y: Double) -> Double? {
        let ix = Int(x.rounded())
        let iy = Int(y.rounded())
        guard ix >= 0, iy >= 0, ix < width, iy < height else { return nil }
        return Double(samples[iy * width + ix])
    }

    private static func median(_ values: [Double]) -> Double? {
        guard !values.isEmpty else { return nil }
        let sorted = values.sorted()
        let mid = sorted.count / 2
        if sorted.count % 2 == 1 { return sorted[mid] }
        return (sorted[mid - 1] + sorted[mid]) / 2
    }

    #if DEBUG
    static func runContractChecks(_ check: ContractCheck) {
        func expect(_ condition: @autoclosure () -> Bool, _ message: @autoclosure () -> String, file: StaticString = #filePath, line: UInt = #line) {
            check(condition(), message(), file, line)
        }
        let outer = axisQuad(minX: 0.20, minY: 0.15, maxX: 0.80, maxY: 0.85)
        let inner = axisQuad(minX: 0.28, minY: 0.24, maxX: 0.72, maxY: 0.76)
        let texture = axisQuad(minX: 0.02, minY: 0.02, maxX: 0.16, maxY: 0.18)
        expect(outer.area > minimumAreaFraction && texture.area < minimumAreaFraction, "a card covers the frame and a texture patch does not")
        if case .adopt(let chosen) = choose(current: nil, candidates: [inner, outer, texture]) {
            expect(abs(chosen.area - outer.area) < 1e-6, "acquisition takes the largest rectangle")
        } else {
            expect(false, "acquisition takes the largest rectangle")
        }
        if case .stay = choose(current: outer, candidates: [inner]) {
            expect(true, "an inner frame does not replace the card")
        } else {
            expect(false, "an inner frame does not replace the card")
        }
        if case .adopt(let kept) = choose(current: outer, candidates: [inner, outer]) {
            expect(abs(kept.area - outer.area) < 1e-6, "the card stays chosen while it is still found")
        } else {
            expect(false, "the card stays chosen while it is still found")
        }
        let closer = axisQuad(minX: 0.16, minY: 0.10, maxX: 0.84, maxY: 0.90)
        if case .adopt(let grown) = choose(current: outer, candidates: [closer]) {
            expect(grown.area > outer.area, "moving closer may grow the same card")
        } else {
            expect(false, "moving closer may grow the same card")
        }
        let modest = axisQuad(minX: 0.206, minY: 0.157, maxX: 0.794, maxY: 0.843)
        if case .adopt(let same) = followTracked(holds: 0, current: outer, tracked: modest, detected: []) {
            expect(same.area < outer.area && same.area > outer.area * shrinkRatio, "a small step back stays on the same card")
        } else {
            expect(false, "a small step back stays on the same card")
        }
        if case .stay = followTracked(holds: 0, current: outer, tracked: inner, detected: []) {
            expect(true, "one frame of a much smaller rectangle does not switch")
        } else {
            expect(false, "one frame of a much smaller rectangle does not switch")
        }
        if case .adopt(let followed) = followTracked(holds: 1, current: outer, tracked: inner, detected: []) {
            expect(abs(followed.area - inner.area) < 1e-6, "a smaller tracked card that remains is followed")
        } else {
            expect(false, "a smaller tracked card that remains is followed")
        }
        if case .adopt(let outerStill) = followTracked(holds: 1, current: outer, tracked: inner, detected: [outer]) {
            expect(abs(outerStill.area - outer.area) < 1e-6, "the outer rectangle wins while it is still found")
        } else {
            expect(false, "the outer rectangle wins while it is still found")
        }
        if case .stay = followTracked(holds: 1, current: outer, tracked: nil, detected: [inner]) {
            expect(true, "a smaller detection does not replace the tracked card")
        } else {
            expect(false, "a smaller detection does not replace the tracked card")
        }
        let elsewhere = axisQuad(minX: 0.00, minY: 0.00, maxX: 0.12, maxY: 0.10)
        if case .stay = followTracked(holds: 0, current: outer, tracked: elsewhere, detected: []) {
            expect(true, "one detection off the card does not move the box")
        } else {
            expect(false, "one detection off the card does not move the box")
        }

        var lock = Lock()
        let first = lock.adopt(outer)
        expect(abs(first.center.x - outer.center.x) < 1e-6 && lock.freshFrames == 1, "the first frame shows the card and does not wait")
        let shifted = axisQuad(minX: 0.25, minY: 0.10, maxX: 0.95, maxY: 0.90)
        let eased = lock.adopt(shifted)
        expect(eased.center.x > outer.center.x && eased.center.x < shifted.center.x, "position eases instead of jumping")
        expect(eased.area > outer.area && eased.area < shifted.area, "one frame eases the size and does not jump to the new rectangle")
        expect(lock.freshFrames == 2, "the second good frame is not yet enough to open the shutter")
        lock.miss()
        expect(lock.shown == nil && lock.freshFrames == 0, "a lost card clears the box")

        let card = paintedCard()
        let cardQuad = axisQuad(minX: 30.0 / 199, minY: 1 - 250.0 / 299, maxX: 170.0 / 199, maxY: 1 - 40.0 / 299)
        let cardContrast = edgeContrast(samples: card.samples, width: card.width, height: card.height, quad: cardQuad)
        expect(cardContrast >= minimumEdgeContrast, "the white card edge clears the contrast floor")
        let matQuad = axisQuad(minX: 4.0 / 199, minY: 1 - 36.0 / 299, maxX: 36.0 / 199, maxY: 1 - 4.0 / 299)
        let matContrast = edgeContrast(samples: card.samples, width: card.width, height: card.height, quad: matQuad)
        expect(matContrast < minimumEdgeContrast, "bare mat has no card-level edge")
        expect(rejectReason(quad: matQuad, contrast: matContrast, imageWidth: 200, imageHeight: 300) == "small", "a mat patch is too small to be a card")
        expect(rejectReason(quad: cardQuad, contrast: cardContrast, imageWidth: 200, imageHeight: 300) == nil, "a card-sized strong edge is accepted")
        let weakCard = axisQuad(minX: 0.15, minY: 0.15, maxX: 0.85, maxY: 0.85)
        expect(rejectReason(quad: weakCard, contrast: 10, imageWidth: 100, imageHeight: 140) == "weak edge", "a card-shaped rectangle on bare mat is a weak edge")
        expect(failureLabel(quads: [texture], contrasts: [4], imageWidth: 100, imageHeight: 140) == "small", "texture reports small")
        expect(failureLabel(quads: [], contrasts: [], imageWidth: 100, imageHeight: 140) == "no quad", "nothing to detect reports no quad")
    }

    private static func axisQuad(minX: Double, minY: Double, maxX: Double, maxY: Double) -> Quad {
        Quad(
            tl: Quad.Point(x: minX, y: maxY),
            tr: Quad.Point(x: maxX, y: maxY),
            br: Quad.Point(x: maxX, y: minY),
            bl: Quad.Point(x: minX, y: minY),
            confidence: 0.95
        )
    }

    /// Pink field, white card. Top-left pixels. 200×300.
    private static func paintedCard() -> (samples: [UInt8], width: Int, height: Int) {
        let width = 200
        let height = 300
        var samples = [UInt8](repeating: 120, count: width * height)
        for y in 40..<250 {
            for x in 30..<170 {
                samples[y * width + x] = 235
            }
        }
        return (samples, width, height)
    }
    #endif
}
