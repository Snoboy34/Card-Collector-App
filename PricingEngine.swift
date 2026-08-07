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

@MainActor
public class PricingEngine: ObservableObject {
    @Published public var historicalTrendData: [Double] = []
    
    public init() {}
    
    public func fetchMarketTickerHistory(for cardName: String) -> [HistoricalTickerPoint] {
        let baseValue = determineBasePrice(for: cardName)
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
    
    public func fetchLiveValuations(cardId: String, category: CardCategory, completion: @escaping @MainActor (Result<CardValuation, Error>) -> Void) {
        let registryMatch: CardValuation
        
        switch category {
        case .tcg:
            let elements = [
                CardValuation(cardName: "Charizard Holo Base Set #4", setName: "1999 Base Set", marketValueRaw: 350, marketValuePSA10: 8500, marketValueBGS95: 5400),
                CardValuation(cardName: "Pikachu Illustrator Promo", setName: "CoroCoro Comics (1998)", marketValueRaw: 50000, marketValuePSA10: 450000, marketValueBGS95: 320000),
                CardValuation(cardName: "Umbreon VMAX Alternate Art #215", setName: "Evolving Skies", marketValueRaw: 120, marketValuePSA10: 950, marketValueBGS95: 720)
            ]
            registryMatch = elements.randomElement()!
            
        case .sports:
            let elements = [
                CardValuation(cardName: "Michael Jordan Rookie Fleer #119", setName: "1986 Fleer Basketball", marketValueRaw: 150, marketValuePSA10: 3500, marketValueBGS95: 2400),
                CardValuation(cardName: "Caitlin Clark Blue Refractor Rookie", setName: "2024 Bowman University", marketValueRaw: 85, marketValuePSA10: 850, marketValueBGS95: 610),
                CardValuation(cardName: "Paige Bueckers Chrome Prospect Autograph", setName: "2025 Bowman University", marketValueRaw: 45, marketValuePSA10: 420, marketValueBGS95: 310)
            ]
            registryMatch = elements.randomElement()!
            
        case .mtg:
            let elements = [
                CardValuation(cardName: "Black Lotus Power Nine", setName: "1993 Alpha Edition", marketValueRaw: 12000, marketValuePSA10: 165000, marketValueBGS95: 110000),
                CardValuation(cardName: "Mox Diamond Holo", setName: "Stronghold", marketValueRaw: 90, marketValuePSA10: 750, marketValueBGS95: 500)
            ]
            registryMatch = elements.randomElement()!
            
        case .entertainment:
            registryMatch = CardValuation(cardName: "Luke Skywalker Rookie #1", setName: "1977 Topps Star Wars", marketValueRaw: 20, marketValuePSA10: 600, marketValueBGS95: 400)
        }
        
        completion(.success(registryMatch))
    }
    
    private func determineBasePrice(for name: String) -> Double {
        if name.contains("Lotus") { return 165000 }
        if name.contains("Illustrator") { return 450000 }
        if name.contains("Charizard") { return 8500 }
        if name.contains("Jordan") { return 3500 }
        if name.contains("Clark") { return 850 }
        return 400
    }
}
