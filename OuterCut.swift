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
/// mat, not an inner printed frame. Chroma (not brightness) keeps a pink
/// shadow or a glare patch from counting as the card, and keeps a blue or
/// black inner frame from winning just because it is a stronger edge.
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
    }

    /// Median of the last three outer quads, so one frame cannot yank the
    /// box onto a different edge.
    struct Tracker {
        private var history: [Norm] = []

        mutating func reset() { history = [] }

        mutating func push(_ quad: Norm) -> Norm {
            history.append(quad)
            if history.count > 3 { history.removeFirst() }
            return Self.median(history)
        }

        static func median(_ quads: [Norm]) -> Norm {
            func m(_ values: [Double]) -> Double {
                let sorted = values.sorted()
                let mid = sorted.count / 2
                if sorted.count % 2 == 1 { return sorted[mid] }
                return (sorted[mid - 1] + sorted[mid]) / 2
            }
            return Norm(
                tl: Norm.Point(x: m(quads.map(\.tl.x)), y: m(quads.map(\.tl.y))),
                tr: Norm.Point(x: m(quads.map(\.tr.x)), y: m(quads.map(\.tr.y))),
                br: Norm.Point(x: m(quads.map(\.br.x)), y: m(quads.map(\.br.y))),
                bl: Norm.Point(x: m(quads.map(\.bl.x)), y: m(quads.map(\.bl.y)))
            )
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
        let sourceW = image.width
        let sourceH = image.height
        guard sourceW > 8, sourceH > 8 else { return nil }
        let scale = min(1.0, Double(searchLongSide) / Double(max(sourceW, sourceH)))
        let sw = max(1, Int((Double(sourceW) * scale).rounded()))
        let sh = max(1, Int((Double(sourceH) * scale).rounded()))
        guard let bytes = rgbBytes(image, width: sw, height: sh) else { return nil }
        guard let found = find(bytes: bytes, width: sw, height: sh, face: face) else { return nil }
        let sx = Double(sourceW) / Double(sw)
        let sy = Double(sourceH) / Double(sh)
        func s(_ p: Point) -> Point { Point(x: p.x * sx, y: p.y * sy) }
        return Result(
            tl: s(found.tl), tr: s(found.tr), br: s(found.br), bl: s(found.bl),
            confident: found.confident, imageWidth: sourceW, imageHeight: sourceH
        )
    }

    /// `bytes` is packed RGB, row-major, origin top-left.
    static func find(bytes: [UInt8], width: Int, height: Int, face: CardFaceSize.Millimetres) -> Result? {
        guard width > 16, height > 16, bytes.count == width * height * 3, face.height > 1, face.aspect > 0 else {
            return nil
        }
        guard let bg = backgroundChroma(bytes: bytes, width: width, height: height) else { return nil }
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
              xHi - xLo > 10, yHi - yLo > 10 else { return nil }

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

        guard let top = fitLine(points(side: "top"), vary: "y"),
              let bottom = fitLine(points(side: "bottom"), vary: "y"),
              let left = fitLine(points(side: "left"), vary: "x"),
              let right = fitLine(points(side: "right"), vary: "x"),
              let tl = intersect(horizontal: top, vertical: left),
              let tr = intersect(horizontal: top, vertical: right),
              let br = intersect(horizontal: bottom, vertical: right),
              let bl = intersect(horizontal: bottom, vertical: left) else { return nil }

        let widthPx = (hypot(tl.x - tr.x, tl.y - tr.y) + hypot(bl.x - br.x, bl.y - br.y)) / 2
        let heightPx = (hypot(tl.x - bl.x, tl.y - bl.y) + hypot(tr.x - br.x, tr.y - br.y)) / 2
        guard heightPx > 8 else { return nil }
        let aspect = widthPx / heightPx
        guard abs(aspect - face.aspect) / face.aspect <= aspectTolerance else { return nil }

        let corners = [tl, tr, br, bl]
        guard corners.allSatisfy({ $0.x > 1 && $0.y > 1 && $0.x < Double(width - 2) && $0.y < Double(height - 2) }) else {
            return nil
        }
        guard outsideIsBackground(side: "top", line: top, atX: (tl.x + tr.x) / 2, bytes: bytes, width: width, height: height, bg: bg),
              outsideIsBackground(side: "bottom", line: bottom, atX: (bl.x + br.x) / 2, bytes: bytes, width: width, height: height, bg: bg),
              outsideIsBackground(side: "left", line: left, atY: (tl.y + bl.y) / 2, bytes: bytes, width: width, height: height, bg: bg),
              outsideIsBackground(side: "right", line: right, atY: (tr.y + br.y) / 2, bytes: bytes, width: width, height: height, bg: bg) else {
            return nil
        }

        let pxPerMm = heightPx / face.height
        let reports = [
            edgeReport(side: "top", x0: (tl.x + tr.x) / 2, y0: top.a * (tl.x + tr.x) / 2 + top.b, dx: 0, dy: 1, sideLength: widthPx, bytes: bytes, width: width, height: height, pxPerMm: pxPerMm),
            edgeReport(side: "bottom", x0: (bl.x + br.x) / 2, y0: bottom.a * (bl.x + br.x) / 2 + bottom.b, dx: 0, dy: -1, sideLength: widthPx, bytes: bytes, width: width, height: height, pxPerMm: pxPerMm),
            edgeReport(side: "left", x0: left.a * (tl.y + bl.y) / 2 + left.b, y0: (tl.y + bl.y) / 2, dx: 1, dy: 0, sideLength: heightPx, bytes: bytes, width: width, height: height, pxPerMm: pxPerMm),
            edgeReport(side: "right", x0: right.a * (tr.y + br.y) / 2 + right.b, y0: (tr.y + br.y) / 2, dx: -1, dy: 0, sideLength: heightPx, bytes: bytes, width: width, height: height, pxPerMm: pxPerMm)
        ]
        let confident = reports.allSatisfy { !cutIsLowConfidence(runnerUpRatio: $0.ratio, offsetAtTenPxPerMm: $0.offset10) }
        return Result(tl: tl, tr: tr, br: br, bl: bl, confident: confident, imageWidth: width, imageHeight: height)
    }

    private struct Line {
        var a: Double
        var b: Double
    }

    private struct EdgeReport {
        var ratio: Double
        var offset10: Double?
    }

    private static func backgroundChroma(bytes: [UInt8], width: Int, height: Int) -> (Double, Double, Double)? {
        let m = max(6, Int(Double(min(width, height)) * 0.04))
        let origins = [(0, 0), (width - m, 0), (0, height - m), (width - m, height - m)]
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
        let distances = chromas.map { chromaDistance($0.0, $0.1, $0.2, center) }
        var keep = Array(repeating: true, count: 4)
        if let worst = distances.enumerated().max(by: { $0.element < $1.element })?.offset, distances[worst] > 0.08 {
            keep[worst] = false
        }
        let kept = medians.enumerated().filter { keep[$0.offset] }.map(\.element)
        guard kept.count >= 3 else { return nil }
        let bg = (median(kept.map(\.0)), median(kept.map(\.1)), median(kept.map(\.2)))
        return chroma(bg.0, bg.1, bg.2)
    }

    private static func fitLine(_ pts: [Point], vary: String) -> Line? {
        guard pts.count >= 8 else { return nil }
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
            guard abs(span) >= 4 else { return nil }
            a0 = (right.y - left.y) / span
            b0 = left.y - a0 * left.x
        } else {
            let top = Point(x: median(head.map(\.x)), y: median(head.map(\.y)))
            let bot = Point(x: median(tail.map(\.x)), y: median(tail.map(\.y)))
            let span = bot.y - top.y
            guard abs(span) >= 4 else { return nil }
            a0 = (bot.x - top.x) / span
            b0 = top.x - a0 * top.y
        }
        let inliers = sorted.filter { p in
            let err = vary == "y" ? abs(p.y - (a0 * p.x + b0)) : abs(p.x - (a0 * p.y + b0))
            return err <= 4.5
        }
        guard inliers.count >= max(6, Int(0.45 * Double(sorted.count))) else { return nil }
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

        var tracker = Tracker()
        let steady = Norm(
            tl: Norm.Point(x: 0.2, y: 0.1), tr: Norm.Point(x: 0.8, y: 0.1),
            br: Norm.Point(x: 0.8, y: 0.9), bl: Norm.Point(x: 0.2, y: 0.9)
        )
        let jumped = Norm(
            tl: Norm.Point(x: 0.28, y: 0.18), tr: Norm.Point(x: 0.72, y: 0.18),
            br: Norm.Point(x: 0.72, y: 0.82), bl: Norm.Point(x: 0.28, y: 0.82)
        )
        _ = tracker.push(steady)
        _ = tracker.push(steady)
        let held = tracker.push(jumped)
        expect(abs(held.tl.x - 0.2) < 0.001 && abs(held.tl.y - 0.1) < 0.001, "one inner jump does not move the box")

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
