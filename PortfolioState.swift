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

    public var displayGrade: String {
        guard let grade else { return Self.absent }
        return String(format: "PSA %.1f", grade)
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

    private static let localTimestampFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.dateStyle = .short
        formatter.timeStyle = .medium
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
            batchId: batchId
        )
    }

    public var displayGrade: String {
        guard let predictedGradePSA else { return ScanLedger.absent }
        return String(format: "PSA %.1f", predictedGradePSA)
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
            incomplete: predictedGradePSA == nil
        )
    }

    enum CodingKeys: String, CodingKey {
        case id, scanId, committedAt, name, setName
        case lrCenteringResult, tbCenteringResult
        case predictedGradePSA, calculatedValue, familyId, subGradesLabel, targetBatchId
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
        try container.encodeIfPresent(targetBatchId, forKey: .targetBatchId)
    }
}

enum ScanLedgerFields {
    static let timestampFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.dateStyle = .short
        formatter.timeStyle = .medium
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
            savedCards[cardIndex] = SavedCard(
                id: oldCard.id,
                scanId: oldCard.scanId,
                committedAt: oldCard.committedAt,
                name: oldCard.name,
                set: oldCard.setName,
                lrCentering: oldCard.lrCenteringResult,
                tbCentering: oldCard.tbCenteringResult,
                predictedGrade: oldCard.predictedGradePSA,
                marketValue: oldCard.calculatedValue,
                familyId: oldCard.familyId,
                subGradesLabel: oldCard.subGradesLabel,
                batchId: batchId
            )
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
        var csvStringDocumentPayload = "Scan ID,Committed At,Card Name,Expansion Set,L/R Centering,T/B Centering,Predicted PSA Grade,Market Valuation,Family ID,Assigned Batch Folder\n"

        for asset in savedCards {
            let assignedFolderName = activeSubmissionBatches.first(where: { $0.id == asset.targetBatchId })?.batchName ?? "Unassigned Vault"
            let layoutRowString = "\"\(asset.scanId)\",\"\(asset.displayTimestamp)\",\"\(asset.name)\",\"\(asset.setName)\",\"\(asset.lrCenteringResult)\",\"\(asset.tbCenteringResult)\",\"\(asset.displayGrade)\",\"\(asset.displayValue)\",\"\(asset.familyId ?? ScanLedger.absent)\",\"\(assignedFolderName)\"\n"
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
