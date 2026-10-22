import Foundation
import os
import SwiftUI
import UIKit

/// Geometry for a line the user drags on the warped card. This is not the
/// border finder: it never reads pixels and it never invents a width.
///
/// Millimetres match measureCenteringOnWarp / the web centering assist:
///   left  x = widthPx
///   right x = (warpWidth - 1) - widthPx
///   top   y = widthPx
///   bottom y = (warpHeight - 1) - widthPx
///   mm = widthPx * cardMm / warpSpan
public enum CenteringAssist {
    static let cardWidthMM = 63.5
    static let cardHeightMM = 88.9
    static let maxWidthFraction = 0.49
    static let sides = ["left", "right", "top", "bottom"]

    public struct SideState: Equatable, Codable {
        public var engineWidthMM: Double?
        public var withheld: Bool
        public var userWidthMM: Double?
        public var kind: String?

        public init(engineWidthMM: Double?, withheld: Bool, userWidthMM: Double?, kind: String?) {
            self.engineWidthMM = engineWidthMM
            self.withheld = withheld
            self.userWidthMM = userWidthMM
            self.kind = kind
        }
    }

    public struct Snapshot: Equatable, Codable {
        public var warpWidth: Double
        public var warpHeight: Double
        public var centeringWithheld: Bool
        public var engineVersion: String?
        public var engineCommit: String?
        public var sides: [String: SideState]
        /// Engine sample lines, JSON. Kept for the on-device example only.
        public var candidatesJSON: String?
        public var headline: String?
        public var centeringLabel: String?
        public var adjustedCount: Int
        /// "front" or "back". Picks the PSA table for the assisted score.
        public var side: String?
        /// When the lines were saved. The capture clock stays on the ledger.
        public var adjustedAt: String?

        public init(
            warpWidth: Double,
            warpHeight: Double,
            centeringWithheld: Bool,
            engineVersion: String?,
            engineCommit: String?,
            sides: [String: SideState],
            candidatesJSON: String?,
            headline: String?,
            centeringLabel: String?,
            adjustedCount: Int,
            side: String? = nil,
            adjustedAt: String? = nil
        ) {
            self.warpWidth = warpWidth
            self.warpHeight = warpHeight
            self.centeringWithheld = centeringWithheld
            self.engineVersion = engineVersion
            self.engineCommit = engineCommit
            self.sides = sides
            self.candidatesJSON = candidatesJSON
            self.headline = headline
            self.centeringLabel = centeringLabel
            self.adjustedCount = adjustedCount
            self.side = side
            self.adjustedAt = adjustedAt
        }

        enum CodingKeys: String, CodingKey {
            case warpWidth, warpHeight, centeringWithheld, engineVersion, engineCommit
            case sides, candidatesJSON, headline, centeringLabel, adjustedCount, side, adjustedAt
        }

        public init(from decoder: Decoder) throws {
            let container = try decoder.container(keyedBy: CodingKeys.self)
            warpWidth = try container.decode(Double.self, forKey: .warpWidth)
            warpHeight = try container.decode(Double.self, forKey: .warpHeight)
            centeringWithheld = try container.decode(Bool.self, forKey: .centeringWithheld)
            engineVersion = try container.decodeIfPresent(String.self, forKey: .engineVersion)
            engineCommit = try container.decodeIfPresent(String.self, forKey: .engineCommit)
            sides = try container.decodeIfPresent([String: SideState].self, forKey: .sides) ?? [:]
            candidatesJSON = try container.decodeIfPresent(String.self, forKey: .candidatesJSON)
            headline = try container.decodeIfPresent(String.self, forKey: .headline)
            centeringLabel = try container.decodeIfPresent(String.self, forKey: .centeringLabel)
            adjustedCount = try container.decodeIfPresent(Int.self, forKey: .adjustedCount) ?? 0
            side = try container.decodeIfPresent(String.self, forKey: .side)
            adjustedAt = try container.decodeIfPresent(String.self, forKey: .adjustedAt)
        }

        public func encode(to encoder: Encoder) throws {
            var container = encoder.container(keyedBy: CodingKeys.self)
            try container.encode(warpWidth, forKey: .warpWidth)
            try container.encode(warpHeight, forKey: .warpHeight)
            try container.encode(centeringWithheld, forKey: .centeringWithheld)
            try container.encodeIfPresent(engineVersion, forKey: .engineVersion)
            try container.encodeIfPresent(engineCommit, forKey: .engineCommit)
            try container.encode(sides, forKey: .sides)
            try container.encodeIfPresent(candidatesJSON, forKey: .candidatesJSON)
            try container.encodeIfPresent(headline, forKey: .headline)
            try container.encodeIfPresent(centeringLabel, forKey: .centeringLabel)
            try container.encode(adjustedCount, forKey: .adjustedCount)
            try container.encodeIfPresent(side, forKey: .side)
            try container.encodeIfPresent(adjustedAt, forKey: .adjustedAt)
        }

        /// User width where they dragged, otherwise the engine width.
        public func placedWidthsMM() -> [String: Double]? {
            var out: [String: Double] = [:]
            for name in CenteringAssist.sides {
                guard let row = sides[name] else { return nil }
                if let user = row.userWidthMM, user.isFinite {
                    out[name] = user
                } else if !row.withheld, let engine = row.engineWidthMM, engine.isFinite {
                    out[name] = engine
                } else {
                    return nil
                }
            }
            return out
        }

        public var assistedLRText: String? {
            guard adjustedCount > 0 else { return nil }
            return CenteringAssist.assistedRatioText(widths: placedWidthsMM())?.lr
        }

        public var assistedTBText: String? {
            guard adjustedCount > 0 else { return nil }
            return CenteringAssist.assistedRatioText(widths: placedWidthsMM())?.tb
        }

        /// Check the server's assisted label against the front or back table.
        /// A missing side is unknown: it is not scored on the front table.
        /// The label on screen stays the server's value.
        public mutating func checkAssistedTable() {
            guard adjustedCount > 0, let widths = placedWidthsMM() else { return }
            let known = side == "front" || side == "back"
            let which = known ? (side ?? "unknown") : "unknown"
            let local: String?
            if known, let score = CenteringAssist.assistedScore(side: which, widths: widths) {
                local = String(format: "%.1f assisted", score)
            } else {
                local = nil
            }
            let server = centeringLabel.flatMap { $0.isEmpty ? nil : $0 }
            let matches = known ? server == local : server == nil
            CenteringAssist.lastTableCheck = AssistedTableCheck(
                serverLabel: server,
                localLabel: local,
                side: which,
                matches: matches
            )
            if !matches {
                CenteringAssist.logTableMismatch(server: server, local: local, side: which)
            }
        }

        public var displayLine: String? {
            guard let headline, !headline.isEmpty else { return nil }
            if side != "front" && side != "back" {
                return headline
            }
            if let centeringLabel, !centeringLabel.isEmpty {
                return "\(centeringLabel) — \(headline)"
            }
            return headline
        }

        /// "adjusted 10/13 09:54". Empty when this save has no adjustment clock.
        public var adjustmentLine: String? {
            guard let adjustedAt, !adjustedAt.isEmpty, let date = CenteringAssist.parseISO(adjustedAt) else { return nil }
            return "adjusted " + CenteringAssist.adjustmentFormatter.string(from: date)
        }

        public var needsAssist: Bool {
            centeringWithheld || sides.values.contains(where: \.withheld)
        }
    }

    public struct Example: Equatable, Codable {
        public var id: String
        public var kind: String
        public var scanId: String
        public var side: String
        public var engineCandidateLines: String?
        public var engineWidthMM: Double?
        public var userWidthMM: Double
        public var engineVersion: String?
        public var engineCommit: String?
        public var consent: Bool
        public var createdAt: String
        /// True when the line was outside the plausible range and the warning was shown.
        public var warningShown: Bool?
        public var plausibleMinMM: Double?
        public var plausibleMaxMM: Double?

        public init(
            id: String,
            kind: String,
            scanId: String,
            side: String,
            engineCandidateLines: String?,
            engineWidthMM: Double?,
            userWidthMM: Double,
            engineVersion: String?,
            engineCommit: String?,
            consent: Bool,
            createdAt: String,
            warningShown: Bool? = nil,
            plausibleMinMM: Double? = nil,
            plausibleMaxMM: Double? = nil
        ) {
            self.id = id
            self.kind = kind
            self.scanId = scanId
            self.side = side
            self.engineCandidateLines = engineCandidateLines
            self.engineWidthMM = engineWidthMM
            self.userWidthMM = userWidthMM
            self.engineVersion = engineVersion
            self.engineCommit = engineCommit
            self.consent = consent
            self.createdAt = createdAt
            self.warningShown = warningShown
            self.plausibleMinMM = plausibleMinMM
            self.plausibleMaxMM = plausibleMaxMM
        }
    }

    public struct PlausibleRange: Equatable {
        public var minMM: Double
        public var maxMM: Double
    }

    public struct ImplausibleSide: Equatable {
        public var side: String
        public var userWidthMM: Double
        public var minMM: Double
        public var maxMM: Double
    }

    static func roundMM(_ value: Double) -> Double {
        (value * 1000).rounded() / 1000
    }

    static func sameMM(_ a: Double?, _ b: Double?) -> Bool {
        guard let a, let b, a.isFinite, b.isFinite else { return false }
        return abs(a - b) < 0.0005
    }

    static func headline(adjustedCount: Int) -> String {
        if adjustedCount == 1 { return "Centering (you adjusted 1 side)" }
        return "Centering (you adjusted \(adjustedCount) sides)"
    }

    /// Millimetres from the card edge. Nil when the line is off the card.
    /// Zero is a real placement on the edge itself.
    static func widthMM(side: String, positionPx: Double, warpWidth: Double, warpHeight: Double) -> Double? {
        guard sides.contains(side), positionPx.isFinite, warpWidth >= 2, warpHeight >= 2 else { return nil }
        let horizontal = side == "left" || side == "right"
        let span = horizontal ? warpWidth : warpHeight
        let cardMM = horizontal ? cardWidthMM : cardHeightMM
        let widthPx: Double
        switch side {
        case "left", "top": widthPx = positionPx
        case "right": widthPx = (warpWidth - 1) - positionPx
        case "bottom": widthPx = (warpHeight - 1) - positionPx
        default: return nil
        }
        guard widthPx >= 0, widthPx <= (span - 1) * maxWidthFraction else { return nil }
        if widthPx == 0 { return 0 }
        return roundMM(widthPx * cardMM / span)
    }

    static func linePx(side: String, widthMM: Double, warpWidth: Double, warpHeight: Double) -> Double? {
        guard sides.contains(side), widthMM.isFinite, widthMM >= 0, warpWidth >= 2, warpHeight >= 2 else { return nil }
        let horizontal = side == "left" || side == "right"
        let span = horizontal ? warpWidth : warpHeight
        let cardMM = horizontal ? cardWidthMM : cardHeightMM
        let widthPx = widthMM * span / cardMM
        guard widthPx <= (span - 1) * maxWidthFraction else { return nil }
        switch side {
        case "left", "top": return widthPx
        case "right": return (warpWidth - 1) - widthPx
        case "bottom": return (warpHeight - 1) - widthPx
        default: return nil
        }
    }

    static func edgeMM(_ side: String) -> Double? {
        if side == "left" || side == "right" { return cardWidthMM }
        if side == "top" || side == "bottom" { return cardHeightMM }
        return nil
    }

    /// Plausible millimetre range for one border. Built only from the engine
    /// widths on this card and the length of each edge. No per-card constants.
    static func plausibleRangeMM(side: String, measured: [String: Double]) -> PlausibleRange? {
        guard let edge = edgeMM(side) else { return nil }
        var fractions: [Double] = []
        for name in sides {
            guard let width = measured[name], width.isFinite, width >= 0, let length = edgeMM(name) else { continue }
            fractions.append(width / length)
        }
        let cardCap = roundMM(edge / 4)
        if fractions.isEmpty { return PlausibleRange(minMM: 0, maxMM: cardCap) }
        var lo = fractions[0]
        var hi = fractions[0]
        for fraction in fractions {
            if fraction < lo { lo = fraction }
            if fraction > hi { hi = fraction }
        }
        let spread = hi - lo
        let unit = spread > 0 ? spread : lo
        let minMM = roundMM(max(0, lo - unit) * edge)
        var maxMM = roundMM((hi + unit) * edge)
        if maxMM > cardCap { maxMM = cardCap }
        if maxMM < minMM { maxMM = minMM }
        return PlausibleRange(minMM: minMM, maxMM: maxMM)
    }

    static func measuredWidths(snapshot: Snapshot) -> [String: Double] {
        var out: [String: Double] = [:]
        for side in sides {
            guard let row = snapshot.sides[side], !row.withheld, let width = row.engineWidthMM, width.isFinite, width >= 0 else { continue }
            out[side] = width
        }
        return out
    }

    /// User widths outside plausibleRangeMM. A line that matches the engine width is not a user width.
    static func implausibleSides(snapshot: Snapshot, userWidths: [String: Double]) -> [ImplausibleSide] {
        let measured = measuredWidths(snapshot: snapshot)
        var hits: [ImplausibleSide] = []
        for side in sides {
            guard let placed = userWidths[side], placed.isFinite else { continue }
            if let engine = measured[side], abs(placed - engine) < 0.0005 { continue }
            guard let range = plausibleRangeMM(side: side, measured: measured) else { continue }
            if placed < range.minMM - 0.0005 || placed > range.maxMM + 0.0005 {
                hits.append(ImplausibleSide(
                    side: side,
                    userWidthMM: roundMM(placed),
                    minMM: range.minMM,
                    maxMM: range.maxMM
                ))
            }
        }
        return hits
    }

    /// Shown millimetres. One decimal. The stored width keeps its full precision.
    static func displayMM(_ value: Double) -> String {
        let tenths = (value * 10).rounded() / 10
        return String(format: "%.1f mm", tenths)
    }

    static func mmText(_ value: Double) -> String {
        let tenths = (value * 10).rounded() / 10
        return String(format: "%.1f", tenths)
    }

    /// Larger border share, 0–100. Same worst-axis rule as the engine table.
    static func worstSharePct(_ widths: [String: Double]) -> Double? {
        guard let left = widths["left"], let right = widths["right"],
              let top = widths["top"], let bottom = widths["bottom"],
              left.isFinite, right.isFinite, top.isFinite, bottom.isFinite,
              left >= 0, right >= 0, top >= 0, bottom >= 0 else {
            return nil
        }
        let lr = left + right
        let tb = top + bottom
        guard lr > 0, tb > 0 else { return nil }
        let leftPct = left / lr * 100
        let topPct = top / tb * 100
        return max(max(leftPct, 100 - leftPct), max(topPct, 100 - topPct))
    }

    /// Front PSA centering table. Worst share, strict end of each published row.
    /// 10 = 55/45, 9 = 60/40, 8 = 65/35, 7 = 70/30, 6 = 80/20, 5 = 85/15, 3 = 90/10.
    static func assistedFrontScore(_ worstShare: Double) -> Double {
        let table: [(Double, Double)] = [
            (55, 10), (60, 9), (65, 8), (70, 7), (80, 6), (85, 5), (90, 3)
        ]
        for row in table {
            if worstShare <= row.0 + 1e-9 { return row.1 }
        }
        return 1
    }

    /// Back PSA centering table. 10 = 75/25, 9 = 90/10. Past 90/10 there is no row.
    static func assistedBackScore(_ worstShare: Double) -> Double? {
        if worstShare <= 75 + 1e-9 { return 10 }
        if worstShare <= 90 + 1e-9 { return 9 }
        return nil
    }

    struct AssistedTableCheck: Equatable {
        var serverLabel: String?
        var localLabel: String?
        var side: String
        var matches: Bool
    }

    /// Last comparison of the server's assisted label with the local table.
    static var lastTableCheck: AssistedTableCheck?

    private static let tableLog = Logger(subsystem: "com.cardgrader.thejudge", category: "centering-assist")

    static func logTableMismatch(server: String?, local: String?, side: String) {
        let serverText = server ?? "nil"
        let localText = local ?? "nil"
        tableLog.error("assisted centering table mismatch side=\(side, privacy: .public) server=\(serverText, privacy: .public) local=\(localText, privacy: .public)")
    }

    static func assistedScore(side: String, widths: [String: Double]) -> Double? {
        guard let worst = worstSharePct(widths) else { return nil }
        if side == "back" { return assistedBackScore(worst) }
        return assistedFrontScore(worst)
    }

    static func assistedRatioText(widths: [String: Double]?) -> (lr: String, tb: String)? {
        guard let widths, let left = widths["left"], let right = widths["right"],
              let top = widths["top"], let bottom = widths["bottom"] else {
            return nil
        }
        let lr = left + right
        let tb = top + bottom
        guard lr > 0, tb > 0 else { return nil }
        let leftPct = left / lr * 100
        let topPct = top / tb * 100
        return (
            lr: String(format: "%.1f%%/%.1f%% assisted", leftPct, 100 - leftPct),
            tb: String(format: "%.1f%%/%.1f%% assisted", topPct, 100 - topPct)
        )
    }

    static func plausibilityWarning(_ hits: [ImplausibleSide]) -> String {
        if hits.isEmpty { return "" }
        let parts = hits.map { hit -> String in
            let label = hit.side.prefix(1).uppercased() + hit.side.dropFirst()
            return "\(label) is \(mmText(hit.userWidthMM)) mm. The borders measured on this card, and the card size, put a \(hit.side) border between \(mmText(hit.minMM)) mm and \(mmText(hit.maxMM)) mm."
        }
        return parts.joined(separator: " ") + " This is outside that range. Save again to keep this line."
    }

    static func parse(report: [String: Any]?, item: [String: Any]?) -> Snapshot? {
        guard let report else { return nil }
        let diagnostics = report["centeringDiagnostics"] as? [String: Any]
        let box = diagnostics?["box"] as? [String: Any]
        guard let warpWidth = doubleValue(box?["width"]),
              let warpHeight = doubleValue(box?["height"]),
              warpWidth >= 2, warpHeight >= 2 else {
            return nil
        }
        let metrics = report["centeringMetrics"] as? [String: Any]
        let widths = metrics?["borderWidthsMm"] as? [String: Any]
        let low = (metrics?["borderVoteLowConfidenceEdges"] as? [String]) ?? []
        let assist = report["centeringAssist"] as? [String: Any]
        let assistSides = assist?["sides"] as? [String: Any]
        var sides: [String: SideState] = [:]
        for side in self.sides {
            let raw = doubleValue(widths?[side])
            let measured = raw != nil && !low.contains(side)
            let assistRow = assistSides?[side] as? [String: Any]
            let user = doubleValue(assistRow?["userWidthMm"])
            let kind = assistRow?["kind"] as? String
            sides[side] = SideState(
                engineWidthMM: raw,
                withheld: !measured,
                userWidthMM: user,
                kind: kind
            )
        }
        let sub = report["subGrades"] as? [String: Any]
        let centering = sub?["centering"]
        let withheldScore = (report["centeringUndetected"] as? Bool) == true
            || (report["printCenteringDetected"] as? Bool) == false
            || centering == nil
            || centering is NSNull
        let engine = item?["engine"] as? [String: Any]
        let version = (report["engineVersion"] as? String) ?? (engine?["version"] as? String)
        let commit = engine?["commit"] as? String
        var candidatesJSON: String?
        if let lines = diagnostics?["sampleLines"],
           let data = try? JSONSerialization.data(withJSONObject: lines, options: [.sortedKeys]),
           let text = String(data: data, encoding: .utf8) {
            candidatesJSON = text
        }
        let cardSide = (item?["side"] as? String) ?? (report["side"] as? String)
        var snap = Snapshot(
            warpWidth: warpWidth,
            warpHeight: warpHeight,
            centeringWithheld: withheldScore,
            engineVersion: version,
            engineCommit: commit,
            sides: sides,
            candidatesJSON: candidatesJSON,
            headline: assist?["headline"] as? String,
            centeringLabel: assist?["centeringLabel"] as? String,
            adjustedCount: Int(doubleValue(assist?["adjustedCount"]) ?? 0),
            side: cardSide,
            adjustedAt: assist?["adjustedAt"] as? String
        )
        snap.checkAssistedTable()
        return snap
    }

    /// Examples for sides whose user millimetres changed. A repeat of the
    /// same line returns nothing. Consent false is the caller's default.
    static func examples(
        scanId: String,
        previous: Snapshot,
        updated: Snapshot,
        consent: Bool,
        createdAt: String,
        warnings: [ImplausibleSide] = []
    ) -> [Example] {
        let measured = measuredWidths(snapshot: updated)
        var rows: [Example] = []
        for side in sides {
            guard let next = updated.sides[side], let user = next.userWidthMM else { continue }
            let prior = previous.sides[side]
            if sameMM(prior?.userWidthMM, user) { continue }
            let kind = next.kind ?? (prior?.withheld == false ? "disagreement" : "assisted")
            guard kind == "assisted" || kind == "disagreement" else { continue }
            let range = plausibleRangeMM(side: side, measured: measured)
            let hit = warnings.first { $0.side == side }
            rows.append(Example(
                id: UUID().uuidString,
                kind: kind,
                scanId: scanId,
                side: side,
                engineCandidateLines: candidates(for: side, json: previous.candidatesJSON),
                engineWidthMM: next.engineWidthMM ?? prior?.engineWidthMM,
                userWidthMM: user,
                engineVersion: updated.engineVersion ?? previous.engineVersion,
                engineCommit: updated.engineCommit ?? previous.engineCommit,
                consent: consent,
                createdAt: createdAt,
                warningShown: hit != nil,
                plausibleMinMM: range?.minMM,
                plausibleMaxMM: range?.maxMM
            ))
        }
        return rows
    }

    static func candidates(for side: String, json: String?) -> String? {
        guard let json, let data = json.data(using: .utf8),
              let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let lines = root[side],
              let encoded = try? JSONSerialization.data(withJSONObject: lines),
              let text = String(data: encoded, encoding: .utf8) else {
            return nil
        }
        return text
    }

    private static func doubleValue(_ value: Any?) -> Double? {
        if let number = value as? NSNumber { return number.doubleValue }
        if let text = value as? String { return Double(text) }
        return nil
    }

    static func parseISO(_ text: String) -> Date? {
        let withFraction = ISO8601DateFormatter()
        withFraction.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = withFraction.date(from: text) { return date }
        let plain = ISO8601DateFormatter()
        plain.formatOptions = [.withInternetDateTime]
        return plain.date(from: text)
    }

    private static let adjustmentFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = "M/d HH:mm"
        formatter.timeZone = TimeZone.current
        return formatter
    }()

    #if DEBUG
    static func runContractChecks(_ check: ContractCheck) {
        func expect(_ condition: @autoclosure () -> Bool, _ message: @autoclosure () -> String = "", file: StaticString = #filePath, line: UInt = #line) {
            check(condition(), message(), file, line)
        }
        let warpW = 643.0
        let warpH = 900.0
        let leftPx = 4.0 * warpW / cardWidthMM
        let leftMM = widthMM(side: "left", positionPx: leftPx, warpWidth: warpW, warpHeight: warpH)
        expect(leftMM == 4, "left mm \(String(describing: leftMM))")
        let back = linePx(side: "left", widthMM: leftMM ?? -1, warpWidth: warpW, warpHeight: warpH)
        let roundTrip = widthMM(side: "left", positionPx: back ?? -1, warpWidth: warpW, warpHeight: warpH)
        expect(roundTrip == leftMM, "round trip")
        expect(widthMM(side: "left", positionPx: -1, warpWidth: warpW, warpHeight: warpH) == nil)
        expect(widthMM(side: "left", positionPx: 0, warpWidth: warpW, warpHeight: warpH) == 0)
        expect(headline(adjustedCount: 1) == "Centering (you adjusted 1 side)")
        expect(headline(adjustedCount: 2) == "Centering (you adjusted 2 sides)")
        expect(sameMM(4, 4.0004))
        expect(!sameMM(4, 4.01))

        let report: [String: Any] = [
            "engineVersion": "2026.10.01-border-band",
            "centeringUndetected": true,
            "subGrades": ["centering": NSNull()],
            "centeringMetrics": [
                "borderWidthsMm": ["left": NSNull(), "right": 4.737, "top": 4.148, "bottom": 4.936],
                "borderVoteLowConfidenceEdges": []
            ],
            "centeringDiagnostics": [
                "box": ["width": warpW, "height": warpH],
                "sampleLines": ["left": [["at": 10, "pos": 22.5]]]
            ]
        ]
        let item: [String: Any] = ["engine": ["version": "2026.10.01-border-band", "commit": "abc1234"]]
        guard let snap = parse(report: report, item: item) else {
            expect(false, "front report parses to a snapshot")
            return
        }
        expect(snap.sides["left"]?.withheld == true, "a null left width stays withheld")
        expect(snap.sides["right"]?.withheld == false, "a measured right width is not withheld")
        expect(snap.sides["right"]?.engineWidthMM == 4.737, "right engine width is 4.737 mm")
        expect(snap.centeringWithheld == true, "a null centering sub-grade is withheld")
        expect(snap.engineCommit == "abc1234", "engine commit is copied from the item")
        expect(snap.needsAssist == true, "a withheld centering needs assist")
        expect(snap.displayLine == nil, "an unadjusted snapshot has no assisted line")

        var updated = snap
        updated.sides["left"]?.userWidthMM = 4
        updated.sides["left"]?.kind = "assisted"
        updated.headline = headline(adjustedCount: 1)
        updated.centeringLabel = "7.0 assisted"
        updated.adjustedCount = 1
        updated.side = "front"
        let rows = examples(scanId: "scan-1", previous: snap, updated: updated, consent: false, createdAt: "2026-10-09T00:00:00Z")
        expect(rows.count == 1, "one assisted example is recorded")
        expect(rows.first?.kind == "assisted", "the example kind is assisted")
        expect(rows.first?.consent == false, "the example is stored with consent off")
        expect(rows.first?.userWidthMM == 4, "the example keeps the user millimetres")
        expect(rows.first?.engineWidthMM == nil, "a withheld side stores no engine millimetres")
        expect(rows.first?.engineCandidateLines?.contains("22.5") == true, "the example keeps the engine candidate line")
        expect(rows.first?.engineVersion == "2026.10.01-border-band", "the example stamps the engine version")
        let again = examples(scanId: "scan-1", previous: updated, updated: updated, consent: false, createdAt: "2026-10-09T00:00:00Z")
        expect(again.isEmpty, "the same line must not become a second example")
        expect(updated.displayLine == "7.0 assisted — Centering (you adjusted 1 side)")
        expect(updated.displayLine?.contains("PSA") == false)

        var disagreed = snap
        disagreed.sides["right"]?.userWidthMM = 5
        disagreed.sides["right"]?.kind = "disagreement"
        disagreed.headline = headline(adjustedCount: 1)
        let disagreement = examples(scanId: "scan-1", previous: snap, updated: disagreed, consent: false, createdAt: "2026-10-09T00:00:00Z")
        expect(disagreement.count == 1 && disagreement.first?.kind == "disagreement", "a moved measured side is a disagreement")
        expect(disagreement.first?.engineWidthMM == 4.737, "the disagreement keeps the engine millimetres")
        expect(rows.first?.warningShown == false, "a plausible line does not set warningShown")
        expect(CenteringAssistStore.examplesClearedToLeave().isEmpty)
        expect(CenteringAssistStore.consentIsOn(nil) == false)
        expect(CenteringAssistStore.consentIsOn(false) == false)
        expect(CenteringAssistStore.consentIsOn(true) == true)

        let measured: [String: Double] = ["right": 4.737, "top": 4.148, "bottom": 4.936]
        let range = plausibleRangeMM(side: "left", measured: measured)
        expect(range?.minMM == 1.189, "min \(String(describing: range?.minMM))")
        expect(range?.maxMM == 6.511, "max \(String(describing: range?.maxMM))")
        let far = implausibleSides(snapshot: snap, userWidths: ["left": 11.43])
        expect(far.count == 1 && far.first?.userWidthMM == 11.43, "11.43 mm is outside the plausible range")
        expect(far.first?.minMM == 1.189 && far.first?.maxMM == 6.511, "the plausible range is 1.189...6.511 mm")
        expect(implausibleSides(snapshot: snap, userWidths: ["left": 4]).isEmpty, "4 mm on this card is plausible")
        let warning = plausibilityWarning(far)
        expect(warning.contains("11.4"))
        expect(!warning.contains("11.43"), "a dragged width is shown to 0.1 mm")
        expect(warning.contains("1.2") && warning.contains("6.5"))
        expect(warning.contains("Save again"))
        expect(displayMM(3.14) == "3.1 mm")
        expect(displayMM(11.43) == "11.4 mm")
        let sixtyForty = ["left": 6.0, "right": 4.0, "top": 5.0, "bottom": 5.0]
        expect(assistedScore(side: "front", widths: sixtyForty) == 9, "front 60/40")
        expect(assistedScore(side: "back", widths: sixtyForty) == 10, "back 60/40 is 10, not the front 9")
        let eightyTwenty = ["left": 8.0, "right": 2.0, "top": 5.0, "bottom": 5.0]
        expect(assistedScore(side: "front", widths: eightyTwenty) == 6, "front 80/20")
        expect(assistedScore(side: "back", widths: eightyTwenty) == 9, "back 80/20 is 9")
        let pastBack = ["left": 9.1, "right": 0.9, "top": 5.0, "bottom": 5.0]
        expect(assistedScore(side: "back", widths: pastBack) == nil, "back past 90/10 has no row")
        expect(assistedScore(side: "front", widths: pastBack) == 1, "front past 90/10 is 1")
        let share75 = ["left": 7.5, "right": 2.5, "top": 5.0, "bottom": 5.0]
        expect(assistedScore(side: "back", widths: share75) == 10, "back 75/25 is 10")
        expect(assistedScore(side: "front", widths: share75) == 6, "front 75/25 is 6")
        let share90 = ["left": 9.0, "right": 1.0, "top": 5.0, "bottom": 5.0]
        expect(assistedScore(side: "back", widths: share90) == 9, "back 90/10 is 9")
        expect(assistedScore(side: "front", widths: share90) == 3, "front 90/10 is 3")
        let ratios = assistedRatioText(widths: sixtyForty)
        expect(ratios?.lr == "60.0%/40.0% assisted" && ratios?.tb == "50.0%/50.0% assisted")
        expect(ScanLedger.deckLine(deckId: "TD-06", side: "back") == "TD-06 · back")
        expect(ScanLedger.deckLine(deckId: "  ", side: "front") == nil)
        let backReport: [String: Any] = [
            "side": "back",
            "centeringUndetected": true,
            "subGrades": ["centering": NSNull()],
            "centeringMetrics": [
                "borderWidthsMm": ["left": 6.0, "right": 4.0, "top": 5.0, "bottom": 5.0],
                "borderVoteLowConfidenceEdges": []
            ],
            "centeringDiagnostics": ["box": ["width": warpW, "height": warpH]],
            "centeringAssist": [
                "headline": "Centering (you adjusted 1 side)",
                "centeringLabel": "9.0 assisted",
                "adjustedCount": 1,
                "sides": [
                    "left": ["userWidthMm": 6.0, "engineWidthMm": 5.0, "kind": "disagreement"],
                    "right": ["engineWidthMm": 4.0],
                    "top": ["engineWidthMm": 5.0],
                    "bottom": ["engineWidthMm": 5.0]
                ]
            ]
        ]
        guard let backSnap = parse(report: backReport, item: ["side": "back", "deckId": "TD-06"]) else {
            expect(false, "back report parses to a snapshot")
            return
        }
        expect(backSnap.side == "back", "the snapshot side is back")
        expect(backSnap.centeringLabel == "9.0 assisted", "the phone shows the server label")
        expect(lastTableCheck?.matches == false, "a front-table 9 on a back is a mismatch")
        expect(lastTableCheck?.localLabel == "10.0 assisted", "local back 60/40 is 10.0 assisted")
        expect(lastTableCheck?.serverLabel == "9.0 assisted", "the mismatch records the server label")
        expect(lastTableCheck?.side == "back", "the mismatch records the back side")
        expect(backSnap.assistedLRText == "60.0%/40.0% assisted", "assisted L/R is labelled assisted")
        expect(backSnap.assistedTBText == "50.0%/50.0% assisted", "assisted T/B is labelled assisted")
        expect(backSnap.displayLine == "9.0 assisted — Centering (you adjusted 1 side)", "the display line keeps the server label")
        guard var agreeAssist = backReport["centeringAssist"] as? [String: Any] else {
            expect(false, "back assist block is a dictionary")
            return
        }
        agreeAssist["centeringLabel"] = "10.0 assisted"
        var agreeReport = backReport
        agreeReport["centeringAssist"] = agreeAssist
        let agreeSnap = parse(report: agreeReport, item: ["side": "back", "deckId": "TD-06"])
        expect(agreeSnap?.centeringLabel == "10.0 assisted", "an agreeing server label is shown as stored")
        expect(lastTableCheck?.matches == true)
        expect(agreeSnap?.displayLine?.contains("PSA") == false)
        let frontReport = backReport.merging(["side": "front"]) { _, new in new }
        let frontSnap = parse(report: frontReport, item: ["side": "front"])
        expect(frontSnap?.centeringLabel == "9.0 assisted", "front 60/40 stays on the front table")
        expect(lastTableCheck?.matches == true)
        expect(lastTableCheck?.localLabel == "9.0 assisted")
        expect(frontSnap?.displayLine?.contains("PSA") == false)
        var pastReport = agreeReport
        guard var pastMetrics = pastReport["centeringMetrics"] as? [String: Any],
              var pastAssist = pastReport["centeringAssist"] as? [String: Any],
              var pastSides = pastAssist["sides"] as? [String: Any] else {
            expect(false, "past-90/10 report keeps metrics and assist dictionaries")
            return
        }
        pastMetrics["borderWidthsMm"] = ["left": 9.1, "right": 0.9, "top": 5.0, "bottom": 5.0]
        pastReport["centeringMetrics"] = pastMetrics
        pastSides["left"] = ["userWidthMm": 9.1, "engineWidthMm": 5.0, "kind": "disagreement"]
        pastSides["right"] = ["engineWidthMm": 0.9]
        pastAssist["sides"] = pastSides
        pastAssist["centeringLabel"] = NSNull()
        pastReport["centeringAssist"] = pastAssist
        let pastSnap = parse(report: pastReport, item: ["side": "back"])
        expect(pastSnap?.centeringLabel == nil, "a back past 90/10 keeps a withheld server label")
        expect(lastTableCheck?.matches == true)
        expect(lastTableCheck?.localLabel == nil)
        pastAssist["centeringLabel"] = "1.0 assisted"
        pastReport["centeringAssist"] = pastAssist
        let fabricated = parse(report: pastReport, item: ["side": "back"])
        expect(fabricated?.centeringLabel == "1.0 assisted", "the phone shows the server label when the tables disagree")
        expect(lastTableCheck?.matches == false)
        expect(lastTableCheck?.localLabel == nil)
        var quiet = backSnap
        quiet.adjustedCount = 0
        expect(quiet.assistedLRText == nil, "an unadjusted scan keeps the engine ratio")
        let vaultLedger = ScanLedger(
            scanId: "366A0E19-0000-4000-8000-000000000001",
            committedAt: .distantPast,
            name: ScanLedger.unidentified,
            setName: ScanLedger.absent,
            grade: nil,
            lrCentering: ScanLedger.absent,
            tbCentering: ScanLedger.absent,
            value: nil,
            familyId: nil,
            subGradesLabel: "",
            primaryFlaw: "",
            incomplete: true,
            cornersGrade: nil,
            debugPath: nil,
            centeringAssist: agreeSnap,
            deckId: "TD-06",
            side: "back"
        )
        let vaultCard = SavedCard(ledger: vaultLedger)
        expect(vaultCard.name == "Unidentified")
        expect(vaultCard.vaultSubtitle == "TD-06 · back")
        expect(vaultCard.asLedger.displayLR == "60.0%/40.0% assisted")
        expect(vaultCard.asLedger.displayTB == "50.0%/50.0% assisted")
        expect(vaultCard.displayGrade == "10.0 assisted — Centering (you adjusted 1 side)")
        expect(vaultCard.displayGrade.contains("PSA") == false)
        if let data = try? JSONEncoder().encode(vaultCard),
           let decoded = try? JSONDecoder().decode(SavedCard.self, from: data) {
            expect(decoded.deckId == "TD-06" && decoded.side == "back")
            expect(decoded.vaultSubtitle == "TD-06 · back")
        } else {
            expect(false, "vault record keeps the deck id")
        }
        let empty = plausibleRangeMM(side: "left", measured: [:])
        expect(empty?.minMM == 0 && empty?.maxMM == roundMM(cardWidthMM / 4))
        var flagged = updated
        flagged.sides["left"]?.userWidthMM = 11.43
        let warned = examples(scanId: "scan-1", previous: snap, updated: flagged, consent: false, createdAt: "2026-10-09T00:00:00Z", warnings: far)
        expect(warned.count == 1 && warned.first?.warningShown == true, "a confirmed implausible line records warningShown")
        expect(warned.first?.plausibleMinMM == 1.189 && warned.first?.plausibleMaxMM == 6.511, "the example stores the plausible range")
        expect(ScanLedger.predictedGradeText(9) == "Predicted PSA 9")
        expect(ScanLedger.predictedGradeText(9.5) == "Predicted PSA 9.5")
        expect(ScanLedger.predictedGradeText(8) == "Predicted PSA 8")

        var unknownSnap = backSnap
        unknownSnap.side = nil
        unknownSnap.centeringLabel = "9.0 assisted"
        unknownSnap.checkAssistedTable()
        expect(unknownSnap.displayLine == "Centering (you adjusted 1 side)", "a missing side withholds the assisted grade")
        expect(unknownSnap.displayLine?.contains("9.0") == false, "a missing side does not show a front-table grade")
        expect(lastTableCheck?.side == "unknown", "a missing side is not scored as the front")
        expect(lastTableCheck?.localLabel == nil, "a missing side has no local assisted grade")
        expect(ScanLedger.deckLine(deckId: "TD-06", side: nil) == "TD-06 · side unknown")
        expect(ScanLedger.knownFace(nil) == nil)
        expect(ScanLedger.knownFace("front") == "front")
        expect(ScanLedger.knownFace("top") == nil)

        let clock = ISO8601DateFormatter()
        clock.formatOptions = [.withInternetDateTime]
        guard let originalCapture = clock.date(from: "2026-10-12T21:57:08Z") else {
            expect(false, "the 10/12 capture instant parses")
            return
        }
        let resaveClock = originalCapture.addingTimeInterval(17 * 3600)
        func sampleLedger(scanId: String, at: Date, deck: String?, side: String?, assist: Snapshot?) -> ScanLedger {
            ScanLedger(
                scanId: scanId,
                committedAt: at,
                name: ScanLedger.unidentified,
                setName: ScanLedger.absent,
                grade: nil,
                lrCentering: ScanLedger.absent,
                tbCentering: ScanLedger.absent,
                value: nil,
                familyId: nil,
                subGradesLabel: "",
                primaryFlaw: "",
                incomplete: true,
                cornersGrade: nil,
                debugPath: nil,
                centeringAssist: assist,
                deckId: deck,
                side: side
            )
        }
        var stamped = backSnap
        stamped.adjustedAt = "2026-10-13T13:54:36.000Z"
        stamped.centeringLabel = "9.0 assisted"
        stamped.side = "front"
        let captured = sampleLedger(scanId: "td06-back-0001", at: originalCapture, deck: "TD-06", side: "back", assist: backSnap)
        let resaved = sampleLedger(scanId: "td06-back-0001", at: resaveClock, deck: "TD-13", side: "front", assist: stamped)
        let kept = ScanLedger.keepingCaptureIdentity(existing: captured, updated: resaved, explicitSide: nil)
        expect(kept.deckId == "TD-06", "a re-save keeps the capture deck id")
        expect(kept.side == "back", "a re-save keeps the capture side")
        expect(kept.committedAt == originalCapture, "a re-save keeps the capture time")
        expect(kept.centeringAssist?.side == "back", "the assist is scored on the capture side")
        expect(kept.centeringAssist?.adjustmentLine?.hasPrefix("adjusted ") == true, "the adjustment clock is stored apart from the scan time")
        expect(kept.centeringAssist?.adjustedAt == "2026-10-13T13:54:36.000Z", "the adjustment time is not the capture time")
        expect(adjustmentFormatter.timeZone == TimeZone.current, "the adjustment line uses the phone's time zone")
        expect(ScanLedger.timestampUsesLocalTimeZone, "the scan time uses the phone's time zone")

        let sideMissing = sampleLedger(scanId: "noside-scan-0001", at: originalCapture, deck: "TD-04", side: nil, assist: nil)
        let defaultedFront = sampleLedger(scanId: "noside-scan-0001", at: resaveClock, deck: "TD-13", side: "front", assist: stamped)
        let stillUnknown = ScanLedger.keepingCaptureIdentity(existing: sideMissing, updated: defaultedFront, explicitSide: nil)
        expect(stillUnknown.side == nil, "a missing side does not become front")
        expect(stillUnknown.deckId == "TD-04", "a missing side does not take the capture-screen deck")
        expect(stillUnknown.committedAt == originalCapture, "a missing side does not take the re-save clock")
        expect(stillUnknown.centeringAssist?.centeringLabel == nil, "a missing side withholds the assisted label")
        expect(stillUnknown.centeringAssist?.displayLine?.contains("9.0") != true, "a missing side does not display 9.0 assisted")
        expect(stillUnknown.deckLine == "TD-04 · side unknown")
        let chosenBack = ScanLedger.keepingCaptureIdentity(existing: sideMissing, updated: defaultedFront, explicitSide: "back")
        expect(chosenBack.side == "back", "an explicit back is stored on a side-less record")
        expect(chosenBack.deckId == "TD-04", "setting the side keeps the deck id")
        expect(chosenBack.committedAt == originalCapture, "setting the side keeps the scan time")
        expect(chosenBack.centeringAssist?.side == "back")

        let held = sampleLedger(
            scanId: "366A0E19-0000-4000-8000-000000000001",
            at: resaveClock,
            deck: "TD-13",
            side: "front",
            assist: stamped
        )
        let stillHeld = ScanLedger.keepingCaptureIdentity(existing: held, updated: resaved, explicitSide: nil)
        expect(stillHeld.committedAt == resaveClock, "the phone does not invent a capture time for 366A0E19")
        expect(stillHeld.deckId == "TD-13", "the phone does not invent a deck id for 366A0E19")

        guard let phoneCapture = clock.date(from: "2026-10-12T21:57:08Z"),
              let earlierPersist = clock.date(from: "2026-10-12T21:50:37Z"),
              var serverSnap = agreeSnap else {
            expect(false, "the phone capture instant and assisted snapshot parse")
            return
        }
        serverSnap.adjustedAt = "2026-10-13T14:54:36.000Z"
        serverSnap.centeringLabel = "10.0 assisted"
        serverSnap.side = "back"
        var staleAssist = stamped
        staleAssist.adjustedAt = nil
        staleAssist.centeringLabel = "9.0 assisted"
        staleAssist.side = "front"
        if var left = staleAssist.sides["left"] {
            left.userWidthMM = 5.6
            staleAssist.sides["left"] = left
        }
        if var right = staleAssist.sides["right"] {
            right.userWidthMM = 4.4
            staleAssist.sides["right"] = right
        }
        let staleLocal = sampleLedger(
            scanId: "366A0E19-0000-4000-8000-000000000001",
            at: phoneCapture,
            deck: "TD-13",
            side: "front",
            assist: staleAssist
        )
        let serverRecord = sampleLedger(
            scanId: "366A0E19-0000-4000-8000-000000000001",
            at: phoneCapture,
            deck: "TD-06",
            side: "back",
            assist: serverSnap
        )
        let offline = ScanLedger.refreshedFromServer(local: staleLocal, server: nil)
        expect(offline.offlineCopy, "an unreachable server leaves the local copy")
        expect(ScanLedger.offlineCopyLabel == "offline copy", "the local copy is marked offline copy")
        expect(offline.ledger.deckId == "TD-13" && offline.ledger.side == "front", "the offline copy keeps the phone's deck and side")
        expect(offline.ledger.committedAt == phoneCapture, "the offline copy keeps the phone's capture")
        expect(offline.ledger.centeringAssist?.centeringLabel == "9.0 assisted", "the offline copy keeps the phone's label")
        expect(offline.ledger.displayLR == "56.0%/44.0% assisted", "the offline copy keeps the phone's ratio")
        expect(offline.ledger.centeringAssist?.adjustmentLine == nil, "the offline copy has no adjustment line")
        let live = ScanLedger.refreshedFromServer(local: staleLocal, server: serverRecord)
        expect(live.offlineCopy == false, "a server record clears the offline mark")
        expect(live.ledger.deckId == "TD-06" && live.ledger.side == "back", "the server deck and side replace the phone's copy")
        expect(live.ledger.deckLine == "TD-06 · back")
        expect(live.ledger.committedAt == phoneCapture, "the scan clock is the phone capture stored on the server")
        expect(live.ledger.committedAt != earlierPersist, "the earlier server persist time is not the scan clock")
        let persistOnly = sampleLedger(
            scanId: "366A0E19-0000-4000-8000-000000000001",
            at: .distantPast,
            deck: "TD-06",
            side: "back",
            assist: serverSnap
        )
        let keptCapture = ScanLedger.refreshedFromServer(local: staleLocal, server: persistOnly)
        expect(keptCapture.ledger.deckId == "TD-06" && keptCapture.ledger.side == "back", "a record with no stored capture still replaces deck and side")
        expect(keptCapture.ledger.committedAt == phoneCapture, "a record with no stored capture keeps the phone capture")
        expect(keptCapture.ledger.committedAt != earlierPersist, "createdAt does not replace the phone capture")
        expect(live.ledger.displayGrade.contains("10.0 assisted"), "the server label replaces the phone's label")
        expect(live.ledger.displayLR == "60.0%/40.0% assisted", "the server L/R replaces the phone's ratio")
        expect(live.ledger.displayTB == "50.0%/50.0% assisted", "the server T/B replaces the phone's ratio")
        expect(live.ledger.centeringAssist?.adjustmentLine?.hasPrefix("adjusted ") == true, "the adjustment stays on its own line")
        expect(live.ledger.centeringAssist?.adjustedAt == "2026-10-13T14:54:36.000Z", "the adjustment clock is not the scan clock")
    }
    #endif
}

/// On-device example log. Nothing here is copied into the CSV manifest,
/// and `examplesClearedToLeave` stays empty until accounts, consent, and
/// a privacy policy exist.
enum CenteringAssistStore {
    static let consentKey = "judgeHelpImprove"
    private static let storageKey = "judgeCenteringExamples"

    static func consentIsOn(_ stored: Bool?) -> Bool {
        stored == true
    }

    static func helpImprove(defaults: UserDefaults = .standard) -> Bool {
        consentIsOn(defaults.object(forKey: consentKey) as? Bool)
    }

    static func setHelpImprove(_ on: Bool, defaults: UserDefaults = .standard) {
        defaults.set(on, forKey: consentKey)
    }

    static func append(_ rows: [CenteringAssist.Example], defaults: UserDefaults = .standard) {
        guard !rows.isEmpty else { return }
        var all = load(defaults: defaults)
        all.append(contentsOf: rows)
        if let data = try? JSONEncoder().encode(all) {
            defaults.set(data, forKey: storageKey)
        }
    }

    static func load(defaults: UserDefaults = .standard) -> [CenteringAssist.Example] {
        guard let data = defaults.data(forKey: storageKey),
              let rows = try? JSONDecoder().decode([CenteringAssist.Example].self, from: data) else {
            return []
        }
        return rows
    }

    /// Always empty. Consent does not unlock a copy off this device.
    static func examplesClearedToLeave() -> [CenteringAssist.Example] {
        []
    }
}

/// Drag one amber line, parallel to a card edge, on the server's warped card.
struct CenteringAssistEditor: View {
    let scanId: String
    let serverURL: String
    let snapshot: CenteringAssist.Snapshot
    /// The second value is the front/back button. A line save passes nil and must not change side.
    let onSaved: (ScanLedger, String?) -> Void

    @State private var image: UIImage?
    @State private var loadError: String?
    @State private var selected = "left"
    @State private var userPx: [String: Double] = [:]
    @State private var dirty = false
    @State private var dragging = false
    @State private var loupeAt: CGPoint = .zero
    @State private var status = ""
    @State private var saving = false
    @State private var confirming = false
    @State private var warningText = ""

    private var intro: String {
        if snapshot.needsAssist {
            return "The engine withheld a side or the centering score. Cyan marks on the card are lines it measured. Drag an amber line, parallel to the card edge, for each side you want to set. The number is millimetres from that edge."
        }
        return "Drag a line to disagree with a side the engine measured. Your line is kept next to the engine's number. Neither replaces the other."
    }

    private var sideUnknown: Bool {
        snapshot.side != "front" && snapshot.side != "back"
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Centering lines").font(.headline)
            if sideUnknown {
                Text("side unknown").font(.subheadline).bold()
                Text("Set front or back on this scan before an assisted grade is shown.")
                    .font(.caption)
                    .foregroundColor(.secondary)
                HStack {
                    Button("This is the front") { Task { await setFace("front") } }
                    Button("This is the back") { Task { await setFace("back") } }
                }
                .disabled(saving)
                if !status.isEmpty {
                    Text(status).font(.caption).foregroundColor(.secondary)
                }
            }
            Text(intro).font(.caption).foregroundColor(.secondary)
            if let image {
                frame(image)
                chips
                Text(readout).font(.subheadline).bold()
                if !warningText.isEmpty {
                    Text(warningText)
                        .font(.subheadline)
                        .bold()
                        .foregroundColor(Color(red: 1, green: 0.69, blue: 0.125))
                }
                HStack {
                    Button(buttonTitle) { Task { await save() } }
                        .disabled(saving || (!confirming && (!dirty || placedCount == 0)))
                    Text(status).font(.caption).foregroundColor(.secondary)
                }
                Text("Amber is your line. A saved result is labelled assisted. The engine's measurement stays as it was.")
                    .font(.caption)
                    .foregroundColor(.secondary)
            } else if let loadError {
                Text(loadError).font(.caption).foregroundColor(.secondary)
            } else {
                ProgressView("Loading warped card")
            }
        }
        .padding(.horizontal)
        .task { await loadImage() }
    }

    private func frame(_ image: UIImage) -> some View {
        Image(uiImage: image)
            .resizable()
            .aspectRatio(image.size.width / image.size.height, contentMode: .fit)
            .frame(maxWidth: 420)
            .background(Color.black)
            .cornerRadius(8)
            .overlay {
                GeometryReader { geo in
                    let size = geo.size
                    ZStack(alignment: .topLeading) {
                        Color.clear
                        ForEach(CenteringAssist.sides, id: \.self) { side in
                            if let px = userPx[side] {
                                lineMark(side: side, px: px, in: size)
                            }
                        }
                        if dragging, let px = userPx[selected] {
                            loupe(image: image, px: px, in: size)
                        }
                    }
                    .contentShape(Rectangle())
                    .gesture(
                        DragGesture(minimumDistance: 0)
                            .onChanged { value in
                                dirty = true
                                dragging = true
                                confirming = false
                                warningText = ""
                                place(at: value.location, in: size)
                            }
                            .onEnded { _ in dragging = false }
                    )
                }
            }
    }

    private func lineMark(side: String, px: Double, in size: CGSize) -> some View {
        let horizontal = side == "left" || side == "right"
        let span = horizontal ? snapshot.warpWidth : snapshot.warpHeight
        let fraction = CGFloat(px / span)
        return Rectangle()
            .fill(Color(red: 1, green: 0.69, blue: 0.125))
            .frame(width: horizontal ? 3 : size.width, height: horizontal ? size.height : 3)
            .offset(x: horizontal ? fraction * size.width - 1.5 : 0, y: horizontal ? 0 : fraction * size.height - 1.5)
    }

    private func loupe(image: UIImage, px: Double, in size: CGSize) -> some View {
        let zoom: CGFloat = 4
        let loupe: CGFloat = 148
        let horizontal = selected == "left" || selected == "right"
        let span = horizontal ? snapshot.warpWidth : snapshot.warpHeight
        let along = CGFloat(px / span)
        let point = loupeAt
        return Canvas { context, canvasSize in
            let drawW = size.width * zoom
            let drawH = size.height * zoom
            let origin = CGPoint(x: canvasSize.width / 2 - point.x * zoom, y: canvasSize.height / 2 - point.y * zoom)
            context.draw(Image(uiImage: image), in: CGRect(x: origin.x, y: origin.y, width: drawW, height: drawH))
            var path = Path()
            if horizontal {
                let x = canvasSize.width / 2 + (along * size.width - point.x) * zoom
                path.move(to: CGPoint(x: x, y: 0))
                path.addLine(to: CGPoint(x: x, y: canvasSize.height))
            } else {
                let y = canvasSize.height / 2 + (along * size.height - point.y) * zoom
                path.move(to: CGPoint(x: 0, y: y))
                path.addLine(to: CGPoint(x: canvasSize.width, y: y))
            }
            context.stroke(path, with: .color(Color(red: 1, green: 0.69, blue: 0.125)), lineWidth: 2)
        }
        .frame(width: loupe, height: loupe)
        .background(Color.black)
        .overlay(RoundedRectangle(cornerRadius: 8).stroke(Color(red: 1, green: 0.69, blue: 0.125), lineWidth: 2))
        .cornerRadius(8)
        .offset(x: min(max(0, point.x - loupe / 2), max(0, size.width - loupe)), y: max(0, point.y - loupe - 16))
        .allowsHitTesting(false)
    }

    private var chips: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack {
                ForEach(CenteringAssist.sides, id: \.self) { side in
                    Button(chipTitle(side)) { selected = side }
                        .font(.caption)
                        .padding(.horizontal, 8)
                        .padding(.vertical, 4)
                        .overlay(Capsule().stroke(selected == side ? Color.orange : Color.secondary.opacity(0.4)))
                }
            }
        }
    }

    private var readout: String {
        let label = selected.prefix(1).uppercased() + selected.dropFirst()
        let row = snapshot.sides[selected]
        guard let mm = liveMM(selected) else {
            if row?.withheld == true { return "\(label) is withheld. Drag a line parallel to that edge." }
            return "\(label) — engine \(format(row?.engineWidthMM)). Drag to place your line."
        }
        if row?.withheld == true { return "\(label) — you \(format(mm)), assisted." }
        return "\(label) — you \(format(mm)), engine \(format(row?.engineWidthMM))."
    }

    private var placedCount: Int {
        CenteringAssist.sides.filter { liveMM($0) != nil }.count
    }

    private var buttonTitle: String {
        if saving { return "Saving…" }
        if confirming { return "Save anyway" }
        return "Save adjustment"
    }

    private func placedWidths() -> [String: Double] {
        var widths: [String: Double] = [:]
        for side in CenteringAssist.sides {
            if let mm = liveMM(side) { widths[side] = mm }
        }
        return widths
    }

    private func chipTitle(_ side: String) -> String {
        let label = side.prefix(1).uppercased() + side.dropFirst()
        let row = snapshot.sides[side]
        if let mm = liveMM(side), row?.withheld == true { return "\(label) — you \(format(mm)) (assisted)" }
        if let mm = liveMM(side) { return "\(label) — you \(format(mm)) (engine \(format(row?.engineWidthMM)))" }
        if row?.withheld == true { return "\(label) — withheld" }
        return "\(label) — engine \(format(row?.engineWidthMM))"
    }

    private func format(_ value: Double?) -> String {
        guard let value, value.isFinite else { return "—" }
        return CenteringAssist.displayMM(value)
    }

    private func liveMM(_ side: String) -> Double? {
        guard let px = userPx[side] else { return nil }
        return CenteringAssist.widthMM(side: side, positionPx: px, warpWidth: snapshot.warpWidth, warpHeight: snapshot.warpHeight)
    }

    private func place(at location: CGPoint, in size: CGSize) {
        guard size.width > 1, size.height > 1 else { return }
        loupeAt = location
        let horizontal = selected == "left" || selected == "right"
        let fraction = horizontal ? location.x / size.width : location.y / size.height
        let span = horizontal ? snapshot.warpWidth : snapshot.warpHeight
        let raw = Double(min(max(fraction, 0), 1)) * span
        let maxPx = (horizontal ? snapshot.warpWidth : snapshot.warpHeight) - 1
        userPx[selected] = min(max(raw, 0), maxPx)
    }

    private func loadImage() async {
        if selected == "left", let first = CenteringAssist.sides.first(where: { snapshot.sides[$0]?.withheld == true }) {
            selected = first
        }
        for side in CenteringAssist.sides {
            guard userPx[side] == nil, let mm = snapshot.sides[side]?.userWidthMM else { continue }
            userPx[side] = CenteringAssist.linePx(side: side, widthMM: mm, warpWidth: snapshot.warpWidth, warpHeight: snapshot.warpHeight)
        }
        guard let root = JudgeAPIClient.normalizedBaseURL(serverURL) else {
            loadError = "Set the home server address before adjusting a line."
            return
        }
        let url = root.appendingPathComponent("scans").appendingPathComponent(scanId).appendingPathComponent("oriented.jpg")
        do {
            let data = try await JudgeAPIClient.shared.fetch(url)
            guard let loaded = UIImage(data: data), loaded.size.width > 1 else {
                loadError = "This scan has no warped card, so a line cannot be placed."
                return
            }
            if abs(Double(loaded.size.width) - snapshot.warpWidth) > 1 || abs(Double(loaded.size.height) - snapshot.warpHeight) > 1 {
                loadError = "The warped card does not match this scan's measurements."
                return
            }
            image = loaded
        } catch {
            loadError = "Could not load the warped card from the home server."
        }
    }

    private func save() async {
        var lines: [String: [String: Double]] = [:]
        for side in CenteringAssist.sides {
            guard userPx[side] != nil, liveMM(side) != nil, let px = userPx[side] else { continue }
            lines[side] = [
                "positionPx": px,
                "warpWidth": snapshot.warpWidth,
                "warpHeight": snapshot.warpHeight
            ]
        }
        guard !lines.isEmpty else { return }
        let hits = CenteringAssist.implausibleSides(snapshot: snapshot, userWidths: placedWidths())
        if !hits.isEmpty && !confirming {
            confirming = true
            warningText = CenteringAssist.plausibilityWarning(hits)
            status = ""
            return
        }
        saving = true
        status = "Saving…"
        let consent = CenteringAssistStore.helpImprove()
        do {
            let report = try await JudgeAPIClient.shared.submitCenteringAssist(
                baseURL: serverURL,
                scanId: scanId,
                lines: lines,
                consent: consent,
                confirmImplausible: confirming
            )
            if let updated = report.centeringAssist {
                let created = ISO8601DateFormatter().string(from: Date())
                let rows = CenteringAssist.examples(
                    scanId: scanId,
                    previous: snapshot,
                    updated: updated,
                    consent: consent,
                    createdAt: created,
                    warnings: hits
                )
                CenteringAssistStore.append(rows)
            }
            status = "Saved. This centering is assisted."
            warningText = ""
            confirming = false
            dirty = false
            onSaved(JudgeAPIClient.ledger(from: report, clientScanId: scanId), nil)
        } catch let error as JudgeAPIClient.APIError {
            if case .implausible(let message) = error {
                confirming = true
                warningText = message
                status = ""
            } else {
                status = error.localizedDescription
            }
        } catch {
            status = error.localizedDescription
        }
        saving = false
    }

    private func setFace(_ face: String) async {
        var lines: [String: [String: Double]] = [:]
        for side in CenteringAssist.sides {
            guard userPx[side] != nil, liveMM(side) != nil, let px = userPx[side] else { continue }
            lines[side] = [
                "positionPx": px,
                "warpWidth": snapshot.warpWidth,
                "warpHeight": snapshot.warpHeight
            ]
        }
        saving = true
        status = "Saving…"
        do {
            let report = try await JudgeAPIClient.shared.submitCenteringAssist(
                baseURL: serverURL,
                scanId: scanId,
                lines: lines,
                consent: CenteringAssistStore.helpImprove(),
                confirmImplausible: confirming,
                setSide: face
            )
            status = "Saved. This centering is assisted."
            warningText = ""
            confirming = false
            dirty = false
            onSaved(JudgeAPIClient.ledger(from: report, clientScanId: scanId), face)
        } catch let error as JudgeAPIClient.APIError {
            if case .implausible(let message) = error {
                confirming = true
                warningText = message
                status = ""
            } else {
                status = error.localizedDescription
            }
        } catch {
            status = error.localizedDescription
        }
        saving = false
    }
}
