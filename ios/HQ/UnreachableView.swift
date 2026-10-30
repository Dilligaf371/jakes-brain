import SwiftUI

/// Shown when no base URL answered. System styling only.
struct UnreachableView: View {
    let tried: [URL]
    let retry: () -> Void

    var body: some View {
        VStack(spacing: 20) {
            Spacer()
            Image(systemName: "wifi.exclamationmark")
                .font(.system(size: 40))
                .foregroundStyle(.secondary)
            Text("Can't reach the PC")
                .font(.title2.weight(.semibold))
            VStack(spacing: 4) {
                ForEach(tried, id: \.self) { url in
                    Text(url.absoluteString)
                        .font(.footnote.monospaced())
                        .foregroundStyle(.secondary)
                }
            }
            Text("Join Tailscale on this phone or connect to home WiFi.")
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
            Button("Retry", action: retry)
                .buttonStyle(.bordered)
                .padding(.top, 8)
            Spacer()
        }
        .padding(.horizontal, 32)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color(.systemBackground))
    }
}
