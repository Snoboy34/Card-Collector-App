import Foundation
import CoreMotion
import Combine
import AVFoundation
import AudioToolbox

@MainActor
public final class CameraCalibration: ObservableObject {

    @Published public var currentPitch: Double = 0.0
    @Published public var currentRoll: Double = 0.0
    @Published public var isPerfectlyLevel: Bool = false
    @Published public var isMotionAvailable: Bool = false

    private let motionManager = CMMotionManager()
    private let updateInterval: TimeInterval = 0.05
    private let maximumAllowedDeviation: Double = 1.5
    private let smoothSampleCount = 5
    private let publishEpsilon = 0.08
    private var pitchSamples: [Double] = []
    private var rollSamples: [Double] = []

    private var confirmationAudioPlayer: AVAudioPlayer?

    public init() {}

    /// Gravity-relative pitch/roll for a phone held screen-up over the mat
    /// (rear camera pointing down). 0/0 = parallel to the table.
    public static func tiltFromGravity(x: Double, y: Double, z: Double) -> (pitch: Double, roll: Double) {
        let pitch = atan2(y, -z) * (180.0 / .pi)
        let roll = atan2(x, -z) * (180.0 / .pi)
        return (pitch, roll)
    }

    public static func smoothedMean(_ buffer: [Double], next: Double, maxN: Int) -> (samples: [Double], mean: Double) {
        var nextBuffer = buffer
        nextBuffer.append(next)
        if nextBuffer.count > maxN {
            nextBuffer = Array(nextBuffer.suffix(maxN))
        }
        let mean = nextBuffer.reduce(0, +) / Double(nextBuffer.count)
        return (nextBuffer, mean)
    }

    /// Commences high-frequency gyroscope monitoring to enforce leveling rules
    public func startDeviceLevelMonitoring() {
        isMotionAvailable = motionManager.isDeviceMotionAvailable
        guard isMotionAvailable else { return }

        motionManager.deviceMotionUpdateInterval = updateInterval
        motionManager.startDeviceMotionUpdates(to: .main) { [weak self] motionData, error in
            guard let data = motionData else { return }
            let gravityTilt = CameraCalibration.tiltFromGravity(
                x: data.gravity.x,
                y: data.gravity.y,
                z: data.gravity.z
            )
            Task { @MainActor in
                guard let self else { return }
                let smoothedPitch = CameraCalibration.smoothedMean(self.pitchSamples, next: gravityTilt.pitch, maxN: self.smoothSampleCount)
                let smoothedRoll = CameraCalibration.smoothedMean(self.rollSamples, next: gravityTilt.roll, maxN: self.smoothSampleCount)
                self.pitchSamples = smoothedPitch.samples
                self.rollSamples = smoothedRoll.samples

                let pitchDegrees = smoothedPitch.mean
                let rollDegrees = smoothedRoll.mean
                let pitchDelta = abs(pitchDegrees - self.currentPitch)
                let rollDelta = abs(rollDegrees - self.currentRoll)
                guard pitchDelta >= self.publishEpsilon || rollDelta >= self.publishEpsilon || self.pitchSamples.count < self.smoothSampleCount else {
                    return
                }

                self.currentPitch = pitchDegrees
                self.currentRoll = rollDegrees
                self.isPerfectlyLevel = abs(pitchDegrees) <= self.maximumAllowedDeviation
                    && abs(rollDegrees) <= self.maximumAllowedDeviation
            }
        }
    }

    /// Releases CoreMotion resources to maximize hardware battery lifecycle
    public func stopDeviceLevelMonitoring() {
        if motionManager.isDeviceMotionActive {
            motionManager.stopDeviceMotionUpdates()
        }
        pitchSamples = []
        rollSamples = []
    }

    public func playSuccessChirp() {
        AudioServicesPlaySystemSound(1108)
    }

    #if DEBUG
    public static func runContractChecks() {
        let level = tiltFromGravity(x: 0, y: 0, z: -1)
        precondition(abs(level.pitch) < 0.01 && abs(level.roll) < 0.01)
        let first = smoothedMean([], next: 10, maxN: 5)
        let second = smoothedMean(first.samples, next: 0, maxN: 5)
        precondition(abs(second.mean - 5) < 0.001)
    }
    #endif
}
