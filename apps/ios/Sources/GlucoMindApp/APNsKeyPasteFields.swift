import SwiftUI
import GlucoMindCore

/// "Wklej klucz i Key ID" in place, in the Trio and Loop remote control settings (owner 2026-11-03: a friend had the
/// key's text and its id, not the file): the key's text (the whole .p8, or only its body) and its 10-character id,
/// checked before saving.
struct APNsKeyPasteFields: View {
    /// "Trio" / "Loopa": whose account built the loop ("konto, które zbudowało Trio").
    let builtBy: String?
    let onSave: (APNsKeyFile.Key) -> Void
    let onCancel: () -> Void
    @State private var text = ""
    @State private var keyID = ""
    @State private var error: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Klucz").font(.footnote.weight(.semibold)).foregroundStyle(.secondary)
            TextEditor(text: $text)
                .font(.system(.footnote, design: .monospaced))
                .frame(minHeight: 120)
                .scrollContentBackground(.hidden)
                .padding(8)
                .background(RoundedRectangle(cornerRadius: 10, style: .continuous).fill(Color.secondary.opacity(0.12)))
                .autocorrectionDisabled()
                #if os(iOS)
                .textInputAutocapitalization(.never)
                #endif
                .accessibilityIdentifier("remote.key.paste.text")
            Text("Cała treść pliku .p8, razem z liniami „BEGIN PRIVATE KEY” i „END PRIVATE KEY”.")
                .font(.footnote).foregroundStyle(.secondary)
            Text("Key ID").font(.footnote.weight(.semibold)).foregroundStyle(.secondary).padding(.top, 6)
            TextField("np. ABC123DEFG", text: $keyID)
                .autocorrectionDisabled()
                #if os(iOS)
                .textInputAutocapitalization(.characters)
                #endif
                .padding(.horizontal, 12)
                .padding(.vertical, 10)
                .background(RoundedRectangle(cornerRadius: 10, style: .continuous).fill(Color.secondary.opacity(0.12)))
                .accessibilityIdentifier("remote.key.paste.id")
            Text(builtBy.map { "10 znaków z developer.apple.com → Keys, przy tym kluczu (konto, które zbudowało \($0)). To nie jest nazwa klucza." }
                 ?? "10 znaków z developer.apple.com → Keys, przy kluczu konta aplikacji Mellis. To nie jest nazwa klucza.")
                .font(.footnote).foregroundStyle(.secondary)
            if let error {
                Label(error, systemImage: "exclamationmark.circle").font(.footnote).foregroundStyle(.orange)
            }
            HStack(spacing: 10) {
                Button("Anuluj", action: onCancel)
                    .buttonStyle(.bordered)
                Button {
                    switch APNsKeyFile.parsePasted(text, keyID: keyID) {
                    case let .success(key): onSave(key)
                    case let .failure(failure): error = failure.message
                    }
                } label: {
                    Text("Zapisz klucz").fontWeight(.semibold).frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                .disabled(text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || keyID.isEmpty)
                .accessibilityIdentifier("remote.key.paste.save")
            }
            .controlSize(.large)
            .padding(.top, 6)
        }
    }
}

/// The secondary button that opens the fields.
struct APNsKeyPasteButton: View {
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Label("Wklej klucz i Key ID", systemImage: "doc.on.clipboard")
                .frame(maxWidth: .infinity)
        }
        .buttonStyle(.bordered)
        .controlSize(.large)
        .accessibilityIdentifier("remote.key.paste")
    }
}
