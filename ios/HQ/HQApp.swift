import SwiftUI

@main
struct HQApp: App {
    @Environment(\.scenePhase) private var scenePhase
    @StateObject private var activity = SceneActivity()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(activity)
        }
        .onChange(of: scenePhase) { _, newPhase in
            activity.scenePhaseChanged(to: newPhase)
        }
    }
}

/// Turns raw `scenePhase` changes into the one signal `RootView` cares about:
/// "the app just became active again after being in the background".
@MainActor
final class SceneActivity: ObservableObject {
    /// Increments every time the scene becomes `.active` after having been `.background`.
    @Published private(set) var foregroundReturns = 0
    private var wasInBackground = false

    func scenePhaseChanged(to phase: ScenePhase) {
        switch phase {
        case .background:
            wasInBackground = true
        case .active:
            if wasInBackground {
                wasInBackground = false
                foregroundReturns += 1
            }
        case .inactive:
            break
        @unknown default:
            break
        }
    }
}
