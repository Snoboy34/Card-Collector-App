import SwiftUI
import Combine

// MARK: - Supported Multi-Phase Scanning Workflow States
enum ScanningPhase: String, CaseIterable {
    case frontCentering = "1. Front Centering"
    case surfaceTiltSweep = "2. Surface Light Scan"
    case cornerMacroCheck = "3. Corner Inspection"
    case backPerimeter = "4. Back Border Check"
}

/// Fits neon + status + 44pt actions on SE (~455pt content) through 16 Pro.
private struct CompactScanLayout {
    let cameraHeight: CGFloat
    let metricsHeight: CGFloat

    init(availableHeight: CGFloat, sweepActive: Bool) {
        let header: CGFloat = 50
        let status: CGFloat = sweepActive ? 48 : 34
        let actions: CGFloat = 44
        let gaps: CGFloat = 28
        let leftover = availableHeight - header - status - actions - gaps
        let tight = leftover < 250
        let metricsFloor: CGFloat = tight ? 56 : 72
        let cameraMin: CGFloat = tight ? 160 : 168
        let camera = min(340, max(cameraMin, leftover - metricsFloor))
        cameraHeight = camera
        metricsHeight = max(metricsFloor, leftover - camera)
    }

    #if DEBUG
    static func runContractChecks() {
        let se = CompactScanLayout(availableHeight: 455, sweepActive: false)
        precondition(se.cameraHeight >= 168 && se.cameraHeight <= 340)
        precondition(50 + 34 + 44 + 28 + se.cameraHeight + se.metricsHeight <= 456)
        let seSweep = CompactScanLayout(availableHeight: 400, sweepActive: true)
        precondition(50 + 48 + 44 + 28 + seSweep.cameraHeight + seSweep.metricsHeight <= 401)
        let pro = CompactScanLayout(availableHeight: 680, sweepActive: false)
        precondition(pro.cameraHeight == 340)
        precondition(pro.metricsHeight >= 72)
    }
    #endif
}

struct CategoryAllocation: Identifiable {
    let id = UUID()
    let categoryName: String
    let totalValue: Double
    let accentColor: Color
}

struct CardScannerView: View {
    @StateObject private var calibrationEngine = CameraCalibration()
    @StateObject private var portfolio = PortfolioState()
    @StateObject private var securityVault = UserSecurity()

    // TheJudge is not used for saved grades. Live framing is CenteringAnalyzer;
    // Capture → /api/grade is the only ledger authority.
    private let centeringAnalyzer = CenteringAnalyzer()
    private let defectAnalyzer = DefectAnalyzer()

    @State private var currentPhase: ScanningPhase = .frontCentering
    @State private var scanResult: CenteringResult?
    @State private var pendingServerLedger: ScanLedger?
    @State private var pendingScanId = ""
    @State private var isLoadingPrice = false
    @State private var isSaveConfirmed = false
    @State private var isCardDetected = false
    @State private var cardMissStreak = 0
    @State private var automaticCardIdentifier = "unknown"

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

    // Native still path: session-once AE lock + PhotoOutput JPEG → neon crop → /api/grade
    @State private var stillCaptureNonce: UInt64 = 0
    @State private var exposureLockStatus = "Camera starting…"
    @State private var judgeServerURL = UserDefaults.standard.string(forKey: JudgeAPIClient.serverURLDefaultsKey) ?? ""
    @State private var isRemoteGrading = false
    @State private var remoteGradeSummary = ""
    @State private var lastRemoteError: String?

    private struct NativeSweepFrame {
        var bin: CardSweepBins.Bin
        var jpeg: Data
        var pitchDeg: Double
        var rollDeg: Double
    }

    @State private var sweepActive = false
    @State private var sweepTarget: CardSweepBins.Bin?
    @State private var sweepFrames: [NativeSweepFrame] = []
    @State private var sweepGrabbed: Set<CardSweepBins.Bin> = []
    @State private var sweepInBinSince: Date?
    @State private var sweepWaitingForStill = false
    @State private var sweepUploadStarted = false
    @State private var sweepStatus = ""
    @State private var pendingLevelOCR: [String] = []
    private let sweepClock = Timer.publish(every: 0.05, on: .main, in: .common).autoconnect()

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

    // NEW (fix): the center-guide box previously turned green on ANY card detection,
    // regardless of whether the centering reading was actually good — meaning a badly
    // off-center card would still show the same "all clear" green as a well-centered one.
    // Now: outside the front-centering phase, green still just means "card detected"
    // (there's no centering reading to verify there). During front-centering specifically,
    // green requires BOTH a stable averaged reading AND that reading actually passing the
    // PSA10 centering threshold — a detected-but-poorly-centered card now shows orange
    // instead, so the color is telling the truth about alignment quality, not just presence.
    private var guideBoxColor: Color {
        guard isCardDetected else { return Color.white.opacity(0.4) }
        if currentPhase == .frontCentering {
            let isVerifiedGoodCentering = isCenteringStable && (scanResult?.passesPSA10 ?? false)
            return isVerifiedGoodCentering ? Color.green : Color.orange
        }
        return Color.green
    }

    private var guideBoxLineWidth: CGFloat {
        isCardDetected ? 4 : 2
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

    // Primary chrome (neon frame, status, Capture/Advance) is pinned. Camera
    // height is leftover space so SE through 16 Pro fit without scrolling.
    // Long diagnostics stay in a short secondary ScrollView.
    private var scannerDashboardView: some View {
        NavigationView {
            GeometryReader { geo in
                let layout = CompactScanLayout(availableHeight: geo.size.height, sweepActive: sweepActive)
                VStack(spacing: 6) {
                    compactHeader
                    cameraViewportSection(height: layout.cameraHeight)
                    compactStatus
                    compactActions
                    compactMetricsPanel
                        .frame(maxHeight: layout.metricsHeight)
                }
                .padding(.horizontal, 10)
                .padding(.top, 4)
                .padding(.bottom, 4)
            }
            .navigationTitle("Scan")
            .navigationBarTitleDisplayMode(.inline)
            .sheet(isPresented: $showingActiveScanReport) {
                if let ledger = pendingServerLedger {
                    ActiveScanReportSheet(ledger: ledger, onCommit: {
                        commitAndResetScan(ledger: ledger)
                    })
                }
            }
            .onAppear {
                #if DEBUG
                CardSweepBins.runContractChecks()
                CameraCalibration.runContractChecks()
                CompactScanLayout.runContractChecks()
                #endif
                calibrationEngine.startDeviceLevelMonitoring()
            }
            .onDisappear { calibrationEngine.stopDeviceLevelMonitoring() }
            .onReceive(sweepClock) { date in
                guard sweepActive else { return }
                checkSweepGrab(now: date)
            }
        }
    }

    private var compactHeader: some View {
        VStack(spacing: 4) {
            Picker("Profile", selection: $selectedCategory) {
                ForEach(CardCategory.allCases, id: \.self) { category in
                    Text(category.rawValue).tag(category)
                }
            }
            .pickerStyle(.segmented)
            .onChange(of: selectedCategory) {
                resetCurrentScanState()
            }
            HStack(spacing: 4) {
                ForEach(ScanningPhase.allCases, id: \.self) { phase in
                    Rectangle()
                        .fill(phase == currentPhase ? Color.blue : (ScanningPhase.allCases.firstIndex(of: phase)! < ScanningPhase.allCases.firstIndex(of: currentPhase)! ? Color.green : Color.gray.opacity(0.3)))
                        .frame(height: 4)
                }
            }
            Text(currentPhase.rawValue)
                .font(.system(.caption2, design: .monospaced))
                .bold()
                .foregroundColor(.secondary)
        }
    }

    private var compactStatus: some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: 8) {
                Text(exposureLockStatus)
                    .font(.caption2)
                    .foregroundColor(exposureLockStatus.contains("locked") ? .green : .orange)
                    .lineLimit(1)
                Spacer()
                Text(automaticCardIdentifier)
                    .font(.caption2)
                    .foregroundColor(.blue)
                    .lineLimit(1)
            }
            Text(primaryInstructionText)
                .font(.caption2)
                .foregroundColor(.secondary)
                .lineLimit(2)
            if !sweepStatus.isEmpty {
                Text(sweepStatus)
                    .font(.caption2)
                    .foregroundColor(.cyan)
                    .lineLimit(2)
            }
        }
    }

    private var primaryInstructionText: String {
        if sweepActive {
            return "Hold the highlighted tick. Keep the whole card in the neon frame."
        }
        return "Keep the whole card in the neon frame. Crop edges are the cut."
    }

    private var compactActions: some View {
        HStack(spacing: 8) {
            Button(action: requestNativeStillGrade) {
                HStack {
                    if isRemoteGrading { ProgressView().tint(.black) }
                    Text(captureButtonTitle)
                        .font(.subheadline).bold()
                        .lineLimit(1)
                        .minimumScaleFactor(0.8)
                }
                .frame(maxWidth: .infinity, minHeight: 44)
                .background((isRemoteGrading || sweepActive) ? Color.gray : Color.cyan)
                .foregroundColor(.black)
                .cornerRadius(8)
            }
            .disabled(isRemoteGrading || sweepActive)

            if sweepActive {
                Button("Skip sweep") {
                    finishSweepAndUpload()
                }
                .font(.subheadline).bold()
                .frame(maxWidth: .infinity, minHeight: 44)
                .background(Color(.secondarySystemBackground))
                .cornerRadius(8)
            } else {
                Button(action: { advanceInspectionFlowPipeline() }) {
                    Text(currentPhase == .backPerimeter ? "Submit grade" : "Advance")
                        .font(.subheadline).bold()
                        .lineLimit(1)
                        .minimumScaleFactor(0.8)
                        .frame(maxWidth: .infinity, minHeight: 44)
                        .background(canAdvancePhase ? Color.blue : Color.gray)
                        .foregroundColor(.white)
                        .cornerRadius(8)
                }
                .disabled(!canAdvancePhase)
            }
        }
    }

    private var compactMetricsPanel: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 6) {
                TextField("https://192.168.x.x:5000", text: $judgeServerURL)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .keyboardType(.URL)
                    .font(.system(.caption2, design: .monospaced))
                    .textFieldStyle(.roundedBorder)
                    .onChange(of: judgeServerURL) {
                        UserDefaults.standard.set(judgeServerURL, forKey: JudgeAPIClient.serverURLDefaultsKey)
                    }
                phaseStatusExplainerLayout()
                if let lastRemoteError {
                    Text(lastRemoteError)
                        .font(.caption2)
                        .foregroundColor(.red)
                        .fixedSize(horizontal: false, vertical: true)
                }
                if !remoteGradeSummary.isEmpty {
                    Text(remoteGradeSummary)
                        .font(.system(size: 10, design: .monospaced))
                        .fixedSize(horizontal: false, vertical: true)
                }
                Text(centeringAnalyzer.diagnosticsSummaryText)
                    .font(.system(size: 8, design: .monospaced))
                    .foregroundColor(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .padding(8)
        }
        .background(Color(.secondarySystemBackground))
        .cornerRadius(8)
    }

    private func cameraViewportSection(height: CGFloat) -> some View {
        GeometryReader { geo in
            let neon = CardAlignmentCrop.cardFrameRect(canvasWidth: geo.size.width, canvasHeight: geo.size.height)
            let neonCenter = CGPoint(x: neon.x + neon.w / 2, y: neon.y + neon.h / 2)
            ZStack {
                LiveCameraView(
                    stillCaptureNonce: $stillCaptureNonce,
                    exposureLockStatus: $exposureLockStatus,
                    onStillCaptured: handleStillCapture,
                    onFrameCaptured: processLiveCameraFrame
                )
                .environmentObject(calibrationEngine)
                .allowsHitTesting(false)

                neonFrameOverlay(neon: neon, center: neonCenter)

                levelBubbleOverlay
                    .position(x: neonCenter.x, y: neonCenter.y)

                if currentPhase == .frontCentering && !isCenteringStable {
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
            }
            .allowsHitTesting(false)
        }
        .frame(height: height)
        .frame(maxWidth: .infinity)
        .contentShape(Rectangle())
        .allowsHitTesting(false)
        .cornerRadius(8)
        .clipped()
    }

    @ViewBuilder
    private func neonFrameOverlay(neon: CardAlignmentCrop.PixelRect, center: CGPoint) -> some View {
        ZStack {
            RoundedRectangle(cornerRadius: 4)
                .stroke(Color.cyan, lineWidth: 2)
            Path { path in
                path.move(to: CGPoint(x: 0, y: neon.h / 2))
                path.addLine(to: CGPoint(x: neon.w, y: neon.h / 2))
                path.move(to: CGPoint(x: neon.w / 2, y: 0))
                path.addLine(to: CGPoint(x: neon.w / 2, y: neon.h))
            }
            .stroke(Color.white.opacity(0.45), lineWidth: 1)
            RoundedRectangle(cornerRadius: 4)
                .stroke(guideBoxColor, lineWidth: guideBoxLineWidth)
            if let centeringRatio = scanResult, isCardDetected {
                CenteringGuideOverlay(ratios: centeringRatio, size: CGSize(width: neon.w, height: neon.h))
            } else {
                VStack {
                    Image(systemName: "viewfinder").font(.title2)
                    Text("FILL NEON 2.5×3.5").font(.caption2).bold().padding(4).background(Color.black.opacity(0.6)).cornerRadius(4)
                }
                .foregroundColor(.white)
            }
        }
        .frame(width: neon.w, height: neon.h)
        .position(x: center.x, y: center.y)
        .allowsHitTesting(false)
    }

    private var levelBubbleOverlay: some View {
        let clamp: Double = 12
        let radius: Double = 28
        let pitch = max(-clamp, min(clamp, calibrationEngine.currentPitch))
        let roll = max(-clamp, min(clamp, calibrationEngine.currentRoll))
        return ZStack {
            Circle()
                .stroke(calibrationEngine.isPerfectlyLevel ? Color.green : Color.red, lineWidth: 3)
                .frame(width: 64, height: 64)
            sweepTick(bin: .pitchMinus, x: 0, y: -32)
            sweepTick(bin: .pitchPlus, x: 0, y: 32)
            sweepTick(bin: .rollPlus, x: 32, y: 0)
            sweepTick(bin: .rollMinus, x: -32, y: 0)
            Circle()
                .fill(Color.white.opacity(0.2))
                .frame(width: 14, height: 14)
            Circle()
                .fill(calibrationEngine.isPerfectlyLevel ? Color.green : Color.orange)
                .frame(width: 10, height: 10)
                .offset(
                    x: CGFloat(roll / clamp * radius),
                    y: CGFloat(pitch / clamp * radius)
                )
                .animation(nil, value: calibrationEngine.currentPitch)
                .animation(nil, value: calibrationEngine.currentRoll)
        }
        .allowsHitTesting(false)
    }

    private var captureButtonTitle: String {
        if isRemoteGrading { return "Uploading…" }
        if sweepActive {
            return "Sweep \(sweepGrabbed.count)/5"
        }
        return "Capture"
    }

    @ViewBuilder
    private func sweepTick(bin: CardSweepBins.Bin, x: CGFloat, y: CGFloat) -> some View {
        let isTarget = sweepActive && sweepTarget == bin
        let isDone = sweepGrabbed.contains(bin)
        RoundedRectangle(cornerRadius: 1)
            .fill(isDone ? Color.green : (isTarget ? Color.yellow : Color.white.opacity(0.7)))
            .frame(width: abs(x) > 0 ? 10 : 3, height: abs(y) > 0 ? 10 : 3)
            .offset(x: x, y: y)
            .opacity(isTarget ? 1 : 0.85)
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
                        VStack(alignment: .leading) { Text("NET WORTH").font(.caption2).bold().foregroundColor(.secondary); Text(portfolio.hasPricedCards ? String(format: "$%.2f", portfolio.totalPortfolioValue) : ScanLedger.absent).font(.title2).bold().foregroundColor(.blue) }.frame(maxWidth: .infinity, alignment: .leading).padding().background(Color(.secondarySystemBackground)).cornerRadius(10)
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
                                    VStack(alignment: .trailing) { Text(card.displayValue).bold().foregroundColor(.green); Text(card.displayGrade).font(.caption2).padding(4).background(Color.blue.opacity(0.1)).cornerRadius(4) }
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
                                    Text(card.displayGrade).font(.caption2)
                                }
                                Spacer()
                                Text(card.displayValue).foregroundColor(.green)
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
                            HStack { Text("Simulated Outcome Score:"); Spacer(); Text(sim.grade.map { String(format: "%.1f Grade", $0) } ?? ScanLedger.absent).bold().foregroundColor(.blue) }
                            HStack { Text("Adjusted Yield Value Projection:"); Spacer(); Text(sim.estimatedValue.map { String(format: "$%.2f", $0) } ?? ScanLedger.absent).bold().foregroundColor(.green) }
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
                        HStack { Text("Traced Spot Price:"); Spacer(); Text(activeTickerCard.displayValue).bold().foregroundColor(.blue) }
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
            currentPhase = .surfaceTiltSweep
        } else if currentPhase == .surfaceTiltSweep {
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
    // computeDynamicPrice removed — vault value is only what /api/grade returns.
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
    private func CenteringGuideOverlay(ratios: CenteringResult, size: CGSize = CGSize(width: 170, height: 210)) -> some View {
        ZStack {
            Path { $0.move(to: CGPoint(x: 0, y: size.height / 2)); $0.addLine(to: CGPoint(x: size.width, y: size.height / 2)) }.stroke(Color.blue.opacity(0.3), lineWidth: 1)
            Path { $0.move(to: CGPoint(x: size.width / 2, y: 0)); $0.addLine(to: CGPoint(x: size.width / 2, y: size.height)) }.stroke(Color.blue.opacity(0.3), lineWidth: 1)
            VStack {
                HStack { Text(String(format: "L:%.0f%%", ratios.leftRightRatio.left)); Spacer(); Text(String(format: "R:%.0f%%", ratios.leftRightRatio.right)) }
                Spacer()
                HStack { Text(String(format: "T:%.0f%%", ratios.topBottomRatio.top)); Spacer(); Text(String(format: "B:%.0f%%", ratios.topBottomRatio.bottom)) }
            }.font(.system(size: 9, weight: .bold)).foregroundColor(.green).padding(6)
        }.frame(width: size.width, height: size.height)
    }

    private func requestNativeStillGrade() {
        lastRemoteError = nil
        remoteGradeSummary = ""
        pendingServerLedger = nil
        pendingScanId = UUID().uuidString
        guard JudgeAPIClient.normalizedBaseURL(judgeServerURL) != nil else {
            lastRemoteError = JudgeAPIClient.APIError.invalidServerURL.localizedDescription
            return
        }
        resetSweepSession()
        stillCaptureNonce += 1
    }

    private func resetSweepSession() {
        sweepActive = false
        sweepTarget = nil
        sweepFrames = []
        sweepGrabbed = []
        sweepInBinSince = nil
        sweepWaitingForStill = false
        sweepUploadStarted = false
        sweepStatus = ""
        pendingLevelOCR = []
    }

    private func handleStillCapture(_ result: Result<LiveCameraView.StillCapture, Error>) {
        switch result {
        case .failure(let error):
            sweepWaitingForStill = false
            lastRemoteError = error.localizedDescription
            if sweepFrames.isEmpty {
                sweepActive = false
            }
        case .success(let still):
            if sweepUploadStarted { return }
            lastRemoteError = nil
            do {
                let cropped = try CardAlignmentCrop.cropJPEG(still.jpeg, previewSize: still.previewSize)
                let pitch = calibrationEngine.currentPitch
                let roll = calibrationEngine.currentRoll
                if sweepFrames.isEmpty {
                    let ocrLines = (try? CardStillOCR.recognizeLines(from: cropped)) ?? []
                    storeSweepFrame(bin: .level, jpeg: cropped, pitch: pitch, roll: roll)
                    pendingLevelOCR = ocrLines
                    beginSweepAfterFirstStill()
                } else if let target = sweepTarget {
                    storeSweepFrame(bin: target, jpeg: cropped, pitch: pitch, roll: roll)
                    advanceSweepAfterGrab()
                } else {
                    finishSweepAndUpload()
                }
            } catch {
                sweepWaitingForStill = false
                lastRemoteError = error.localizedDescription
            }
        }
    }

    private func storeSweepFrame(bin: CardSweepBins.Bin, jpeg: Data, pitch: Double, roll: Double) {
        sweepFrames.append(NativeSweepFrame(bin: bin, jpeg: jpeg, pitchDeg: pitch, rollDeg: roll))
        sweepGrabbed.insert(bin)
        sweepWaitingForStill = false
        sweepInBinSince = nil
    }

    private func beginSweepAfterFirstStill() {
        guard calibrationEngine.isMotionAvailable else {
            sweepStatus = "No motion sensor — uploading the first still only."
            finishSweepAndUpload()
            return
        }
        guard let next = CardSweepBins.nextSweepBin(captured: Array(sweepGrabbed)) else {
            finishSweepAndUpload()
            return
        }
        sweepActive = true
        sweepTarget = next
        sweepStatus = "\(next.prompt) (1/5)"
    }

    private func advanceSweepAfterGrab() {
        guard let next = CardSweepBins.nextSweepBin(captured: Array(sweepGrabbed)) else {
            finishSweepAndUpload()
            return
        }
        sweepTarget = next
        sweepInBinSince = nil
        sweepStatus = "\(next.prompt) (\(sweepGrabbed.count)/5)"
    }

    private func checkSweepGrab(now: Date) {
        guard sweepActive, let target = sweepTarget, !sweepWaitingForStill else { return }
        let matched = CardSweepBins.matchSweepBin(
            pitchDeg: calibrationEngine.currentPitch,
            rollDeg: calibrationEngine.currentRoll
        )
        let inTarget = matched == target
        if inTarget {
            if sweepInBinSince == nil { sweepInBinSince = now }
        } else {
            sweepInBinSince = nil
        }
        let heldMs = sweepInBinSince.map { now.timeIntervalSince($0) * 1000 } ?? 0
        if CardSweepBins.shouldGrabSweepBin(
            inTargetBin: inTarget,
            heldMs: heldMs,
            alreadyGrabbed: sweepGrabbed.contains(target)
        ) {
            sweepWaitingForStill = true
            stillCaptureNonce += 1
        }
    }

    private func finishSweepAndUpload() {
        guard !sweepUploadStarted else { return }
        sweepActive = false
        sweepTarget = nil
        sweepWaitingForStill = false
        sweepUploadStarted = true
        guard let level = sweepFrames.first else {
            lastRemoteError = "Sweep failed — no level still."
            resetSweepSession()
            return
        }
        let extras = Array(sweepFrames.dropFirst())
        sweepStatus = extras.isEmpty
            ? "Uploading first still…"
            : "Uploading level still + \(extras.count) diagnostic sweep frames…"
        uploadNativeGrade(levelJPEG: level.jpeg, extras: extras)
    }

    private func uploadNativeGrade(levelJPEG: Data, extras: [NativeSweepFrame]) {
        isRemoteGrading = true
        lastRemoteError = nil
        let level = sweepFrames.first
        let tilt = JudgeAPIClient.TiltSnapshot(
            pitchDeg: level?.pitchDeg ?? calibrationEngine.currentPitch,
            rollDeg: level?.rollDeg ?? calibrationEngine.currentRoll,
            isLevel: CardSweepBins.isDeviceLevel(
                level?.pitchDeg ?? calibrationEngine.currentPitch,
                level?.rollDeg ?? calibrationEngine.currentRoll
            )
        )
        let sweepPayload = extras.map {
            JudgeAPIClient.SweepFrame(
                bin: $0.bin.rawValue,
                jpeg: $0.jpeg,
                pitchDeg: $0.pitchDeg,
                rollDeg: $0.rollDeg
            )
        }
        let ocrLines = pendingLevelOCR
        let cardType = selectedCategory == .sports ? "SPORTS" : "TCG"
        Task {
            do {
                let report = try await JudgeAPIClient.shared.grade(
                    jpeg: levelJPEG,
                    baseURL: judgeServerURL,
                    name: automaticCardIdentifier,
                    cardType: cardType,
                    tilt: tilt,
                    ocrLines: ocrLines,
                    sweepFrames: sweepPayload,
                    scanId: pendingScanId
                )
                await MainActor.run {
                    isRemoteGrading = false
                    remoteGradeSummary = report.summaryText
                    sweepStatus = extras.isEmpty
                        ? "Uploaded first still."
                        : "Uploaded \(1 + extras.count) frames. SUR is still the level still."
                    if !report.ok {
                        lastRemoteError = "Server returned ok=false"
                    } else {
                        let ledger = JudgeAPIClient.ledger(from: report, clientScanId: pendingScanId)
                        pendingServerLedger = ledger
                        showingActiveScanReport = true
                    }
                }
            } catch {
                await MainActor.run {
                    isRemoteGrading = false
                    lastRemoteError = error.localizedDescription
                }
            }
        }
    }
    private func executeGradingPipeline() {
        if pendingServerLedger != nil {
            showingActiveScanReport = true
        } else {
            lastRemoteError = "No server grade yet. Use Capture to send this card to /api/grade."
        }
    }
    private func commitAndResetScan(ledger: ScanLedger) {
        portfolio.appendCard(from: ledger)
        resetCurrentScanState()
    }
    private func resetCurrentScanState() {
        scanResult = nil; pendingServerLedger = nil; pendingScanId = ""; isSaveConfirmed = false; isCardDetected = false; cardMissStreak = 0
        autoSurfaceScratches = 0; autoEdgeWhitening = 0; autoCornerFraying = 0
        // NEW: clear the multi-frame centering buffer so a new card (or a new scan of the
        // same card) starts averaging fresh rather than blending in stale samples.
        centeringAnalyzer.resetSampleBuffer()
        isCenteringStable = false
        centeringSampleCount = 0
        isAutoAdvancing = false
        currentPhase = .frontCentering
        automaticCardIdentifier = "unknown"
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
                        self.cardMissStreak += 1
                        guard self.cardMissStreak >= 3 else { return }
                        if self.isCardDetected { self.isCardDetected = false }
                        self.centeringAnalyzer.resetSampleBuffer()
                        self.isCenteringStable = false
                        self.centeringSampleCount = 0
                    }; return
                }
                let automatedDefects = defectAnalyzer.analyzeCardSurface(from: imageFrame)
                self.centeringAnalyzer.extractCardIdentifierText(from: imageFrame, cardBoundingBox: cardRect) { foundTextString in
                    Task { @MainActor in
                        if let serialCode = foundTextString, !serialCode.isEmpty {
                            self.automaticCardIdentifier = serialCode
                        } else if self.automaticCardIdentifier.isEmpty || self.automaticCardIdentifier == "Processing Viewport..." {
                            self.automaticCardIdentifier = "unknown"
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
                    self.cardMissStreak = 0
                    if !self.isCardDetected { self.isCardDetected = true }
                    if let computedCentering = computedCentering, currentPhase == .frontCentering {
                        self.scanResult = computedCentering
                        self.isCenteringStable = self.centeringAnalyzer.isStableReading
                        self.centeringSampleCount = self.centeringAnalyzer.currentSampleCount
                    }
                    // FIXED: these were placeholder `imageFrame.width % N` computations that
                    // had nothing to do with the actual card in frame. automatedDefects is
                    // already computed above from a real DefectAnalyzer pass over this exact
                    // frame — surfaceScratchCount and edgeWhiteningSeverity were already being
                    // used correctly elsewhere in this function; edgeWhiteningSeverity and the
                    // new cornerFrayingSeverity now feed these two phases the same way.
                    if currentPhase == .surfaceTiltSweep {
                        self.autoSurfaceScratches = automatedDefects.surfaceScratchCount
                        self.autoEdgeWhitening = automatedDefects.edgeWhiteningSeverity
                    } else if currentPhase == .cornerMacroCheck {
                        self.autoCornerFraying = automatedDefects.cornerFrayingSeverity
                    } else if currentPhase == .backPerimeter {
                        self.autoEdgeWhitening = automatedDefects.edgeWhiteningSeverity
                    }
                    // RE-ENABLED: auto-advance was temporarily disabled to allow screenshotting
                    // the locked diagnostic panel while chasing the axis-swap bug. The manual
                    // "Lock & Advance" button remains as a fallback either way (canAdvancePhase
                    // already requires isCenteringStable). isAutoAdvancing still guards against
                    // multiple in-flight frame-processing Tasks all seeing "stable" at once and
                    // firing the phase change more than once.
                    if currentPhase == .frontCentering && self.isCenteringStable && !self.isAutoAdvancing {
                        self.isAutoAdvancing = true
                        self.advanceInspectionFlowPipeline()
                    }
                }
            }
        }
    }
}
// MARK: - Shared ledger fields (report sheet and vault must match)
struct ScanLedgerRows: View {
    let ledger: ScanLedger

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(ledger.name).font(.title3).bold()
            Text(ledger.setName).font(.subheadline).foregroundColor(.secondary)
            Text("scan \(ledger.displayScanIdShort) · \(ledger.displayTimestamp)")
                .font(.system(.caption2, design: .monospaced))
                .foregroundColor(.secondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal)
        VStack(spacing: 12) {
            HStack {
                Text("Grade")
                Spacer()
                Text(ledger.displayGrade).bold().foregroundColor(.purple)
            }
            Divider()
            HStack {
                Text("L/R")
                Spacer()
                Text(ledger.lrCentering)
                    .font(.system(.footnote, design: .monospaced))
                    .lineLimit(1)
                    .minimumScaleFactor(0.7)
            }
            HStack {
                Text("T/B")
                Spacer()
                Text(ledger.tbCentering)
                    .font(.system(.footnote, design: .monospaced))
                    .lineLimit(1)
                    .minimumScaleFactor(0.7)
            }
            HStack {
                Text("Corners")
                Spacer()
                Text(ledger.displayCorners)
                    .font(.system(.footnote, design: .monospaced))
            }
            if let debugPath = ledger.debugPath, !debugPath.isEmpty {
                Text("Debug: \(debugPath)/")
                    .font(.system(.caption2, design: .monospaced))
                    .foregroundColor(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Divider()
            HStack {
                Text("Value")
                Spacer()
                Text(ledger.displayValue).bold().foregroundColor(.green)
            }
            if !ledger.subGradesLabel.isEmpty {
                Divider()
                Text(ledger.subGradesLabel)
                    .font(.system(.footnote, design: .monospaced))
                    .fixedSize(horizontal: false, vertical: true)
            }
            if !ledger.primaryFlaw.isEmpty {
                Text(ledger.primaryFlaw)
                    .font(.caption)
                    .foregroundColor(.secondary)
                    .italic()
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding()
        .background(Color(.secondarySystemBackground))
        .cornerRadius(12)
        .padding(.horizontal)
    }
}

struct VaultDetailSheet: View {
    let card: SavedCard
    @Environment(\.dismiss) var dismiss
    var body: some View {
        VStack(spacing: 20) {
            Capsule().fill(Color.secondary.opacity(0.2)).frame(width: 40, height: 6).padding(.top, 12)
            Text("VAULT RECORD AUDIT").font(.headline).bold().foregroundColor(.purple)
            ScanLedgerRows(ledger: card.asLedger)
            Button("Dismiss Audit Ledger") { dismiss() }
                .font(.subheadline).bold().foregroundColor(.secondary).padding()
            Spacer()
        }
    }
}

struct ActiveScanReportSheet: View {
    let ledger: ScanLedger
    let onCommit: () -> Void
    @Environment(\.dismiss) var dismiss
    var body: some View {
        VStack(spacing: 20) {
            Capsule().fill(Color.secondary.opacity(0.2)).frame(width: 40, height: 6).padding(.top, 12)
            Text("SERVER GRADE REPORT").font(.headline).bold().foregroundColor(.blue)
            ScanLedgerRows(ledger: ledger)
            Button(action: {
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
