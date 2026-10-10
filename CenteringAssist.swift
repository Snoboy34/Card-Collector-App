import Foundation
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
            adjustedCount: Int
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
        }

        public var displayLine: String? {
            guard let headline, !headline.isEmpty else { return nil }
            if let centeringLabel, !centeringLabel.isEmpty {
                return "\(centeringLabel) — \(headline)"
            }
            return headline
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
        var minMM = roundMM(max(0, lo - unit) * edge)
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

    static func mmText(_ value: Double) -> String {
        let rounded = roundMM(value)
        var text = String(format: "%.3f", rounded)
        while text.hasSuffix("0") { text.removeLast() }
        if text.hasSuffix(".") { text.removeLast() }
        return text
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
        return Snapshot(
            warpWidth: warpWidth,
            warpHeight: warpHeight,
            centeringWithheld: withheldScore,
            engineVersion: version,
            engineCommit: commit,
            sides: sides,
            candidatesJSON: candidatesJSON,
            headline: assist?["headline"] as? String,
            centeringLabel: assist?["centeringLabel"] as? String,
            adjustedCount: Int(doubleValue(assist?["adjustedCount"]) ?? 0)
        )
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

    #if DEBUG
    static func runContractChecks() {
        let warpW = 643.0
        let warpH = 900.0
        let leftPx = 4.0 * warpW / cardWidthMM
        let leftMM = widthMM(side: "left", positionPx: leftPx, warpWidth: warpW, warpHeight: warpH)
        precondition(leftMM == 4, "left mm \(String(describing: leftMM))")
        let back = linePx(side: "left", widthMM: leftMM ?? -1, warpWidth: warpW, warpHeight: warpH)
        let roundTrip = widthMM(side: "left", positionPx: back ?? -1, warpWidth: warpW, warpHeight: warpH)
        precondition(roundTrip == leftMM, "round trip")
        precondition(widthMM(side: "left", positionPx: -1, warpWidth: warpW, warpHeight: warpH) == nil)
        precondition(widthMM(side: "left", positionPx: 0, warpWidth: warpW, warpHeight: warpH) == 0)
        precondition(headline(adjustedCount: 1) == "Centering (you adjusted 1 side)")
        precondition(headline(adjustedCount: 2) == "Centering (you adjusted 2 sides)")
        precondition(sameMM(4, 4.0004))
        precondition(!sameMM(4, 4.01))

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
        let snap = parse(report: report, item: item)
        precondition(snap?.sides["left"]?.withheld == true)
        precondition(snap?.sides["right"]?.withheld == false)
        precondition(snap?.sides["right"]?.engineWidthMM == 4.737)
        precondition(snap?.centeringWithheld == true)
        precondition(snap?.engineCommit == "abc1234")
        precondition(snap?.needsAssist == true)
        precondition(snap?.displayLine == nil)

        var updated = snap!
        updated.sides["left"]?.userWidthMM = 4
        updated.sides["left"]?.kind = "assisted"
        updated.headline = headline(adjustedCount: 1)
        updated.centeringLabel = "7.0 assisted"
        updated.adjustedCount = 1
        let rows = examples(scanId: "scan-1", previous: snap!, updated: updated, consent: false, createdAt: "2026-10-09T00:00:00Z")
        precondition(rows.count == 1)
        precondition(rows[0].kind == "assisted")
        precondition(rows[0].consent == false)
        precondition(rows[0].userWidthMM == 4)
        precondition(rows[0].engineWidthMM == nil)
        precondition(rows[0].engineCandidateLines?.contains("22.5") == true)
        precondition(rows[0].engineVersion == "2026.10.01-border-band")
        let again = examples(scanId: "scan-1", previous: updated, updated: updated, consent: false, createdAt: "2026-10-09T00:00:00Z")
        precondition(again.isEmpty, "the same line must not become a second example")
        precondition(updated.displayLine == "7.0 assisted — Centering (you adjusted 1 side)")
        precondition(updated.displayLine?.contains("PSA") == false)

        var disagreed = snap!
        disagreed.sides["right"]?.userWidthMM = 5
        disagreed.sides["right"]?.kind = "disagreement"
        disagreed.headline = headline(adjustedCount: 1)
        let disagreement = examples(scanId: "scan-1", previous: snap!, updated: disagreed, consent: false, createdAt: "2026-10-09T00:00:00Z")
        precondition(disagreement.count == 1 && disagreement[0].kind == "disagreement")
        precondition(disagreement[0].engineWidthMM == 4.737)
        precondition(rows[0].warningShown == false)
        precondition(CenteringAssistStore.examplesClearedToLeave().isEmpty)
        precondition(CenteringAssistStore.consentIsOn(nil) == false)
        precondition(CenteringAssistStore.consentIsOn(false) == false)
        precondition(CenteringAssistStore.consentIsOn(true) == true)

        let measured: [String: Double] = ["right": 4.737, "top": 4.148, "bottom": 4.936]
        let range = plausibleRangeMM(side: "left", measured: measured)
        precondition(range?.minMM == 1.189, "min \(String(describing: range?.minMM))")
        precondition(range?.maxMM == 6.511, "max \(String(describing: range?.maxMM))")
        let far = implausibleSides(snapshot: snap!, userWidths: ["left": 11.43])
        precondition(far.count == 1 && far[0].userWidthMM == 11.43)
        precondition(far[0].minMM == 1.189 && far[0].maxMM == 6.511)
        precondition(implausibleSides(snapshot: snap!, userWidths: ["left": 4]).isEmpty)
        let warning = plausibilityWarning(far)
        precondition(warning.contains("11.43"))
        precondition(warning.contains("1.189") && warning.contains("6.511"))
        precondition(warning.contains("Save again"))
        let empty = plausibleRangeMM(side: "left", measured: [:])
        precondition(empty?.minMM == 0 && empty?.maxMM == roundMM(cardWidthMM / 4))
        var flagged = updated
        flagged.sides["left"]?.userWidthMM = 11.43
        let warned = examples(scanId: "scan-1", previous: snap!, updated: flagged, consent: false, createdAt: "2026-10-09T00:00:00Z", warnings: far)
        precondition(warned.count == 1 && warned[0].warningShown == true)
        precondition(warned[0].plausibleMinMM == 1.189 && warned[0].plausibleMaxMM == 6.511)
        precondition(ScanLedger.predictedGradeText(9) == "Predicted PSA 9")
        precondition(ScanLedger.predictedGradeText(9.5) == "Predicted PSA 9.5")
        precondition(ScanLedger.predictedGradeText(8) == "Predicted PSA 8")
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
    let onSaved: (ScanLedger) -> Void

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

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Centering lines").font(.headline)
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
        return "\(CenteringAssist.roundMM(value)) mm"
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
            onSaved(JudgeAPIClient.ledger(from: report, clientScanId: scanId))
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
