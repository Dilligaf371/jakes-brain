import Foundation

/// Finds a reachable Jake's Data server.
///
/// Preference order: the `jakesdata.baseURL` override (if set), then the last URL that
/// answered (`jakesdata.lastGoodURL`), then the built-in candidates. Every URL is probed at
/// once so a dead preferred URL never delays a live one by a full timeout: a
/// preferred URL that answers healthy wins outright, and when a less-preferred URL
/// answers first the preferred ones get `preferredGrace` to catch up before it is
/// taken. Worst case is one `Config.healthTimeout`. The first `200` whose JSON says
/// `ok: true` wins and is remembered as last-good. Returns nil when nothing answers.
actor ServerLocator {
    /// How long a healthy lower-priority URL waits for a higher-priority one to answer.
    static let preferredGrace: Duration = .milliseconds(400)

    /// One probe session for the process: `RootView` re-creates its locator on
    /// re-render, so a per-instance session would be allocated and dropped each time.
    private static let session: URLSession = {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        configuration.urlCache = nil
        configuration.timeoutIntervalForRequest = Config.healthTimeout
        configuration.timeoutIntervalForResource = Config.healthTimeout
        configuration.waitsForConnectivity = false
        return URLSession(configuration: configuration)
    }()

    private let defaults: UserDefaults

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
    }

    /// The first base URL that answers `/api/health`, or nil if none does.
    func locate() async -> URL? {
        let ranked = rankedCandidates()
        guard !ranked.isEmpty, !Task.isCancelled else { return nil }
        guard let winner = await firstHealthy(of: ranked) else { return nil }
        remember(winner)
        return winner
    }

    // MARK: - Internals

    /// A URL to probe and its priority; lower rank is preferred.
    private struct Candidate: Sendable {
        let url: URL
        let rank: Int
    }

    private enum Probe: Sendable {
        case answered(Candidate, healthy: Bool)
        case graceExpired
    }

    /// Override = 0, last-good = next, the built-in candidates share the rank after
    /// that. No duplicates, so nothing is probed twice.
    private func rankedCandidates() -> [Candidate] {
        var preferred: [URL] = []
        if let override = Config.overrideURL(in: defaults) {
            preferred.append(override)
        }
        if let last = Config.lastGoodURL(in: defaults), !preferred.contains(last) {
            preferred.append(last)
        }
        var ranked = preferred.enumerated().map { Candidate(url: $0.element, rank: $0.offset) }
        for url in Config.allCandidates(in: defaults) where !preferred.contains(url) {
            ranked.append(Candidate(url: url, rank: preferred.count))
        }
        return ranked
    }

    private func remember(_ url: URL) {
        defaults.set(url.absoluteString, forKey: Config.lastGoodURLKey)
    }

    /// Probes every candidate concurrently and returns the best healthy one, cancelling
    /// the rest. "Best" is the lowest rank; a healthy answer is taken as soon as no
    /// lower-ranked probe is still pending, or once `preferredGrace` has passed since the
    /// first healthy answer.
    private func firstHealthy(of candidates: [Candidate]) async -> URL? {
        await withTaskGroup(of: Probe.self) { group in
            for candidate in candidates {
                group.addTask { .answered(candidate, healthy: await self.isHealthy(candidate.url)) }
            }
            var pendingRanks = Dictionary(uniqueKeysWithValues: candidates.map { ($0.url, $0.rank) })
            var best: Candidate?
            var graceStarted = false

            for await probe in group {
                var graceExpired = false
                switch probe {
                case .answered(let candidate, let healthy):
                    pendingRanks[candidate.url] = nil
                    if healthy, candidate.rank < (best?.rank ?? Int.max) {
                        best = candidate
                    }
                case .graceExpired:
                    graceExpired = true
                }
                guard let current = best else { continue }

                let betterStillPending = pendingRanks.values.contains { $0 < current.rank }
                if graceExpired || !betterStillPending {
                    group.cancelAll()
                    return current.url
                }
                if !graceStarted {
                    graceStarted = true
                    group.addTask {
                        try? await Task.sleep(for: Self.preferredGrace)
                        return .graceExpired
                    }
                }
            }
            return best?.url
        }
    }

    /// One GET to `<base>/api/health`. True only for a 200 whose JSON has `ok == true`.
    private func isHealthy(_ base: URL) async -> Bool {
        guard let url = URL(string: Config.healthPath, relativeTo: base)?.absoluteURL else {
            return false
        }
        var request = URLRequest(
            url: url,
            cachePolicy: .reloadIgnoringLocalCacheData,
            timeoutInterval: Config.healthTimeout
        )
        request.httpMethod = "GET"
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        do {
            let (data, response) = try await Self.session.data(for: request)
            guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
                return false
            }
            let json = try JSONSerialization.jsonObject(with: data) as? [String: Any]
            return json?["ok"] as? Bool == true
        } catch {
            return false
        }
    }
}
