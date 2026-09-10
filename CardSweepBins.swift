import Foundation

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

    static func shouldGrabSweepBin(
        inTargetBin: Bool,
        heldMs: Double,
        alreadyGrabbed: Bool,
        holdMs: Double = holdMs
    ) -> Bool {
        inTargetBin && !alreadyGrabbed && heldMs >= holdMs
    }

    /// Same assertions as `scripts/verify_judge_math.js` sweep matcher checks.
    static func runContractChecks() {
        precondition(matchSweepBin(pitchDeg: 0.2, rollDeg: -0.4) == .level)
        precondition(matchSweepBin(pitchDeg: 12, rollDeg: 0.5) == .pitchPlus)
        precondition(matchSweepBin(pitchDeg: -12, rollDeg: 0) == .pitchMinus)
        precondition(matchSweepBin(pitchDeg: 0.3, rollDeg: 12) == .rollPlus)
        precondition(matchSweepBin(pitchDeg: 1, rollDeg: -12) == .rollMinus)
        precondition(matchSweepBin(pitchDeg: 12, rollDeg: 12) == nil)
        precondition(matchSweepBin(pitchDeg: 6, rollDeg: 0) == nil)
        precondition(nextSweepBin(captured: [.level])?.rawValue == "pitchPlus")
        precondition(shouldGrabSweepBin(inTargetBin: true, heldMs: 250, alreadyGrabbed: false))
        precondition(!shouldGrabSweepBin(inTargetBin: true, heldMs: 200, alreadyGrabbed: false))
    }
}
