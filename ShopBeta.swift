import AuthenticationServices
import CryptoKit
import Foundation
import SwiftUI

/// Measured capture tier. The numbers come from the server. This type does
/// not pick a phone or a fixed px/mm.
public struct CaptureTier: Equatable, Codable {
    public var pxPerMm: Double
    public var toleranceMm: Double?
    public var label: String

    public init(pxPerMm: Double, toleranceMm: Double?, label: String) {
        self.pxPerMm = pxPerMm
        self.toleranceMm = toleranceMm
        self.label = label
    }

    public static func read(_ value: Any?) -> CaptureTier? {
        guard let dict = value as? [String: Any] else { return nil }
        let px = (dict["pxPerMm"] as? NSNumber)?.doubleValue
        guard let px, px > 0, px.isFinite else { return nil }
        let label = (dict["label"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard !label.isEmpty else { return nil }
        let tolerance = (dict["toleranceMm"] as? NSNumber)?.doubleValue
        return CaptureTier(pxPerMm: px, toleranceMm: tolerance, label: label)
    }

    public var line: String {
        String(format: "This scan measured %.2f px/mm. The tier for this scan is %@.", pxPerMm, label)
    }
}

/// What the shop typed. Empty strings mean the field was left blank.
public struct CardManualEntry: Equatable, Codable {
    public var name: String
    public var year: String
    public var set: String
    public var number: String
    public var game: String
    public var notes: String

    public init(name: String = "", year: String = "", set: String = "", number: String = "", game: String = "", notes: String = "") {
        self.name = name
        self.year = year
        self.set = set
        self.number = number
        self.game = game
        self.notes = notes
    }

    public var displayName: String? {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }

    public var displaySet: String? {
        let trimmed = set.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }

    public static func read(_ value: Any?) -> CardManualEntry? {
        guard let dict = value as? [String: Any] else { return nil }
        func text(_ key: String) -> String {
            ((dict[key] as? String) ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        }
        let entry = CardManualEntry(
            name: text("name"),
            year: text("year"),
            set: text("set"),
            number: text("number"),
            game: text("game"),
            notes: text("notes")
        )
        let blank = entry.name.isEmpty && entry.year.isEmpty && entry.set.isEmpty &&
            entry.number.isEmpty && entry.game.isEmpty && entry.notes.isEmpty
        return blank ? nil : entry
    }

    public var requestBody: [String: String] {
        ["name": name, "year": year, "set": set, "number": number, "game": game, "notes": notes]
    }
}

public struct BetaFlags: Equatable {
    public var accounts: Bool
    public var manualEntry: Bool
    public var firstRunGuide: Bool

    public static let off = BetaFlags(accounts: false, manualEntry: false, firstRunGuide: false)

    public static func read(_ value: Any?) -> BetaFlags {
        guard let dict = value as? [String: Any] else { return .off }
        return BetaFlags(
            accounts: dict["accounts"] as? Bool ?? false,
            manualEntry: dict["manualEntry"] as? Bool ?? false,
            firstRunGuide: dict["firstRunGuide"] as? Bool ?? false
        )
    }
}

enum FirstRunCopy {
    static func sentences(tier: CaptureTier?) -> [String] {
        var lines = [
            "One card, flat, on the wide camera. Hold the phone level.",
            "Front, then back.",
            "Fill the neon frame and leave background showing on all four sides.",
            "The number is a prediction, not a company grade.",
            "A moved line is your estimate and does not change the prediction.",
            "Type the card after the scan. The card stays Unidentified until you do.",
            "A withheld border means that edge was not published."
        ]
        if let tier {
            lines.append(tier.line)
        } else {
            lines.append("After a scan, this screen shows the px/mm that scan measured and the tier that goes with it.")
        }
        return lines
    }

    static func text(tier: CaptureTier?) -> String {
        sentences(tier: tier).joined(separator: " ")
    }
}

enum AppleNonce {
    static func make() -> String {
        UUID().uuidString + "-" + UUID().uuidString
    }

    static func sha256Hex(_ raw: String) -> String {
        SHA256.hash(data: Data(raw.utf8)).map { String(format: "%02x", $0) }.joined()
    }
}

enum BetaSessionStore {
    private static let service = "com.cardgrader.thejudge.session"
    private static let account = "apple"

    static func save(_ token: String) {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account
        ]
        SecItemDelete(query as CFDictionary)
        var add = query
        add[kSecValueData as String] = Data(token.utf8)
        SecItemAdd(add as CFDictionary, nil)
        JudgeAPIClient.authorizationToken = token
    }

    static func load() -> String? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne
        ]
        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        guard status == errSecSuccess, let data = item as? Data else { return nil }
        guard let token = String(data: data, encoding: .utf8), !token.isEmpty else { return nil }
        JudgeAPIClient.authorizationToken = token
        return token
    }

    static func clear() {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account
        ]
        SecItemDelete(query as CFDictionary)
        JudgeAPIClient.authorizationToken = nil
    }
}

final class ShopBetaStore: ObservableObject {
    static let shared = ShopBetaStore()
    static let dismissedKey = "judgeFirstRunDismissed"

    @Published var flags = BetaFlags.off
    var continuedThisLaunch = false
    var pendingNonce: String?

    var shouldHoldShutter: Bool {
        flags.firstRunGuide &&
            !UserDefaults.standard.bool(forKey: Self.dismissedKey) &&
            !continuedThisLaunch
    }

    func dismissForever() {
        UserDefaults.standard.set(true, forKey: Self.dismissedKey)
    }

    func notePairCompleted() {
        if flags.firstRunGuide { dismissForever() }
    }

    func refresh(serverURL: String) async {
        _ = BetaSessionStore.load()
        guard let flags = try? await JudgeAPIClient.shared.fetchBetaFlags(baseURL: serverURL) else { return }
        await MainActor.run { self.flags = flags }
    }
}

struct FirstRunGuideSheet: View {
    let tier: CaptureTier?
    let onContinue: () -> Void
    let onSkip: () -> Void
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                Text("Before the first scan")
                    .font(.headline)
                Text(FirstRunCopy.text(tier: tier))
                    .font(.body)
                Button("Continue") {
                    onContinue()
                    dismiss()
                }
                .frame(maxWidth: .infinity, minHeight: 44)
                Button("Skip") {
                    onSkip()
                    dismiss()
                }
                .frame(maxWidth: .infinity, minHeight: 44)
            }
            .padding(20)
        }
    }
}

struct ShopBetaControls: View {
    let serverURL: String
    let portfolio: PortfolioState
    @ObservedObject private var store = ShopBetaStore.shared
    @State private var status = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if store.flags.accounts {
                if JudgeAPIClient.authorizationToken == nil {
                    SignInWithAppleButton(.signIn, onRequest: { request in
                        let raw = AppleNonce.make()
                        store.pendingNonce = raw
                        request.requestedScopes = [.email]
                        request.nonce = AppleNonce.sha256Hex(raw)
                    }, onCompletion: { result in
                        handle(result)
                    })
                    .frame(height: 44)
                    Text("Sign in to keep this shop’s cards separate. The home bench stays on the iMac.")
                        .font(.caption2)
                        .foregroundColor(.secondary)
                } else {
                    Text("Signed in. This vault is this Apple account.")
                        .font(.caption2)
                    Button("Delete this account’s scans") {
                        Task { await deleteAccount() }
                    }
                    .font(.caption2)
                    Button("Sign out") {
                        BetaSessionStore.clear()
                        portfolio.restoreBenchInventory()
                        status = "Signed out. The home bench is back."
                    }
                    .font(.caption2)
                }
            }
            if !status.isEmpty {
                Text(status)
                    .font(.caption2)
                    .foregroundColor(.secondary)
            }
        }
        .task {
            await store.refresh(serverURL: serverURL)
            await restoreVaultIfNeeded()
        }
    }

    private func restoreVaultIfNeeded() async {
        guard store.flags.accounts, JudgeAPIClient.authorizationToken != nil else { return }
        guard !portfolio.showsAccountVault else { return }
        do {
            let ledgers = try await JudgeAPIClient.shared.fetchInventory(baseURL: serverURL)
            let cards = ledgers.map { SavedCard(ledger: $0) }
            await MainActor.run { portfolio.useAccountInventory(cards) }
        } catch {
            BetaSessionStore.clear()
            await MainActor.run { status = error.localizedDescription }
        }
    }

    private func handle(_ result: Result<ASAuthorization, Error>) {
        switch result {
        case .failure:
            status = "Sign in with Apple did not finish."
        case .success(let authorization):
            guard let credential = authorization.credential as? ASAuthorizationAppleIDCredential,
                  let tokenData = credential.identityToken,
                  let token = String(data: tokenData, encoding: .utf8),
                  let nonce = store.pendingNonce else {
                status = "Sign in with Apple did not return a token."
                return
            }
            Task { await finish(token: token, nonce: nonce) }
        }
    }

    private func finish(token: String, nonce: String) async {
        do {
            let session = try await JudgeAPIClient.shared.signInWithApple(baseURL: serverURL, identityToken: token, nonce: nonce)
            BetaSessionStore.save(session.token)
            let ledgers = try await JudgeAPIClient.shared.fetchInventory(baseURL: serverURL)
            let cards = ledgers.map { SavedCard(ledger: $0) }
            await MainActor.run {
                portfolio.useAccountInventory(cards)
                status = "Signed in."
            }
        } catch {
            BetaSessionStore.clear()
            await MainActor.run { status = error.localizedDescription }
        }
    }

    private func deleteAccount() async {
        do {
            _ = try await JudgeAPIClient.shared.deleteAccount(baseURL: serverURL)
            BetaSessionStore.clear()
            await MainActor.run {
                portfolio.restoreBenchInventory()
                status = "That account’s images, grades, and examples were deleted."
            }
        } catch {
            await MainActor.run { status = error.localizedDescription }
        }
    }
}

struct ShopBetaReportExtras: View {
    @Binding var ledger: ScanLedger
    let serverURL: String
    var onDeleted: () -> Void = {}
    var onChanged: (ScanLedger) -> Void = { _ in }
    @ObservedObject private var store = ShopBetaStore.shared
    @State private var name = ""
    @State private var year = ""
    @State private var setName = ""
    @State private var number = ""
    @State private var game = ""
    @State private var notes = ""
    @State private var status = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if let tier = ledger.captureTier {
                Text(tier.line)
                    .font(.caption)
            }
            if store.flags.manualEntry {
                Text("Card")
                    .font(.caption).bold()
                Text("Type the card. This does not change the prediction.")
                    .font(.caption2)
                    .foregroundColor(.secondary)
                field("Name or player", text: $name)
                field("Year", text: $year)
                field("Set", text: $setName)
                field("Number", text: $number)
                field("Game or sport", text: $game)
                field("Notes", text: $notes)
                Button("Save card") { Task { await save() } }
                    .font(.caption)
            }
            if store.flags.accounts, JudgeAPIClient.authorizationToken != nil {
                Button("Delete this card") { Task { await deleteScan() } }
                    .font(.caption)
            }
            if !status.isEmpty {
                Text(status).font(.caption2).foregroundColor(.secondary)
            }
        }
        .onAppear(perform: loadFields)
        .task { await store.refresh(serverURL: serverURL) }
    }

    private func field(_ label: String, text: Binding<String>) -> some View {
        TextField(label, text: text)
            .textFieldStyle(.roundedBorder)
            .font(.caption)
    }

    private func loadFields() {
        let entry = ledger.cardEntry
        name = entry?.name ?? ""
        year = entry?.year ?? ""
        setName = entry?.set ?? ""
        number = entry?.number ?? ""
        game = entry?.game ?? ""
        notes = entry?.notes ?? ""
    }

    private func save() async {
        let entry = CardManualEntry(name: name, year: year, set: setName, number: number, game: game, notes: notes)
        do {
            let report = try await JudgeAPIClient.shared.saveCardEntry(baseURL: serverURL, scanId: ledger.scanId, entry: entry)
            let updated = JudgeAPIClient.ledger(from: report, clientScanId: ledger.scanId, timestamp: ledger.committedAt)
            await MainActor.run {
                let merged = ScanLedger.applyingServerRecord(local: ledger, server: updated)
                ledger = merged
                onChanged(merged)
                status = "Saved. The prediction is unchanged."
            }
        } catch {
            await MainActor.run { status = error.localizedDescription }
        }
    }

    private func deleteScan() async {
        do {
            try await JudgeAPIClient.shared.deleteScan(baseURL: serverURL, scanId: ledger.scanId)
            await MainActor.run { onDeleted() }
        } catch {
            await MainActor.run { status = error.localizedDescription }
        }
    }
}

#if DEBUG
extension FirstRunCopy {
    static func runContractChecks(_ check: ContractCheck) {
        func expect(_ condition: @autoclosure () -> Bool, _ message: @autoclosure () -> String, file: StaticString = #filePath, line: UInt = #line) {
            check(condition(), message(), file, line)
        }
        let blank = text(tier: nil)
        expect(!blank.contains("27.5"), "the guide does not hard-code a px/mm")
        expect(!blank.contains("±0.2"), "the guide does not hard-code a tier before a scan")
        expect(blank.contains("your estimate"), "the guide names the dragged line")
        expect(blank.contains("Unidentified"), "the guide says the card stays unnamed")
        let mid = CaptureTier(pxPerMm: 22.77, toleranceMm: 0.2, label: "±0.2 mm")
        let filled = text(tier: mid)
        expect(filled.contains("22.77 px/mm"), "the guide reads the measured px/mm")
        expect(filled.contains("±0.2 mm"), "the guide reads the tier label it was given")
        let tall = CaptureTier(pxPerMm: 45.4, toleranceMm: 0.1, label: "±0.1 mm")
        let other = text(tier: tall)
        expect(other.contains("45.40 px/mm") && other.contains("±0.1 mm"), "a different scan shows its own tier")
        expect(!other.contains("22.77"), "the guide does not keep another scan's px/mm")
        expect(JudgeAPIClient.authorizationValue(for: nil) == nil, "no session sends no Authorization header")
        expect(JudgeAPIClient.authorizationValue(for: "") == nil, "an empty session sends no Authorization header")
        expect(JudgeAPIClient.authorizationValue(for: "abc") == "Bearer abc", "a session is a bearer token")
        let entry = CardManualEntry.read(["name": "Shohei Ohtani", "year": "2018", "set": "Topps", "number": "1", "game": "Baseball", "notes": ""])
        expect(entry?.displayName == "Shohei Ohtani" && entry?.game == "Baseball", "typed fields round-trip")
        expect(CardManualEntry.read(["name": "  "]) == nil, "a blank entry is not a name")
        expect(!BetaFlags.read(nil).accounts && !BetaFlags.read(["accounts": false]).manualEntry, "missing flags stay off")
        expect(BetaFlags.read(["accounts": true, "manualEntry": true, "firstRunGuide": true]).firstRunGuide, "the server can turn the guide on")
    }
}
#endif
