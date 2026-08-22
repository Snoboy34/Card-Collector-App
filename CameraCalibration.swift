import Foundation
import CoreMotion
import Combine
import AVFoundation

@MainActor 
public final class CameraCalibration: ObservableObject {

    @Published public var currentPitch: Double = 0.0
    @Published public var currentRoll: Double = 0.0
    @Published public var isPerfectlyLevel: Bool = false

    private let motionManager = CMMotionManager()
    private let updateInterval: TimeInterval = 0.1
    private let maximumAllowedDeviation: Double = 1.5

    // NEW: System Audio Playback Instance Anchor
    private var confirmationAudioPlayer: AVAudioPlayer?

    public init() {}

    /// Commences high-frequency gyroscope monitoring to enforce leveling rules
    public func startDeviceLevelMonitoring() {
        guard motionManager.isDeviceMotionAvailable else { return }

        motionManager.deviceMotionUpdateInterval = updateInterval
        motionManager.startDeviceMotionUpdates(to: .main) { [weak self] motionData, error in
            guard let self = self, let data = motionData else { return }

            let pitchDegrees = data.attitude.pitch * (180.0 / .pi)
            let rollDegrees = data.attitude.roll * (180.0 / .pi)

            Task { @MainActor in
                self.currentPitch = pitchDegrees
                self.currentRoll = rollDegrees

                let isPitchValid = abs(pitchDegrees) <= self.maximumAllowedDeviation
                let isRollValid = abs(rollDegrees) <= self.maximumAllowedDeviation
                self.isPerfectlyLevel = isPitchValid && isRollValid
            }
        }
    }

    /// Releases CoreMotion resources to maximize hardware battery lifecycle
    public func stopDeviceLevelMonitoring() {
        if motionManager.isDeviceMotionActive {
            motionManager.stopDeviceMotionUpdates()
        }
    }

    // NEW: Fires off a professional electronic scan chirp using native system beeps
    public func playSuccessChirp() {
        // We trigger iOS system sound ID 1108 (the crisp electronic camera focus chirp)
        // This removes the need to bundle raw audio files, keeping your app under 1MB
        AudioServicesPlaySystemSound(1108)
    }
}
