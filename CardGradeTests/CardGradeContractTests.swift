import XCTest
@testable import CardGrade

/// Contract checks that used to run when the scan screen appeared.
/// Xcode Cloud runs this target from the CardGrade scheme's Test action.
@MainActor
final class CardGradeContractTests: XCTestCase {
    func testCenteringAssistContract() {
        #if DEBUG
        CenteringAssist.runContractChecks()
        #else
        XCTFail("Centering assist checks are part of the Debug app")
        #endif
    }

    func testCaptureContracts() {
        #if DEBUG
        CardSweepBins.runContractChecks()
        CameraCalibration.runContractChecks()
        CompactScanLayout.runContractChecks()
        CaptureMetadata.runContractChecks()
        JudgeAPIClient.runContractChecks()
        #else
        XCTFail("Capture checks are part of the Debug app")
        #endif
    }
}
