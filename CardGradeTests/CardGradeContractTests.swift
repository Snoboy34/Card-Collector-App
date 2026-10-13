import XCTest
@testable import CardGrade

/// Contract checks that used to run when the scan screen appeared.
/// Xcode Cloud runs this target from the CardGrade scheme's Test action.
/// A failed check is an XCTAssert message. Nothing here calls assert,
/// precondition, fatalError, or a force unwrap.
@MainActor
final class CardGradeContractTests: XCTestCase {
    private func report(_ passed: Bool, _ message: String, file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertTrue(passed, message, file: file, line: line)
    }

    func testCenteringAssistContract() {
        #if DEBUG
        CenteringAssist.runContractChecks { passed, message, file, line in
            self.report(passed, message, file: file, line: line)
        }
        #else
        XCTFail("Centering assist checks are part of the Debug app")
        #endif
    }

    func testCaptureContracts() {
        #if DEBUG
        // Each of these checks is arithmetic or a payload built from fixture
        // bytes. None opens a camera or starts device motion, so the simulator
        // runs all of them. A check that needs the camera belongs behind
        // XCTSkip("needs a camera") and nowhere else.
        let report: ContractCheck = { passed, message, file, line in
            self.report(passed, message, file: file, line: line)
        }
        CardSweepBins.runContractChecks(report)
        CameraCalibration.runContractChecks(report)
        CompactScanLayout.runContractChecks(report)
        CaptureMetadata.runContractChecks(report)
        JudgeAPIClient.runContractChecks(report)
        #else
        XCTFail("Capture checks are part of the Debug app")
        #endif
    }
}
