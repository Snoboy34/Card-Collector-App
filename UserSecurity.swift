import Foundation
import LocalAuthentication
import SwiftUI

public class UserSecurity: ObservableObject {

    @Published public var isVaultUnlocked: Bool = false
    @Published public var securityErrorMessage: String?

    public init() {}

    /// Requests device authentication (biometrics if available, falling back to device passcode) to unlock the vault
    public func authenticateCollectorVault() {
        let context = LAContext()
        var structuralError: NSError?

        // FIXED: try biometrics first, but fall back to device passcode instead of
        // unlocking automatically when biometrics aren't available. Using
        // .deviceOwnerAuthentication (not ...WithBiometrics) lets the system
        // offer the passcode as a fallback on its own.
        if context.canEvaluatePolicy(.deviceOwnerAuthentication, error: &structuralError) {
            let unlockReasonText = "Authorize access to unlock your high-value portfolio collection vault."

            context.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: unlockReasonText) { success, authenticationError in
                Task { @MainActor in
                    if success {
                        self.isVaultUnlocked = true
                        self.securityErrorMessage = nil
                    } else {
                        // FIXED: no longer unlocks on failure — stays locked and shows the real error
                        self.isVaultUnlocked = false
                        self.securityErrorMessage = authenticationError?.localizedDescription ?? "Authentication was not completed."
                    }
                }
            }
        } else {
            // FIXED: if the device genuinely has no authentication method set up at all
            // (no biometrics AND no passcode configured), stay locked and explain why,
            // rather than unlocking automatically.
            Task { @MainActor in
                self.isVaultUnlocked = false
                self.securityErrorMessage = "No device passcode or biometrics are set up. Please set a passcode in Settings to use the vault."
            }
        }
    }

    /// Instantly locks down access controls upon backgrounding transitions
    public func enforceVaultLockdown() {
        self.isVaultUnlocked = false
    }
}

// Satisfy Swift Playgrounds compiler target architecture parameters
struct UserSecurity_Previews: PreviewProvider {
    static var previews: some View {
        Text("User Security Vault Module Live")
            .foregroundColor(.secondary)
            .padding()
    }
}
