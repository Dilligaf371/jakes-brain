import AVFoundation
import WebKit

/// Records a memo for the Voice Memos app and uploads it to the PC. This lives in the shell
/// because a page served over plain http cannot reach the microphone.
final class VoiceRecorder {
    private var recorder: AVAudioRecorder?
    private var fileURL: URL?

    func handle(action: String?, webView: WKWebView?) {
        switch action {
        case "start": requestAndStart(webView)
        case "stop": stopAndUpload(webView)
        default: break
        }
    }

    private func requestAndStart(_ webView: WKWebView?) {
        AVAudioApplication.requestRecordPermission { [weak self, weak webView] granted in
            DispatchQueue.main.async {
                guard let self else { return }
                if granted {
                    self.start(webView)
                } else {
                    self.emit(webView, state: "error", message: "Allow the microphone in Settings to record.")
                }
            }
        }
    }

    private func start(_ webView: WKWebView?) {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("\(UUID().uuidString).m4a")
        let settings: [String: Any] = [
            AVFormatIDKey: Int(kAudioFormatMPEG4AAC),
            AVSampleRateKey: 44_100,
            AVNumberOfChannelsKey: 1,
            AVEncoderAudioQualityKey: AVAudioQuality.high.rawValue,
        ]
        do {
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.record, mode: .default)
            try session.setActive(true)
            let recorder = try AVAudioRecorder(url: url, settings: settings)
            guard recorder.record() else { throw CocoaError(.fileWriteUnknown) }
            self.recorder = recorder
            fileURL = url
            emit(webView, state: "recording")
        } catch {
            emit(webView, state: "error", message: "Couldn't start recording.")
        }
    }

    private func stopAndUpload(_ webView: WKWebView?) {
        guard let recorder, let fileURL else { return }
        recorder.stop()
        self.recorder = nil
        self.fileURL = nil
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        guard let page = webView?.url, var parts = URLComponents(url: page, resolvingAgainstBaseURL: false) else {
            emit(webView, state: "error", message: "Couldn't find the PC.")
            return
        }
        parts.path = "/api/voice/upload"
        parts.query = nil
        parts.fragment = nil
        guard let target = parts.url else { return }
        emit(webView, state: "uploading")
        var request = URLRequest(url: target)
        request.httpMethod = "PUT"
        request.timeoutInterval = 180
        request.setValue("audio/mp4", forHTTPHeaderField: "Content-Type")
        request.setValue("memo.m4a", forHTTPHeaderField: "X-Filename")
        URLSession.shared.uploadTask(with: request, fromFile: fileURL) { [weak self, weak webView] _, response, error in
            try? FileManager.default.removeItem(at: fileURL)
            let ok = error == nil && (response as? HTTPURLResponse)?.statusCode == 201
            DispatchQueue.main.async {
                self?.emit(webView, state: ok ? "done" : "error", message: ok ? nil : "Upload failed. The recording was not saved.")
            }
        }.resume()
    }

    private func emit(_ webView: WKWebView?, state: String, message: String? = nil) {
        var detail = ["state": state]
        if let message { detail["message"] = message }
        guard let data = try? JSONSerialization.data(withJSONObject: detail),
              let json = String(data: data, encoding: .utf8) else { return }
        webView?.evaluateJavaScript("window.dispatchEvent(new CustomEvent('jakesdata:voice',{detail:\(json)}))") { _, _ in }
    }
}
