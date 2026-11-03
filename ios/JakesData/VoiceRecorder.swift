import AVFoundation
import WebKit

/// Records a memo for the Voice Memos app and uploads it to the PC. This lives in the shell
/// to keep recording behavior consistent across app updates.
@MainActor
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
        guard let webView, let page = webView.url, Config.isAppURL(page) else {
            try? FileManager.default.removeItem(at: fileURL)
            emit(webView, state: "error", message: "Couldn't connect to your app.")
            return
        }
        emit(webView, state: "uploading")
        Task {
            defer { try? FileManager.default.removeItem(at: fileURL) }
            do {
                var request = try await NativeHTTP.request(
                    to: Config.origin.appendingPathComponent("api/voice/upload"), webView: webView
                )
                request.httpMethod = "PUT"
                request.timeoutInterval = 180
                request.setValue("audio/mp4", forHTTPHeaderField: "Content-Type")
                request.setValue("memo.m4a", forHTTPHeaderField: "X-Filename")
                let (_, response) = try await NativeHTTP.session.upload(for: request, fromFile: fileURL)
                guard (response as? HTTPURLResponse)?.statusCode == 201 else { throw URLError(.badServerResponse) }
                emit(webView, state: "done")
            } catch {
                emit(webView, state: "error", message: "Upload failed. The recording was not saved.")
            }
        }
    }

    private func emit(_ webView: WKWebView?, state: String, message: String? = nil) {
        var detail = ["state": state]
        if let message { detail["message"] = message }
        guard let data = try? JSONSerialization.data(withJSONObject: detail),
              let json = String(data: data, encoding: .utf8) else { return }
        webView?.evaluateJavaScript("window.dispatchEvent(new CustomEvent('jakesdata:voice',{detail:\(json)}))") { _, _ in }
    }
}
