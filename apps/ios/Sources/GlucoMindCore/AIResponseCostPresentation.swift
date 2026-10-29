import Foundation

enum AIResponseCostPresentation {
    static func labelText(for cost: AIResponseCost?) -> String? {
        guard let cost else {
            return nil
        }

        let status = cost.status.trimmingCharacters(in: .whitespacesAndNewlines).uppercased()
        if status == "UNKNOWN" {
            return "koszt AI: niedostępny"
        }

        guard status == "KNOWN",
              let amount = cost.amount,
              amount >= 0,
              let currency = normalizedCurrencyCode(cost.currency) else {
            return nil
        }

        if amount > 0, amount < 0.01 {
            return "koszt AI: <0,01 \(currencyDisplayName(for: currency))"
        }

        guard let formattedAmount = formatCurrencyAmount(amount, currencyCode: currency) else {
            return nil
        }

        return "koszt AI: \(formattedAmount)"
    }

    private static func normalizedCurrencyCode(_ value: String?) -> String? {
        guard let value else {
            return nil
        }

        let code = value.trimmingCharacters(in: .whitespacesAndNewlines).uppercased()
        return code.isEmpty ? nil : code
    }

    private static func currencyDisplayName(for currencyCode: String) -> String {
        if currencyCode == "PLN" {
            return "zł"
        }

        return currencyCode
    }

    private static func formatCurrencyAmount(_ amount: Double, currencyCode: String) -> String? {
        let formatter = NumberFormatter()
        formatter.locale = Locale(identifier: "pl_PL")
        formatter.numberStyle = .currency
        formatter.currencyCode = currencyCode
        formatter.minimumFractionDigits = 2
        formatter.maximumFractionDigits = 2

        if currencyCode == "PLN" {
            formatter.currencySymbol = "zł"
        }

        return formatter.string(from: NSNumber(value: amount))
    }
}
