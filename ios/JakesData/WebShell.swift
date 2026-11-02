import SwiftUI
import WebKit

/// Native-side handle onto the live web view. Owned by `RootView`, filled in by `WebShell`.
@MainActor
final class WebShellController {
    fileprivate weak var webView: WKWebView?
    /// True once the current page has finished loading.
    fileprivate(set) var isPageLoaded = false

    /// Tells the page the app is back in the foreground (it refetches status + version).
    func postForeground() {
        guard isPageLoaded, let webView else { return }
        webView.evaluateJavaScript("window.dispatchEvent(new Event('jakesdata:foreground'))") { _, _ in }
    }
}

/// `WKWebView` wrapper. The web view is created once; `updateUIView` only loads when the
/// URL actually changes, so SwiftUI re-renders never trigger reloads.
struct WebShell: UIViewRepresentable {
    let url: URL
    let controller: WebShellController
    /// Called when the main frame fails to load because of a network error. `RootView`
    /// answers by re-running the locator, so this must be safe to call while the web
    /// view is being torn down.
    let onUnreachable: () -> Void

    static let messageHandlerName = "native"

    func makeCoordinator() -> Coordinator {
        Coordinator(self)
    }

    func makeUIView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.allowsInlineMediaPlayback = true          // <video playsinline> inside the page (JakeTube)
        configuration.mediaTypesRequiringUserActionForPlayback = []  // let the page start playback itself
        let content = WKUserContentController()
        content.add(WeakScriptMessageHandler(context.coordinator), name: Self.messageHandlerName)
        content.addUserScript(WKUserScript(
            source: Self.bridgeScript(),
            injectionTime: .atDocumentStart,
            forMainFrameOnly: true
        ))
        configuration.userContentController = content

        let webView = WKWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = context.coordinator
        webView.uiDelegate = context.coordinator
        webView.allowsBackForwardNavigationGestures = false
        webView.isOpaque = false
        webView.backgroundColor = .systemGroupedBackground
        webView.isInspectable = true
        webView.scrollView.contentInsetAdjustmentBehavior = .never // the web app handles safe areas
        webView.scrollView.bounces = true

        let refresh = UIRefreshControl()
        refresh.addTarget(context.coordinator, action: #selector(Coordinator.handleRefresh(_:)), for: .valueChanged)
        webView.scrollView.refreshControl = refresh

        controller.webView = webView
        return webView
    }

    func updateUIView(_ webView: WKWebView, context: Context) {
        context.coordinator.parent = self
        guard context.coordinator.lastLoadedURL != url else { return }
        context.coordinator.lastLoadedURL = url
        controller.isPageLoaded = false
        webView.load(URLRequest(url: url))
    }

    static func dismantleUIView(_ webView: WKWebView, coordinator: Coordinator) {
        webView.stopLoading()
        webView.navigationDelegate = nil
        webView.uiDelegate = nil
        webView.configuration.userContentController.removeScriptMessageHandler(forName: messageHandlerName)
        coordinator.parent.controller.webView = nil
    }

    /// `window.JakesData = { native: true, version: "1.0 (1)" }` from the bundle's version keys.
    static func bridgeScript() -> String {
        let info = Bundle.main.infoDictionary ?? [:]
        let short = info["CFBundleShortVersionString"] as? String ?? "0"
        let build = info["CFBundleVersion"] as? String ?? "0"
        let payload: [String: Any] = ["native": true, "canRecord": true, "version": "\(short) (\(build))"]
        let json = (try? JSONSerialization.data(withJSONObject: payload))
            .flatMap { String(data: $0, encoding: .utf8) } ?? #"{"native":true}"#
        return "window.JakesData = \(json);"
    }

    // MARK: - Coordinator

    @MainActor
    final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler {
        var parent: WebShell
        var lastLoadedURL: URL?

        init(_ parent: WebShell) {
            self.parent = parent
        }

        // MARK: Pull to refresh

        @objc func handleRefresh(_ sender: UIRefreshControl) {
            guard let webView = parent.controller.webView else {
                sender.endRefreshing()
                return
            }
            if webView.url != nil {
                webView.reload()
            } else if let url = lastLoadedURL {
                webView.load(URLRequest(url: url))
            } else {
                sender.endRefreshing()
            }
        }

        private let voiceRecorder = VoiceRecorder()


        // MARK: Messages from the page

        func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
            guard message.name == WebShell.messageHandlerName,
                  let body = message.body as? [String: Any]
            else { return }
            if body["type"] as? String == "voice" {
                voiceRecorder.handle(action: body["action"] as? String, webView: message.webView)
                return
            }
            guard body["type"] as? String == "haptic" else { return }
            switch body["style"] as? String {
            case "success":
                UINotificationFeedbackGenerator().notificationOccurred(.success)
            case "error":
                UINotificationFeedbackGenerator().notificationOccurred(.error)
            case "medium":
                UIImpactFeedbackGenerator(style: .medium).impactOccurred()
            default:
                UIImpactFeedbackGenerator(style: .light).impactOccurred()
            }
        }

        // MARK: Navigation

        func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
            guard let url = navigationAction.request.url else {
                decisionHandler(.allow)
                return
            }
            let opensNewWindow = navigationAction.targetFrame == nil // target=_blank
            let leavesApp = (navigationAction.targetFrame?.isMainFrame ?? false) && !isInsideApp(url)
            if opensNewWindow || leavesApp {
                openExternally(url)
                decisionHandler(.cancel)
            } else {
                decisionHandler(.allow)
            }
        }

        // Covers the first load, pull-to-refresh, and the reload after a content-process
        // crash in one place, so `postForeground` never scripts a page that is mid-load.
        func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
            parent.controller.isPageLoaded = false
        }

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            parent.controller.isPageLoaded = true
            webView.scrollView.refreshControl?.endRefreshing()
        }

        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
            webView.scrollView.refreshControl?.endRefreshing()
        }

        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
            webView.scrollView.refreshControl?.endRefreshing()
            let nsError = error as NSError
            guard nsError.domain == NSURLErrorDomain, nsError.code != NSURLErrorCancelled else { return }
            parent.onUnreachable()
        }

        func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
            webView.reload()
        }

        // MARK: UI delegate

        func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
            // window.open() lands here without a policy check first; hand it to Safari too.
            if let url = navigationAction.request.url {
                openExternally(url)
            }
            return nil
        }

        // WKWebView shows no JS dialogs unless the UI delegate implements them, and the web
        // app's note delete uses confirm().
        func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
            guard let presenter = presenter(for: webView) else {
                completionHandler()
                return
            }
            let alert = UIAlertController(title: nil, message: message, preferredStyle: .alert)
            alert.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler() })
            presenter.present(alert, animated: true)
        }

        func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
            guard let presenter = presenter(for: webView) else {
                completionHandler(false)
                return
            }
            let alert = UIAlertController(title: nil, message: message, preferredStyle: .alert)
            alert.addAction(UIAlertAction(title: "Cancel", style: .cancel) { _ in completionHandler(false) })
            alert.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler(true) })
            presenter.present(alert, animated: true)
        }

        func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String, defaultText: String?, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (String?) -> Void) {
            guard let presenter = presenter(for: webView) else {
                completionHandler(nil)
                return
            }
            let alert = UIAlertController(title: nil, message: prompt, preferredStyle: .alert)
            alert.addTextField { $0.text = defaultText }
            alert.addAction(UIAlertAction(title: "Cancel", style: .cancel) { _ in completionHandler(nil) })
            alert.addAction(UIAlertAction(title: "OK", style: .default) { [weak alert] _ in
                completionHandler(alert?.textFields?.first?.text)
            })
            presenter.present(alert, animated: true)
        }

        // MARK: Helpers

        /// URLs the web view handles itself: same origin as the base URL, or WebKit-internal schemes.
        private func isInsideApp(_ url: URL) -> Bool {
            guard let scheme = url.scheme?.lowercased() else { return true }
            if Self.internalSchemes.contains(scheme) { return true }
            return Self.origin(of: url) == Self.origin(of: parent.url)
        }

        private func openExternally(_ url: URL) {
            guard let scheme = url.scheme?.lowercased(), !Self.internalSchemes.contains(scheme) else { return }
            UIApplication.shared.open(url)
        }

        private func presenter(for webView: WKWebView) -> UIViewController? {
            guard var top = webView.window?.rootViewController else { return nil }
            while let next = top.presentedViewController {
                top = next
            }
            return top
        }

        private static let internalSchemes: Set<String> = ["about", "blob", "data", "javascript"]

        /// `scheme://host:port`, so a link to another service on the same PC still counts as external.
        private static func origin(of url: URL) -> String? {
            guard let scheme = url.scheme?.lowercased(), let host = url.host()?.lowercased() else { return nil }
            let port = url.port ?? (scheme == "https" ? 443 : 80)
            return "\(scheme)://\(host):\(port)"
        }
    }
}

/// `WKUserContentController` retains its message handlers, which would make the
/// web view <-> coordinator pair leak. This forwards to a weak target instead.
@MainActor
final class WeakScriptMessageHandler: NSObject, WKScriptMessageHandler {
    private weak var target: WKScriptMessageHandler?

    init(_ target: WKScriptMessageHandler) {
        self.target = target
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        target?.userContentController(userContentController, didReceive: message)
    }
}
