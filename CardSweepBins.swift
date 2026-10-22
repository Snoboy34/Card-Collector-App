import Foundation

#if DEBUG
/// Passed in by the XCTest method. A failed check records a message there.
/// Contract checks must not call `assert`, `precondition`, `fatalError`, or force-unwrap.
typealias ContractCheck = (_ passed: Bool, _ message: String, _ file: StaticString, _ line: UInt) -> Void
#endif

/// Diagnostic surface-sweep bins, ported from `public/scan_level.js`
/// (`matchSweepBin`, `nextSweepBin`, `shouldGrabSweepBin`).
///
/// Contract (must stay in lockstep with the Node helpers):
///   - level still first, then pitch ±12° and roll ±12°
///   - bin tolerance 3.5°, off-axis max 4°, hold 250 ms
///   - +pitch → +Y (bottom tick), +roll → +X (right tick)
///
/// Extra frames are diagnostic only. `subGrades.surface` still comes from
/// the first (level) still on the Mac Judge.
enum CardSweepBins {
    static let targetDeg = 12.0
    static let holdMs = 250.0
    static let binToleranceDeg = 3.5
    static let offAxisMaxDeg = 4.0
    static let levelToleranceDeg = 1.5

    enum Bin: String, CaseIterable {
        case level
        case pitchPlus
        case pitchMinus
        case rollPlus
        case rollMinus

        var targetPitch: Double {
            switch self {
            case .level: return 0
            case .pitchPlus: return CardSweepBins.targetDeg
            case .pitchMinus: return -CardSweepBins.targetDeg
            case .rollPlus, .rollMinus: return 0
            }
        }

        var targetRoll: Double {
            switch self {
            case .level: return 0
            case .pitchPlus, .pitchMinus: return 0
            case .rollPlus: return CardSweepBins.targetDeg
            case .rollMinus: return -CardSweepBins.targetDeg
            }
        }

        var prompt: String {
            switch self {
            case .level:
                return "Hold level — first still"
            case .pitchPlus:
                return "Tip the top of the phone toward you until the dot hits the mark"
            case .pitchMinus:
                return "Tip the top of the phone away from you until the dot hits the mark"
            case .rollPlus:
                return "Tip the phone right until the dot hits the mark"
            case .rollMinus:
                return "Tip the phone left until the dot hits the mark"
            }
        }
    }

    static func isDeviceLevel(_ pitchDeg: Double, _ rollDeg: Double, toleranceDeg: Double = levelToleranceDeg) -> Bool {
        abs(pitchDeg) <= toleranceDeg && abs(rollDeg) <= toleranceDeg
    }

    static func matchSweepBin(
        pitchDeg: Double,
        rollDeg: Double,
        binToleranceDeg: Double = binToleranceDeg,
        offAxisMaxDeg: Double = offAxisMaxDeg,
        levelToleranceDeg: Double = levelToleranceDeg
    ) -> Bin? {
        if isDeviceLevel(pitchDeg, rollDeg, toleranceDeg: levelToleranceDeg) {
            return .level
        }
        let angled: [Bin] = [.pitchPlus, .pitchMinus, .rollPlus, .rollMinus]
        for bin in angled {
            let dPitch = abs(pitchDeg - bin.targetPitch)
            let dRoll = abs(rollDeg - bin.targetRoll)
            if bin.targetPitch != 0 && dPitch <= binToleranceDeg && abs(rollDeg) <= offAxisMaxDeg {
                return bin
            }
            if bin.targetRoll != 0 && dRoll <= binToleranceDeg && abs(pitchDeg) <= offAxisMaxDeg {
                return bin
            }
        }
        return nil
    }

    static func nextSweepBin(captured: [Bin]) -> Bin? {
        for bin in Bin.allCases where !captured.contains(bin) {
            return bin
        }
        return nil
    }

    static let expectedBins: [Bin] = [.level, .pitchPlus, .pitchMinus, .rollPlus, .rollMinus]

    static func summarize(bins: [String?]) -> (capturedBins: [Bin], complete: Bool) {
        var have = Set<Bin>()
        for raw in bins {
            if let raw, let bin = Bin(rawValue: raw) {
                have.insert(bin)
            }
        }
        let captured = expectedBins.filter { have.contains($0) }
        return (captured, captured.count == expectedBins.count)
    }

    static func shouldGrabSweepBin(
        inTargetBin: Bool,
        heldMs: Double,
        alreadyGrabbed: Bool,
        holdMs: Double = holdMs
    ) -> Bool {
        inTargetBin && !alreadyGrabbed && heldMs >= holdMs
    }

    #if DEBUG
    /// Same assertions as `scripts/verify_judge_math.js` sweep matcher checks.
    /// Arithmetic only: no camera and no motion hardware.
    static func runContractChecks(_ check: ContractCheck) {
        func expect(_ condition: @autoclosure () -> Bool, _ message: @autoclosure () -> String, file: StaticString = #filePath, line: UInt = #line) {
            check(condition(), message(), file, line)
        }
        expect(matchSweepBin(pitchDeg: 0.2, rollDeg: -0.4) == .level, "0.2° / -0.4° is the level bin")
        expect(matchSweepBin(pitchDeg: 12, rollDeg: 0.5) == .pitchPlus, "12° pitch is pitchPlus")
        expect(matchSweepBin(pitchDeg: -12, rollDeg: 0) == .pitchMinus, "-12° pitch is pitchMinus")
        expect(matchSweepBin(pitchDeg: 0.3, rollDeg: 12) == .rollPlus, "12° roll is rollPlus")
        expect(matchSweepBin(pitchDeg: 1, rollDeg: -12) == .rollMinus, "-12° roll is rollMinus")
        expect(matchSweepBin(pitchDeg: 12, rollDeg: 12) == nil, "pitch and roll together match no bin")
        expect(matchSweepBin(pitchDeg: 6, rollDeg: 0) == nil, "6° pitch is between bins")
        expect(nextSweepBin(captured: [.level])?.rawValue == "pitchPlus", "after level the next bin is pitchPlus")
        expect(shouldGrabSweepBin(inTargetBin: true, heldMs: 250, alreadyGrabbed: false), "250 ms in the bin grabs")
        expect(!shouldGrabSweepBin(inTargetBin: true, heldMs: 200, alreadyGrabbed: false), "200 ms in the bin waits")
        let partial = summarize(bins: ["level", "pitchPlus", "unknown"])
        expect(partial.complete == false, "two bins are not a complete sweep")
        expect(partial.capturedBins.map(\.rawValue) == ["level", "pitchPlus"], "partial sweep keeps level then pitchPlus")
        let full = summarize(bins: ["rollMinus", "level", "pitchPlus", "rollPlus", "pitchMinus"])
        expect(full.complete, "five bins complete the sweep")
        expect(full.capturedBins.map(\.rawValue) == ["level", "pitchPlus", "pitchMinus", "rollPlus", "rollMinus"], "a full sweep is stored in capture order")
    }
    #endif
}
