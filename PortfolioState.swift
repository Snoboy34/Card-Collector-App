import Foundation
import SwiftUI

/// Fields the Capture → /api/grade path produced. Report sheet and vault
/// both render this so they cannot disagree. Missing measurements stay
/// "Unidentified" / "—" — never a mock name, grade, or price.
public struct ScanLedger: Equatable {
    public static let unidentified = "Unidentified"
    public static let absent = "—"

    public let scanId: String
    public let committedAt: Date
    public let name: String
    public let setName: String
    public let grade: Double?
    public let lrCentering: String
    public let tbCentering: String
    public let value: Double?
    public let familyId: String?
    public let subGradesLabel: String
    public let primaryFlaw: String
    public let incomplete: Bool
    public let cornersGrade: Double?
    public let debugPath: String?
    public let centeringAssist: CenteringAssist.Snapshot?
    public let deckId: String?
    public let side: String?

    public var displayCorners: String {
        guard let cornersGrade else { return Self.absent }
        return String(format: "%.1f", cornersGrade)
    }

    /// Engine final score is a prediction. Whole numbers drop the trailing .0.
    public static func predictedGradeText(_ grade: Double) -> String {
        let tenths = (grade * 10).rounded() / 10
        let text = String(format: "%.1f", tenths)
        if text.hasSuffix(".0") {
            return "Predicted PSA " + String(text.dropLast(2))
        }
        return "Predicted PSA " + text
    }

    /// Engine final score only. An assisted centering is never formatted as PSA.
    public var displayEngineGrade: String {
        guard let grade else { return Self.absent }
        return Self.predictedGradeText(grade)
    }

    /// L/R from the dragged lines when an assist is saved. Otherwise the engine ratio.
    public var displayLR: String {
        if let text = centeringAssist?.assistedLRText { return text }
        return lrCentering
    }

    /// T/B from the dragged lines when an assist is saved. Otherwise the engine ratio.
    public var displayTB: String {
        if let text = centeringAssist?.assistedTBText { return text }
        return tbCentering
    }

    public static func knownFace(_ side: String?) -> String? {
        if side == "front" || side == "back" { return side }
        return nil
    }

    public static func deckLine(deckId: String?, side: String?) -> String? {
        guard let deckId else { return nil }
        let trimmed = deckId.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty { return nil }
        if side == "back" { return trimmed + " · back" }
        if side == "front" { return trimmed + " · front" }
        return trimmed + " · side unknown"
    }

    public static let offlineCopyLabel = "offline copy"

    /// Local merge used when a save has no server record to apply.
    /// Deck, side, and scan time stay on the existing ledger.
    /// `explicitSide` is the front/back button on a record that has no side yet.
    public static func keepingCaptureIdentity(existing: ScanLedger, updated: ScanLedger, explicitSide: String?) -> ScanLedger {
        let keptSide = knownFace(existing.side) ?? knownFace(explicitSide)
        var assist = updated.centeringAssist
        if var snap = assist {
            if let keptSide {
                snap.side = keptSide
            } else {
                snap.side = nil
                snap.centeringLabel = nil
            }
            assist = snap
        }
        let merged = ScanLedger(
            scanId: existing.scanId,
            committedAt: existing.committedAt,
            name: existing.name,
            setName: existing.setName,
            grade: existing.grade ?? updated.grade,
            lrCentering: updated.lrCentering,
            tbCentering: updated.tbCentering,
            value: existing.value,
            familyId: existing.familyId,
            subGradesLabel: updated.subGradesLabel,
            primaryFlaw: existing.primaryFlaw,
            incomplete: existing.incomplete,
            cornersGrade: updated.cornersGrade,
            debugPath: updated.debugPath,
            centeringAssist: assist,
            deckId: nonempty(existing.deckId) ?? nonempty(updated.deckId),
            side: keptSide
        )
        return merged
    }

    /// The server record replaces deck, side, assisted label, ratios, and the
    /// scan clock. The scan clock is the server's createdAt. A later local
    /// ledger time is not copied onto that clock. Name, set, and value stay
    /// on the local card.
    public static func applyingServerRecord(local: ScanLedger, server: ScanLedger) -> ScanLedger {
        let face = knownFace(server.side) ?? knownFace(server.centeringAssist?.side)
        var assist = server.centeringAssist
        if var snap = assist {
            snap.side = face
            if face == nil {
                snap.centeringLabel = nil
            }
            assist = snap
        }
        let scanTime = server.committedAt == .distantPast ? local.committedAt : server.committedAt
        return ScanLedger(
            scanId: nonempty(server.scanId) ?? local.scanId,
            committedAt: scanTime,
            name: local.name,
            setName: local.setName,
            grade: server.grade ?? local.grade,
            lrCentering: server.lrCentering,
            tbCentering: server.tbCentering,
            value: local.value,
            familyId: local.familyId,
            subGradesLabel: server.subGradesLabel.isEmpty ? local.subGradesLabel : server.subGradesLabel,
            primaryFlaw: local.primaryFlaw,
            incomplete: server.grade == nil ? local.incomplete : server.incomplete,
            cornersGrade: server.cornersGrade ?? local.cornersGrade,
            debugPath: server.debugPath ?? local.debugPath,
            centeringAssist: assist,
            deckId: nonempty(server.deckId) ?? nonempty(local.deckId),
            side: face
        )
    }

    /// A reachable server replaces the local copy. No server record leaves
    /// the local copy and marks it an offline copy.
    public static func refreshedFromServer(local: ScanLedger, server: ScanLedger?) -> (ledger: ScanLedger, offlineCopy: Bool) {
        guard let server else { return (local, true) }
        return (applyingServerRecord(local: local, server: server), false)
    }

    public var showsSideUnknown: Bool {
        Self.knownFace(side) == nil
    }

    private static func nonempty(_ value: String?) -> String? {
        guard let value else { return nil }
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }

    public var deckLine: String? {
        Self.deckLine(deckId: deckId, side: side)
    }

    /// Assisted line when the user moved a border. Otherwise the engine grade.
    public var displayGrade: String {
        if let line = centeringAssist?.displayLine { return line }
        return displayEngineGrade
    }

    public var displayValue: String {
        guard let value else { return Self.absent }
        return String(format: "$%.2f", value)
    }

    public var displayScanIdShort: String {
        String(scanId.prefix(8))
    }

    public var displayTimestamp: String {
        if committedAt == .distantPast { return Self.absent }
        return Self.localTimestampFormatter.string(from: committedAt)
    }

    public var recordId: UUID {
        UUID(uuidString: scanId) ?? UUID()
    }

    /// Scan time is formatted in the phone's current time zone.
    static var timestampUsesLocalTimeZone: Bool {
        localTimestampFormatter.timeZone == TimeZone.current &&
        ScanLedgerFields.timestampFormatter.timeZone == TimeZone.current
    }

    private static let localTimestampFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.dateStyle = .short
        formatter.timeStyle = .medium
        formatter.timeZone = TimeZone.current
        return formatter
    }()
}

public struct SavedCard: Identifiable, Codable {
    public let id: UUID
    public let scanId: String
    public let committedAt: Date
    public let name: String
    public let setName: String
    public let lrCenteringResult: String
    public let tbCenteringResult: String
    public let predictedGradePSA: Double?
    public let calculatedValue: Double?
    public let familyId: String?
    public let subGradesLabel: String
    public let cornersGrade: Double?
    public let debugPath: String?
    public let centeringAssist: CenteringAssist.Snapshot?
    public let deckId: String?
    public let side: String?
    public var offlineCopy: Bool
    public var targetBatchId: UUID?

    public init(
        id: UUID = UUID(),
        scanId: String,
        committedAt: Date,
        name: String,
        set: String,
        lrCentering: String,
        tbCentering: String,
        predictedGrade: Double?,
        marketValue: Double?,
        familyId: String? = nil,
        subGradesLabel: String = "",
        cornersGrade: Double? = nil,
        debugPath: String? = nil,
        centeringAssist: CenteringAssist.Snapshot? = nil,
        deckId: String? = nil,
        side: String? = nil,
        offlineCopy: Bool = false,
        batchId: UUID? = nil
    ) {
        self.id = id
        self.scanId = scanId
        self.committedAt = committedAt
        self.name = name
        self.setName = set
        self.lrCenteringResult = lrCentering
        self.tbCenteringResult = tbCentering
        self.predictedGradePSA = predictedGrade
        self.calculatedValue = marketValue
        self.familyId = familyId
        self.subGradesLabel = subGradesLabel
        self.cornersGrade = cornersGrade
        self.debugPath = debugPath
        self.centeringAssist = centeringAssist
        self.deckId = deckId
        self.side = side
        self.offlineCopy = offlineCopy
        self.targetBatchId = batchId
    }

    public init(ledger: ScanLedger, batchId: UUID? = nil) {
        self.init(
            id: ledger.recordId,
            scanId: ledger.scanId,
            committedAt: ledger.committedAt,
            name: ledger.name,
            set: ledger.setName,
            lrCentering: ledger.lrCentering,
            tbCentering: ledger.tbCentering,
            predictedGrade: ledger.grade,
            marketValue: ledger.value,
            familyId: ledger.familyId,
            subGradesLabel: ledger.subGradesLabel,
            cornersGrade: ledger.cornersGrade,
            debugPath: ledger.debugPath,
            centeringAssist: ledger.centeringAssist,
            deckId: ledger.deckId,
            side: ledger.side,
            batchId: batchId
        )
    }

    public var displayEngineGrade: String {
        guard let predictedGradePSA else { return ScanLedger.absent }
        return ScanLedger.predictedGradeText(predictedGradePSA)
    }

    public var displayGrade: String {
        if let line = centeringAssist?.displayLine { return line }
        return displayEngineGrade
    }

    public var deckLine: String? {
        ScanLedger.deckLine(deckId: deckId, side: side)
    }

    public var vaultSubtitle: String {
        if let deckLine { return deckLine }
        return setName
    }

    public var displayValue: String {
        guard let calculatedValue else { return ScanLedger.absent }
        return String(format: "$%.2f", calculatedValue)
    }

    public var displayScanIdShort: String {
        String(scanId.prefix(8))
    }

    public var displayTimestamp: String {
        if committedAt == .distantPast { return ScanLedger.absent }
        return ScanLedgerFields.timestampFormatter.string(from: committedAt)
    }

    public var asLedger: ScanLedger {
        ScanLedger(
            scanId: scanId,
            committedAt: committedAt,
            name: name.isEmpty ? ScanLedger.unidentified : name,
            setName: setName.isEmpty ? ScanLedger.absent : setName,
            grade: predictedGradePSA,
            lrCentering: lrCenteringResult.isEmpty ? ScanLedger.absent : lrCenteringResult,
            tbCentering: tbCenteringResult.isEmpty ? ScanLedger.absent : tbCenteringResult,
            value: calculatedValue,
            familyId: familyId,
            subGradesLabel: subGradesLabel,
            primaryFlaw: "",
            incomplete: predictedGradePSA == nil,
            cornersGrade: cornersGrade,
            debugPath: debugPath,
            centeringAssist: centeringAssist,
            deckId: deckId,
            side: side
        )
    }

    public func assigned(to batchId: UUID) -> SavedCard {
        var copy = self
        copy.targetBatchId = batchId
        return copy
    }

    enum CodingKeys: String, CodingKey {
        case id, scanId, committedAt, name, setName
        case lrCenteringResult, tbCenteringResult
        case predictedGradePSA, calculatedValue, familyId, subGradesLabel, cornersGrade, debugPath, centeringAssist, deckId, side, offlineCopy, targetBatchId
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(UUID.self, forKey: .id)
        name = try container.decode(String.self, forKey: .name)
        setName = try container.decode(String.self, forKey: .setName)
        lrCenteringResult = try container.decode(String.self, forKey: .lrCenteringResult)
        tbCenteringResult = try container.decode(String.self, forKey: .tbCenteringResult)
        if let grade = try? container.decodeIfPresent(Double.self, forKey: .predictedGradePSA) {
            predictedGradePSA = grade
        } else if let grade = try? container.decodeIfPresent(Int.self, forKey: .predictedGradePSA) {
            predictedGradePSA = Double(grade)
        } else {
            predictedGradePSA = nil
        }
        calculatedValue = try container.decodeIfPresent(Double.self, forKey: .calculatedValue)
        scanId = try container.decodeIfPresent(String.self, forKey: .scanId) ?? id.uuidString
        committedAt = try container.decodeIfPresent(Date.self, forKey: .committedAt) ?? .distantPast
        familyId = try container.decodeIfPresent(String.self, forKey: .familyId)
        subGradesLabel = try container.decodeIfPresent(String.self, forKey: .subGradesLabel) ?? ""
        cornersGrade = try container.decodeIfPresent(Double.self, forKey: .cornersGrade)
        debugPath = try container.decodeIfPresent(String.self, forKey: .debugPath)
        centeringAssist = try container.decodeIfPresent(CenteringAssist.Snapshot.self, forKey: .centeringAssist)
        deckId = try container.decodeIfPresent(String.self, forKey: .deckId)
        side = try container.decodeIfPresent(String.self, forKey: .side)
        offlineCopy = try container.decodeIfPresent(Bool.self, forKey: .offlineCopy) ?? false
        targetBatchId = try container.decodeIfPresent(UUID.self, forKey: .targetBatchId)
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(id, forKey: .id)
        try container.encode(scanId, forKey: .scanId)
        try container.encode(committedAt, forKey: .committedAt)
        try container.encode(name, forKey: .name)
        try container.encode(setName, forKey: .setName)
        try container.encode(lrCenteringResult, forKey: .lrCenteringResult)
        try container.encode(tbCenteringResult, forKey: .tbCenteringResult)
        try container.encodeIfPresent(predictedGradePSA, forKey: .predictedGradePSA)
        try container.encodeIfPresent(calculatedValue, forKey: .calculatedValue)
        try container.encodeIfPresent(familyId, forKey: .familyId)
        try container.encode(subGradesLabel, forKey: .subGradesLabel)
        try container.encodeIfPresent(cornersGrade, forKey: .cornersGrade)
        try container.encodeIfPresent(debugPath, forKey: .debugPath)
        try container.encodeIfPresent(centeringAssist, forKey: .centeringAssist)
        try container.encodeIfPresent(deckId, forKey: .deckId)
        try container.encodeIfPresent(side, forKey: .side)
        try container.encode(offlineCopy, forKey: .offlineCopy)
        try container.encodeIfPresent(targetBatchId, forKey: .targetBatchId)
    }
}

enum ScanLedgerFields {
    static let timestampFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.dateStyle = .short
        formatter.timeStyle = .medium
        formatter.timeZone = TimeZone.current
        return formatter
    }()
}

public struct ValueSnapshot: Identifiable, Codable {
    public let id: UUID
    public let date: Date
    public let value: Double

    public init(id: UUID = UUID(), date: Date, value: Double) {
        self.id = id
        self.date = date
        self.value = value
    }
}

public struct SubmissionBatch: Identifiable, Codable {
    public let id: UUID
    public var batchName: String
    public var gradingServiceTarget: String
    public var creationDate: Date

    public init(id: UUID = UUID(), name: String, service: String = "PSA", date: Date = Date()) {
        self.id = id
        self.batchName = name
        self.gradingServiceTarget = service
        self.creationDate = date
    }
}

public struct ArbitrageOpportunity: Identifiable {
    public let id = UUID()
    public let companyName: String
    public let projectedGrade: Double
    public let grossValue: Double
    public let upfrontFee: Double
    public let turnaroundDays: Int
    public var netProfitROI: Double {
        return grossValue - upfrontFee
    }
}

public class PortfolioState: ObservableObject {

    @Published public var savedCards: [SavedCard] = []
    @Published public var historicalTrendSnapshots: [ValueSnapshot] = []
    @Published public var activeSubmissionBatches: [SubmissionBatch] = []

    private let storageKeyCards = "com.cardgrader.portfolio.savedcards"
    private let storageKeyTrend = "com.cardgrader.portfolio.trendsnapshots"
    private let storageKeyBatches = "com.cardgrader.portfolio.activebatches"

    public var totalPortfolioValue: Double {
        savedCards.reduce(0.0) { $0 + ($1.calculatedValue ?? 0) }
    }

    public var hasPricedCards: Bool {
        savedCards.contains { $0.calculatedValue != nil }
    }

    public init() {
        loadDataFromPersistentDisk()

        if activeSubmissionBatches.isEmpty {
            createNewSubmissionBatch(name: "PSA Quarter Bulk Tier", service: "PSA")
            createNewSubmissionBatch(name: "BGS Express Autographs", service: "BGS")
        }
        if historicalTrendSnapshots.isEmpty && totalPortfolioValue > 0 {
            seedInitialTrendCurveMetrics()
        }
    }

    public func simulateCrossCompanyScore(for card: SavedCard, targetCompany: String) -> (grade: Double?, estimatedValue: Double?) {
        guard let baseGrade = card.predictedGradePSA else {
            return (nil, nil)
        }
        guard let value = card.calculatedValue else {
            return (baseGrade, nil)
        }

        switch targetCompany {
        case "BGS":
            let adjustedGrade = card.lrCenteringResult.contains("50%") ? baseGrade : max(1.0, baseGrade - 0.5)
            return (adjustedGrade, value * 1.15)
        case "CGC":
            return (baseGrade, value * 0.90)
        case "SGC":
            let adjustedGrade = baseGrade >= 10 ? 10.0 : baseGrade
            return (adjustedGrade, value * 1.05)
        case "TAG":
            let adjustedGrade = card.lrCenteringResult.contains("50%") ? baseGrade : max(1.0, baseGrade - 0.2)
            return (adjustedGrade, value * 1.10)
        default:
            return (baseGrade, value)
        }
    }

    public func calculateArbitrageMatrix(for card: SavedCard) -> [ArbitrageOpportunity] {
        guard card.predictedGradePSA != nil, card.calculatedValue != nil else { return [] }
        let companies = ["PSA", "BGS", "CGC", "SGC", "TAG"]
        let fees = ["PSA": 25.0, "BGS": 35.0, "CGC": 15.0, "SGC": 18.0, "TAG": 20.0]
        let turnarounds = ["PSA": 45, "BGS": 20, "CGC": 10, "SGC": 5, "TAG": 14]

        return companies.compactMap { company in
            let sim = simulateCrossCompanyScore(for: card, targetCompany: company)
            guard let projected = sim.grade, let gross = sim.estimatedValue else { return nil }
            return ArbitrageOpportunity(
                companyName: company,
                projectedGrade: projected,
                grossValue: gross,
                upfrontFee: fees[company] ?? 20.0,
                turnaroundDays: turnarounds[company] ?? 14
            )
        }.sorted { $0.netProfitROI > $1.netProfitROI }
    }

    public func generateCompressedBatchPayload(for batchId: UUID?) -> String {
        guard let targetId = batchId else { return "NoActiveBatchStaged" }
        let segmentedList = savedCards.filter { $0.targetBatchId == targetId }
        guard !segmentedList.isEmpty else { return "BatchEmpty" }

        var summaryString = "MANIFEST_ID:\(targetId.uuidString.prefix(6))|"
        for item in segmentedList {
            summaryString.append("\(item.name.prefix(8))-\(item.displayGrade);")
        }
        return summaryString.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? "SerializationError"
    }

    public func appendCard(from ledger: ScanLedger) {
        let fallbackBatchId = activeSubmissionBatches.first?.id
        savedCards.append(SavedCard(ledger: ledger, batchId: fallbackBatchId))
        appendLiveTrendSnapshotRecord(with: totalPortfolioValue)
        saveDataToPersistentDisk()
    }

    /// A server record replaces deck, side, label, ratios, and the scan clock.
    /// Without one, the existing capture identity stays.
    public func replaceSavedCard(id: UUID, ledger: ScanLedger, adoptServerRecord: Bool = false) {
        guard let index = savedCards.firstIndex(where: { $0.id == id }) else { return }
        let existing = savedCards[index]
        let merged: ScanLedger
        if adoptServerRecord {
            merged = ScanLedger.applyingServerRecord(local: existing.asLedger, server: ledger)
        } else {
            let explicit = ScanLedger.knownFace(existing.side) == nil ? ledger.side : nil
            merged = ScanLedger.keepingCaptureIdentity(existing: existing.asLedger, updated: ledger, explicitSide: explicit)
        }
        savedCards[index] = SavedCard(
            id: existing.id,
            scanId: existing.scanId,
            committedAt: merged.committedAt,
            name: existing.name,
            set: existing.setName,
            lrCentering: merged.lrCentering,
            tbCentering: merged.tbCentering,
            predictedGrade: merged.grade,
            marketValue: existing.calculatedValue,
            familyId: existing.familyId,
            subGradesLabel: merged.subGradesLabel,
            cornersGrade: merged.cornersGrade,
            debugPath: merged.debugPath,
            centeringAssist: merged.centeringAssist,
            deckId: merged.deckId,
            side: merged.side,
            offlineCopy: adoptServerRecord ? false : existing.offlineCopy,
            batchId: existing.targetBatchId
        )
        saveDataToPersistentDisk()
    }

    public func markOfflineCopy(id: UUID) {
        guard let index = savedCards.firstIndex(where: { $0.id == id }) else { return }
        savedCards[index].offlineCopy = true
        saveDataToPersistentDisk()
    }

    public func deleteCard(at offsets: IndexSet) {
        savedCards.remove(atOffsets: offsets)
        appendLiveTrendSnapshotRecord(with: totalPortfolioValue)
        saveDataToPersistentDisk()
    }

    public func createNewSubmissionBatch(name: String, service: String) {
        let newBatch = SubmissionBatch(name: name, service: service)
        activeSubmissionBatches.append(newBatch)
        saveDataToPersistentDisk()
    }

    public func assignCardToBatch(cardId: UUID, batchId: UUID) {
        if let cardIndex = savedCards.firstIndex(where: { $0.id == cardId }) {
            let oldCard = savedCards[cardIndex]
            savedCards[cardIndex] = oldCard.assigned(to: batchId)
            saveDataToPersistentDisk()
        }
    }

    public func removeBatch(at offsets: IndexSet) {
        activeSubmissionBatches.remove(atOffsets: offsets)
        saveDataToPersistentDisk()
    }

    public func generatePrintableSubmissionManifest() -> URL? {
        let manifestDocumentFileName = "Bulk_Grading_Manifest_Invoice.csv"
        guard let deviceCacheDirectoryPath = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first else { return nil }

        let outputTargetURL = deviceCacheDirectoryPath.appendingPathComponent(manifestDocumentFileName)
        var csvStringDocumentPayload = "Scan ID,Committed At,Card Name,Expansion Set,L/R Centering,T/B Centering,Predicted PSA Grade,Assisted centering,Market Valuation,Family ID,Assigned Batch Folder,Deck ID\n"

        for asset in savedCards {
            let assignedFolderName = activeSubmissionBatches.first(where: { $0.id == asset.targetBatchId })?.batchName ?? "Unassigned Vault"
            let assisted = asset.centeringAssist?.headline ?? ScanLedger.absent
            let deck = asset.deckLine ?? ScanLedger.absent
            let layoutRowString = "\"\(asset.scanId)\",\"\(asset.displayTimestamp)\",\"\(asset.name)\",\"\(asset.setName)\",\"\(asset.lrCenteringResult)\",\"\(asset.tbCenteringResult)\",\"\(asset.displayEngineGrade)\",\"\(assisted)\",\"\(asset.displayValue)\",\"\(asset.familyId ?? ScanLedger.absent)\",\"\(assignedFolderName)\",\"\(deck)\"\n"
            csvStringDocumentPayload.append(layoutRowString)
        }

        do {
            try csvStringDocumentPayload.write(to: outputTargetURL, atomically: true, encoding: .utf8)
            return outputTargetURL
        } catch {
            return nil
        }
    }

    private func saveDataToPersistentDisk() {
        let jsonEncoder = JSONEncoder()
        if let cardsData = try? jsonEncoder.encode(savedCards) {
            UserDefaults.standard.set(cardsData, forKey: storageKeyCards)
        }
        if let trendData = try? jsonEncoder.encode(historicalTrendSnapshots) {
            UserDefaults.standard.set(trendData, forKey: storageKeyTrend)
        }
        if let batchesData = try? jsonEncoder.encode(activeSubmissionBatches) {
            UserDefaults.standard.set(batchesData, forKey: storageKeyBatches)
        }
    }

    private func loadDataFromPersistentDisk() {
        let jsonDecoder = JSONDecoder()
        if let cardsData = UserDefaults.standard.data(forKey: storageKeyCards),
           let parsedCards = try? jsonDecoder.decode([SavedCard].self, from: cardsData) {
            self.savedCards = parsedCards
        }
        if let trendData = UserDefaults.standard.data(forKey: storageKeyTrend),
           let parsedSnapshots = try? jsonDecoder.decode([ValueSnapshot].self, from: trendData) {
            self.historicalTrendSnapshots = parsedSnapshots
        }
        if let batchesData = UserDefaults.standard.data(forKey: storageKeyBatches),
           let parsedBatches = try? jsonDecoder.decode([SubmissionBatch].self, from: batchesData) {
            self.activeSubmissionBatches = parsedBatches
        }
    }
    private func appendLiveTrendSnapshotRecord(with currentTotalValue: Double) {
        let newSnapshot = ValueSnapshot(date: Date(), value: currentTotalValue)
        historicalTrendSnapshots.append(newSnapshot)
        if historicalTrendSnapshots.count > 30 { historicalTrendSnapshots.removeFirst() }
    }
    private func seedInitialTrendCurveMetrics() {
        let currentTimeline = Date()
        self.historicalTrendSnapshots = [
            ValueSnapshot(date: currentTimeline.addingTimeInterval(-86400 * 4), value: totalPortfolioValue * 0.88),
            ValueSnapshot(date: currentTimeline.addingTimeInterval(-86400 * 3), value: totalPortfolioValue * 0.92),
            ValueSnapshot(date: currentTimeline.addingTimeInterval(-86400 * 2), value: totalPortfolioValue * 0.90),
            ValueSnapshot(date: currentTimeline.addingTimeInterval(-86400 * 1), value: totalPortfolioValue * 0.96),
            ValueSnapshot(date: currentTimeline, value: totalPortfolioValue)
        ]
        saveDataToPersistentDisk()
    }
}
