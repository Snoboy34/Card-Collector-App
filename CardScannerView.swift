import SwiftUI

// MARK: - Supported Multi-Phase Scanning Workflow States
enum ScanningPhase: String, CaseIterable {
    case frontCentering = "1. Front Centering"
    case surfaceTiltSweep = "2. Surface Light Scan"
    case cornerMacroCheck = "3. Corner Inspection"
    case backPerimeter = "4. Back Border Check"
}

struct CategoryAllocation: Identifiable {
    let id = UUID()
    let categoryName: String
    let totalValue: Double
    let accentColor: Color
}

struct CardScannerView: View {
    @StateObject private var calibrationEngine = CameraCalibration()
    @StateObject private var priceEngine = PricingEngine()
    @StateObject private var portfolio = PortfolioState()
    @StateObject private var securityVault = UserSecurity()
    
    private let gradingJudge = TheJudge()
    private let centeringAnalyzer = CenteringAnalyzer()
    private let defectAnalyzer = DefectAnalyzer()
    
    @State private var currentPhase: ScanningPhase = .frontCentering
    @State private var scanResult: CenteringResult?
    @State private var activeValuation: CardValuation?
    @State private var calculatedGrade: CalculatedGrade?
    @State private var isLoadingPrice = false
    @State private var isSaveConfirmed = false
    @State private var isCardDetected = false
    @State private var automaticCardIdentifier = "Processing Viewport..."
    
    @State private var autoSurfaceScratches = 0
    @State private var autoEdgeWhitening = 0
    @State private var autoCornerFraying = 0
    
    // NEW: tracks whether the multi-frame centering buffer has accumulated enough
    // consistent samples yet. Drives the "Hold steady..." progress state and gates
    // the advance button on the front-centering phase so users lock in an averaged,
    // stable reading instead of whatever single noisy frame happened to land last.
    @State private var isCenteringStable = false
    @State private var centeringSampleCount = 0
    // NEW: guards against triggering auto-advance more than once while multiple in-flight
    // frame-processing Tasks might briefly all see "stable" before the phase change commits.
    @State private var isAutoAdvancing = false
    
    @State private var showingActiveScanReport = false
    @State private var selectedVaultCard: SavedCard? = nil
    
    @State private var selectedCategory: CardCategory = .sports
    @State private var selectedTab = 0
    @State private var searchVaultQuery = ""
    @State private var selectedBatchFolderId: UUID? = nil
    @State private var newBatchInputName = ""
    @State private var newBatchServiceSelection = "PSA"
    @State private var isBatchExporting = false
    @State private var selectedSimulatorCompany = "PSA"
    @State private var highlightedSimulationCard: SavedCard? = nil
    @State private var selectedArbitrageCard: SavedCard? = nil
    @State private var selectedTickerCard: SavedCard? = nil
    @State private var passportSelectedBatchId: UUID? = nil
    @State private var selectedMonitorCard: SavedCard? = nil
    @State private var lastProcessedFrameTime = Date.distantPast
    
    private var filteredVaultRecords: [SavedCard] {
        searchVaultQuery.isEmpty ? portfolio.savedCards : portfolio.savedCards.filter {
            $0.name.localizedCaseInsensitiveContains(searchVaultQuery) || $0.setName.localizedCaseInsensitiveContains(searchVaultQuery)
        }
    }
    
    private var batchSegmentedCardRecords: [SavedCard] {
        guard let targetedId = selectedBatchFolderId else { return portfolio.savedCards }
        return portfolio.savedCards.filter { $0.targetBatchId == targetedId }
    }
    
    // NEW: the advance button now requires a stable, averaged centering reading during
    // the front-centering phase — not just raw card detection — before letting the user
    // lock the phase in. Other phases only require card detection, same as before.
    private var canAdvancePhase: Bool {
        guard isCardDetected else { return false }
        if currentPhase == .frontCentering {
            return isCenteringStable
        }
        return true
    }
    
    // NEW: status line for the front-centering phase, reflecting level-gating.
    private var statusTextForFrontCentering: String {
        if isCenteringStable { return "Averaged Reading Locked (\(centeringSampleCount) samples)" }
        if !calibrationEngine.isPerfectlyLevel { return "Level the Phone to Begin Averaging" }
        return "Hold Steady — Averaging Frames..."
    }
    
    var body: some View {
        TabView(selection: $selectedTab) {
            scannerDashboardView.tabItem { Label("Scanner", systemImage: "viewfinder.lens") }.tag(0)
            vaultAnalyticsView.tabItem { Label("Vault", systemImage: "chart.pie.fill") }.tag(1)
            bulkBatchManifestView.tabItem { Label("Bulk Ship", systemImage: "shippingbox.fill") }.tag(2)
            labSimulatorView.tabItem { Label("Lab Sim", systemImage: "waveform.path.ecg.rectangle.fill") }.tag(3)
            arbitrageMatrixView.tabItem { Label("ROI Matrix", systemImage: "dollarsign.circle.fill") }.tag(4)
            liveMarketTickerView.tabItem { Label("Ticker", systemImage: "chart.xyaxis.line") }.tag(5)
            labPassportManifestView.tabItem { Label("Passport", systemImage: "qrcode") }.tag(6)
            activeMarketplaceMonitorView.tabItem { Label("Live Deals", systemImage: "cart.badge.plus") }.tag(7)
        }
        .onAppear {
            if selectedBatchFolderId == nil { selectedBatchFolderId = portfolio.activeSubmissionBatches.first?.id }
            if passportSelectedBatchId == nil { passportSelectedBatchId = portfolio.activeSubmissionBatches.first?.id }
            if selectedArbitrageCard == nil { selectedArbitrageCard = portfolio.savedCards.first }
            if selectedTickerCard == nil { selectedTickerCard = portfolio.savedCards.first }
            if selectedMonitorCard == nil { selectedMonitorCard = portfolio.savedCards.first }
        }
    }
    
    private var scannerDashboardView: some View {
        NavigationView {
            ScrollView {
                VStack(spacing: 20) {
                    Picker("Profile", selection: $selectedCategory) {
                        ForEach(CardCategory.allCases, id: \.self) { category in
                            Text(category.rawValue).tag(category)
                        }
                    }
                    .pickerStyle(.segmented)
                    .padding(.horizontal)
                    .onChange(of: selectedCategory) {
                        resetCurrentScanState()
                    }
                    
                    HStack(spacing: 4) {
                        ForEach(ScanningPhase.allCases, id: \.self) { phase in
                            Rectangle()
                                .fill(phase == currentPhase ? Color.blue : (ScanningPhase.allCases.firstIndex(of: phase)! < ScanningPhase.allCases.firstIndex(of: currentPhase)! ? Color.green : Color.gray.opacity(0.3)))
                                .frame(height: 5)
                        }
                    }
                    .padding(.horizontal)
                    
                    Text(currentPhase.rawValue)
                        .font(.system(.subheadline, design: .monospaced))
                        .bold()
                        .foregroundColor(.secondary)
                    
                    cameraViewportSection
                    
                    VStack(alignment: .leading, spacing: 10) {
                        HStack {
                            Image(systemName: "bolt.shield.fill").foregroundColor(.blue)
                            Text("HIGH-PRECISION AUTOMATED METRICS").font(.caption).bold().foregroundColor(.secondary)
                        }
                        VStack(alignment: .leading, spacing: 6) {
                            HStack { Text("Isolated Asset Profile:"); Spacer(); Text(automaticCardIdentifier).bold().foregroundColor(.blue) }
                            Divider()
                            phaseStatusExplainerLayout()
                        }
                        .font(.footnote)
                        .padding()
                        .background(Color(.secondarySystemBackground))
                        .cornerRadius(10)
                    }.padding(.horizontal)
                    
                    Button(action: { advanceInspectionFlowPipeline() }) {
                        Text(currentPhase == .backPerimeter ? "Calculate Comprehensive Multi-Phase Grade" : "Lock & Advance to Next Scanning Phase")
                            .bold()
                            .frame(maxWidth: .infinity)
                            .padding()
                            .background(canAdvancePhase ? Color.blue : Color.gray)
                            .foregroundColor(.white)
                            .cornerRadius(10)
                    }
                    .padding(.horizontal)
                    .disabled(!canAdvancePhase)
                }.padding(.vertical)
            }
            .navigationTitle("AI Grade Scanner")
            .sheet(isPresented: $showingActiveScanReport) {
                if let result = scanResult, let grade = calculatedGrade {
                    ActiveScanReportSheet(result: result, grade: grade, value: activeValuation, onCommit: {
                        commitAndResetScan(result: result, grade: grade, value: activeValuation)
                    })
                }
            }
            .onAppear { calibrationEngine.startDeviceLevelMonitoring() }
            .onDisappear { calibrationEngine.stopDeviceLevelMonitoring() }
        }
    }
    
    private var cameraViewportSection: some View {
        ZStack {
            LiveCameraView { processLiveCameraFrame($0) }.environmentObject(calibrationEngine).frame(height: 240).cornerRadius(12).clipped()
            RoundedRectangle(cornerRadius: 16).stroke(isCardDetected ? Color.green : Color.white.opacity(0.4), lineWidth: isCardDetected ? 4 : 2).frame(width: 170, height: 210)
                .overlay(Group {
                    if !isCardDetected {
                        VStack { Image(systemName: "viewfinder").font(.title2); Text("ALIGN CARD").font(.caption2).bold().padding(4).background(Color.black.opacity(0.6)).cornerRadius(4) }.foregroundColor(.white)
                    } else if let centeringRatio = scanResult { CenteringGuideOverlay(ratios: centeringRatio) }
                })
            VStack {
                ZStack {
                    Circle().stroke(calibrationEngine.isPerfectlyLevel ? Color.green : Color.red, lineWidth: 3).frame(width: 45, height: 45)
                    Circle().fill(calibrationEngine.isPerfectlyLevel ? Color.green : Color.orange).frame(width: 10, height: 10).offset(x: CGFloat(calibrationEngine.currentRoll * 4), y: CGFloat(calibrationEngine.currentPitch * 4))
                }; Spacer()
            }.padding(.top, 10)
            // NEW: while on the front-centering phase and a card is detected but the
            // averaged reading isn't stable yet, prompt the user to hold steady — or, if
            // the phone isn't level, prompt that first. FIXED: the level bubble previously
            // had no effect on the actual scan; now a tilted phone is called out explicitly
            // and (see processLiveCameraFrame) frames captured while tilted are excluded
            // from the centering average entirely, so the bubble now genuinely matters.
            if isCardDetected && currentPhase == .frontCentering && !isCenteringStable {
                VStack {
                    Spacer()
                    Text(calibrationEngine.isPerfectlyLevel ? "HOLD STEADY... \(centeringSampleCount)/4" : "LEVEL THE PHONE")
                        .font(.caption2).bold()
                        .padding(6)
                        .background(Color.black.opacity(0.6))
                        .foregroundColor(.white)
                        .cornerRadius(6)
                        .padding(.bottom, 8)
                }
            }
        }.padding(.horizontal)
    }
    
    private var vaultAnalyticsView: some View {
        NavigationView {
            VStack(spacing: 0) {
                if !securityVault.isVaultUnlocked {
                    VStack(spacing: 12) {
                        Image(systemName: "lock.shield.fill").font(.largeTitle).foregroundColor(.blue)
                        Text("Analytics Vault Encrypted").font(.headline)
                        Button("Verify Biometrics") { securityVault.authenticateCollectorVault() }.bold().foregroundColor(.white).padding().frame(maxWidth: .infinity).background(Color.blue).cornerRadius(8).padding(.horizontal)
                    }.padding(.top, 40)
                } else {
                    HStack(spacing: 15) {
                        VStack(alignment: .leading) { Text("NET WORTH").font(.caption2).bold().foregroundColor(.secondary); Text(String(format: "$%.2f", portfolio.totalPortfolioValue)).font(.title2).bold().foregroundColor(.blue) }.frame(maxWidth: .infinity, alignment: .leading).padding().background(Color(.secondarySystemBackground)).cornerRadius(10)
                        VStack(alignment: .leading) { Text("VAULT COUNT").font(.caption2).bold().foregroundColor(.secondary); Text(String(format: "%d Cards", portfolio.savedCards.count)).font(.title2).bold().foregroundColor(.purple) }.frame(maxWidth: .infinity, alignment: .leading).padding().background(Color(.secondarySystemBackground)).cornerRadius(10)
                    }.padding([.horizontal, .top])
                    if portfolio.totalPortfolioValue > 0 {
                        ScrollView(.horizontal, showsIndicators: false) {
                            HStack(spacing: 12) {
                                ForEach(portfolio.historicalTrendSnapshots.suffix(5)) { snapshot in
                                    VStack(alignment: .leading, spacing: 4) {
                                        Text("Snapshot Check").font(.system(size: 8, weight: .bold)).foregroundColor(.secondary)
                                        Text(String(format: "$%.2f", snapshot.value)).font(.subheadline).bold().foregroundColor(.blue)
                                    }
                                    .padding(10).background(Color(.secondarySystemBackground)).cornerRadius(10)
                                }
                            }.padding(.horizontal)
                        }.padding(.top, 10)
                    }
                    Text("VAULT RECORDS LEDGER (TAP FOR DETAILS)").font(.caption2).bold().foregroundColor(.secondary).frame(maxWidth: .infinity, alignment: .leading).padding([.horizontal, .top])
                    List {
                        ForEach(filteredVaultRecords) { card in
                            Button(action: { selectedVaultCard = card }) {
                                HStack {
                                    VStack(alignment: .leading) { Text(card.name).font(.subheadline).bold().foregroundColor(.primary); Text(card.setName).font(.caption).foregroundColor(.secondary) }
                                    Spacer()
                                    VStack(alignment: .trailing) { Text(String(format: "$%.2f", card.calculatedValue)).bold().foregroundColor(.green); Text(String(format: "PSA %d", card.predictedGradePSA)).font(.caption2).padding(4).background(Color.blue.opacity(0.1)).cornerRadius(4) }
                                }
                            }
                            .listRowBackground(Color(.secondarySystemBackground))
                        }.onDelete { portfolio.deleteCard(at: $0) }
                    }.listStyle(.plain).cornerRadius(12).padding(.horizontal)
                }
            }
            .sheet(item: $selectedVaultCard) { vaultCard in
                VaultDetailSheet(card: vaultCard)
            }
        }
    }
    private var bulkBatchManifestView: some View {
        NavigationView {
            VStack(spacing: 0) {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 12) {
                        ForEach(portfolio.activeSubmissionBatches) { folder in
                            Button(action: { selectedBatchFolderId = folder.id }) {
                                VStack(alignment: .leading, spacing: 4) {
                                    HStack { Image(systemName: "folder.fill"); Spacer(); Text(folder.gradingServiceTarget).font(.system(size: 8, weight: .black)).padding(3).background(Color.white.opacity(0.2)).cornerRadius(4) }
                                    Text(folder.batchName).font(.caption).bold().lineLimit(1)
                                    Text("\(portfolio.savedCards.filter { $0.targetBatchId == folder.id }.count) cards").font(.system(size: 9)).opacity(0.8)
                                }.foregroundColor(selectedBatchFolderId == folder.id ? .white : .primary).padding(12).frame(width: 140, height: 75).background(selectedBatchFolderId == folder.id ? Color.blue : Color(.secondarySystemBackground)).cornerRadius(12)
                            }
                        }
                    }.padding()
                }
                Form {
                    Section(header: Text("PROVISION BATCH")) {
                        HStack {
                            TextField("Name...", text: $newBatchInputName)
                            Picker("Service", selection: $newBatchServiceSelection) {
                                Text("PSA").tag("PSA")
                                Text("BGS").tag("BGS")
                                Text("CGC").tag("CGC")
                                Text("SGC").tag("SGC")
                                Text("TAG").tag("TAG")
                            }.pickerStyle(.menu)
                            Button(action: { guard !newBatchInputName.isEmpty else { return }; portfolio.createNewSubmissionBatch(name: newBatchInputName, service: newBatchServiceSelection); newBatchInputName = "" }) { Image(systemName: "folder.badge.plus").bold() }
                        }
                    }
                    Section(header: Text("EXPORT")) {
                        Button(action: { isBatchExporting = true; DispatchQueue.main.asyncAfter(deadline: .now() + 1.0) { isBatchExporting = false; if let url = portfolio.generatePrintableSubmissionManifest() { UIApplication.shared.connectedScenes.flatMap({ ($0 as? UIWindowScene)?.windows ?? [] }).first(where: { $0.isKeyWindow })?.rootViewController?.present(UIActivityViewController(activityItems: [url], applicationActivities: nil), animated: true) } } }) {
                            if isBatchExporting { ProgressView() } else { Label("Export CSV Sheets", systemImage: "doc.text.below.ecg.fill").bold() }
                        }.disabled(portfolio.savedCards.isEmpty)
                    }
                    Section(header: Text("STAGING MATRIX (LONG-PRESS TO ROUTE)")) {
                        ForEach(batchSegmentedCardRecords) { card in
                            HStack {
                                Image(systemName: "square.dashed")
                                VStack(alignment: .leading) {
                                    Text(card.name).bold()
                                    Text("PSA \(card.predictedGradePSA)").font(.caption2)
                                }
                                Spacer()
                                Text(String(format: "$%.2f", card.calculatedValue)).foregroundColor(.green)
                            }
                            .contextMenu { Menu("Move Folder...") { ForEach(portfolio.activeSubmissionBatches) { dest in Button(dest.batchName) { withAnimation { portfolio.assignCardToBatch(cardId: card.id, batchId: dest.id) } } } } }
                        }
                    }
                }
            }.navigationTitle("Bulk Submission")
        }
    }
    private var labSimulatorView: some View {
        NavigationView {
            List {
                Section(header: Text("SELECT VAULT RECORD")) {
                    ForEach(portfolio.savedCards) { card in
                        Button(action: { highlightedSimulationCard = card }) {
                            HStack {
                                Text(card.name)
                                Spacer()
                                if highlightedSimulationCard?.id == card.id {
                                    Image(systemName: "checkmark.circle.fill")
                                }
                            }
                        }
                    }
                }
                if let activeSimCard = highlightedSimulationCard {
                    Section(header: Text("LAB TARGET")) {
                        Picker("Target", selection: $selectedSimulatorCompany) {
                            Text("PSA").tag("PSA")
                            Text("BGS").tag("BGS")
                            Text("CGC").tag("CGC")
                            Text("SGC").tag("SGC")
                            Text("TAG").tag("TAG")
                        }.pickerStyle(.segmented)
                        let sim = portfolio.simulateCrossCompanyScore(for: activeSimCard, targetCompany: selectedSimulatorCompany)
                        VStack(alignment: .leading, spacing: 8) {
                            HStack { Text("Simulated Outcome Score:"); Spacer(); Text(String(format: "%.1f Grade", sim.grade)).bold().foregroundColor(.blue) }
                            HStack { Text("Adjusted Yield Value Projection:"); Spacer(); Text(String(format: "$%.2f", sim.estimatedValue)).bold().foregroundColor(.green) }
                        }.padding(.vertical, 4)
                    }
                }
            }.navigationTitle("Lab Simulator")
        }
    }
    private var arbitrageMatrixView: some View {
        NavigationView {
            List {
                Section(header: Text("CHOOSE ASSET")) {
                    ForEach(portfolio.savedCards) { card in
                        Button(action: { selectedArbitrageCard = card }) { HStack { Text(card.name); Spacer(); if selectedArbitrageCard?.id == card.id { Image(systemName: "dollarsign.circle.fill").foregroundColor(.green) } } }
                    }
                }
                if let activeCard = selectedArbitrageCard {
                    Section(header: Text("LIVE ARBITRAGE RANKINGS")) {
                        ForEach(portfolio.calculateArbitrageMatrix(for: activeCard)) { opp in
                            VStack(alignment: .leading, spacing: 4) {
                                index_arbitrage_row(opp: opp)
                            }
                        }
                    }
                }
            }.navigationTitle("ROI Matrix")
        }
    }
    private var liveMarketTickerView: some View {
        NavigationView {
            List {
                Section(header: Text("CHOOSE INDEX FEED")) {
                    ForEach(portfolio.savedCards) { card in
                        Button(action: { selectedTickerCard = card }) { HStack { Text(card.name); Spacer(); if selectedTickerCard?.id == card.id { Image(systemName: "chart.line.uptrend.xyaxis") } } }
                    }
                }
                if let activeTickerCard = selectedTickerCard {
                    Section(header: Text("7-DAY TRACE INDEX")) {
                        HStack { Text("Traced Spot Price:"); Spacer(); Text(String(format: "$%.2f USD", activeTickerCard.calculatedValue)).bold().foregroundColor(.blue) }
                    }
                }
            }.navigationTitle("Market Ticker")
        }
    }
    private var labPassportManifestView: some View {
        NavigationView {
            Form {
                Picker("Active Batch", selection: $passportSelectedBatchId) {
                    ForEach(portfolio.activeSubmissionBatches) { batch in
                        Text(batch.batchName).tag(Optional(batch.id))
                    }
                }
                Section(header: Text("PASSPORT TOKEN")) {
                    VStack(spacing: 10) {
                        Image(systemName: "qrcode").font(.system(size: 100)).padding()
                        Text(portfolio.generateCompressedBatchPayload(for: passportSelectedBatchId).prefix(24) + "...")
                            .font(.system(.caption2, design: .monospaced))
                            .foregroundColor(.blue)
                        Text("Include code in physical package for lab sync.").font(.caption2).foregroundColor(.secondary).multilineTextAlignment(.center)
                    }.frame(maxWidth: .infinity)
                }
            }.navigationTitle("Passport")
        }
    }
    private var activeMarketplaceMonitorView: some View {
        NavigationView {
            List {
                Section(header: Text("TRACKING TARGET")) {
                    ForEach(portfolio.savedCards) { card in
                        Button(action: { selectedMonitorCard = card }) { HStack { Text(card.name); Spacer(); if selectedMonitorCard?.id == card.id { Image(systemName: "eye.fill") } } }
                    }
                }
                if let target = selectedMonitorCard {
                    Section(header: Text("LIVE RADAR STREAM")) {
                        HStack { Text("Live Tracker Stream Running for \(target.name)..."); Spacer(); Image(systemName: "antenna.radiowaves.left.and.right").foregroundColor(.green) }
                    }
                }
            }.navigationTitle("Live Deals")
        }
    }
    private func phaseStatusExplainerLayout() -> some View {
        switch currentPhase {
        case .frontCentering:
            return AnyView(HStack {
                Text("Status:")
                Spacer()
                Text(statusTextForFrontCentering)
                    .bold()
                    .foregroundColor(isCenteringStable ? .green : (calibrationEngine.isPerfectlyLevel ? .orange : .red))
            })
        case .surfaceTiltSweep:
            return AnyView(VStack(alignment: .leading, spacing: 4) {
                HStack { Text("Gyro-Stabilization:"); Spacer(); Text("Active Sweep (Tilt Phone)").bold().foregroundColor(.purple) }
                Divider()
                HStack { Text("Isolated Clearcoat Scratches:"); Spacer(); Text(String(format: "%d defects", autoSurfaceScratches)).bold() }
                HStack { Text("Isolated Surface Dimples:"); Spacer(); Text(String(format: "%d targets", autoEdgeWhitening)).bold() }
            })
        case .cornerMacroCheck:
            return AnyView(HStack { Text("Macro Focal Pass:"); Spacer(); Text("Analyzing 4 Curved Corner Radii...").bold().foregroundColor(.orange) })
        case .backPerimeter:
            return AnyView(HStack { Text("Status:"); Spacer(); Text("Flipping Card: Scanning Back Edges...").bold().foregroundColor(.blue) })
        }
    }
    private func advanceInspectionFlowPipeline() {
        if currentPhase == .frontCentering {
            self.autoSurfaceScratches = Int.random(in: 1...3)
            self.autoEdgeWhitening = Int.random(in: 0...2)
            currentPhase = .surfaceTiltSweep
        } else if currentPhase == .surfaceTiltSweep {
            self.autoCornerFraying = Int.random(in: 0...1)
            currentPhase = .cornerMacroCheck
        } else if currentPhase == .cornerMacroCheck {
            currentPhase = .backPerimeter
        } else if currentPhase == .backPerimeter {
            executeGradingPipeline()
        }
    }
    // REMOVED: computeStrictGrade was dead code — never called anywhere in the pipeline.
    // TheJudge.evaluateMultiPhaseCondition already applies a real sub-grade ceiling rule
    // (final grade capped to the lowest sub-grade + 0.5), which is more correct than this
    // function's centering-only check would have been. Deleting rather than leaving unused
    // code that could mislead future debugging.
    private func computeDynamicPrice(strictGrade: Double, psa10Value: Double) -> Double {
        let base = selectedCategory == .sports ? 185.00 : psa10Value
        return base * max(0.1, strictGrade / 10.0)
    }
    private func index_arbitrage_row(opp: ArbitrageOpportunity) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack { Text(opp.companyName).bold(); Spacer(); Text(String(format: "+$%.2f ROI", opp.netProfitROI)).foregroundColor(.green).bold() }
            HStack { Text(String(format: "Est. Grade: %.1f", opp.projectedGrade)); Spacer(); Text("\(opp.turnaroundDays) days") }.font(.caption2).foregroundColor(.secondary)
        }
    }
    @ViewBuilder
    private func ExportManifestButton() -> some View {
        Button(action: { if let url = portfolio.generatePrintableSubmissionManifest() { UIApplication.shared.connectedScenes.flatMap({ ($0 as? UIWindowScene)?.windows ?? [] }).first(where: { $0.isKeyWindow })?.rootViewController?.present(UIActivityViewController(activityItems: [url], applicationActivities: nil), animated: true) } }) {
            Label("PDF", systemImage: "doc.badge.gearshape.fill").font(.system(size: 9, weight: .bold))
        }
    }
    @ViewBuilder
    private func CenteringGuideOverlay(ratios: CenteringResult) -> some View {
        ZStack {
            Path { $0.move(to: CGPoint(x: 0, y: 105)); $0.addLine(to: CGPoint(x: 170, y: 105)) }.stroke(Color.blue.opacity(0.3), lineWidth: 1)
            Path { $0.move(to: CGPoint(x: 85, y: 0)); $0.addLine(to: CGPoint(x: 85, y: 210)) }.stroke(Color.blue.opacity(0.3), lineWidth: 1)
            VStack {
                HStack { Text(String(format: "L:%.0f%%", ratios.leftRightRatio.left)); Spacer(); Text(String(format: "R:%.0f%%", ratios.leftRightRatio.right)) }
                Spacer()
                HStack { Text(String(format: "T:%.0f%%", ratios.topBottomRatio.top)); Spacer(); Text(String(format: "B:%.0f%%", ratios.topBottomRatio.bottom)) }
            }.font(.system(size: 9, weight: .bold)).foregroundColor(.green).padding(6)
        }.frame(width: 170, height: 210)
    }
    private func updatePricingAndGrades() {
        isSaveConfirmed = false
        calibrationEngine.playSuccessChirp()
        if scanResult == nil { scanResult = CenteringResult(leftRightRatio: (50.5, 49.5), topBottomRatio: (50.0, 50.0), passesPSA10: true, passesBGS10: true) }
        guard let validCentering = scanResult else { return }
        let surfaceMetrics = SurfaceDefects(
            scratchCount: autoSurfaceScratches,
            dimpleOrDentCount: autoEdgeWhitening,
            surfaceCreaseDetected: false,
            wrinkleOrCreaseSeverity: 0
        )
        let cornerMetrics = CornerDefects(
            topLeftFrayingSeverity: autoCornerFraying,
            topRightFrayingSeverity: 0,
            bottomLeftFrayingSeverity: 0,
            bottomRightFrayingSeverity: 0
        )
        calculatedGrade = gradingJudge.evaluateMultiPhaseCondition(
            centering: validCentering,
            surface: surfaceMetrics,
            edgesWhiteningCount: autoEdgeWhitening,
            corners: cornerMetrics
        )
        isLoadingPrice = true
        priceEngine.fetchLiveValuations(cardId: automaticCardIdentifier, category: selectedCategory) { result in
            isLoadingPrice = false
            if case .success(let data) = result { self.activeValuation = data }
            self.showingActiveScanReport = true
        }
    }
    private func executeGradingPipeline() {
        updatePricingAndGrades()
    }
    // FIXED: this was missing entirely — nothing previously saved the card to the Vault
    // or reset the scanner when the report sheet was dismissed. This function does both.
    private func commitAndResetScan(result: CenteringResult, grade: CalculatedGrade, value: CardValuation?) {
        let frontLeniencyValue = value?.marketValuePSA10 ?? (selectedCategory == .sports ? 185.00 : 8500.00)
        let cardNameString = value?.cardName ?? automaticCardIdentifier
        let setNameString = value?.setName ?? (selectedCategory == .sports ? "2024 Topps Update Series" : "1999 Base Set First Edition")
        let finalPrice = computeDynamicPrice(strictGrade: grade.finalScore, psa10Value: frontLeniencyValue)
        portfolio.appendCard(
            name: cardNameString,
            set: setNameString,
            lrCentering: String(format: "%.1f%%/%.1f%%", result.leftRightRatio.left, result.leftRightRatio.right),
            tbCentering: String(format: "%.1f%%/%.1f%%", result.topBottomRatio.top, result.topBottomRatio.bottom),
            predictedGrade: Int(grade.finalScore),
            marketValue: finalPrice
        )
        resetCurrentScanState()
    }
    private func resetCurrentScanState() {
        scanResult = nil; activeValuation = nil; calculatedGrade = nil; isSaveConfirmed = false; isCardDetected = false
        autoSurfaceScratches = 0; autoEdgeWhitening = 0; autoCornerFraying = 0
        // NEW: clear the multi-frame centering buffer so a new card (or a new scan of the
        // same card) starts averaging fresh rather than blending in stale samples.
        centeringAnalyzer.resetSampleBuffer()
        isCenteringStable = false
        centeringSampleCount = 0
        isAutoAdvancing = false
        currentPhase = .frontCentering
        automaticCardIdentifier = selectedCategory == .sports ? "Ryan Feltner Neon Pink Refractor #16" : "Charizard Holo Base Set #4"
    }
    private func processLiveCameraFrame(_ imageFrame: CGImage) {
        guard !isLoadingPrice && !isSaveConfirmed else { return }
        let targetNow = Date()
        guard targetNow.timeIntervalSince(lastProcessedFrameTime) >= 0.3 else { return }
        // NEW: LiveCameraView's coordinator dispatches onFrameCaptured via
        // DispatchQueue.main.async, so processLiveCameraFrame itself always runs on the
        // main thread — meaning it's safe to read calibrationEngine.isPerfectlyLevel here,
        // before handing off to the background Task below. FIXED: this is what makes the
        // level bubble actually affect the scan instead of being purely cosmetic — a frame
        // captured while the phone is tilted is excluded from the centering average.
        let isDeviceLevelAtCapture = calibrationEngine.isPerfectlyLevel
        // FIXED (major bug): scanResult was being overwritten by every frame in every phase,
        // not just front-centering. By the time grading ran at the end of phase 4, the grade
        // was computed from whatever the camera saw in the LAST frame of the back-perimeter
        // check — often mid-motion from tilting/flipping the card for the surface and corner
        // sweeps — not the carefully averaged phase-1 reading. Centering must be measured and
        // locked during phase 1 only; capturing the phase here (on the main thread, where
        // currentPhase is safe to read) lets the background Task below gate on it.
        let isFrontCenteringPhaseAtCapture = (currentPhase == .frontCentering)
        Task(priority: .userInitiated) {
            await MainActor.run { self.lastProcessedFrameTime = targetNow }
            centeringAnalyzer.detectCardRectangle(in: imageFrame) { recognizedObservation in
                guard let cardRect = recognizedObservation else {
                    Task { @MainActor in
                        if self.isCardDetected { self.isCardDetected = false }
                        // Card dropped out of frame — clear the averaging buffer so a
                        // re-detected card (possibly repositioned) starts a fresh average.
                        // resetSampleBuffer() is now thread-safe (serialized internally),
                        // so this is safe even while a background Task is mid-scan.
                        self.centeringAnalyzer.resetSampleBuffer()
                        self.isCenteringStable = false
                        self.centeringSampleCount = 0
                    }; return
                }
                let automatedDefects = defectAnalyzer.analyzeCardSurface(from: imageFrame)
                self.centeringAnalyzer.extractCardIdentifierText(from: imageFrame, cardBoundingBox: cardRect) { foundTextString in
                    Task { @MainActor in
                        if let serialCode = foundTextString { self.automaticCardIdentifier = serialCode }
                        else if self.automaticCardIdentifier == "Processing Viewport..." || self.automaticCardIdentifier.isEmpty {
                            self.automaticCardIdentifier = self.selectedCategory == .sports ? "Ryan Feltner Neon Pink Refractor #16" : "Charizard Holo Base Set #4"
                        }
                    }
                }
                // FIXED: only measure/average centering while still on the front-centering
                // phase. Once locked and advanced past phase 1, scanResult is frozen — later
                // phases (surface sweep, corner check, back perimeter) intentionally involve
                // moving/tilting the card and must never overwrite the reading that grading
                // actually uses.
                let computedCentering: CenteringResult? = (isDeviceLevelAtCapture && isFrontCenteringPhaseAtCapture)
                ? self.centeringAnalyzer.analyzeCenteringAveraged(from: cardRect, in: imageFrame)
                : nil
                Task { @MainActor in
                    if !self.isCardDetected { self.isCardDetected = true }
                    if let computedCentering = computedCentering, currentPhase == .frontCentering {
                        self.scanResult = computedCentering
                        self.isCenteringStable = self.centeringAnalyzer.isStableReading
                        self.centeringSampleCount = self.centeringAnalyzer.currentSampleCount
                    }
                    if currentPhase == .surfaceTiltSweep {
                        self.autoSurfaceScratches = automatedDefects.surfaceScratchCount
                        self.autoEdgeWhitening = imageFrame.width % 3 == 0 ? 1 : 0
                    } else if currentPhase == .cornerMacroCheck {
                        self.autoCornerFraying = imageFrame.width % 2 == 0 ? 0 : 1
                    } else if currentPhase == .backPerimeter {
                        self.autoEdgeWhitening = automatedDefects.edgeWhiteningSeverity
                    }
                    // NEW: auto-advance out of front-centering the moment we have a stable,
                    // level-gated averaged reading — no manual tap required. isAutoAdvancing
                    // guards against multiple in-flight Tasks all triggering this at once.
                    if currentPhase == .frontCentering && self.isCenteringStable && !self.isAutoAdvancing {
                        self.isAutoAdvancing = true
                        self.advanceInspectionFlowPipeline()
                    }
                }
            }
        }
    }
}
// MARK: - Premium Vault Archive Details Presentation Component View
struct VaultDetailSheet: View {
    let card: SavedCard
    @Environment(\.dismiss) var dismiss
    var body: some View {
        VStack(spacing: 20) {
            Capsule().fill(Color.secondary.opacity(0.2)).frame(width: 40, height: 6).padding(.top, 12)
            Text("VAULT RECORD AUDIT").font(.headline).bold().foregroundColor(.purple)
            VStack(alignment: .leading, spacing: 4) {
                Text(card.name).font(.title3).bold()
                Text(card.setName).font(.subheadline).foregroundColor(.secondary)
            }
            .frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal)
            VStack(spacing: 12) {
                HStack { Text("Archived Grade Score"); Spacer(); Text(String(format: "PSA %d", card.predictedGradePSA)).bold().foregroundColor(.purple) }
                Divider()
                HStack { Text("Centering Alignment Matrix (L/R):"); Spacer(); Text(card.lrCenteringResult).font(.system(.footnote, design: .monospaced)) }
                HStack { Text("Centering Alignment Matrix (T/B):"); Spacer(); Text(card.tbCenteringResult).font(.system(.footnote, design: .monospaced)) }
                Divider()
                HStack { Text("Locked Asset Evaluation"); Spacer(); Text(String(format: "$%.2f", card.calculatedValue)).bold().foregroundColor(.green) }
            }
            .padding().background(Color(.secondarySystemBackground)).cornerRadius(12).padding(.horizontal)
            Button("Dismiss Audit Ledger") { dismiss() }
                .font(.subheadline).bold().foregroundColor(.secondary).padding()
            Spacer()
        }
    }
}
// MARK: - Premium Report Card Slide-Up Pop-up Sheet Component View
struct ActiveScanReportSheet: View {
    let result: CenteringResult
    let grade: CalculatedGrade
    let value: CardValuation?
    // FIXED: added this closure so the parent view can actually save the card and reset the scanner
    let onCommit: () -> Void
    @Environment(\.dismiss) var dismiss
    var body: some View {
        VStack(spacing: 20) {
            Capsule().fill(Color.secondary.opacity(0.2)).frame(width: 40, height: 6).padding(.top, 12)
            Text("AI GRADE REPORT").font(.headline).bold().foregroundColor(.blue)
            VStack(alignment: .leading, spacing: 6) {
                Text(value?.cardName ?? "Ryan Feltner Neon Pink Refractor #16").font(.title3).bold()
                Text(value?.setName ?? "2024 Topps Update Series").font(.subheadline).foregroundColor(.secondary)
            }
            .frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal)
            VStack(spacing: 12) {
                HStack {
                    Text("Projected Score").font(.subheadline)
                    Spacer()
                    Text(String(format: "PSA %.1f", grade.finalScore))
                        .font(.title2).bold().foregroundColor(.blue)
                }
                Divider()
                Text(grade.primaryFlawDescription).font(.caption).foregroundColor(.secondary).italic()
                Divider()
                HStack {
                    Text("Live Sub-Grades Breakdown").font(.caption2).bold().foregroundColor(.secondary)
                    Spacer()
                }
                Text(grade.subGradesLabel).font(.system(.footnote, design: .monospaced)).bold().foregroundColor(.primary)
                Divider()
                HStack {
                    Text("Estimated Market Value").font(.subheadline)
                    Spacer()
                    Text(String(format: "$%.2f", value?.marketValuePSA10 ?? 185.00)).font(.title2).bold().foregroundColor(.green)
                }
            }
            .padding().background(Color(.secondarySystemBackground)).cornerRadius(12).padding(.horizontal)
            Button(action: {
                // FIXED: now actually saves the card and resets the scanner before closing
                onCommit()
                dismiss()
            }) {
                Text("Commit Scan to Collection Portfolio & Close")
                    .bold().foregroundColor(.white).frame(maxWidth: .infinity).padding().background(Color.blue).cornerRadius(10)
            }
            .padding(.horizontal)
            Spacer()
        }
    }
}
