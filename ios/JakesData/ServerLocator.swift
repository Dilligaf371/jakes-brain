import Foundation

/// Checks the public gateway without a session. Health exposes no account data.
actor ServerLocator {
    func locate() async -> URL? {
        var request = URLRequest(
            url: Config.origin.appendingPathComponent("api/health"),
            cachePolicy: .reloadIgnoringLocalCacheData,
            timeoutInterval: Config.healthTimeout
        )
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        Config.addTransportHeaders(to: &request)
        do {
            let (data, response) = try await NativeHTTP.session.data(for: request)
            guard !Task.isCancelled,
                  let http = response as? HTTPURLResponse, http.statusCode == 200,
                  let finalURL = http.url, Config.isAppURL(finalURL),
                  let json = try JSONSerialization.jsonObject(with: data) as? [String: Any],
                  json["ok"] as? Bool == true else { return nil }
            return Config.origin
        } catch {
            return nil
        }
    }
}
