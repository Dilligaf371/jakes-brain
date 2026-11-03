import Foundation
import WebKit

/// Native uploads and reminders use the same session as the embedded app. Cookies are
/// read from WebKit only for the configured HTTPS origin, never from URLSession's jar.
enum NativeHTTP {
    private static let redirects = RejectRedirects()
    static let session: URLSession = {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.httpCookieStorage = nil
        configuration.httpShouldSetCookies = false
        configuration.urlCache = nil
        return URLSession(configuration: configuration, delegate: redirects, delegateQueue: nil)
    }()

    @MainActor
    static func request(to url: URL, webView: WKWebView) async throws -> URLRequest {
        guard Config.isAppURL(url), let page = webView.url, Config.isAppURL(page) else {
            throw URLError(.unsupportedURL)
        }
        let cookies = await webView.configuration.websiteDataStore.httpCookieStore.allCookies()
        var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData)
        Config.addTransportHeaders(to: &request)
        request.setValue(Config.origin.absoluteString, forHTTPHeaderField: "Origin")
        let matched = cookies.filter { cookieMatches($0, url: url) }
            .sorted { $0.path.count > $1.path.count }
        for (name, value) in HTTPCookie.requestHeaderFields(with: matched) {
            request.setValue(value, forHTTPHeaderField: name)
        }
        return request
    }

    static func cookieMatches(_ cookie: HTTPCookie, url: URL, now: Date = Date()) -> Bool {
        guard Config.isAppURL(url), cookie.expiresDate.map({ $0 > now }) ?? true,
              !cookie.isSecure || url.scheme?.lowercased() == "https",
              let host = url.host?.lowercased() else { return false }
        let domain = cookie.domain.lowercased()
        let bareDomain = domain.hasPrefix(".") ? String(domain.dropFirst()) : domain
        guard host == bareDomain || (domain.hasPrefix(".") && host.hasSuffix("." + bareDomain)) else { return false }
        let path = url.path.isEmpty ? "/" : url.path
        return path == cookie.path || (path.hasPrefix(cookie.path)
            && (cookie.path.hasSuffix("/") || path.dropFirst(cookie.path.count).hasPrefix("/")))
    }

    private final class RejectRedirects: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
        func urlSession(_ session: URLSession, task: URLSessionTask,
                        willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest,
                        completionHandler: @escaping (URLRequest?) -> Void) {
            // APIs do not redirect. Never forward a cookie, pairing token, or recording.
            completionHandler(nil)
        }
    }
}

/// The installer may supply a short-lived, single-use token in the process environment.
/// Redeem it before loading the page, then keep only the normal HttpOnly WebKit cookie.
@MainActor
enum OwnerPairing {
    private static var attempted = false

    static func prepare(_ store: WKHTTPCookieStore) async {
        guard !attempted else { return }
        attempted = true
        guard let token = ProcessInfo.processInfo.environment["JAKESDATA_PAIRING_TOKEN"],
              !token.isEmpty else { return }
        var request = URLRequest(url: Config.origin.appendingPathComponent("app-pair"))
        request.httpMethod = "POST"
        request.timeoutInterval = 20
        Config.addTransportHeaders(to: &request)
        request.setValue(Config.origin.absoluteString, forHTTPHeaderField: "Origin")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try? JSONSerialization.data(withJSONObject: ["token": token])
        guard let (_, response) = try? await NativeHTTP.session.data(for: request),
              let http = response as? HTTPURLResponse, http.statusCode == 200,
              let url = http.url, Config.isAppURL(url) else { return }
        var fields: [String: String] = [:]
        for (key, value) in http.allHeaderFields {
            if let key = key as? String { fields[key] = String(describing: value) }
        }
        for cookie in HTTPCookie.cookies(withResponseHeaderFields: fields, for: url)
            where cookie.name == "__Host-jakesbrain" && cookie.isSecure && cookie.isHTTPOnly
                && cookie.path == "/" && cookie.domain.lowercased() == Config.origin.host?.lowercased() {
            await store.setCookie(cookie)
        }
    }
}
