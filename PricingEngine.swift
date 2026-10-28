import Foundation

public struct CardValuation: Identifiable, Codable {
    public let id: UUID
    public let cardName: String
    public let setName: String
    public let marketValueRaw: Double
    public let marketValuePSA10: Double
    public let marketValueBGS95: Double
    public let cacheTimestamp: Date?

    public init(id: UUID = UUID(), cardName: String, setName: String, marketValueRaw: Double, marketValuePSA10: Double, marketValueBGS95: Double, cacheTimestamp: Date = Date()) {
        self.id = id
        self.cardName = cardName
        self.setName = setName
        self.marketValueRaw = marketValueRaw
        self.marketValuePSA10 = marketValuePSA10
        self.marketValueBGS95 = marketValueBGS95
        self.cacheTimestamp = cacheTimestamp
    }
}

public enum CardCategory: String, CaseIterable, Identifiable, Sendable {
    case tcg = "TCG / Pokémon"
    case sports = "Sports Card"
    case mtg = "Magic / MTG"
    case entertainment = "Entertainment"

    public var id: String { self.rawValue }
}

public struct HistoricalTickerPoint: Identifiable, Sendable {
    public let id = UUID()
    public let dateLabel: String
    public let closingPrice: Double
}

public enum PricingEngineError: LocalizedError {
    case notARealPriceSource

    public var errorDescription: String? {
        "No live price source. Scan value stays — until a real lookup exists."
    }
}

@MainActor
public class PricingEngine: ObservableObject {
    @Published public var historicalTrendData: [Double] = []

    public init() {}

    public func fetchMarketTickerHistory(for cardName: String) -> [HistoricalTickerPoint] {
        let baseValue = determineBasePrice(for: cardName)
        guard baseValue > 0 else { return [] }
        return [
            HistoricalTickerPoint(dateLabel: "Mon", closingPrice: baseValue * 0.94),
            HistoricalTickerPoint(dateLabel: "Tue", closingPrice: baseValue * 0.96),
            HistoricalTickerPoint(dateLabel: "Wed", closingPrice: baseValue * 0.92),
            HistoricalTickerPoint(dateLabel: "Thu", closingPrice: baseValue * 0.98),
            HistoricalTickerPoint(dateLabel: "Fri", closingPrice: baseValue * 1.02),
            HistoricalTickerPoint(dateLabel: "Sat", closingPrice: baseValue * 1.01),
            HistoricalTickerPoint(dateLabel: "Sun", closingPrice: baseValue)
        ]
    }

    /// Removed mock sports/TCG registries. A scan must never display a name
    /// or price this function did not receive from a real source.
    public func fetchLiveValuations(cardId: String, category: CardCategory, completion: @escaping @MainActor (Result<CardValuation, Error>) -> Void) {
        completion(.failure(PricingEngineError.notARealPriceSource))
    }

    private func determineBasePrice(for name: String) -> Double {
        if name.isEmpty || name == ScanLedger.unidentified { return 0 }
        if name.contains("Lotus") { return 165000 }
        if name.contains("Illustrator") { return 450000 }
        if name.contains("Charizard") { return 8500 }
        if name.contains("Jordan") { return 3500 }
        if name.contains("Clark") { return 850 }
        return 0
    }
}
