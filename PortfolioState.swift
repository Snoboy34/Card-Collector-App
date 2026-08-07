import Foundation
import SwiftUI

public struct SavedCard: Identifiable, Codable {
    public let id: UUID
    public let name: String
    public let setName: String
    public let lrCenteringResult: String
    public let tbCenteringResult: String
    public let predictedGradePSA: Int
    public let calculatedValue: Double
    public var targetBatchId: UUID? 
    
    public init(id: UUID = UUID(), name: String, set: String, lrCentering: String, tbCentering: String, predictedGrade: Int, marketValue: Double, batchId: UUID? = nil) {
        self.id = id
        self.name = name
        self.setName = set
        self.lrCenteringResult = lrCentering
        self.tbCenteringResult = tbCentering
        self.predictedGradePSA = predictedGrade
        self.calculatedValue = marketValue
        self.targetBatchId = batchId
    }
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
        savedCards.reduce(0.0) { $0 + $1.calculatedValue }
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
    
    public func simulateCrossCompanyScore(for card: SavedCard, targetCompany: String) -> (grade: Double, estimatedValue: Double) {
        let baseGrade = Double(card.predictedGradePSA)
        
        switch targetCompany {
        case "BGS":
            let adjustedGrade = card.lrCenteringResult.contains("50%") ? baseGrade : max(1.0, baseGrade - 0.5)
            return (adjustedGrade, card.calculatedValue * 1.15) 
        case "CGC":
            return (baseGrade, card.calculatedValue * 0.90)
        case "SGC":
            let adjustedGrade = card.predictedGradePSA >= 10 ? 10.0 : Double(card.predictedGradePSA)
            return (adjustedGrade, card.calculatedValue * 1.05)
        case "TAG":
            let adjustedGrade = card.lrCenteringResult.contains("50%") ? baseGrade : max(1.0, baseGrade - 0.2)
            return (adjustedGrade, card.calculatedValue * 1.10)
        default:
            return (baseGrade, card.calculatedValue)
        }
    }
    
    public func calculateArbitrageMatrix(for card: SavedCard) -> [ArbitrageOpportunity] {
        let companies = ["PSA", "BGS", "CGC", "SGC", "TAG"]
        let fees = ["PSA": 25.0, "BGS": 35.0, "CGC": 15.0, "SGC": 18.0, "TAG": 20.0]
        let turnarounds = ["PSA": 45, "BGS": 20, "CGC": 10, "SGC": 5, "TAG": 14]
        
        return companies.map { company in
            let sim = simulateCrossCompanyScore(for: card, targetCompany: company)
            return ArbitrageOpportunity(
                companyName: company,
                projectedGrade: sim.grade,
                grossValue: sim.estimatedValue,
                upfrontFee: fees[company] ?? 20.0,
                turnaroundDays: turnarounds[company] ?? 14
            )
        }.sorted { $0.netProfitROI > $1.netProfitROI }
    }
    
    // NEW: Serializes the highlighted shipment array metadata cleanly into a universal safe text transmission block
    public func generateCompressedBatchPayload(for batchId: UUID?) -> String {
        guard let targetId = batchId else { return "NoActiveBatchStaged" }
        let segmentedList = savedCards.filter { $0.targetBatchId == targetId }
        guard !segmentedList.isEmpty else { return "BatchEmpty" }
        
        var summaryString = "MANIFEST_ID:\(targetId.uuidString.prefix(6))|"
        for item in segmentedList {
            summaryString.append("\(item.name.prefix(8))-\(item.predictedGradePSA);")
        }
        return summaryString.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? "SerializationError"
    }
    
    public func appendCard(name: String, set: String, lrCentering: String, tbCentering: String, predictedGrade: Int, marketValue: Double) {
        let fallbackBatchId = activeSubmissionBatches.first?.id
        
        let targetNewCard = SavedCard(
            name: name,
            set: set,
            lrCentering: lrCentering,
            tbCentering: tbCentering,
            predictedGrade: predictedGrade,
            marketValue: marketValue,
            batchId: fallbackBatchId
        )
        
        savedCards.append(targetNewCard)
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
                name: oldCard.name,
                set: oldCard.setName,
                lrCentering: oldCard.lrCenteringResult,
                tbCentering: oldCard.tbCenteringResult,
                predictedGrade: oldCard.predictedGradePSA,
                marketValue: oldCard.calculatedValue,
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
        var csvStringDocumentPayload = "Card Name,Expansion Set,L/R Centering,T/B Centering,Predicted PSA Grade,Market Valuation Projections,Assigned Batch Folder\n"
        
        for asset in savedCards {
            let assignedFolderName = activeSubmissionBatches.first(where: { $0.id == asset.targetBatchId })?.batchName ?? "Unassigned Vault"
            let layoutRowString = "\"\(asset.name)\",\"\(asset.setName)\",\"\(asset.lrCenteringResult)\",\"\(asset.tbCenteringResult)\",\(asset.predictedGradePSA),\(asset.calculatedValue),\"\(assignedFolderName)\"\n"
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
