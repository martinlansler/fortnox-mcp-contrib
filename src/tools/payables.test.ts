import { describe, it, expect } from "vitest";
import {
  buildSupplierInvoiceBody, summarizeInvoice, matchDuplicates, checkPayment, prepareRows, paymentAmounts, checkRowsCurrency
} from "./payables.js";

describe("buildSupplierInvoiceBody", () => {
  it("sends cost rows only; Fortnox adds 2440 and VAT itself", () => {
    const body = buildSupplierInvoiceBody({
      supplier_number: "1",
      invoice_number: "INV-1001",
      invoice_date: "2026-03-01",
      due_date: "2026-03-31",
      total: 1250,
      vat: 250,
      vat_type: "NORMAL",
      rows: [{ account: 6540, debit: 1000, transaction_information: "hosting March" }]
    });
    expect(body).toMatchObject({
      SupplierNumber: "1",
      InvoiceNumber: "INV-1001",
      Total: 1250,
      VAT: 250,
      VATType: "NORMAL"
    });
    expect(body.SupplierInvoiceRows).toEqual([
      { Account: 6540, Debit: 1000, TransactionInformation: "hosting March" }
    ]);
  });

  it("rejects 2440 and VAT rows, which Fortnox would book a second time", () => {
    expect(() => buildSupplierInvoiceBody({
      supplier_number: "1", total: 125, vat: 25,
      rows: [{ account: 2440, credit: 125 }, { account: 2641, debit: 25 }, { account: 6540, debit: 100 }]
    })).toThrow(/cost rows only/);
  });

  it("rejects cost rows that do not add up to total - vat", () => {
    expect(() => buildSupplierInvoiceBody({
      supplier_number: "1", total: 125, vat: 25, rows: [{ account: 6540, debit: 90 }]
    })).toThrow(/total - vat/);
  });

  it("refuses rows on a foreign-currency invoice", () => {
    expect(() => buildSupplierInvoiceBody({ supplier_number: "1", currency: "USD", total: 100, vat: 0,
      rows: [{ account: 4535, debit: 100 }] })).toThrow(/only supported on SEK/);
    expect(buildSupplierInvoiceBody({ supplier_number: "1", currency: "USD", total: 100, vat: 0 })).toMatchObject({ Currency: "USD" });
    // The currency looked up from the invoice or supplier when the caller left it out:
    expect(() => checkRowsCurrency({ rows: [{ account: 4535, debit: 100 }] }, "EUR")).toThrow(/only supported on SEK/);
    expect(() => checkRowsCurrency({ rows: [{ account: 4535, debit: 100 }] }, undefined)).not.toThrow();
    expect(() => checkRowsCurrency({}, "EUR")).not.toThrow();
  });

  it("leaves out fields that were not given (partial update)", () => {
    expect(buildSupplierInvoiceBody({ due_date: "2026-12-01" })).toEqual({ DueDate: "2026-12-01" });
  });

  it("passes the code of re-sent generated rows through and leaves them out of the cost check", () => {
    const body = buildSupplierInvoiceBody({
      supplier_number: "1", total: 100, vat: 0, vat_type: "EUINTERNAL",
      rows: [
        { account: 2440, credit: 100, code: "TOT" },
        { account: 4535, debit: 100 },
        { account: 2645, debit: 25, code: "PRD" },
        { account: 2614, credit: 25, code: "PRC" }
      ]
    });
    expect((body.SupplierInvoiceRows as Array<Record<string, unknown>>).map((r) => r.Code ?? null))
      .toEqual(["TOT", null, "PRD", "PRC"]);
  });
});

describe("summarizeInvoice", () => {
  it("returns numbers and booleans, not Fortnox strings", () => {
    const s = summarizeInvoice({
      GivenNumber: "7", SupplierNumber: "2", Total: "100.5", Balance: "0",
      Booked: "true" as never, Cancelled: false, VoucherSeries: "D", VoucherNumber: 3, VoucherYear: 1
    });
    expect(s.total).toBe(100.5);
    expect(s.balance).toBe(0);
    expect(s.booked).toBe(true);
    expect(s.voucher).toBe("D3");
  });
});

describe("matchDuplicates", () => {
  const items = [
    { GivenNumber: "1", SupplierNumber: "1", InvoiceNumber: "TEST-001", Cancelled: false },
    { GivenNumber: "2", SupplierNumber: "1", InvoiceNumber: "test-001 ", Cancelled: "true" },
    { GivenNumber: "4", SupplierNumber: "1", InvoiceNumber: "TEST-001", Cancel: true },
    { GivenNumber: "3", SupplierNumber: "2", InvoiceNumber: "TEST-001", Cancelled: false }
  ];
  it("finds the same supplier + number, ignoring case, spaces and cancelled invoices", () => {
    expect(matchDuplicates(items, "1", "Test-001").map((i) => i.GivenNumber)).toEqual(["1"]);
  });
  it("finds nothing for a new number", () => {
    expect(matchDuplicates(items, "1", "TEST-002")).toEqual([]);
  });
});

describe("checkPayment", () => {
  it("allows a payment up to the remaining balance", () => {
    expect(checkPayment({ Balance: "125.00" }, 125)).toBeNull();
    expect(checkPayment({ Balance: 125 }, 50)).toBeNull();
  });
  it("refuses a second payment on a fully paid invoice", () => {
    expect(checkPayment({ Balance: "0" }, 125)).toMatch(/fully paid/);
  });
  it("refuses more than the balance and cancelled invoices", () => {
    expect(checkPayment({ Balance: 100 }, 125)).toMatch(/exceeds/);
    expect(checkPayment({ Balance: 100, Cancelled: true }, 50)).toMatch(/cancelled/);
    expect(checkPayment({ Balance: -200 }, 50)).toMatch(/credit note/);
  });
  it("lets allow_overpayment lift only the balance checks", () => {
    expect(checkPayment({ Balance: 100 }, 125, true)).toBeNull();
    expect(checkPayment({ Balance: 0 }, 125, true)).toBeNull();
    expect(checkPayment({ Balance: 100, Cancelled: true }, 50, true)).toMatch(/cancelled/);
    expect(checkPayment({ Balance: -200 }, 50, true)).toMatch(/credit note/);
  });
});

describe("prepareRows", () => {
  const t = "Acme AB - 1234 - hosting March";
  const rowsOf = (p: ReturnType<typeof prepareRows>) =>
    (p.rows ?? []).map((r) => [r.account, r.debit ?? 0, r.credit ?? 0, r.code ?? null, r.transaction_information ?? null]);

  it("leaves rows alone on create without row_text, so Fortnox generates 2440 and VAT", () => {
    const p = prepareRows({ supplier_number: "1", total: 125, vat: 25, rows: [{ account: 6540, debit: 100 }] }, { create: true });
    expect(rowsOf(p)).toEqual([[6540, 100, 0, null, null]]);
    expect(prepareRows({ supplier_number: "1" }, { create: true })).toEqual({ supplier_number: "1" });
  });

  it("adds the reverse charge rows when only the rate is given, and needs vat_type for it", () => {
    const p = prepareRows({ supplier_number: "1", total: 100, vat: 0, vat_type: "EUINTERNAL", reverse_charge_vat_rate: 12,
      rows: [{ account: 4535, debit: 100 }] }, { create: true });
    expect(rowsOf(p).map((r) => [r[0], r[1], r[2]])).toEqual([[2440, 0, 100], [4535, 100, 0], [2645, 12, 0], [2624, 0, 12]]);
    expect(() => prepareRows({ supplier_number: "1", total: 100, vat: 0, reverse_charge_vat_rate: 12,
      rows: [{ account: 4535, debit: 100 }] }, { create: true })).toThrow(/vat_type is required/);
    expect(() => prepareRows({ supplier_number: "1", total: 100, vat: 0, row_text: t,
      rows: [{ account: 4535, debit: 100 }] }, { create: true })).toThrow(/vat_type is required/);
    expect(() => prepareRows({ supplier_number: "1", total: 125, vat: 25, vat_type: "NORMAL", reverse_charge_vat_rate: 25,
      rows: [{ account: 6540, debit: 100 }] }, { create: true })).toThrow(/only applies/);
  });

  it("refuses row_text without rows instead of dropping it", () => {
    expect(() => prepareRows({ supplier_number: "1", total: 125, vat: 25, row_text: t }, { create: true }))
      .toThrow(/row_text needs rows/);
  });

  it("adds 2440 and 2641 with the text for Swedish VAT", () => {
    const p = prepareRows({ supplier_number: "1", total: 125, vat: 25, vat_type: "NORMAL", row_text: t,
      rows: [{ account: 6540, debit: 100 }] }, { create: true });
    expect(rowsOf(p)).toEqual([
      [2440, 0, 125, "TOT", t],
      [6540, 100, 0, null, t],
      [2641, 25, 0, "VAT", t]
    ]);
  });

  it("adds 2440 and 2645/2614 with the text for EUINTERNAL at 25 %", () => {
    const p = prepareRows({ supplier_number: "1", total: 200, vat: 0, vat_type: "EUINTERNAL", row_text: t,
      reverse_charge_vat_rate: 25, rows: [{ account: 4535, debit: 200 }] }, { create: true });
    expect(rowsOf(p)).toEqual([
      [2440, 0, 200, "TOT", t],
      [4535, 200, 0, null, t],
      [2645, 50, 0, "PRD", t],
      [2614, 0, 50, "PRC", t]
    ]);
    const body = buildSupplierInvoiceBody(p);
    expect((body.SupplierInvoiceRows as Array<Record<string, unknown>>).every((r) => r.TransactionInformation === t)).toBe(true);
  });

  it("uses the reverse charge rate and its output VAT account", () => {
    const six = prepareRows({ supplier_number: "1", total: 1000, vat: 0, vat_type: "EUINTERNAL", row_text: t,
      reverse_charge_vat_rate: 6, rows: [{ account: 4535, debit: 1000 }] }, { create: true });
    expect(six.rows!.slice(2).map((r) => [r.account, r.debit ?? 0, r.credit ?? 0])).toEqual([[2645, 60, 0], [2634, 0, 60]]);
    const twelve = prepareRows({ supplier_number: "1", total: 1000, vat: 0, vat_type: "REVERSE", row_text: t,
      reverse_charge_vat_rate: 12, rows: [{ account: 4535, debit: 1000 }] }, { create: true });
    expect(twelve.rows!.slice(2).map((r) => [r.account, r.debit ?? 0, r.credit ?? 0])).toEqual([[2647, 120, 0], [2627, 0, 120]]);
    const reverse25 = prepareRows({ supplier_number: "1", total: 1000, vat: 0, vat_type: "REVERSE", row_text: t,
      reverse_charge_vat_rate: 25, rows: [{ account: 4535, debit: 1000 }] }, { create: true });
    expect(reverse25.rows!.slice(2).map((r) => r.account)).toEqual([2647, 2617]);
  });

  it("requires vat 0 when it adds reverse charge rows", () => {
    expect(() => prepareRows({ supplier_number: "1", total: 125, vat: 25, vat_type: "EUINTERNAL", reverse_charge_vat_rate: 25,
      rows: [{ account: 4535, debit: 100 }] }, { create: true })).toThrow(/vat must be 0/);
  });

  it("requires the reverse charge rate when it adds those VAT rows", () => {
    expect(() => prepareRows({ supplier_number: "1", total: 1000, vat: 0, vat_type: "EUINTERNAL", row_text: t,
      rows: [{ account: 4535, debit: 1000 }] }, { create: true })).toThrow(/reverse_charge_vat_rate/);
  });

  it("adds only 2440 when there is no VAT", () => {
    const p = prepareRows({ supplier_number: "1", total: 250, vat: 0, vat_type: "NORMAL", row_text: t,
      rows: [{ account: 6570, debit: 250 }] }, { create: true });
    expect(rowsOf(p).map((r) => r[0])).toEqual([2440, 6570]);
  });

  it("keeps a row's own text and generated rows the caller sent", () => {
    const p = prepareRows({ supplier_number: "1", total: 100, vat: 0, vat_type: "EUINTERNAL", row_text: t,
      rows: [
        { account: 2440, credit: 100, code: "TOT" },
        { account: 4535, debit: 100, transaction_information: "own" },
        { account: 2645, debit: 25, code: "PRD" },
        { account: 2614, credit: 25, code: "PRC" }
      ] }, { create: true });
    expect(rowsOf(p).map((r) => r[4])).toEqual([t, "own", t, t]);
  });

  it("re-adds the generated rows when an update replaces rows, and needs vat_type, total and vat for it", () => {
    const p = prepareRows({ total: 125, vat: 25, vat_type: "NORMAL", rows: [{ account: 6540, debit: 100 }] }, { create: false });
    expect(rowsOf(p).map((r) => r[0])).toEqual([2440, 6540, 2641]);
    const eu = prepareRows({ total: 100, vat: 0, vat_type: "EUINTERNAL", reverse_charge_vat_rate: 25,
      rows: [{ account: 4535, debit: 100 }] }, { create: false });
    expect(rowsOf(eu).map((r) => r[0])).toEqual([2440, 4535, 2645, 2614]);
    expect(() => prepareRows({ total: 100, vat: 0, rows: [{ account: 4535, debit: 100 }] }, { create: false }))
      .toThrow(/vat_type is required/);
    expect(() => prepareRows({ vat_type: "NORMAL", rows: [{ account: 6540, debit: 100 }] }, { create: false }))
      .toThrow(/total and vat are required/);
    expect(prepareRows({ due_date: "2026-12-01" }, { create: false })).toEqual({ due_date: "2026-12-01" });
  });
});

describe("paymentAmounts", () => {
  it("sends SEK as Amount only", () => {
    expect(paymentAmounts({ Currency: "SEK" }, 500)).toEqual({ Amount: 500 });
    expect(paymentAmounts({}, 500)).toEqual({ Amount: 500 });
  });
  it("sends a foreign amount as AmountCurrency with the SEK amount and rate", () => {
    expect(paymentAmounts({ Currency: "USD", CurrencyRate: "10.5", CurrencyUnit: 1 }, 100))
      .toEqual({ Amount: 1050, AmountCurrency: 100, Currency: "USD", CurrencyRate: 10.5, CurrencyUnit: 1 });
    expect(paymentAmounts({ Currency: "USD", CurrencyRate: 10.5 }, 100, 1032.4))
      .toMatchObject({ Amount: 1032.4, AmountCurrency: 100, CurrencyRate: 10.324 });
  });
  it("refuses a foreign invoice without a rate or amount_sek", () => {
    expect(() => paymentAmounts({ Currency: "EUR" }, 100)).toThrow(/amount_sek/);
  });
});
