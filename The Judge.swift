import Foundation

// MARK: - Explicit Structural Defect Parameters
public struct SurfaceDefects: Sendable {
    public let scratchCount: Int
    public let dimpleOrDentCount: Int
    public let surfaceCreaseDetected: Bool
    public let wrinkleOrCreaseSeverity: Int // 0 to 5 scale
}

public struct CornerDefects: Sendable {
    public let topLeftFrayingSeverity: Int     // 0 to 5 scale
    public let topRightFrayingSeverity: Int    // 0 to 5 scale
    public let bottomLeftFrayingSeverity: Int  // 0 to 5 scale
    public let bottomRightFrayingSeverity: Int // 0 to 5 scale
}

public struct CalculatedGrade: Sendable {
    public let finalScore: Double
    public let primaryFlawDescription: String
    public let subGradesLabel: String
    public var isGemMint: Bool { finalScore >= 9.5 }
}

public class TheJudge {

    public init() {}

    /// Fully automated real-world evaluation engine computing structural multi-phase inspection results
    public func evaluateMultiPhaseCondition(
        centering: CenteringResult,
        surface: SurfaceDefects,
        edgesWhiteningCount: Int,
        corners: CornerDefects
    ) -> CalculatedGrade {

        // 1. PHASE 1: CENTERING SUB-GRADE (PSA & BGS Tolerances Matrix)
        let lrDiff = abs(centering.leftRightRatio.left - centering.leftRightRatio.right)
        let tbDiff = abs(centering.topBottomRatio.top - centering.topBottomRatio.bottom)
        let maxCenteringDeviation = max(lrDiff, tbDiff)

        let centeringScore: Double
        if maxCenteringDeviation <= 2.0 { centeringScore = 10.0 }       // Perfect 50/50 tracking
        else if maxCenteringDeviation <= 4.0 { centeringScore = 9.5 }  // BGS Pristine Threshold
        else if maxCenteringDeviation <= 9.0 { centeringScore = 9.0 }  // PSA 10 Strict Bound Target
        else if maxCenteringDeviation <= 14.0 { centeringScore = 8.0 } // Near Mint 8 Track
        else if maxCenteringDeviation <= 20.0 { centeringScore = 7.0 } 
        else { centeringScore = 5.0 }

        // 2. PHASE 2: SURFACE SUB-GRADE (Tilt Reflective Video Stream Analysis)
        var surfaceScore = 10.0

        // Minor print clearcoat surface scratches penalization
        if surface.scratchCount == 1 { surfaceScore -= 0.5 }
        else if surface.scratchCount > 1 { surfaceScore -= Double(surface.scratchCount) * 0.5 }

        // Volumetric dimples or print dots dent tracking penalization
        if surface.dimpleOrDentCount > 0 { surfaceScore -= Double(surface.dimpleOrDentCount) * 1.0 }

        // KILL SWITCH: If a physical card wrinkle or cardboard crease is isolated, it breaks structural safety
        if surface.surfaceCreaseDetected || surface.wrinkleOrCreaseSeverity >= 2 {
            let creasePenalty = Double(max(2, surface.wrinkleOrCreaseSeverity)) * 1.5
            surfaceScore -= creasePenalty
        }
        let finalSurfaceScore = max(1.0, surfaceScore)

        // 3. PHASE 3: EDGES SUB-GRADE (Back Perimeter Silvering Analysis)
        let edgeScore: Double
        if edgesWhiteningCount == 0 { edgeScore = 10.0 }
        else if edgesWhiteningCount == 1 { edgeScore = 9.0 } // Drops immediately out of Gem Mint bounds
        else if edgesWhiteningCount <= 3 { edgeScore = 8.0 }
        else { edgeScore = 5.0 }

        // 4. PHASE 4: CORNERS SUB-GRADE (High-Res 4-Point Macro Curvature Check)
        let absoluteMaxCornerFray = max(
            corners.topLeftFrayingSeverity,
            corners.topRightFrayingSeverity,
            corners.bottomLeftFrayingSeverity,
            corners.bottomRightFrayingSeverity
        )

        let cornerScore: Double
        if absoluteMaxCornerFray == 0 { cornerScore = 10.0 }
        else if absoluteMaxCornerFray == 1 { cornerScore = 9.0 }  // Light corner softening
        else if absoluteMaxCornerFray == 2 { cornerScore = 8.0 }  // Distinct rounding wear
        else if absoluteMaxCornerFray == 3 { cornerScore = 6.5 }  // Layer splitting / paper lifting
        else { cornerScore = 4.0 }

        // 5. THE STRICT REAL-WORLD GRADE CEILING ENFORCEMENT RULES
        // Real-world laboratories utilize strict sub-grade capping policies.
        // A card cannot receive a final grade higher than 0.5 points above its lowest sub-grade score.
        let subGradesList = [centeringScore, finalSurfaceScore, edgeScore, cornerScore]
        let lowestIsolatedSubGrade = subGradesList.min() ?? 1.0
        let overallMathematicalAverage = subGradesList.reduce(0.0, +) / 4.0

        let absoluteConditionCeilingLimit = lowestIsolatedSubGrade + 0.5
        let strictCalculatedFinalGrade = min(overallMathematicalAverage, absoluteConditionCeilingLimit)

        // Format explicit condition description readout logs
        let flawExplanation: String
        if strictCalculatedFinalGrade >= 9.5 {
            flawExplanation = "Gem Mint Compliance Locked. Reflective light sweeps verify zero surface dent fracture lines or micro-creases."
        } else if surface.surfaceCreaseDetected || surface.wrinkleOrCreaseSeverity >= 2 {
            flawExplanation = "Capped Condition Grade. Volumetric frame processing tracked structural cardboard crease lines or soft wrinkles."
        } else if absoluteMaxCornerFray >= 3 {
            flawExplanation = "Pristine criteria broken due to corner layer separation or localized card paper splitting."
        } else if finalSurfaceScore <= 8.5 {
            flawExplanation = "Surface grade lowered due to clearcoat micro-scratch clusters or background indentation dimples."
        } else if centeringScore <= 8.5 {
            flawExplanation = "Border aspect alignment variation exceeds premium limits. Outer perimeter matrix out of tolerance."
        } else {
            flawExplanation = "Perimeter edge tracking isolated card border silvering or whitening chipping down back line."
        }

        // Round cleanly to standard 0.5 grade step boundaries matching real lab scales
        let roundedFinalGrade = (strictCalculatedFinalGrade * 2.0).rounded() / 2.0
        let cappedFinalGrade = min(10.0, max(1.0, roundedFinalGrade))

        let subGradesDisplayLabel = String(
            format: "CEN: %.1f | SUR: %.1f | EDG: %.1f | CRN: %.1f",
            centeringScore, finalSurfaceScore, edgeScore, cornerScore
        )

        return CalculatedGrade(
            finalScore: cappedFinalGrade,
            primaryFlawDescription: flawExplanation,
            subGradesLabel: subGradesDisplayLabel
        )
    }
}
