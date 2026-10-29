import SwiftUI

/// A meal change the AI prepared in a conversation (conversation-meal-actions.v1): one line of what the meal was and
/// will be, chips of the values that change, the warnings, and the buttons. Nothing changes in the meals tab until
/// "Zatwierdź"; a decided card collapses to one line.
struct MealActionCard: View {
    let action: ConversationMealAction
    let isBusy: Bool
    let errorMessage: String?
    let onApply: () -> Void
    let onEdit: () -> Void
    let onReject: () -> Void
    let onUndo: () -> Void
    let onOpenMeal: ((String) -> Void)?

    @State private var showsItems = false

    var body: some View {
        Group {
            if let decidedLine = action.decidedLine {
                decided(decidedLine)
            } else {
                proposal
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("meal-action-\(action.id)")
    }

    private var mealID: String? { action.meal_id ?? action.after.meal_id }

    // MARK: Waiting for a decision

    private var proposal: some View {
        VStack(alignment: .leading, spacing: 0) {
            header

            summary
                .padding(.top, 10)

            let changes = action.valueChanges
            if !changes.isEmpty {
                FlowChips(changes: changes)
                    .padding(.top, 8)
            }

            if let itemsSummary = action.itemsSummary, let items = action.after.items {
                Button {
                    withAnimation(.easeInOut(duration: 0.2)) { showsItems.toggle() }
                } label: {
                    HStack {
                        Text(itemsSummary)
                        Spacer()
                        Image(systemName: "chevron.down")
                            .rotationEffect(.degrees(showsItems ? 180 : 0))
                    }
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .padding(.top, 10)
                if showsItems {
                    MealActionItems(items: items)
                        .padding(.top, 6)
                }
            }

            if let reason = action.reason, !reason.isEmpty {
                Text(reason)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .padding(.top, 8)
            }

            ForEach(action.visibleWarnings, id: \.self) { warning in
                let quiet = warning.code == "NOT_UNDOABLE"
                Label(warning.message, systemImage: quiet ? "arrow.uturn.backward.circle" : "exclamationmark.triangle.fill")
                    .font(.footnote)
                    .foregroundStyle(quiet ? Color.secondary : Color.orange)
                    .padding(.top, 8)
            }

            if let errorMessage {
                Text(errorMessage)
                    .font(.footnote)
                    .foregroundStyle(.red)
                    .padding(.top, 8)
            }

            if action.can_apply {
                buttons
                    .padding(.top, 12)
            } else if action.status == "APPLYING" {
                HStack(spacing: 8) {
                    ProgressView()
                    Text("Zapisuję…").font(.subheadline).foregroundStyle(.secondary)
                }
                .padding(.top, 12)
            }
        }
        .padding(.horizontal, 15)
        .padding(.vertical, 13)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 18, style: .continuous).fill(Color.secondary.opacity(0.08)))
        .overlay(RoundedRectangle(cornerRadius: 18, style: .continuous).stroke(Color.secondary.opacity(0.18), lineWidth: 1))
    }

    private var header: some View {
        let headline = action.headline
        return VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: 8) {
                Image(systemName: action.after.kind == "WBT_REMINDER" ? "bell" : "fork.knife")
                    .font(.body.weight(.semibold))
                    .foregroundStyle(.tint)
                Text(headline.title)
                    .font(.subheadline.weight(.semibold))
                    .lineLimit(2)
                Spacer(minLength: 6)
                if let chip = headline.chip {
                    Text(chip)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .padding(.horizontal, 9)
                        .padding(.vertical, 3)
                        .background(Capsule().fill(Color.secondary.opacity(0.14)))
                }
            }
            if let detail = headline.detail {
                Text(detail)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .padding(.leading, 28)
            }
        }
    }

    /// "~~Skyr 150 g~~ → Naleśniki z serem ×2".
    private var summary: some View {
        let line = action.summaryLine
        var text = AttributedString()
        if let before = line.before {
            var old = AttributedString(before)
            old.strikethroughStyle = .single
            old.foregroundColor = .secondary
            text += old
            text += AttributedString(" → ")
        }
        text += AttributedString(line.after)
        return Text(text)
            .font(.body)
            .fixedSize(horizontal: false, vertical: true)
    }

    private var buttons: some View {
        HStack(spacing: 8) {
            Button(action: onApply) {
                Group {
                    if isBusy {
                        ProgressView()
                    } else {
                        Label("Zatwierdź", systemImage: "checkmark").fontWeight(.semibold)
                    }
                }
                .frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            if action.can_edit {
                Button("Popraw", action: onEdit)
                    .buttonStyle(.bordered)
            }
            Button(action: onReject) {
                Image(systemName: "xmark")
                    .fontWeight(.semibold)
            }
            .buttonStyle(.bordered)
            .accessibilityLabel("Odrzuć")
        }
        .controlSize(.large)
        .disabled(isBusy)
    }

    // MARK: Decided

    private func decided(_ line: String) -> some View {
        let applied = action.status == "APPLIED"
        return VStack(alignment: .leading, spacing: 4) {
            HStack(alignment: .firstTextBaseline, spacing: 10) {
                Label(line, systemImage: applied ? "checkmark.circle.fill" : action.status == "STALE" ? "info.circle" : "minus.circle")
                    .font(.subheadline.weight(applied ? .semibold : .regular))
                    .foregroundStyle(applied ? Color.green : Color.secondary)
                    .lineLimit(action.status == "STALE" ? nil : 2)
                    .frame(maxWidth: .infinity, alignment: .leading)
                if action.can_undo {
                    Button(action: onUndo) {
                        if isBusy { ProgressView() } else { Text("Cofnij") }
                    }
                    .font(.subheadline)
                    .buttonStyle(.borderless)
                    .disabled(isBusy)
                }
                if (applied || action.status == "UNDONE"), let mealID, let onOpenMeal {
                    Button("Otwórz") { onOpenMeal(mealID) }
                        .font(.subheadline)
                        .buttonStyle(.borderless)
                }
            }
            if applied, let decidedBy = action.decided_by {
                Text(decidedBy)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .padding(.leading, 28)
            }
            if let errorMessage {
                Text(errorMessage)
                    .font(.footnote)
                    .foregroundStyle(.red)
            }
        }
        .padding(.horizontal, 15)
        .padding(.vertical, 10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .fill(applied ? Color.green.opacity(0.1) : Color.secondary.opacity(0.06))
        )
    }

    static func label(_ side: MealActionSide) -> String {
        switch side.kind {
        case "WBT_REMINDER":
            switch side.enabled {
            case .some(true): return "przypomnienie o WBT włączone"
            case .some(false): return "przypomnienie o WBT wyłączone"
            case .none: return "bez przypomnienia o WBT"
            }
        default:
            return side.label ?? "—"
        }
    }
}

/// The value chips of a content change, wrapping to the next line; carbohydrates that change in the warning colour.
private struct FlowChips: View {
    let changes: [MealActionValueChange]

    var body: some View {
        ChipFlowLayout(spacing: 6) {
            ForEach(changes) { change in
                let highlighted = change.name == "W" && change.changed
                Text(change.text)
                    .font(.caption.monospacedDigit().weight(highlighted ? .semibold : .regular))
                    .foregroundStyle(highlighted ? Color.orange : Color.secondary)
                    .padding(.horizontal, 9)
                    .padding(.vertical, 3)
                    .background(Capsule().fill(highlighted ? Color.orange.opacity(0.15) : Color.secondary.opacity(0.14)))
            }
        }
    }
}

/// Lays chips out left to right, starting a new row when the next one does not fit.
private struct ChipFlowLayout: Layout {
    let spacing: CGFloat

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let rows = arrange(width: proposal.width ?? .infinity, subviews: subviews)
        let width = rows.map(\.width).max() ?? 0
        let height = rows.map(\.height).reduce(0, +) + spacing * CGFloat(max(rows.count - 1, 0))
        return CGSize(width: width, height: height)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var y = bounds.minY
        for row in arrange(width: bounds.width, subviews: subviews) {
            var x = bounds.minX
            for index in row.indices {
                let size = subviews[index].sizeThatFits(.unspecified)
                subviews[index].place(at: CGPoint(x: x, y: y), proposal: ProposedViewSize(size))
                x += size.width + spacing
            }
            y += row.height + spacing
        }
    }

    private struct Row {
        var indices: [Int] = []
        var width: CGFloat = 0
        var height: CGFloat = 0
    }

    private func arrange(width: CGFloat, subviews: Subviews) -> [Row] {
        var rows: [Row] = []
        var row = Row()
        for index in subviews.indices {
            let size = subviews[index].sizeThatFits(.unspecified)
            let needed = row.indices.isEmpty ? size.width : row.width + spacing + size.width
            if needed > width && !row.indices.isEmpty {
                rows.append(row)
                row = Row()
            }
            row.width = row.indices.isEmpty ? size.width : row.width + spacing + size.width
            row.height = max(row.height, size.height)
            row.indices.append(index)
        }
        if !row.indices.isEmpty { rows.append(row) }
        return rows
    }
}

/// The new items of a content change, unfolded under "Skład".
private struct MealActionItems: View {
    let items: [MealChatProposalItem]

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            ForEach(items) { item in
                HStack(alignment: .firstTextBaseline) {
                    VStack(alignment: .leading, spacing: 1) {
                        Text(item.name)
                            .font(.subheadline)
                        Text([item.grams.map { "\(MealActionPresentation.number($0)) g" }, item.source == "DIABCALC" ? "DiabCalc" : "szacunek"].compactMap { $0 }.joined(separator: " · "))
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    Spacer()
                    Text("\(MealActionPresentation.number(item.carbs_g)) g W")
                        .font(.subheadline.monospacedDigit())
                }
            }
        }
        .padding(10)
        .background(RoundedRectangle(cornerRadius: 12, style: .continuous).fill(Color.secondary.opacity(0.08)))
    }
}

/// "Popraw" on a meal change card: the description and values to save instead of the proposed ones. An empty value
/// is saved as unknown.
struct MealActionEditSheet: View {
    let action: ConversationMealAction
    let onSave: (MealActionEdit) async -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var description: String
    @State private var carbs: String
    @State private var protein: String
    @State private var fat: String
    @State private var isSaving = false

    init(action: ConversationMealAction, onSave: @escaping (MealActionEdit) async -> Void) {
        self.action = action
        self.onSave = onSave
        func text(_ value: Double?) -> String { value.map { LoopFormat.number($0) } ?? "" }
        _description = State(initialValue: action.after.description ?? "")
        _carbs = State(initialValue: text(action.after.carbs_g))
        _protein = State(initialValue: text(action.after.protein_g))
        _fat = State(initialValue: text(action.after.fat_g))
    }

    private var onlyDescription: Bool { action.operation == "UPDATE_DESCRIPTION" }

    private static func number(_ text: String) -> Double? {
        Double(text.trimmingCharacters(in: .whitespaces).replacingOccurrences(of: ",", with: "."))
    }

    private var canSave: Bool {
        if onlyDescription {
            return !description.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        }
        let values = [carbs, protein, fat].map(Self.number)
        let typedValid = zip([carbs, protein, fat], values).allSatisfy { text, value in text.trimmingCharacters(in: .whitespaces).isEmpty || (value.map { $0 >= 0 && $0 <= 1000 } ?? false) }
        return typedValid && values.contains { $0 != nil }
    }

    var body: some View {
        NavigationStack {
            Form {
                Section("Opis") {
                    TextField("Np. kanapka z masłem i pół jabłka", text: $description, axis: .vertical)
                }
                if !onlyDescription {
                    Section {
                        valueField("Węglowodany", text: $carbs)
                        valueField("Białko", text: $protein)
                        valueField("Tłuszcz", text: $fat)
                    } header: {
                        Text("Wartości (g)")
                    } footer: {
                        Text("Lista składników zostaje tylko, gdy wartości się z nią zgadzają.")
                    }
                }
            }
            .navigationTitle("Popraw zmianę")
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Anuluj") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button {
                        Task {
                            isSaving = true
                            await onSave(MealActionEdit(
                                description: description.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : description,
                                carbs_g: onlyDescription ? nil : Self.number(carbs),
                                protein_g: onlyDescription ? nil : Self.number(protein),
                                fat_g: onlyDescription ? nil : Self.number(fat)
                            ))
                            isSaving = false
                            dismiss()
                        }
                    } label: {
                        if isSaving { ProgressView() } else { Text("Zatwierdź").fontWeight(.semibold) }
                    }
                    .disabled(!canSave || isSaving)
                }
            }
        }
        .presentationDetents([.medium, .large])
    }

    private func valueField(_ title: String, text: Binding<String>) -> some View {
        HStack {
            Text(title)
            Spacer()
            TextField("?", text: text)
                #if os(iOS)
                .keyboardType(.decimalPad)
                #endif
                .multilineTextAlignment(.trailing)
                .frame(maxWidth: 90)
        }
    }
}
