import Foundation

enum Config {
    /// The PC over Tailscale — works anywhere once Tailscale is on the phone.
    static let tailscale = URL(string: "http://100.106.249.89:4800")!
    /// The PC on the home LAN.
    static let lan = URL(string: "http://192.168.1.81:4800")!
    /// Base URLs to try, in order.
    static let candidates: [URL] = [tailscale, lan]

    static let healthPath = "/api/health"
    static let healthTimeout: TimeInterval = 2.5

    /// UserDefaults key. A string URL that, when set, is tried before everything else.
    static let baseURLOverrideKey = "hq.baseURL"
    /// UserDefaults key. The last base URL whose health check passed.
    static let lastGoodURLKey = "hq.lastGoodURL"

    /// The `hq.baseURL` override, if set and it parses as an http(s) URL.
    static func overrideURL(in defaults: UserDefaults = .standard) -> URL? {
        url(forKey: baseURLOverrideKey, in: defaults)
    }

    /// The last base URL that answered `/api/health`, if any.
    static func lastGoodURL(in defaults: UserDefaults = .standard) -> URL? {
        url(forKey: lastGoodURLKey, in: defaults)
    }

    /// Every base URL the locator may try, in priority order and without duplicates:
    /// the override (when set) followed by `candidates`.
    static func allCandidates(in defaults: UserDefaults = .standard) -> [URL] {
        var seen = Set<URL>()
        let ordered = [overrideURL(in: defaults)].compactMap { $0 } + candidates
        return ordered.filter { seen.insert($0).inserted }
    }

    private static func url(forKey key: String, in defaults: UserDefaults) -> URL? {
        guard let raw = defaults.string(forKey: key)?
                .trimmingCharacters(in: .whitespacesAndNewlines),
              !raw.isEmpty,
              let url = URL(string: raw),
              let scheme = url.scheme?.lowercased(),
              scheme == "http" || scheme == "https",
              url.host() != nil
        else { return nil }
        return url
    }
}
