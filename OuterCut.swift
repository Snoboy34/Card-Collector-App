import CoreGraphics
import Foundation
import UIKit

/// Physical card size for the selected profile. The live quad has to match
/// this aspect. Sports and entertainment cards are 2.5×3.5 in. Pokémon and
/// Magic cards are 63×88 mm.
enum CardFaceSize {
    struct Millimetres: Equatable {
        var width: Double
        var height: Double
        var aspect: Double { width / height }
    }

    static let sports = Millimetres(width: 63.5, height: 88.9)
    static let tcg = Millimetres(width: 63.0, height: 88.0)

    static func size(for category: CardCategory) -> Millimetres {
        switch category {
        case .sports, .entertainment: return sports
        case .tcg, .mtg: return tcg
        }
    }
}

/// The card's outer cut: the largest card-shaped quad whose outside is the
/// mat, not an inner printed frame. Chroma (not brightness) keeps a shadow
/// or a glare patch from counting as the card, and keeps a blue or black
/// inner frame from winning just because it is a stronger edge.
///
/// Live tracking uses `locate` and accepts any card-shaped quad, including
/// one whose edge is clipped or whose corners are covered. The strict face
/// aspect and the runner-up flag only decide the shutter and the upload.
///
/// A second step in the same window the server uses (#92) marks the cut
/// low-confidence. The quad is still the outer edge. The upload then sends
/// the full still instead of cropping.
enum OuterCut {
    /// Same ratios as services/card_quad.js cut confidence. The 3 px window
    /// is at 10 px/mm, which is one pixel of the 900 px grading raster.
    static let runnerUpRatio = 0.6
    static let runnerUpMaxPx = 3.0
    static let runnerUpWideRatio = 0.8
    static let aspectTolerance = 0.10
    /// Same window the previous rectangle finder used for acquisition.
    /// The 10% face check is only for the shutter and the upload.
    static let trackAspectMin = 0.55
    static let trackAspectMax = 0.85
    static let chromaThreshold = 0.12
    static let searchLongSide = 640

    struct Point: Equatable {
        var x: Double
        var y: Double
    }

    struct Result: Equatable {
        var tl: Point
        var tr: Point
        var br: Point
        var bl: Point
        var confident: Bool
        var imageWidth: Int
        var imageHeight: Int

        var norm: Norm {
            let w = Double(imageWidth)
            let h = Double(imageHeight)
            func n(_ p: Point) -> Norm.Point { Norm.Point(x: p.x / w, y: p.y / h) }
            return Norm(tl: n(tl), tr: n(tr), br: n(br), bl: n(bl))
        }

        func cardQuad() -> JudgeAPIClient.CardQuad {
            JudgeAPIClient.CardQuad(
                tl: [tl.x, tl.y], tr: [tr.x, tr.y], br: [br.x, br.y], bl: [bl.x, bl.y],
                imageWidth: imageWidth, imageHeight: imageHeight, confidence: confident ? 0.9 : 0.5
            )
        }
    }

    struct Norm: Equatable {
        struct Point: Equatable {
            var x: Double
            var y: Double
        }

        var tl: Point
        var tr: Point
        var br: Point
        var bl: Point

        var height: Double {
            let left = hypot(tl.x - bl.x, tl.y - bl.y)
            let right = hypot(tr.x - br.x, tr.y - br.y)
            return (left + right) / 2
        }

        var center: Point {
            Point(
                x: (tl.x + tr.x + br.x + bl.x) / 4,
                y: (tl.y + tr.y + br.y + bl.y) / 4
            )
        }

        var width: Double {
            let top = hypot(tl.x - tr.x, tl.y - tr.y)
            let bottom = hypot(bl.x - br.x, bl.y - br.y)
            return (top + bottom) / 2
        }

        var aspect: Double {
            let h = height
            guard h > 1e-6 else { return 0 }
            return width / h
        }

        /// Move the quad without changing its size or aspect.
        func translated(to center: Point) -> Norm {
            let dx = center.x - self.center.x
            let dy = center.y - self.center.y
            func shift(_ point: Point) -> Point { Point(x: point.x + dx, y: point.y + dy) }
            return Norm(tl: shift(tl), tr: shift(tr), br: shift(br), bl: shift(bl))
        }
    }

    /// Live acquisition. A card-shaped quad is enough to draw the box.
    /// `aspectFail` means a region was found and it is not card-shaped.
    enum Locate: Equatable {
        case noQuad
        case aspectFail
        case quad(Hit)

        struct Hit: Equatable {
            var result: Result
            /// Within 10% of the selected card type. The shutter uses this.
            var matchesFace: Bool
        }
    }

    /// Position is the median of the last three centers. Size and aspect
    /// stay on the latest quad, so moving closer does not skew the box.
    /// The box is the first frame. The shutter waits for three strict frames.
    struct Tracker {
        private var centers: [Norm.Point] = []
        private var last: Norm?
        private(set) var freshCount = 0

        mutating func reset() {
            centers = []
            last = nil
            freshCount = 0
        }

        var shutterSettled: Bool { freshCount >= 3 }

        mutating func push(_ quad: Norm, strict: Bool) -> Norm {
            centers.append(quad.center)
            if centers.count > 3 { centers.removeFirst() }
            if strict {
                freshCount += 1
            } else {
                freshCount = 0
            }
            let shown = quad.translated(to: Self.medianPoint(centers))
            last = shown
            return shown
        }

        /// This frame had no card. Keep the last box and search again.
        mutating func miss() -> Norm? {
            freshCount = 0
            centers = []
            return last
        }

        static func medianPoint(_ points: [Norm.Point]) -> Norm.Point {
            Norm.Point(x: OuterCut.median(points.map(\.x)), y: OuterCut.median(points.map(\.y)))
        }
    }

    static func cutIsLowConfidence(runnerUpRatio ratio: Double, offsetAtTenPxPerMm offset: Double?) -> Bool {
        guard let offset else { return false }
        return (ratio >= runnerUpRatio && abs(offset) <= runnerUpMaxPx) || ratio >= runnerUpWideRatio
    }

    /// Preview-layer `.resizeAspectFill` maps a top-left-normalized image
    /// point into the camera view.
    static func aspectFill(x: Double, y: Double, imageWidth: Double, imageHeight: Double, viewWidth: Double, viewHeight: Double) -> CGPoint {
        guard imageWidth > 1, imageHeight > 1, viewWidth > 1, viewHeight > 1 else {
            return CGPoint(x: x * viewWidth, y: y * viewHeight)
        }
        let imageAspect = imageWidth / imageHeight
        let viewAspect = viewWidth / viewHeight
        if imageAspect > viewAspect {
            let scale = viewHeight / imageHeight
            let xOff = (imageWidth * scale - viewWidth) / 2
            return CGPoint(x: x * imageWidth * scale - xOff, y: y * imageHeight * scale)
        }
        let scale = viewWidth / imageWidth
        let yOff = (imageHeight * scale - viewHeight) / 2
        return CGPoint(x: x * imageWidth * scale, y: y * imageHeight * scale - yOff)
    }

    static func find(in image: CGImage, face: CardFaceSize.Millimetres) -> Result? {
        guard case .quad(let hit) = search(in: image, face: face, tracking: false) else { return nil }
        return hit.result
    }

    /// Card-shaped quad for the live box. The strict face aspect and the
    /// runner-up flag travel with it and do not hide the box.
    static func locate(in image: CGImage, face: CardFaceSize.Millimetres) -> Locate {
        search(in: image, face: face, tracking: true)
    }

    /// `bytes` is packed RGB, row-major, origin top-left.
    static func find(bytes: [UInt8], width: Int, height: Int, face: CardFaceSize.Millimetres) -> Result? {
        guard case .quad(let hit) = search(bytes: bytes, width: width, height: height, face: face, tracking: false) else {
            return nil
        }
        return hit.result
    }

    static func locate(bytes: [UInt8], width: Int, height: Int, face: CardFaceSize.Millimetres) -> Locate {
        search(bytes: bytes, width: width, height: height, face: face, tracking: true)
    }

    private static func search(in image: CGImage, face: CardFaceSize.Millimetres, tracking: Bool) -> Locate {
        let sourceW = image.width
        let sourceH = image.height
        guard sourceW > 8, sourceH > 8 else { return .noQuad }
        let scale = min(1.0, Double(searchLongSide) / Double(max(sourceW, sourceH)))
        let sw = max(1, Int((Double(sourceW) * scale).rounded()))
        let sh = max(1, Int((Double(sourceH) * scale).rounded()))
        guard let bytes = rgbBytes(image, width: sw, height: sh) else { return .noQuad }
        let found = search(bytes: bytes, width: sw, height: sh, face: face, tracking: tracking)
        guard case .quad(let hit) = found else { return found }
        let sx = Double(sourceW) / Double(sw)
        let sy = Double(sourceH) / Double(sh)
        func s(_ p: Point) -> Point { Point(x: p.x * sx, y: p.y * sy) }
        let scaled = Result(
            tl: s(hit.result.tl), tr: s(hit.result.tr), br: s(hit.result.br), bl: s(hit.result.bl),
            confident: hit.result.confident, imageWidth: sourceW, imageHeight: sourceH
        )
        return .quad(Locate.Hit(result: scaled, matchesFace: hit.matchesFace))
    }

    /// `bytes` is packed RGB, row-major, origin top-left.
    private static func search(bytes: [UInt8], width: Int, height: Int, face: CardFaceSize.Millimetres, tracking: Bool) -> Locate {
        guard width > 16, height > 16, bytes.count == width * height * 3, face.height > 1, face.aspect > 0 else {
            return .noQuad
        }
        guard let bg = backgroundChroma(bytes: bytes, width: width, height: height, loose: tracking) else { return .noQuad }
        var mask = [Bool](repeating: false, count: width * height)
        for i in 0..<(width * height) {
            let o = i * 3
            mask[i] = chromaDistance(Double(bytes[o]), Double(bytes[o + 1]), Double(bytes[o + 2]), bg) > chromaThreshold
        }
        var colSum = [Int](repeating: 0, count: width)
        var rowSum = [Int](repeating: 0, count: height)
        for y in 0..<height {
            for x in 0..<width where mask[y * width + x] {
                colSum[x] += 1
                rowSum[y] += 1
            }
        }
        let xs = (0..<width).filter { Double(colSum[$0]) / Double(height) > 0.12 }
        let ys = (0..<height).filter { Double(rowSum[$0]) / Double(width) > 0.12 }
        guard let xLo = xs.first, let xHi = xs.last, let yLo = ys.first, let yHi = ys.last,
              xHi - xLo > 10, yHi - yLo > 10 else { return .noQuad }

        func points(side: String) -> [Point] {
            var pts: [Point] = []
            if side == "top" || side == "bottom" {
                let x0 = xLo + Int(0.22 * Double(xHi - xLo))
                let x1 = xLo + Int(0.78 * Double(xHi - xLo))
                var x = x0
                while x < x1 {
                    if side == "top" {
                        var y = 0
                        while y < height - 3 && !(mask[y * width + x] && mask[(y + 1) * width + x] && mask[(y + 2) * width + x]) {
                            y += 1
                        }
                        if y > 1 && y < height - 3 { pts.append(Point(x: Double(x), y: Double(y))) }
                    } else {
                        var y = height - 1
                        while y > 2 && !(mask[y * width + x] && mask[(y - 1) * width + x] && mask[(y - 2) * width + x]) {
                            y -= 1
                        }
                        if y > 1 && y < height - 3 { pts.append(Point(x: Double(x), y: Double(y))) }
                    }
                    x += 2
                }
            } else {
                let y0 = yLo + Int(0.22 * Double(yHi - yLo))
                let y1 = yLo + Int(0.78 * Double(yHi - yLo))
                var y = y0
                while y < y1 {
                    if side == "left" {
                        var x = 0
                        while x < width - 3 && !(mask[y * width + x] && mask[y * width + x + 1] && mask[y * width + x + 2]) {
                            x += 1
                        }
                        if x > 1 && x < width - 3 { pts.append(Point(x: Double(x), y: Double(y))) }
                    } else {
                        var x = width - 1
                        while x > 2 && !(mask[y * width + x] && mask[y * width + x - 1] && mask[y * width + x - 2]) {
                            x -= 1
                        }
                        if x > 1 && x < width - 3 { pts.append(Point(x: Double(x), y: Double(y))) }
                    }
                    y += 2
                }
            }
            return pts
        }

        let fittedTop = fitLine(points(side: "top"), vary: "y", loose: tracking)
        let fittedBottom = fitLine(points(side: "bottom"), vary: "y", loose: tracking)
        let fittedLeft = fitLine(points(side: "left"), vary: "x", loose: tracking)
        let fittedRight = fitLine(points(side: "right"), vary: "x", loose: tracking)
        func side(_ fitted: Line?, _ box: Line) -> Line? {
            if let fitted { return fitted }
            if tracking { return box }
            return nil
        }
        let top = side(fittedTop, Line(a: 0, b: Double(yLo)))
        let bottom = side(fittedBottom, Line(a: 0, b: Double(yHi)))
        let left = side(fittedLeft, Line(a: 0, b: Double(xLo)))
        let right = side(fittedRight, Line(a: 0, b: Double(xHi)))
        let fallback = fittedTop == nil || fittedBottom == nil || fittedLeft == nil || fittedRight == nil
        guard let top, let bottom, let left, let right,
              let tl = intersect(horizontal: top, vertical: left),
              let tr = intersect(horizontal: top, vertical: right),
              let br = intersect(horizontal: bottom, vertical: right),
              let bl = intersect(horizontal: bottom, vertical: left) else { return .noQuad }

        let widthPx = (hypot(tl.x - tr.x, tl.y - tr.y) + hypot(bl.x - br.x, bl.y - br.y)) / 2
        let heightPx = (hypot(tl.x - bl.x, tl.y - bl.y) + hypot(tr.x - br.x, tr.y - br.y)) / 2
        guard heightPx > 8 else { return .noQuad }
        let aspect = widthPx / heightPx
        let matchesFace = abs(aspect - face.aspect) / face.aspect <= aspectTolerance
        let tracks = aspect >= trackAspectMin && aspect <= trackAspectMax
        if tracking {
            guard tracks else { return .aspectFail }
        } else {
            guard matchesFace else { return .noQuad }
            let corners = [tl, tr, br, bl]
            guard corners.allSatisfy({ $0.x > 1 && $0.y > 1 && $0.x < Double(width - 2) && $0.y < Double(height - 2) }) else {
                return .noQuad
            }
            guard outsideIsBackground(side: "top", line: top, atX: (tl.x + tr.x) / 2, bytes: bytes, width: width, height: height, bg: bg),
                  outsideIsBackground(side: "bottom", line: bottom, atX: (bl.x + br.x) / 2, bytes: bytes, width: width, height: height, bg: bg),
                  outsideIsBackground(side: "left", line: left, atY: (tl.y + bl.y) / 2, bytes: bytes, width: width, height: height, bg: bg),
                  outsideIsBackground(side: "right", line: right, atY: (tr.y + br.y) / 2, bytes: bytes, width: width, height: height, bg: bg) else {
                return .noQuad
            }
        }

        let pxPerMm = heightPx / face.height
        let reports = [
            edgeReport(side: "top", x0: (tl.x + tr.x) / 2, y0: top.a * (tl.x + tr.x) / 2 + top.b, dx: 0, dy: 1, sideLength: widthPx, bytes: bytes, width: width, height: height, pxPerMm: pxPerMm),
            edgeReport(side: "bottom", x0: (bl.x + br.x) / 2, y0: bottom.a * (bl.x + br.x) / 2 + bottom.b, dx: 0, dy: -1, sideLength: widthPx, bytes: bytes, width: width, height: height, pxPerMm: pxPerMm),
            edgeReport(side: "left", x0: left.a * (tl.y + bl.y) / 2 + left.b, y0: (tl.y + bl.y) / 2, dx: 1, dy: 0, sideLength: heightPx, bytes: bytes, width: width, height: height, pxPerMm: pxPerMm),
            edgeReport(side: "right", x0: right.a * (tr.y + br.y) / 2 + right.b, y0: (tr.y + br.y) / 2, dx: -1, dy: 0, sideLength: heightPx, bytes: bytes, width: width, height: height, pxPerMm: pxPerMm)
        ]
        let confident = !fallback && reports.allSatisfy { !cutIsLowConfidence(runnerUpRatio: $0.ratio, offsetAtTenPxPerMm: $0.offset10) }
        let result = Result(tl: tl, tr: tr, br: br, bl: bl, confident: confident, imageWidth: width, imageHeight: height)
        return .quad(Locate.Hit(result: result, matchesFace: matchesFace))
    }

    private struct Line {
        var a: Double
        var b: Double
    }

    private struct EdgeReport {
        var ratio: Double
        var offset10: Double?
    }

    private static func backgroundChroma(bytes: [UInt8], width: Int, height: Int, loose: Bool) -> (Double, Double, Double)? {
        let m = max(6, Int(Double(min(width, height)) * 0.04))
        let midX = max(0, (width - m) / 2)
        let midY = max(0, (height - m) / 2)
        var origins = [(0, 0), (width - m, 0), (0, height - m), (width - m, height - m)]
        if loose {
            origins += [(midX, 0), (midX, height - m), (0, midY), (width - m, midY)]
        }
        var medians: [(Double, Double, Double)] = []
        for origin in origins {
            var rs: [Double] = []
            var gs: [Double] = []
            var bs: [Double] = []
            for y in origin.1..<(origin.1 + m) {
                for x in origin.0..<(origin.0 + m) {
                    let o = (y * width + x) * 3
                    rs.append(Double(bytes[o]))
                    gs.append(Double(bytes[o + 1]))
                    bs.append(Double(bytes[o + 2]))
                }
            }
            medians.append((median(rs), median(gs), median(bs)))
        }
        let chromas = medians.map { chroma($0.0, $0.1, $0.2) }
        let center = (
            median(chromas.map(\.0)),
            median(chromas.map(\.1)),
            median(chromas.map(\.2))
        )
        if loose {
            return looseBackground(medians: medians, bytes: bytes, width: width, height: height)
        }
        let distances = chromas.map { chromaDistance($0.0, $0.1, $0.2, center) }
        var keep = Array(repeating: true, count: medians.count)
        if let worst = distances.enumerated().max(by: { $0.element < $1.element })?.offset, distances[worst] > 0.08 {
            keep[worst] = false
        }
        let kept = medians.enumerated().filter { keep[$0.offset] }.map(\.element)
        guard kept.count >= 3 else { return nil }
        let bg = (median(kept.map(\.0)), median(kept.map(\.1)), median(kept.map(\.2)))
        return chroma(bg.0, bg.1, bg.2)
    }

    /// The mat is the border color that agrees with itself, even when the
    /// card covers two corners. A split between card and mat does not follow
    /// whichever sample happens to sit on the median.
    private static func looseBackground(medians: [(Double, Double, Double)], bytes: [UInt8], width: Int, height: Int) -> (Double, Double, Double)? {
        let chromas = medians.map { chroma($0.0, $0.1, $0.2) }
        var best: [Int] = []
        var bestVotes = -1
        for seed in chromas.indices {
            let group = medians.indices.filter {
                chromaDistance(medians[$0].0, medians[$0].1, medians[$0].2, chromas[seed]) <= 0.08
            }
            guard group.count >= 2 else { continue }
            let rgb = (
                median(group.map { medians[$0].0 }),
                median(group.map { medians[$0].1 }),
                median(group.map { medians[$0].2 })
            )
            let votes = borderVotes(for: chroma(rgb.0, rgb.1, rgb.2), bytes: bytes, width: width, height: height)
            if votes > bestVotes {
                bestVotes = votes
                best = Array(group)
            }
        }
        guard best.count >= 2, bestVotes > 0 else { return nil }
        let bg = (
            median(best.map { medians[$0].0 }),
            median(best.map { medians[$0].1 }),
            median(best.map { medians[$0].2 })
        )
        return chroma(bg.0, bg.1, bg.2)
    }

    private static func borderVotes(for bg: (Double, Double, Double), bytes: [UInt8], width: Int, height: Int) -> Int {
        var votes = 0
        var seen = 0
        func consider(_ x: Int, _ y: Int) {
            seen += 1
            if seen % 3 != 0 { return }
            let o = (y * width + x) * 3
            if chromaDistance(Double(bytes[o]), Double(bytes[o + 1]), Double(bytes[o + 2]), bg) <= chromaThreshold {
                votes += 1
            }
        }
        guard width > 2, height > 2 else { return 0 }
        for x in 0..<width {
            consider(x, 0)
            consider(x, height - 1)
        }
        for y in 1..<(height - 1) {
            consider(0, y)
            consider(width - 1, y)
        }
        return votes
    }

    private static func fitLine(_ pts: [Point], vary: String, loose: Bool) -> Line? {
        let minimumPoints = loose ? 4 : 8
        guard pts.count >= minimumPoints else { return nil }
        let sorted: [Point]
        if vary == "y" {
            sorted = pts.sorted { $0.x < $1.x }
        } else {
            sorted = pts.sorted { $0.y < $1.y }
        }
        let k = max(3, sorted.count / 5)
        let head = Array(sorted.prefix(k))
        let tail = Array(sorted.suffix(k))
        let a0: Double
        let b0: Double
        if vary == "y" {
            let left = Point(x: median(head.map(\.x)), y: median(head.map(\.y)))
            let right = Point(x: median(tail.map(\.x)), y: median(tail.map(\.y)))
            let span = right.x - left.x
            guard abs(span) >= (loose ? 2 : 4) else { return nil }
            a0 = (right.y - left.y) / span
            b0 = left.y - a0 * left.x
        } else {
            let top = Point(x: median(head.map(\.x)), y: median(head.map(\.y)))
            let bot = Point(x: median(tail.map(\.x)), y: median(tail.map(\.y)))
            let span = bot.y - top.y
            guard abs(span) >= (loose ? 2 : 4) else { return nil }
            a0 = (bot.x - top.x) / span
            b0 = top.x - a0 * top.y
        }
        let inliers = sorted.filter { p in
            let err = vary == "y" ? abs(p.y - (a0 * p.x + b0)) : abs(p.x - (a0 * p.y + b0))
            return err <= (loose ? 8 : 4.5)
        }
        let minimumInliers = loose ? max(4, Int(0.30 * Double(sorted.count))) : max(6, Int(0.45 * Double(sorted.count)))
        guard inliers.count >= minimumInliers else { return nil }
        if vary == "y" {
            guard let line = leastSquares(xs: inliers.map(\.x), ys: inliers.map(\.y)) else { return nil }
            return line
        }
        guard let line = leastSquares(xs: inliers.map(\.y), ys: inliers.map(\.x)) else { return nil }
        return line
    }

    private static func leastSquares(xs: [Double], ys: [Double]) -> Line? {
        let n = Double(xs.count)
        guard n >= 2 else { return nil }
        var sumX = 0.0, sumY = 0.0, sumXX = 0.0, sumXY = 0.0
        for i in 0..<xs.count {
            sumX += xs[i]
            sumY += ys[i]
            sumXX += xs[i] * xs[i]
            sumXY += xs[i] * ys[i]
        }
        let den = n * sumXX - sumX * sumX
        guard abs(den) > 1e-6 else { return nil }
        let a = (n * sumXY - sumX * sumY) / den
        let b = (sumY - a * sumX) / n
        return Line(a: a, b: b)
    }

    private static func intersect(horizontal: Line, vertical: Line) -> Point? {
        let den = 1 - horizontal.a * vertical.a
        guard abs(den) > 1e-4 else { return nil }
        let y = (horizontal.a * vertical.b + horizontal.b) / den
        let x = vertical.a * y + vertical.b
        return Point(x: x, y: y)
    }

    private static func outsideIsBackground(side: String, line: Line, atX: Double = 0, atY: Double = 0, bytes: [UInt8], width: Int, height: Int, bg: (Double, Double, Double)) -> Bool {
        let x: Double
        let y: Double
        switch side {
        case "top":
            x = atX
            y = line.a * atX + line.b - 5
        case "bottom":
            x = atX
            y = line.a * atX + line.b + 5
        case "left":
            y = atY
            x = line.a * atY + line.b - 5
        default:
            y = atY
            x = line.a * atY + line.b + 5
        }
        let xx = Int(x.rounded())
        let yy = Int(y.rounded())
        guard xx >= 0, yy >= 0, xx < width, yy < height else { return false }
        let o = (yy * width + xx) * 3
        return chromaDistance(Double(bytes[o]), Double(bytes[o + 1]), Double(bytes[o + 2]), bg) <= chromaThreshold
    }

    private static func edgeReport(side: String, x0: Double, y0: Double, dx: Double, dy: Double, sideLength: Double, bytes: [UInt8], width: Int, height: Int, pxPerMm: Double) -> EdgeReport {
        let expand = max(4, Int((sideLength * 0.02).rounded()))
        var profile: [Double] = []
        profile.reserveCapacity(expand * 2 + 2)
        for s in -expand...(expand + 1) {
            let xx = Int((x0 + dx * Double(s)).rounded())
            let yy = Int((y0 + dy * Double(s)).rounded())
            if xx >= 0, yy >= 0, xx < width, yy < height {
                let o = (yy * width + xx) * 3
                profile.append((Double(bytes[o]) + Double(bytes[o + 1]) + Double(bytes[o + 2])) / 3)
            } else if let last = profile.last {
                profile.append(last)
            } else {
                profile.append(0)
            }
        }
        guard profile.count >= 3 else { return EdgeReport(ratio: 0, offset10: nil) }
        var steps = [Double](repeating: 0, count: profile.count - 1)
        for i in 0..<steps.count {
            steps[i] = abs(profile[i + 1] - profile[i])
        }
        let nominal = expand
        let lo = max(0, nominal - 2)
        let hi = min(steps.count, nominal + 3)
        guard hi > lo else { return EdgeReport(ratio: 0, offset10: nil) }
        var bestI = lo
        for i in lo..<hi where steps[i] > steps[bestI] { bestI = i }
        let best = steps[bestI]
        var runnerI = -1
        var runner = 0.0
        for i in 0..<steps.count {
            if abs(i - bestI) < 2 { continue }
            let left = i > 0 ? steps[i - 1] : -1
            let right = i < steps.count - 1 ? steps[i + 1] : -1
            if steps[i] >= left && steps[i] >= right && steps[i] > runner {
                runner = steps[i]
                runnerI = i
            }
        }
        guard best > 0, runnerI >= 0 else { return EdgeReport(ratio: 0, offset10: nil) }
        let ratio = runner / best
        let offset10 = Double(runnerI - bestI) * (10 / max(pxPerMm, 0.1))
        _ = side
        return EdgeReport(ratio: ratio, offset10: offset10)
    }

    private static func chroma(_ r: Double, _ g: Double, _ b: Double) -> (Double, Double, Double) {
        let s = r + g + b + 0.001
        return (r / s, g / s, b / s)
    }

    private static func chromaDistance(_ r: Double, _ g: Double, _ b: Double, _ bg: (Double, Double, Double)) -> Double {
        let c = chroma(r, g, b)
        let dx = c.0 - bg.0
        let dy = c.1 - bg.1
        let dz = c.2 - bg.2
        return (dx * dx + dy * dy + dz * dz).squareRoot()
    }

    private static func median(_ values: [Double]) -> Double {
        let sorted = values.sorted()
        let mid = sorted.count / 2
        if sorted.count % 2 == 1 { return sorted[mid] }
        return (sorted[mid - 1] + sorted[mid]) / 2
    }

    private static func rgbBytes(_ image: CGImage, width: Int, height: Int) -> [UInt8]? {
        var bytes = [UInt8](repeating: 0, count: width * height * 4)
        let wrote = bytes.withUnsafeMutableBytes { raw -> Bool in
            guard let base = raw.baseAddress else { return false }
            guard let context = CGContext(
                data: base,
                width: width,
                height: height,
                bitsPerComponent: 8,
                bytesPerRow: width * 4,
                space: CGColorSpaceCreateDeviceRGB(),
                bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue
            ) else { return false }
            context.interpolationQuality = .none
            context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
            return true
        }
        guard wrote else { return nil }
        var rgb = [UInt8](repeating: 0, count: width * height * 3)
        for i in 0..<(width * height) {
            rgb[i * 3] = bytes[i * 4]
            rgb[i * 3 + 1] = bytes[i * 4 + 1]
            rgb[i * 3 + 2] = bytes[i * 4 + 2]
        }
        return rgb
    }

    #if DEBUG
    static func runContractChecks(_ check: ContractCheck) {
        func expect(_ condition: @autoclosure () -> Bool, _ message: @autoclosure () -> String, file: StaticString = #filePath, line: UInt = #line) {
            check(condition(), message(), file, line)
        }
        expect(cutIsLowConfidence(runnerUpRatio: 0.80, offsetAtTenPxPerMm: 6), "a second step at 80% is low confidence anywhere in the search")
        expect(cutIsLowConfidence(runnerUpRatio: 0.60, offsetAtTenPxPerMm: 3), "a second step at 60% within 3 px is low confidence")
        expect(!cutIsLowConfidence(runnerUpRatio: 0.59, offsetAtTenPxPerMm: 3), "59% within 3 px stays confident")
        expect(!cutIsLowConfidence(runnerUpRatio: 0.70, offsetAtTenPxPerMm: 4), "70% farther than 3 px stays confident")
        expect(cutIsLowConfidence(runnerUpRatio: 0.90, offsetAtTenPxPerMm: 0.5), "a nearly coincident strong step is low confidence")
        expect(CardFaceSize.size(for: .sports).aspect == 63.5 / 88.9, "a sports card is 63.5×88.9 mm")
        expect(abs(CardFaceSize.size(for: .tcg).aspect - (63.0 / 88.0)) < 1e-9, "a Pokémon card is 63×88 mm")
        expect(CardFaceSize.size(for: .mtg).height == 88, "a Magic card uses the 88 mm height")

        let outer = syntheticCard()
        let found = find(bytes: outer.bytes, width: outer.width, height: outer.height, face: CardFaceSize.sports)
        let height = found.map { hypot($0.tl.x - $0.bl.x, $0.tl.y - $0.bl.y) }
        let width = found.map { hypot($0.tl.x - $0.tr.x, $0.tl.y - $0.tr.y) }
        expect(found != nil, "a white card on pink with a blue inner frame still has an outer quad")
        expect((height ?? 0) > 200 && (height ?? 0) < 230, "the quad height is the white card, not the blue frame")
        expect((width ?? 0) > 145 && (width ?? 0) < 170, "the quad width is the white card, not the blue frame")
        expect(found?.confident == true, "the blue frame sits outside the 2% cut window, so the outer edge stays confident")

        let square = solid(width: 120, height: 120, color: (190, 110, 125), rect: (20, 20, 80, 80), fill: (245, 245, 245))
        expect(find(bytes: square.bytes, width: 120, height: 120, face: CardFaceSize.sports) == nil, "a square is not a card")
        if case .aspectFail = locate(bytes: square.bytes, width: 120, height: 120, face: CardFaceSize.sports) {
            expect(true, "a square is an aspect fail")
        } else {
            expect(false, "a square is an aspect fail, not a vanished detector")
        }

        if case .quad(let tracked) = locate(bytes: outer.bytes, width: outer.width, height: outer.height, face: CardFaceSize.sports) {
            expect(tracked.matchesFace && tracked.result.confident, "a clean outer cut still matches the face and stays confident")
        } else {
            expect(false, "a clean outer cut still matches the face and stays confident")
        }

        let clipped = solid(width: 200, height: 260, color: (190, 110, 125), rect: (20, 20, 160, 260), fill: (245, 245, 245))
        expect(find(bytes: clipped.bytes, width: 200, height: 260, face: CardFaceSize.sports) == nil, "a card cut off by the frame is not uploaded as a confident crop")
        if case .quad(let partial) = locate(bytes: clipped.bytes, width: 200, height: 260, face: CardFaceSize.sports) {
            expect(!partial.result.confident, "a clipped side does not open the shutter")
            expect(partial.result.imageWidth == 200, "a clipped card still produces a tracking quad")
        } else {
            expect(false, "a card that touches the frame still tracks")
        }

        func rect(cx: Double, cy: Double, height: Double, aspect: Double) -> Norm {
            let halfH = height / 2
            let halfW = height * aspect / 2
            return Norm(
                tl: Norm.Point(x: cx - halfW, y: cy - halfH),
                tr: Norm.Point(x: cx + halfW, y: cy - halfH),
                br: Norm.Point(x: cx + halfW, y: cy + halfH),
                bl: Norm.Point(x: cx - halfW, y: cy + halfH)
            )
        }
        var tracker = Tracker()
        let far = rect(cx: 0.50, cy: 0.50, height: 0.40, aspect: 0.714)
        let near = rect(cx: 0.50, cy: 0.50, height: 0.70, aspect: 0.714)
        let first = tracker.push(far, strict: false)
        expect(abs(first.height - 0.40) < 0.001 && tracker.freshCount == 0, "the first frame shows a box and does not open the shutter")
        _ = tracker.push(far, strict: true)
        _ = tracker.push(far, strict: true)
        let grown = tracker.push(near, strict: true)
        expect(abs(grown.height - 0.70) < 0.02, "moving closer updates the box size")
        expect(abs(grown.aspect - 0.714) < 0.02, "a size change keeps the card aspect")
        expect(tracker.shutterSettled, "three strict frames settle the shutter")

        var moved = Tracker()
        let steady = rect(cx: 0.50, cy: 0.50, height: 0.60, aspect: 0.714)
        let shifted = rect(cx: 0.68, cy: 0.50, height: 0.60, aspect: 0.714)
        _ = moved.push(steady, strict: true)
        _ = moved.push(steady, strict: true)
        let held = moved.push(shifted, strict: true)
        expect(abs(held.center.x - 0.50) < 0.02, "one position jump does not move the box")
        let kept = moved.miss()
        expect(kept != nil && moved.freshCount == 0 && !moved.shutterSettled, "a missed frame keeps the last quad and closes the shutter")

        let center = aspectFill(x: 0.5, y: 0.5, imageWidth: 100, imageHeight: 200, viewWidth: 100, viewHeight: 100)
        expect(abs(center.x - 50) < 0.1 && abs(center.y - 50) < 0.1, "aspect fill keeps the card center in the view center")
    }

    private static func solid(width: Int, height: Int, color: (UInt8, UInt8, UInt8), rect: (Int, Int, Int, Int), fill: (UInt8, UInt8, UInt8)) -> (bytes: [UInt8], width: Int, height: Int) {
        var bytes = [UInt8](repeating: 0, count: width * height * 3)
        for y in 0..<height {
            for x in 0..<width {
                let o = (y * width + x) * 3
                let inside = x >= rect.0 && y >= rect.1 && x < rect.2 && y < rect.3
                let rgb = inside ? fill : color
                bytes[o] = rgb.0
                bytes[o + 1] = rgb.1
                bytes[o + 2] = rgb.2
            }
        }
        return (bytes, width, height)
    }

    /// Pink mat, white 157×220 card, blue inner frame 18 px in, orange middle.
    private static func syntheticCard() -> (bytes: [UInt8], width: Int, height: Int) {
        let width = 220
        let height = 300
        var bytes = [UInt8](repeating: 0, count: width * height * 3)
        let x0 = 30, y0 = 40, x1 = 187, y1 = 260
        for y in 0..<height {
            for x in 0..<width {
                let o = (y * width + x) * 3
                var rgb: (UInt8, UInt8, UInt8) = (190, 110, 125)
                if x >= x0 && x < x1 && y >= y0 && y < y1 { rgb = (245, 245, 245) }
                if x >= x0 + 18 && x < x1 - 18 && y >= y0 + 18 && y < y1 - 18 { rgb = (40, 90, 190) }
                if x >= x0 + 40 && x < x1 - 40 && y >= y0 + 40 && y < y1 - 40 { rgb = (220, 90, 30) }
                bytes[o] = rgb.0
                bytes[o + 1] = rgb.1
                bytes[o + 2] = rgb.2
            }
        }
        return (bytes, width, height)
    }
    #endif
}
