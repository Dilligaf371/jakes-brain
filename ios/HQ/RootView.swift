import SwiftUI

struct RootView: View {
    enum Phase: Equatable {
        case locating
        case loaded(URL)
        case unreachable([URL])
    }

    /// Delay before the one automatic retry on a fresh install (see `startLocating`).
    private static let firstRunRetryDelay: Duration = .seconds(3)

    @EnvironmentObject private var activity: SceneActivity
    @State private var phase: Phase = .locating
    @State private var locator = ServerLocator()
    @State private var web = WebShellController()
    @State private var locateTask: Task<Void, Never>?
    @State private var autoRetried = false

    var body: some View {
        Group {
            switch phase {
            case .locating:
                VStack(spacing: 12) {
                    ProgressView()
                    Text("Finding the PC…")
                        .foregroundStyle(.secondary)
                }
            case .loaded(let url):
                // A main-frame load failure re-runs the locator rather than declaring the
                // PC unreachable: another candidate may answer (e.g. the page was loaded
                // over the LAN, the phone left home and Tailscale is on now).
                WebShell(url: url, controller: web, onUnreachable: startLocating)
                    .ignoresSafeArea()
            case .unreachable(let tried):
                UnreachableView(tried: tried, retry: startLocating)
            }
        }
        .task { startLocating() }
        .onChange(of: activity.foregroundReturns) { _, _ in
            returnedToForeground()
        }
    }

    /// Runs the locator; lands in `.loaded` or `.unreachable`.
    private func startLocating() {
        locateTask?.cancel()
        phase = .locating
        locateTask = Task {
            let found = await locator.locate()
            guard !Task.isCancelled else { return }
            if let found {
                phase = .loaded(found)
                return
            }
            phase = .unreachable(Config.allCandidates())

            // Fresh install only: the first LAN probe triggers the Local Network
            // permission alert, and iOS may deny it while the alert is on screen. One
            // automatic retry a few seconds later picks up the Allow without a tap.
            guard !autoRetried, Config.lastGoodURL() == nil else { return }
            autoRetried = true
            try? await Task.sleep(for: Self.firstRunRetryDelay)
            guard !Task.isCancelled else { return }
            startLocating()
        }
    }

    /// The app became active after being in the background.
    private func returnedToForeground() {
        switch phase {
        case .loaded:
            web.postForeground()
        case .unreachable:
            startLocating()
        case .locating:
            break
        }
    }
}
