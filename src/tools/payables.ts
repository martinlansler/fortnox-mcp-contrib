/**
 * Supplier invoice write flow and supplier invoice payments.
 *
 * Fortnox's own two-step model is kept visible, so nothing is booked by accident:
 *   1. create_supplier_invoice           -> an UNBOOKED invoice (editable, cancellable)
 *   2. bookkeep_supplier_invoice         -> its voucher (series D by default); now immutable
 *   3. create_supplier_invoice_payment   -> an UNBOOKED payment (deletable)
 *   4. bookkeep_supplier_invoice_payment -> its voucher (series E by default)
 * Every write is a separate call; none of them books implicitly.
 */
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { fetchAllPages, fortnoxRequest } from "../services/api.js";
import { buildToolResponse, buildErrorResponse } from "../services/formatters.js";

// A factory, not a shared instance: a reused zod schema is advertised as a JSON-Schema $ref.
const date = () => z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Date must be in YYYY-MM-DD format");

const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };
const DESTRUCTIVE = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true };
const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };

function json(output: unknown) {
  return buildToolResponse(JSON.stringify(output, null, 2), output as Record<string, unknown>);
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

export const SupplierInvoiceRowSchema = z.object({
  account: z.number().int().min(1000).max(9999).describe("Account number"),
  debit: z.number().min(0).optional().describe("Debit amount"),
  credit: z.number().min(0).optional().describe("Credit amount"),
  transaction_information: z.string().max(100).optional().describe("Row text (Transaktionsinfo)"),
  cost_center: z.string().max(20).optional(),
  project: z.string().max(20).optional(),
  code: z.enum(["TOT", "VAT", "PRD", "PRC", "CND", "CNC"]).optional()
    .describe("Only for re-sending a row Fortnox generated (TOT = 2440, VAT = 2641, PRD/PRC = 2645/26x4 for EUINTERNAL, CND/CNC = 2647/26x7 for REVERSE), e.g. to give it a row text. Leave out on cost rows.")
}).strict().refine(
  (r) => ((r.debit ?? 0) > 0) !== ((r.credit ?? 0) > 0),
  { message: "Each row needs exactly one of debit or credit greater than 0" }
);

const SupplierInvoiceFields = {
  invoice_number: z.string().max(50).optional().describe("The supplier's own invoice number"),
  invoice_date: date().optional().describe("Invoice date"),
  due_date: date().optional().describe("Due date"),
  total: z.number().optional().describe("Invoice total incl. VAT"),
  vat: z.number().optional().describe("VAT amount (0 for reverse charge)"),
  vat_type: z.enum(["NORMAL", "EUINTERNAL", "REVERSE"]).optional()
    .describe("NORMAL = Swedish VAT (Fortnox adds 2641). EUINTERNAL = purchase from abroad, EU or non-EU services (Fortnox adds 2645/2614). REVERSE = Swedish domestic reverse charge, e.g. construction (Fortnox adds 2647/2617) - NOT for foreign suppliers."),
  reverse_charge_vat_rate: z.union([z.literal(25), z.literal(12), z.literal(6)]).optional()
    .describe("VAT rate (25, 12 or 6) the buyer self-assesses on an EUINTERNAL or REVERSE invoice. Required when the tool adds the VAT rows (with row_text, or on an update with rows); decides the amount and the output VAT account (EUINTERNAL 2614 / 2624 / 2634, REVERSE 2617 / 2627 / 2637)."),
  currency: z.string().length(3).optional().describe("Currency code, e.g. SEK"),
  ocr: z.string().max(50).optional(),
  your_reference: z.string().max(50).optional(),
  our_reference: z.string().max(50).optional(),
  comments: z.string().max(1024).optional(),
  row_text: z.string().trim().min(1).max(100).optional()
    .describe("Optional row text (Transaktionsinfo) for every row of the invoice's voucher, e.g. 'Acme AB - 1234 - hosting March'. Put on each cost row without its own text, and on the 2440/VAT rows, which the tool then adds itself so the text is kept. Needs total and vat."),
  rows: z.array(SupplierInvoiceRowSchema).min(1).optional()
    .describe("COST rows only (e.g. 6540 debit, net of VAT). Do NOT include 2440 or VAT rows: Fortnox generates the 2440 row from total and the VAT rows from vat/vat_type. Omit to let Fortnox use the supplier's default account.")
};

const CreateSupplierInvoiceSchema = z.object({
  supplier_number: z.string().min(1).describe("Supplier number (required)"),
  ...SupplierInvoiceFields,
  allow_duplicate: z.boolean().optional()
    .describe("Create even if this supplier already has a non-cancelled invoice with the same invoice_number")
}).strict();

const UpdateSupplierInvoiceSchema = z.object({
  given_number: z.string().min(1).describe("Fortnox löpnummer (GivenNumber) of an UNBOOKED invoice"),
  ...SupplierInvoiceFields
}).strict();

const GivenNumberSchema = z.object({
  given_number: z.string().min(1).describe("Fortnox löpnummer (GivenNumber) of the supplier invoice")
}).strict();

const CreatePaymentSchema = z.object({
  given_number: z.string().min(1).describe("Supplier invoice löpnummer (GivenNumber) being paid"),
  amount: z.number().positive().describe("Amount paid, in the invoice currency (e.g. USD for a USD invoice)"),
  amount_sek: z.number().positive().optional()
    .describe("For a foreign-currency invoice: what the payment cost in SEK (the bank's amount). Omit to use the invoice's currency rate; Fortnox books any difference as exchange gain/loss."),
  payment_date: date().describe("Payment date"),
  mode_of_payment: z.string().min(1).max(10)
    .describe("Fortnox mode of payment code; it decides the credit account (see fortnox_list_modes_of_payment)"),
  information: z.string().max(100).optional().describe("Payment information text"),
  allow_overpayment: z.boolean().optional()
    .describe("Register even if amount exceeds the invoice's remaining balance (or the invoice is already paid). Cancelled invoices and credit notes are always refused.")
}).strict();

const PaymentNumberSchema = z.object({
  payment_number: z.number().int().min(1).describe("Supplier invoice payment number")
}).strict();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type InvoiceFields = Partial<z.infer<typeof CreateSupplierInvoiceSchema>>;

/** Accounts Fortnox generates itself on a supplier invoice: payable and the VAT accounts. */
export const GENERATED_ACCOUNTS = new Set([2440, 2641, 2645, 2647, 2614, 2615, 2617, 2624, 2627, 2634, 2637]);

/**
 * Output VAT account for self-assessed VAT, per VAT type and rate (BAS): 26x4 for purchases from
 * abroad (EUINTERNAL), 26x7 for Swedish domestic reverse charge (REVERSE).
 */
const OUTPUT_VAT_ACCOUNT: Record<"EUINTERNAL" | "REVERSE", Record<25 | 12 | 6, number>> = {
  EUINTERNAL: { 25: 2614, 12: 2624, 6: 2634 },
  REVERSE: { 25: 2617, 12: 2627, 6: 2637 }
};

type Row = z.infer<typeof SupplierInvoiceRowSchema>;

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Fortnox generates the 2440 row (code TOT) and the VAT rows itself, and only keeps a row text on
 * them when they are sent with their code. They are therefore added here when:
 *   - row_text is given, so every row of the voucher carries it, or
 *   - an invoice's rows are replaced on update, where Fortnox would otherwise drop the reverse
 *     charge rows.
 * The rows added are TOT 2440, VAT 2641 (NORMAL), PRD/PRC 2645/26x4 (EUINTERNAL) or CND/CNC
 * 2647/26x7 (REVERSE), the reverse charge ones at reverse_charge_vat_rate (x = 1 at 25 %, 2 at
 * 12 %, 3 at 6 %). Generated rows the caller sends with a code are kept as given.
 */
export function prepareRows(p: InvoiceFields, opts: { create: boolean }): InvoiceFields {
  const text = p.row_text?.trim() || undefined;
  if (!p.rows) {
    if (text) throw new Error("row_text needs rows: give the cost rows it should go on.");
    return p;
  }
  const withText = (r: Row): Row => {
    const own = r.transaction_information?.trim() || text;
    return own ? { ...r, transaction_information: own } : r;
  };
  const cost = p.rows.filter((r) => !r.code).map(withText);
  let generated = p.rows.filter((r) => r.code).map(withText);
  // A reverse charge rate only reaches Fortnox through the VAT rows the tool adds.
  const rateGiven = p.reverse_charge_vat_rate !== undefined;
  if (!generated.length && (text || !opts.create || rateGiven)) {
    if (!p.vat_type) {
      // Defaulting to NORMAL would silently drop or contradict a reverse charge invoice's VAT rows.
      throw new Error("vat_type is required " + (opts.create ? "with row_text or reverse_charge_vat_rate" : "when rows are replaced") +
        ", so the right VAT rows can be added.");
    }
    if (rateGiven && p.vat_type === "NORMAL") {
      throw new Error("reverse_charge_vat_rate only applies to vat_type EUINTERNAL or REVERSE.");
    }
    if (p.total === undefined || p.vat === undefined) {
      throw new Error(text
        ? "total and vat are required with row_text, so the 2440 and VAT rows can be given the text."
        : "total and vat are required when rows are replaced, so the 2440 and VAT rows can be re-added.");
    }
    const vatType = p.vat_type ?? "NORMAL";
    const net = cost.reduce((s, r) => s + (r.debit ?? 0) - (r.credit ?? 0), 0);
    const side = (amount: number, debitWhenPositive: boolean): Pick<Row, "debit" | "credit"> =>
      (amount >= 0) === debitWhenPositive ? { debit: round2(Math.abs(amount)) } : { credit: round2(Math.abs(amount)) };
    const t = text ? { transaction_information: text } : {};
    const g: Row[] = [{ account: 2440, code: "TOT", ...t, ...side(p.total, false) }];
    if (vatType === "NORMAL" && p.vat !== 0) {
      g.push({ account: 2641, code: "VAT", ...t, ...side(p.vat, true) });
    } else if (vatType === "EUINTERNAL" || vatType === "REVERSE") {
      if (p.vat !== 0) {
        // Self-assessed VAT is not part of what the supplier invoiced: total - vat must equal net.
        throw new Error(`vat must be 0 on a ${vatType} invoice; the tool adds the self-assessed VAT rows from the rate.`);
      }
      const rate = p.reverse_charge_vat_rate;
      if (!rate) {
        throw new Error(`reverse_charge_vat_rate (25, 12 or 6) is required to add the VAT rows for vat_type ${vatType}.`);
      }
      const vat = net * rate / 100;
      const [inAcc, inCode, outCode] = vatType === "EUINTERNAL" ? [2645, "PRD", "PRC"] : [2647, "CND", "CNC"];
      g.push({ account: inAcc, code: inCode as Row["code"], ...t, ...side(vat, true) });
      g.push({ account: OUTPUT_VAT_ACCOUNT[vatType][rate], code: outCode as Row["code"], ...t, ...side(vat, false) });
    }
    generated = g.filter((r) => (r.debit ?? 0) > 0 || (r.credit ?? 0) > 0);
  }
  const rows = [...generated.filter((r) => r.code === "TOT"), ...cost, ...generated.filter((r) => r.code !== "TOT")];
  return { ...p, rows };
}

/** Throws when rows are given on an invoice whose currency is not SEK. */
export function checkRowsCurrency(p: InvoiceFields, currency: string | undefined): void {
  const c = (currency || "SEK").toUpperCase();
  if (p.rows && c !== "SEK") {
    // Row Debit/Credit are SEK while total and vat are in the invoice currency.
    throw new Error(`rows are only supported on SEK invoices; leave rows out for a ${c} invoice ` +
      `and let Fortnox use the supplier's default account.`);
  }
}

/**
 * The currency rows would be booked in: the one given, else (only when rows are given) the
 * existing invoice's on update or the supplier's default on create.
 */
async function rowsCurrency(p: InvoiceFields, givenNumber?: string): Promise<string | undefined> {
  if (!p.rows || p.currency) return p.currency;
  if (givenNumber) {
    const r = await fortnoxRequest<{ SupplierInvoice: { Currency?: string } }>(`/3/supplierinvoices/${enc(givenNumber)}`);
    return r.SupplierInvoice.Currency;
  }
  if (!p.supplier_number) return undefined;
  const r = await fortnoxRequest<{ Supplier: { Currency?: string } }>(`/3/suppliers/${enc(p.supplier_number)}`);
  return r.Supplier.Currency;
}

export function buildSupplierInvoiceBody(p: InvoiceFields): Record<string, unknown> {
  if (p.currency) checkRowsCurrency(p, p.currency);
  if (p.rows) {
    const generated = p.rows.filter((r) => !r.code && GENERATED_ACCOUNTS.has(r.account)).map((r) => r.account);
    if (generated.length) {
      throw new Error(
        `Rows must be cost rows only; Fortnox generates ${[...new Set(generated)].join(", ")} itself ` +
        `from total, vat and vat_type. Remove those rows.`);
    }
    if (p.total !== undefined) {
      const net = p.rows.filter((r) => !r.code).reduce((s, r) => s + (r.debit ?? 0) - (r.credit ?? 0), 0);
      const expected = p.total - (p.vat ?? 0);
      if (Math.abs(net - expected) > 0.005) {
        throw new Error(
          `Cost rows sum to ${net.toFixed(2)} but total - vat is ${expected.toFixed(2)}.`);
      }
    }
  }
  const body: Record<string, unknown> = {};
  const set = (key: string, value: unknown) => { if (value !== undefined) body[key] = value; };
  set("SupplierNumber", p.supplier_number);
  set("InvoiceNumber", p.invoice_number);
  set("InvoiceDate", p.invoice_date);
  set("DueDate", p.due_date);
  set("Total", p.total);
  set("VAT", p.vat);
  set("VATType", p.vat_type);
  set("Currency", p.currency);
  set("OCR", p.ocr);
  set("YourReference", p.your_reference);
  set("OurReference", p.our_reference);
  set("Comments", p.comments);
  if (p.rows) {
    body.SupplierInvoiceRows = p.rows.map((r) => {
      const row: Record<string, unknown> = { Account: r.account };
      if (r.debit) row.Debit = r.debit;
      if (r.credit) row.Credit = r.credit;
      if (r.transaction_information) row.TransactionInformation = r.transaction_information;
      if (r.cost_center) row.CostCenter = r.cost_center;
      if (r.project) row.Project = r.project;
      if (r.code) row.Code = r.code;
      return row;
    });
  }
  return body;
}

interface SupplierInvoiceApi {
  GivenNumber: string;
  SupplierNumber: string;
  SupplierName?: string;
  InvoiceNumber?: string;
  InvoiceDate?: string;
  DueDate?: string;
  Total?: string | number;
  VAT?: string | number;
  VATType?: string;
  Balance?: string | number;
  Currency?: string;
  Booked?: boolean | string;
  Cancelled?: boolean | string;
  VoucherSeries?: string;
  VoucherNumber?: number;
  VoucherYear?: number;
  SupplierInvoiceRows?: Array<{
    Account?: number; AccountDescription?: string; Debit?: number; Credit?: number; TransactionInformation?: string; Code?: string;
  }>;
}

interface SupplierInvoiceListItem {
  GivenNumber: string;
  SupplierNumber?: string;
  InvoiceNumber?: string;
  Cancelled?: boolean | string;
  Cancel?: boolean | string;
}

/** Non-cancelled invoices of this supplier carrying the same supplier invoice number. */
export function matchDuplicates(
  items: SupplierInvoiceListItem[], supplierNumber: string, invoiceNumber: string
): SupplierInvoiceListItem[] {
  const norm = (v: string | undefined) => (v ?? "").trim().toUpperCase();
  return items.filter((i) =>
    norm(i.SupplierNumber) === norm(supplierNumber) &&
    norm(i.InvoiceNumber) === norm(invoiceNumber) &&
    // The list endpoint calls the flag Cancel; the single-invoice endpoint calls it Cancelled.
    ![i.Cancelled, i.Cancel].some((v) => v === true || v === "true"));
}

async function findDuplicateInvoices(supplierNumber: string, invoiceNumber: string) {
  const all = await fetchAllPages<SupplierInvoiceListItem, {
    SupplierInvoices?: SupplierInvoiceListItem[];
    MetaInformation?: { "@TotalResources"?: number };
  }>("/3/supplierinvoices", { suppliernumber: supplierNumber },
    (r) => r.SupplierInvoices || [], (r) => r.MetaInformation?.["@TotalResources"] || 0);
  if (all.truncated) {
    throw new Error(`Could not check every existing invoice for a duplicate (${all.truncationReason}). ` +
      `Nothing was created. Pass allow_duplicate: true to create it anyway.`);
  }
  return matchDuplicates(all.items, supplierNumber, invoiceNumber);
}

/** Why a payment of `amount` must not be registered on this invoice, or null when it may. */
export function checkPayment(
  inv: { Balance?: string | number; Cancelled?: boolean | string; Booked?: boolean | string },
  amount: number,
  allowOverpayment = false
): string | null {
  const yes = (v: unknown) => v === true || v === "true";
  if (yes(inv.Cancelled)) return "The invoice is cancelled.";
  const balance = Number(inv.Balance ?? 0);
  if (balance < -0.005) return "This is a credit note (negative balance); registering its refund is not supported by this tool.";
  if (allowOverpayment) return null;
  if (balance <= 0.005) return "The invoice is already fully paid (balance 0) - is this a duplicate payment?";
  if (amount > balance + 0.005) {
    return `Amount ${amount.toFixed(2)} exceeds the remaining balance ${balance.toFixed(2)}.`;
  }
  return null;
}

type PaymentInvoiceApi = {
  Balance?: string | number; Cancelled?: boolean | string; Booked?: boolean | string;
  Currency?: string; CurrencyRate?: string | number; CurrencyUnit?: string | number;
};

/**
 * Amount fields of a supplier invoice payment. Fortnox's Amount is always SEK; for a foreign
 * invoice the invoice-currency amount goes in AmountCurrency, with the rate it was paid at.
 */
export function paymentAmounts(inv: PaymentInvoiceApi, amount: number, amountSek?: number): Record<string, unknown> {
  const currency = (inv.Currency || "SEK").toUpperCase();
  if (currency === "SEK") {
    if (amountSek !== undefined && Math.abs(amountSek - amount) > 0.005) {
      throw new Error("amount_sek only applies to foreign-currency invoices; this invoice is in SEK.");
    }
    return { Amount: amount };
  }
  const unit = Number(inv.CurrencyUnit || 1) || 1;
  let sek = amountSek;
  if (sek === undefined) {
    const rate = Number(inv.CurrencyRate || 0);
    if (!(rate > 0)) {
      throw new Error(`The invoice is in ${currency} but has no currency rate; give amount_sek.`);
    }
    sek = round2(amount * rate / unit);
  }
  return {
    Amount: round2(sek),
    AmountCurrency: amount,
    Currency: currency,
    CurrencyRate: Math.round((sek / amount) * unit * 1e6) / 1e6,
    CurrencyUnit: unit
  };
}

export function summarizeInvoice(inv: SupplierInvoiceApi) {
  const n = (v: unknown) => (v === undefined || v === null || v === "" ? null : Number(v));
  const b = (v: unknown) => v === true || v === "true";
  return {
    given_number: inv.GivenNumber,
    supplier_number: inv.SupplierNumber,
    supplier_name: inv.SupplierName ?? null,
    invoice_number: inv.InvoiceNumber ?? null,
    invoice_date: inv.InvoiceDate ?? null,
    due_date: inv.DueDate ?? null,
    total: n(inv.Total),
    vat: n(inv.VAT),
    vat_type: inv.VATType ?? null,
    balance: n(inv.Balance),
    currency: inv.Currency ?? null,
    booked: b(inv.Booked),
    cancelled: b(inv.Cancelled),
    voucher: inv.VoucherNumber ? `${inv.VoucherSeries}${inv.VoucherNumber}` : null,
    voucher_year: inv.VoucherYear ?? null,
    rows: (inv.SupplierInvoiceRows || []).map((r) => ({
      account: r.Account ?? null,
      account_name: r.AccountDescription ?? null,
      code: r.Code ?? null,
      debit: r.Debit ?? 0,
      credit: r.Credit ?? 0,
      transaction_information: r.TransactionInformation ?? null
    }))
  };
}

interface PaymentApi {
  Number: number;
  InvoiceNumber: string;
  Amount?: number;
  AmountCurrency?: number;
  Currency?: string;
  PaymentDate?: string;
  ModeOfPayment?: string;
  Information?: string;
  Booked?: boolean;
  VoucherSeries?: string;
  VoucherNumber?: number;
  VoucherYear?: number;
}

function summarizePayment(p: PaymentApi) {
  return {
    payment_number: p.Number,
    given_number: p.InvoiceNumber,
    // Amount is SEK. The amount in the invoice currency is AmountCurrency, which the list
    // endpoint does not return: then it is unknown for a foreign payment.
    amount: (p.Currency ?? "SEK").toUpperCase() === "SEK" ? (p.Amount ?? null) : (p.AmountCurrency || null),
    currency: p.Currency ?? "SEK",
    amount_sek: p.Amount ?? null,
    payment_date: p.PaymentDate ?? null,
    mode_of_payment: p.ModeOfPayment ?? null,
    information: p.Information ?? null,
    booked: p.Booked ?? false,
    voucher: p.VoucherNumber ? `${p.VoucherSeries}${p.VoucherNumber}` : null,
    voucher_year: p.VoucherYear ?? null
  };
}

const enc = encodeURIComponent;

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

export function registerPayablesTools(server: McpServer): void {
  server.registerTool("fortnox_create_supplier_invoice", {
    title: "Create Supplier Invoice (unbooked)",
    description: `Register a supplier invoice in Fortnox WITHOUT booking it.

The invoice is created unbooked: it can still be changed with fortnox_update_supplier_invoice
or cancelled with fortnox_cancel_supplier_invoice. Nothing reaches the ledger until
fortnox_bookkeep_supplier_invoice is called.

rows: the COST rows only. Fortnox itself adds the 2440 row (from total) and the VAT rows (from vat and
vat_type), so passing them too books them twice. Cost rows must sum to total - vat. Omit rows to let
Fortnox use the supplier's default account. Rows are only supported on SEK invoices.
Example (Swedish VAT): total 1250, vat 250, vat_type NORMAL, rows [{account:6540,debit:1000}]
Example (service bought from abroad, reverse charge): total 100, vat 0, vat_type EUINTERNAL, rows [{account:4535,debit:100}]

row_text (optional) puts one row text (Transaktionsinfo) on every row of the invoice's voucher, e.g.
'Acme AB - 1234 - hosting March'. Fortnox only keeps a text on its generated rows when they are sent with
their code, so the tool then adds them itself (TOT 2440, VAT 2641, PRD/PRC 2645/26x4 for EUINTERNAL,
CND/CNC 2647/26x7 for REVERSE); you still send cost rows only. For EUINTERNAL and REVERSE give
reverse_charge_vat_rate (25, 12 or 6), with or without row_text, to have the tool add the VAT rows at that rate: output VAT goes to 2614/2624/2634 (EUINTERNAL) or 2617/2627/2637
(REVERSE). row_text needs rows.
Generated rows you do send with a code are kept as given.
The voucher's own description is set by Fortnox ("Levfakt <supplier> (n)"); the API cannot set it.

Refuses an invoice whose supplier + invoice_number already exists (not cancelled) unless allow_duplicate is true.`,
    inputSchema: CreateSupplierInvoiceSchema,
    annotations: WRITE
  }, async (params) => {
    try {
      const body = buildSupplierInvoiceBody(prepareRows(params, { create: true }));
      checkRowsCurrency(params, await rowsCurrency(params));
      if (params.invoice_number && !params.allow_duplicate) {
        const existing = await findDuplicateInvoices(params.supplier_number, params.invoice_number);
        if (existing.length) {
          return buildErrorResponse(new Error(
            `Duplicate: supplier ${params.supplier_number} already has invoice ${params.invoice_number} ` +
            `(löpnummer ${existing.map((e) => e.GivenNumber).join(", ")}). Nothing was created. ` +
            `Pass allow_duplicate: true only if this really is a second invoice with the same number.`));
        }
      }
      const res = await fortnoxRequest<{ SupplierInvoice: SupplierInvoiceApi }>(
        "/3/supplierinvoices", "POST", { SupplierInvoice: body });
      return json({ success: true, ...summarizeInvoice(res.SupplierInvoice) });
    } catch (e) { return buildErrorResponse(e); }
  });

  server.registerTool("fortnox_update_supplier_invoice", {
    title: "Update Unbooked Supplier Invoice",
    description: `Change an UNBOOKED supplier invoice. Only the fields given are sent; rows, if given,
replace all rows. Fortnox rejects changes to a booked invoice.
When rows are given, total, vat and vat_type are required too (and reverse_charge_vat_rate for
EUINTERNAL/REVERSE): the tool re-adds the 2440/VAT rows, which Fortnox would otherwise drop
(the reverse charge rows). row_text, if given, goes on every row as on create.`,
    inputSchema: UpdateSupplierInvoiceSchema,
    annotations: WRITE
  }, async ({ given_number, ...fields }) => {
    try {
      const body = buildSupplierInvoiceBody(prepareRows(fields, { create: false }));
      checkRowsCurrency(fields, await rowsCurrency(fields, given_number));
      const res = await fortnoxRequest<{ SupplierInvoice: SupplierInvoiceApi }>(
        `/3/supplierinvoices/${enc(given_number)}`, "PUT", { SupplierInvoice: body });
      return json({ success: true, ...summarizeInvoice(res.SupplierInvoice) });
    } catch (e) { return buildErrorResponse(e); }
  });

  server.registerTool("fortnox_bookkeep_supplier_invoice", {
    title: "Book Supplier Invoice",
    description: `Book an unbooked supplier invoice. This creates its voucher (series D by default).
IRREVERSIBLE: a booked invoice can no longer be edited or cancelled via the API; only credited.`,
    inputSchema: GivenNumberSchema,
    annotations: DESTRUCTIVE
  }, async ({ given_number }) => {
    try {
      const res = await fortnoxRequest<{ SupplierInvoice: SupplierInvoiceApi }>(
        `/3/supplierinvoices/${enc(given_number)}/bookkeep`, "PUT");
      return json({ success: true, ...summarizeInvoice(res.SupplierInvoice) });
    } catch (e) { return buildErrorResponse(e); }
  });

  server.registerTool("fortnox_cancel_supplier_invoice", {
    title: "Cancel Unbooked Supplier Invoice",
    description: "Cancel an UNBOOKED supplier invoice (Fortnox has no delete for supplier invoices). It stays in the register marked cancelled.",
    inputSchema: GivenNumberSchema,
    annotations: DESTRUCTIVE
  }, async ({ given_number }) => {
    try {
      const res = await fortnoxRequest<{ SupplierInvoice: SupplierInvoiceApi }>(
        `/3/supplierinvoices/${enc(given_number)}/cancel`, "PUT");
      return json({ success: true, ...summarizeInvoice(res.SupplierInvoice) });
    } catch (e) { return buildErrorResponse(e); }
  });

  server.registerTool("fortnox_create_supplier_invoice_payment", {
    title: "Register Supplier Invoice Payment (unbooked)",
    description: `Register a payment against a supplier invoice. Created UNBOOKED; book it with
fortnox_bookkeep_supplier_invoice_payment, or remove it with fortnox_delete_supplier_invoice_payment.
The mode of payment decides the credit account (e.g. a bank account such as 1930).
amount is in the invoice currency. For a foreign-currency invoice also give amount_sek (what the bank
charged); without it the invoice's own rate is used.`,
    inputSchema: CreatePaymentSchema,
    annotations: WRITE
  }, async (p) => {
    try {
      const inv = (await fortnoxRequest<{ SupplierInvoice: PaymentInvoiceApi }>(
        `/3/supplierinvoices/${enc(p.given_number)}`)).SupplierInvoice;
      // Balance is in the invoice currency, like amount.
      const refusal = checkPayment(inv, p.amount, p.allow_overpayment);
      if (refusal) return buildErrorResponse(new Error(`${refusal} Nothing was registered.`));
      const body: Record<string, unknown> = {
        InvoiceNumber: p.given_number,
        PaymentDate: p.payment_date,
        ModeOfPayment: p.mode_of_payment,
        ...paymentAmounts(inv, p.amount, p.amount_sek)
      };
      if (p.information) body.Information = p.information;
      const res = await fortnoxRequest<{ SupplierInvoicePayment: PaymentApi }>(
        "/3/supplierinvoicepayments", "POST", { SupplierInvoicePayment: body });
      return json({ success: true, ...summarizePayment(res.SupplierInvoicePayment) });
    } catch (e) { return buildErrorResponse(e); }
  });

  server.registerTool("fortnox_bookkeep_supplier_invoice_payment", {
    title: "Book Supplier Invoice Payment",
    description: "Book an unbooked supplier invoice payment, creating its voucher (series E). IRREVERSIBLE via the API.",
    inputSchema: PaymentNumberSchema,
    annotations: DESTRUCTIVE
  }, async ({ payment_number }) => {
    try {
      const res = await fortnoxRequest<{ SupplierInvoicePayment: PaymentApi }>(
        `/3/supplierinvoicepayments/${payment_number}/bookkeep`, "PUT");
      return json({ success: true, ...summarizePayment(res.SupplierInvoicePayment) });
    } catch (e) { return buildErrorResponse(e); }
  });

  server.registerTool("fortnox_delete_supplier_invoice_payment", {
    title: "Delete Unbooked Supplier Invoice Payment",
    description: "Delete an UNBOOKED supplier invoice payment. Fortnox refuses for booked payments.",
    inputSchema: PaymentNumberSchema,
    annotations: DESTRUCTIVE
  }, async ({ payment_number }) => {
    try {
      await fortnoxRequest(`/3/supplierinvoicepayments/${payment_number}`, "DELETE");
      return json({ success: true, payment_number, deleted: true });
    } catch (e) { return buildErrorResponse(e); }
  });

  server.registerTool("fortnox_list_supplier_invoice_payments", {
    title: "List Supplier Invoice Payments",
    description: "List supplier invoice payments, optionally for one invoice (given_number).",
    inputSchema: z.object({ given_number: z.string().min(1).optional() }).strict(),
    annotations: READ
  }, async ({ given_number }) => {
    try {
      const all = await fetchAllPages<PaymentApi, {
        SupplierInvoicePayments?: PaymentApi[];
        MetaInformation?: { "@TotalResources"?: number };
      }>("/3/supplierinvoicepayments", given_number ? { invoicenumber: given_number } : {},
        (r) => r.SupplierInvoicePayments || [], (r) => r.MetaInformation?.["@TotalResources"] || 0);
      // Filter here too, in case Fortnox ignores the invoicenumber parameter.
      const payments = all.items.filter((x) => !given_number || String(x.InvoiceNumber) === given_number);
      return json({
        payments: payments.map(summarizePayment),
        ...(all.truncated ? { truncated: true, truncation_reason: all.truncationReason } : {})
      });
    } catch (e) { return buildErrorResponse(e); }
  });

  server.registerTool("fortnox_list_modes_of_payment", {
    title: "List Modes of Payment",
    description: "List Fortnox modes of payment (betalsätt) with the account each one credits. Needs the settings scope, which is not requested by default: add settings to the scopes when you create the refresh token.",
    inputSchema: z.object({}).strict(),
    annotations: READ
  }, async () => {
    try {
      const res = await fortnoxRequest<{ ModesOfPayments: Array<{ Code: string; Description?: string; AccountNumber?: number }> }>(
        "/3/modesofpayments");
      return json({
        modes_of_payment: (res.ModesOfPayments || []).map((m) => ({
          code: m.Code, description: m.Description ?? null, account: m.AccountNumber ?? null
        }))
      });
    } catch (e) { return buildErrorResponse(e); }
  });
}
