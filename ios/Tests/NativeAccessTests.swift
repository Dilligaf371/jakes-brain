import XCTest
import WebKit
@testable import JakesData

final class NativeAccessTests: XCTestCase {
    func testPublicOriginRejectsPrivateAndLookalikeOrigins() {
        XCTAssertTrue(Config.isAppURL(Config.origin.appendingPathComponent("api/voice/upload")))
        for address in [
            "http://100.106.249.89:4800", "http://192.168.1.81:4800",
            "http://nonpertinent-striped-deandre.ngrok-free.dev",
            "https://nonpertinent-striped-deandre.ngrok-free.dev.evil.example",
            "https://nonpertinent-striped-deandre.ngrok-free.dev:444",
            "https://owner@nonpertinent-striped-deandre.ngrok-free.dev"
        ] {
            XCTAssertFalse(Config.isAppURL(URL(string: address)!), address)
        }
        XCTAssertEqual(Config.allCandidates(), [Config.origin])
    }

    func testCookiesRespectOriginPathExpiryAndSecureTransport() {
        let api = Config.origin.appendingPathComponent("api/voice/upload")
        XCTAssertTrue(NativeHTTP.cookieMatches(cookie(path: "/"), url: api))
        XCTAssertTrue(NativeHTTP.cookieMatches(cookie(path: "/api"), url: api))
        XCTAssertFalse(NativeHTTP.cookieMatches(cookie(path: "/ap"), url: api))
        XCTAssertFalse(NativeHTTP.cookieMatches(cookie(path: "/api/reminders"), url: api))
        XCTAssertFalse(NativeHTTP.cookieMatches(cookie(domain: "evil.example"), url: api))
        XCTAssertFalse(NativeHTTP.cookieMatches(cookie(expires: Date(timeIntervalSince1970: 1)), url: api))
        XCTAssertFalse(NativeHTTP.cookieMatches(cookie(), url: URL(string: "https://evil.example/api")!))
        XCTAssertFalse(NativeHTTP.cookieMatches(cookie(), url: URL(string: "http://nonpertinent-striped-deandre.ngrok-free.dev/api")!))
    }

    func testPairingCookieParsesAsHostScopedHttpOnlySession() {
        let fields = ["Set-Cookie": "__Host-jakesbrain=test-only; Path=/; Max-Age=7776000; Secure; HttpOnly; SameSite=Lax"]
        let cookie = HTTPCookie.cookies(withResponseHeaderFields: fields, for: Config.origin)[0]
        XCTAssertEqual(cookie.domain.lowercased(), Config.origin.host?.lowercased())
        XCTAssertEqual(cookie.path, "/")
        XCTAssertTrue(cookie.isHTTPOnly)
        XCTAssertTrue(cookie.isSecure)
        XCTAssertTrue(NativeHTTP.cookieMatches(cookie, url: Config.origin))
    }

    @MainActor
    func testNativeRequestsUseWebKitCookieAndOrigin() async throws {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        let webView = TrustedPage(frame: .zero, configuration: configuration)
        await configuration.websiteDataStore.httpCookieStore.setCookie(cookie())
        await configuration.websiteDataStore.httpCookieStore.setCookie(cookie(domain: "evil.example", name: "foreign"))
        let request = try await NativeHTTP.request(to: Config.origin.appendingPathComponent("api/reminders"), webView: webView)
        XCTAssertEqual(request.value(forHTTPHeaderField: "Origin"), Config.origin.absoluteString)
        XCTAssertEqual(request.value(forHTTPHeaderField: "User-Agent"), "JakeBrain/1.4")
        XCTAssertEqual(request.value(forHTTPHeaderField: "ngrok-skip-browser-warning"), "1")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Cookie"), "test-session=only-a-test")
        XCTAssertNil(NativeHTTP.session.configuration.httpCookieStorage)
    }

    @MainActor
    func testNativeRequestsRejectUntrustedDestinationAndPage() async {
        let webView = TrustedPage()
        do {
            _ = try await NativeHTTP.request(to: URL(string: "https://evil.example/upload")!, webView: webView)
            XCTFail("Foreign destination was accepted")
        } catch { }
        let untrusted = WKWebView()
        do {
            _ = try await NativeHTTP.request(to: Config.origin, webView: untrusted)
            XCTFail("Unknown page was accepted")
        } catch { }
    }

    private func cookie(domain: String = Config.origin.host!, path: String = "/", name: String = "test-session",
                        expires: Date = Date().addingTimeInterval(3600)) -> HTTPCookie {
        HTTPCookie(properties: [.domain: domain, .path: path, .name: name, .value: "only-a-test",
                                .secure: "TRUE", .expires: expires])!
    }

    @MainActor
    private final class TrustedPage: WKWebView {
        override var url: URL? { Config.origin }
    }
}
