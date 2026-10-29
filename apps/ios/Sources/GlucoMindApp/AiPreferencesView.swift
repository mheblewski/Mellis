import SwiftUI
import GlucoMindCore

/// "Instrukcje dla Mellisa" in Settings. SettingsView shows it once the server has answered, so a server without it
/// shows no row.
struct AiPreferencesSection: View {
    let preferences: UserAiPreferences
    let onSave: (UserAiPreferences) async throws -> Void

    var body: some View {
        Section {
            NavigationLink {
                AiPreferencesEditView(preferences: preferences, onSave: onSave)
            } label: {
                LabeledContent {
                    Text(preferences.summary)
                } label: {
                    Label("Instrukcje dla Mellisa", systemImage: "text.bubble")
                }
            }
        } header: {
            Text("Asystent")
        } footer: {
            Text("Dotyczą Twojego konta, u każdego pacjenta.")
        }
    }
}

/// Who is writing ("Kim jesteś"), then the user's own words about themself and their wishes (up to 500 characters), then
/// ready examples that fill the text. They change the tone and who the AI talks to; the safety rules stay on.
struct AiPreferencesEditView: View {
    let preferences: UserAiPreferences
    let onSave: (UserAiPreferences) async throws -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var role: AiUserRole?
    @State private var text = ""
    @State private var isSaving = false
    @State private var errorMessage: String?
    @State private var didLoad = false
    /// The example being written into the field as an answer in the chat (TextRevealer: steady pace, each letter fading
    /// in); the field shows the revealed text until it is all in, then is editable again.
    @State private var typingExample: AiInstructionExample?
    @State private var typingPrefix = ""
    @State private var revealer: TextRevealer?
    /// The role from before an example changed it: back when the example is taken back.
    @State private var roleMemory = AiExampleRoleMemory()
    /// "Kim jesteś" lights up for a moment when an example changes the role, so the change is seen.
    @State private var roleHighlighted = false
    @State private var highlightTask: Task<Void, Never>?
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private var edited: UserAiPreferences { UserAiPreferences(role: role, instructions: text) }
    private var hasChanges: Bool {
        edited.role != preferences.role
            || text.trimmingCharacters(in: .whitespacesAndNewlines) != preferences.instructions.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    var body: some View {
        Form {
            // The role, the field and the examples in one card: an example fills the field and may choose the role, both
            // right above it.
            Section {
                RoleRow(
                    role: Binding(get: { role }, set: { chosen in
                        role = chosen
                        roleMemory.userChoseRole()
                    }),
                    isHighlighted: roleHighlighted
                )
                .disabled(isSaving)
                VStack(alignment: .trailing, spacing: 6) {
                    TextField("Np. Jestem mamą 6-latka, od roku na pętli. Pisz krótko i konkretnie.", text: $text, axis: .vertical)
                        .lineLimit(4...10)
                        .disabled(isSaving || revealer != nil)
                        // The field holds the whole text already (its height does not jump); it is hidden while the
                        // example is written in above it.
                        .opacity(revealer == nil ? 1 : 0)
                        // At once both ways: a fade would flash the whole text before it is written in.
                        .animation(nil, value: revealer == nil)
                        .overlay(alignment: .topLeading) {
                            if let revealer {
                                RevealingInstructions(prefix: typingPrefix, revealer: revealer) {
                                    self.revealer = nil
                                    typingExample = nil
                                }
                            }
                        }
                        .onChange(of: text) { _, newText in
                            errorMessage = nil
                            // The field cleared by hand: the example is gone, and the role it brought too.
                            if revealer == nil, newText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                                setRole(roleMemory.roleAfterRemovingExample(current: role))
                            }
                        }
                    Text("\(edited.instructionsCount)/\(UserAiPreferences.maxInstructionsLength)")
                        .font(.caption)
                        .monospacedDigit()
                        .foregroundStyle(edited.isInstructionsTooLong ? .red : .secondary)
                }
                // The line under the field spans the card, not only the counter on its right.
                .alignmentGuide(.listRowSeparatorLeading) { _ in 0 }
                ForEach(AiInstructionExample.all) { example in
                    let isSelected = typingExample == nil ? edited.selectedExample == example : typingExample == example
                    Button {
                        tap(example, isSelected: isSelected)
                    } label: {
                        ExampleRow(example: example, isSelected: isSelected)
                    }
                    // Form rows tint button labels with the accent colour; the examples read as content.
                    .tint(.primary)
                    .disabled(isSaving)
                }
            } header: {
                Text("Opowiedz o sobie i dodaj własne instrukcje albo skorzystaj z gotowych przykładów poniżej. To opcjonalne i nie wpływa na jakość odpowiedzi.")
                    .font(.subheadline)
                    .fontWeight(.regular)
                    // Darker than the placeholder below, so the two never read as one.
                    .foregroundStyle(.primary)
                    .textCase(nil)
            } footer: {
                VStack(alignment: .leading, spacing: 6) {
                    if let errorMessage {
                        Text(errorMessage).foregroundStyle(.red)
                    } else if edited.isInstructionsTooLong {
                        Text("Skróć tekst do \(UserAiPreferences.maxInstructionsLength) znaków.").foregroundStyle(.red)
                    }
                    if let roleFooter {
                        Text(roleFooter)
                    }
                    Text("Instrukcje zmieniają ton odpowiedzi i to, jak Mellis się do Ciebie zwraca. Nigdy nie wyłączają zasad bezpieczeństwa: ostrzeżeń, blokad przy niskiej glukozie ani reguł dawkowania.")
                }
            }
        }
        // The keyboard covers the examples: scrolling the form puts it away.
        .scrollDismissesKeyboard(.interactively)
        .navigationTitle("Instrukcje dla Mellisa")
        #if os(iOS)
        .navigationBarTitleDisplayMode(.inline)
        #endif
        .toolbar {
            ToolbarItem(placement: .confirmationAction) {
                if isSaving {
                    ProgressView()
                } else {
                    Button("Zapisz", action: save)
                        .disabled(!hasChanges || edited.isInstructionsTooLong)
                }
            }
        }
        .onAppear {
            guard !didLoad else { return }
            didLoad = true
            role = preferences.role
            text = preferences.instructions
        }
    }

    /// What the chosen role changes, for the roles that change more than the tone (the line below says that).
    private var roleFooter: String? {
        switch role {
        case .patientSelf: return "Mellis będzie zwracać się bezpośrednio do Ciebie jako do pacjenta."
        case .institutionCaregiver: return "Mellis nie założy, że znasz historię i ustawienia pacjenta."
        case .clinician: return "Mellis może używać terminów klinicznych."
        default: return nil
        }
    }

    /// A tap on an example: the selected one leaves the field; another one replaces it, written in as in the chat.
    private func tap(_ example: AiInstructionExample, isSelected: Bool) {
        revealer = nil
        typingExample = nil
        if isSelected {
            withAnimation(.easeOut(duration: 0.2)) { text = edited.removingExample().instructions }
            setRole(roleMemory.roleAfterRemovingExample(current: role))
            return
        }
        let applied = edited.applying(example)
        setRole(roleMemory.roleAfterApplying(example, current: role))
        guard !reduceMotion else {
            text = applied.instructions
            return
        }
        let own = edited.ownInstructions
        typingPrefix = own.isEmpty ? "" : own + "\n"
        typingExample = example
        text = applied.instructions
        let revealer = TextRevealer()
        self.revealer = revealer
        // The whole text is known: it comes in at the chat's pace and finishes within about a second.
        revealer.complete(with: example.text)
    }

    /// A role set by an example (or given back): "Kim jesteś" lights up when it really changes.
    private func setRole(_ newRole: AiUserRole?) {
        guard newRole != role else { return }
        // The new role pops in a tinted capsule (RoleRow animates it), which then fades away.
        role = newRole
        roleHighlighted = true
        highlightTask?.cancel()
        highlightTask = Task { @MainActor in
            try? await Task.sleep(for: .seconds(1.6))
            guard !Task.isCancelled else { return }
            roleHighlighted = false
        }
    }

    private func save() {
        let value = edited
        isSaving = true
        Task {
            do {
                try await onSave(value)
                dismiss()
            } catch {
                errorMessage = "Nie udało się zapisać. Sprawdź połączenie i spróbuj ponownie."
            }
            isSaving = false
        }
    }
}

/// "Kim jesteś": the role in a menu. When an example changes it, the value pops in a tinted capsule for a moment.
private struct RoleRow: View {
    @Binding var role: AiUserRole?
    let isHighlighted: Bool
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        HStack {
            Text("Kim jesteś")
            Spacer(minLength: 12)
            Menu {
                Picker("Kim jesteś", selection: $role) {
                    Text("Nie wybrano").tag(AiUserRole?.none)
                    ForEach(AiUserRole.allCases) { option in
                        Text(option.label).tag(AiUserRole?.some(option))
                    }
                }
                .pickerStyle(.inline)
            } label: {
                HStack(spacing: 4) {
                    Text(role?.label ?? "Nie wybrano")
                        .lineLimit(1)
                        .minimumScaleFactor(0.8)
                    Image(systemName: "chevron.up.chevron.down")
                        .font(.footnote.weight(.medium))
                }
                .foregroundStyle(Color.accentColor)
                .padding(.horizontal, 10)
                .padding(.vertical, 5)
                // Only the capsule and the pop are animated: the new name and its place in the row change at once
                // (sliding, a longer name would spill out of the card).
                .animation(reduceMotion ? .easeOut(duration: 0.25) : .spring(duration: 0.5, bounce: 0.4)) { label in
                    label
                        .background(Capsule().fill(Color.accentColor.opacity(isHighlighted ? 0.16 : 0)))
                        .scaleEffect(isHighlighted && !reduceMotion ? 1.06 : 1, anchor: .trailing)
                }
                // The capsule's padding stays out of the row, so the value lines up with the rows below.
                .padding(.horizontal, -10)
            }
        }
        .accessibilityElement(children: .combine)
    }
}

/// The user's own words, then the example as it is written in: the newest letters fade in as in the chat.
private struct RevealingInstructions: View {
    let prefix: String
    @ObservedObject var revealer: TextRevealer
    let onFinished: () -> Void

    var body: some View {
        Text(AttributedString(prefix) + StreamingMarkdown.fadeTail(AttributedString(revealer.displayed), opacities: revealer.tailOpacities))
            .frame(maxWidth: .infinity, alignment: .topLeading)
            .allowsHitTesting(false)
            .onChange(of: revealer.isFinished) { _, finished in
                if finished { onFinished() }
            }
    }
}

/// An example as a settings row: a tinted icon, the situation and what the AI will do, "+" to add it.
private struct ExampleRow: View {
    let example: AiInstructionExample
    /// Its text is in the field: a checkmark instead of "+", a tinted row.
    let isSelected: Bool

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: example.symbol)
                .font(.system(size: 15, weight: .medium))
                .foregroundStyle(Color.accentColor)
                .frame(width: 30, height: 30)
                .background(RoundedRectangle(cornerRadius: 8, style: .continuous).fill(Color.accentColor.opacity(0.12)))
            VStack(alignment: .leading, spacing: 2) {
                Text(example.title)
                    .foregroundStyle(.primary)
                Text(example.subtitle)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
            Spacer(minLength: 8)
            Image(systemName: isSelected ? "checkmark.circle.fill" : "plus.circle")
                .font(.system(size: 18))
                .foregroundStyle(Color.accentColor)
                .contentTransition(.symbolEffect(.replace))
        }
        .contentShape(Rectangle())
        .animation(.easeOut(duration: 0.2), value: isSelected)
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(isSelected ? .isSelected : [])
        .accessibilityHint(isSelected ? "Usuwa ten tekst z instrukcji" : "Wstawia gotowy tekst w miejsce poprzedniego przykładu")
    }
}
