import { describe, it, expect } from "vitest";
import { getSupplierInvoiceStatus, normalizeInvoice, toBool, toNum } from "./supplierInvoices.js";

// Fortnox returns Total and Balance as strings, e.g. "0" and "1250.5".
const base = { GivenNumber: "1", SupplierNumber: "1", Booked: true, Cancelled: false };

describe("supplier invoice status", () => {
  it("is fully_paid when the string balance is \"0\"", () => {
    const inv = normalizeInvoice({ ...base, Total: "1250.5", Balance: "0" } as never);
    expect(getSupplierInvoiceStatus(inv)).toBe("fully_paid");
  });
  it("is unpaid when balance equals total", () => {
    const inv = normalizeInvoice({ ...base, Total: "800", Balance: "800" } as never);
    expect(getSupplierInvoiceStatus(inv)).toBe("unpaid");
  });
  it("is partially_paid when 0 < balance < total", () => {
    const inv = normalizeInvoice({ ...base, Total: "1000", Balance: "400" } as never);
    expect(getSupplierInvoiceStatus(inv)).toBe("partially_paid");
  });
  it("is unbooked before bookkeeping, whatever the balance", () => {
    const inv = normalizeInvoice({ ...base, Booked: false, Total: "100", Balance: "100" } as never);
    expect(getSupplierInvoiceStatus(inv)).toBe("unbooked");
  });
  it("handles credit notes, where balance and total are negative", () => {
    const part = normalizeInvoice({ ...base, Total: "-500", Balance: "-200" } as never);
    expect(getSupplierInvoiceStatus(part)).toBe("partially_paid");
    const open = normalizeInvoice({ ...base, Total: "-500", Balance: "-500" } as never);
    expect(getSupplierInvoiceStatus(open)).toBe("unpaid");
  });
  it("is overpaid when the balance has the opposite sign to the total", () => {
    const inv = normalizeInvoice({ ...base, Total: "100", Balance: "-20" } as never);
    expect(getSupplierInvoiceStatus(inv)).toBe("overpaid");
  });
  it("reads the list endpoint's Cancel flag as well as Cancelled", () => {
    const inv = normalizeInvoice({ GivenNumber: "1", SupplierNumber: "1", Booked: false, Cancel: true, Total: "100", Balance: "100" } as never);
    expect(getSupplierInvoiceStatus(inv)).toBe("cancelled");
  });
  it("is cancelled first", () => {
    const inv = normalizeInvoice({ ...base, Cancelled: true, Total: "100", Balance: "0" } as never);
    expect(getSupplierInvoiceStatus(inv)).toBe("cancelled");
  });
});

describe("normalisation", () => {
  it("turns numeric strings into numbers so sums are numeric", () => {
    const a = normalizeInvoice({ ...base, Total: "10.10", Balance: "0" } as never) as { Total: number };
    const b = normalizeInvoice({ ...base, Total: "0.20", Balance: "0" } as never) as { Total: number };
    expect(a.Total + b.Total).toBeCloseTo(10.30);
  });
  it("turns \"false\" into false", () => {
    expect(toBool("false")).toBe(false);
    expect(toBool("true")).toBe(true);
    const inv = normalizeInvoice({ ...base, Credit: "false" } as never) as { Credit: unknown };
    expect(inv.Credit).toBe(false);
  });
  it("treats empty and garbage as 0", () => {
    expect(toNum("")).toBe(0);
    expect(toNum(undefined)).toBe(0);
    expect(toNum("abc")).toBe(0);
  });
});
